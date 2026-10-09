#!/usr/bin/env python3
"""Mutation-test driver: one mutant at a time per worker, real bytecode, full relevant test suite.

Per mutant:
  1. apply the mutant to a private compile directory (src/ plus the one test file that inherits src,
     test/UniformClearing.t.sol) and `forge build` it with the project's own settings (via-IR, solc 0.8.34);
     a compile error marks the mutant "invalid";
  2. copy the rebuilt src artifacts into the worker's fully compiled project, whose sources are unchanged,
     so `forge test` does not recompile: the tests deploy the mutated bytecode through forge's dynamic test
     linking (`new AuctionEngine(...)` is served from the artifact);
  3. run the test command; any failing test kills the mutant; then restore the original artifacts.
A test run that recompiles anything is recorded as "error" (the swap would not be trustworthy).

usage: mutdriver.py <compiled-project> <mutants.json> <out.jsonl> <workers> [--only idx,idx,...]
"""
import json, os, re, shutil, subprocess, sys, threading, queue, time

project, mutants_path, out_path, workers = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
only = None
if "--only" in sys.argv:
    only = set(int(x) for x in sys.argv[sys.argv.index("--only") + 1].split(","))
FORGE = os.path.expanduser("~/.foundry/bin/forge")
ENV = dict(os.environ, PATH=os.path.expanduser("~/.foundry/bin") + ":" + os.environ["PATH"])
TEST_CMD = [FORGE, "test", "--fail-fast", "--offline", "--fuzz-seed", "0x5eed", "-j", "2", "--no-match-path",
            "test/{Scale.t.sol,UniswapV3Adapter.t.sol,fork/*,symbolic/*}"]
# Test files that inherit src contracts (their bytecode embeds the code under test): rebuilt with each mutant.
EXTRA_TEST_SOURCES = os.environ.get("MUT_EXTRA", "test/UniformClearing.t.sol").split(",")
COMP_BUILD = [FORGE, "build", "--offline", "src"] + EXTRA_TEST_SOURCES
TIMEOUT = 1800

mutants = json.load(open(mutants_path))
done = set()
if os.path.exists(out_path):
    for l in open(out_path):
        done.add(json.loads(l)["idx"])
sel = [m for m in mutants if m["idx"] not in done and (only is None or m["idx"] in only)]
print(f"{len(mutants)} mutants; running {len(sel)} ({len(done)} already done)", flush=True)

lock = threading.Lock()
q = queue.Queue()
for m in sel:
    q.put(m)
base = os.path.dirname(os.path.abspath(out_path))


def artifacts_of(comp):
    """Artifact paths (relative to out/) of every src file and the extra test sources in comp's cache."""
    c = json.load(open(os.path.join(comp, "cache", "solidity-files-cache.json")))
    paths = []
    for name, f in c["files"].items():
        if name.startswith("src/") or name in EXTRA_TEST_SOURCES:
            for contract in f["artifacts"].values():
                for ver in contract.values():
                    for prof in ver.values():
                        paths.append(prof["path"])
    return sorted(set(paths))


def setup(wid):
    w = os.path.join(base, f"w{wid}")
    c = os.path.join(base, f"c{wid}")
    if not os.path.exists(w):
        subprocess.run(["rsync", "-a", "--exclude", "reports", project + "/", w + "/"], check=True)
    if not os.path.exists(c):
        os.makedirs(c)
        subprocess.run(["rsync", "-a", "--exclude", "out", "--exclude", "cache", "--exclude", "test", "--exclude",
                        "script", "--exclude", "reports", project + "/", c + "/"], check=True)
        for t in EXTRA_TEST_SOURCES:
            os.makedirs(os.path.dirname(os.path.join(c, t)), exist_ok=True)
            shutil.copy(os.path.join(project, t), os.path.join(c, t))
        subprocess.run(COMP_BUILD, cwd=c, env=ENV, capture_output=True, check=True)
    arts = artifacts_of(c)
    orig = {a: open(os.path.join(w, "out", a), "rb").read() for a in arts}
    return w, c, arts, orig


def worker(wid):
    w, c, arts, orig_art = setup(wid)
    while True:
        try:
            m = q.get_nowait()
        except queue.Empty:
            return
        rel = m["file"]
        src_path = os.path.join(c, rel)
        orig_src = open(os.path.join(project, rel), "rb").read()
        mutated = orig_src[:m["lo"]] + m["mutant"].encode() + orig_src[m["hi"]:]
        assert orig_src[m["lo"]:m["hi"]].decode() == m["original"], m
        t0 = time.time()
        failing = []
        try:
            open(src_path, "wb").write(mutated)
            b = subprocess.run(COMP_BUILD, cwd=c, env=ENV, capture_output=True, text=True, timeout=TIMEOUT)
            if b.returncode != 0:
                status = "invalid"
            else:
                for a in artifacts_of(c):
                    shutil.copy(os.path.join(c, "out", a), os.path.join(w, "out", a))
                p = subprocess.run(TEST_CMD, cwd=w, env=ENV, capture_output=True, text=True, timeout=TIMEOUT)
                out = p.stdout + p.stderr
                if "No files changed, compilation skipped" not in out:
                    status = "error"
                elif p.returncode == 0:
                    status = "survived"
                elif "[FAIL" in out:
                    status = "killed"
                else:
                    status = "error"
                failing = re.findall(r"^\[FAIL.*?\] ((?:test|invariant|setUp)\w*)\(", out, re.M)[:3]
        except subprocess.TimeoutExpired:
            status = "timeout"
        finally:
            open(src_path, "wb").write(orig_src)
            for a, data in orig_art.items():
                open(os.path.join(w, "out", a), "wb").write(data)
        rec = dict(idx=m["idx"], file=rel, line=m["line"], function=m["function"], kind=m["kind"],
                   original=m["original"], mutant=m["mutant"], status=status, secs=round(time.time() - t0),
                   killed_by=failing)
        with lock:
            with open(out_path, "a") as f:
                f.write(json.dumps(rec) + "\n")
            print(f"[{status}] {rel}:{m['line']} ({m['function']}) `{m['original']}` -> `{m['mutant']}` "
                  f"({rec['secs']}s)", flush=True)


ts = [threading.Thread(target=worker, args=(i,)) for i in range(workers)]
for t in ts:
    t.start()
for t in ts:
    t.join()
print("DONE", flush=True)
