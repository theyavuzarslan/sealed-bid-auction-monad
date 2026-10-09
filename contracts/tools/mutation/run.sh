#!/bin/bash
# Mutation testing of the money path (reports/mutation-summary.md).
# usage, from contracts/: tools/mutation/run.sh <workdir> [workers]
#   Copies contracts/ into <workdir>/project, compiles it once, generates the mutants of each file and runs
#   them; results land in <workdir>/<File>.jsonl. Re-running resumes where it stopped.
set -e
here="$(cd "$(dirname "$0")" && pwd)"; root="$(cd "$here/../.." && pwd)"
work="$1"; workers="${2:-8}"
mkdir -p "$work/lists"
rsync -a --exclude out --exclude cache --exclude reports --exclude test/symbolic "$root/" "$work/project/"
(cd "$work/project" && forge build --offline > /dev/null)
export MUT_EXTRA="test/UniformClearing.t.sol,test/ClearingEdgeCases.t.sol,test/DepositLedger.t.sol"
for f in src/DepositLedger.sol src/SealingLayer.sol src/UniformClearing.sol src/AuctionEngine.sol src/exit/ExitAuction.sol; do
  n=$(basename "$f" .sol)
  python3 "$here/genmut.py" "$work/project" "$f" "$work/lists/$n.json"
  python3 "$here/mutdriver.py" "$work/project" "$work/lists/$n.json" "$work/$n.jsonl" "$workers"
done
