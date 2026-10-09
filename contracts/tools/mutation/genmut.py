#!/usr/bin/env python3
"""Generate source-level mutants for one Solidity file from its solc AST.

Operators follow forge 1.8.3's mutator (binary-operator replacement, require-condition, assignment
and initializer literal, unary-operator removal), with one reduction: an arithmetic operator is
replaced by the other four arithmetic operators (+ - * / %) only, not by the bitwise, shift or power
operators forge also tries. Comparison operators are replaced by each of the other five.

usage: genmut.py <project-dir> <src/File.sol> <out.json>
"""
import json, os, subprocess, sys

proj, rel, out = sys.argv[1], sys.argv[2], sys.argv[3]
SOLC = os.environ.get("SOLC") or next(
    (p for p in (os.path.expanduser("~/Library/Application Support/svm/0.8.34/solc-0.8.34"),
                 os.path.expanduser("~/.svm/0.8.34/solc-0.8.34")) if os.path.exists(p)), "solc")
res = subprocess.run([SOLC, "--ast-compact-json", rel], cwd=proj, capture_output=True,
                     text=True)
txt = res.stdout
start = txt.index("{")
ast = json.loads(txt[start:txt.rindex("}") + 1]) if txt.count("======") <= 1 else None
if ast is None:  # several sources: take ours
    parts = txt.split("======= ")
    for p in parts:
        if p.startswith(rel + " ======="):
            ast = json.loads(p[p.index("{"):p.rindex("}") + 1])
src = open(os.path.join(proj, rel), "rb").read()

ARITH = ["+", "-", "*", "/", "%"]
CMP = ["<", "<=", ">", ">=", "==", "!="]
LOGIC = ["&&", "||"]
mutants = []


def span(n):
    s, l, _ = map(int, n["src"].split(":"))
    return s, s + l


def line_of(off):
    return src[:off].count(b"\n") + 1


def add(lo, hi, new, kind, fn):
    orig = src[lo:hi].decode()
    if orig == new:
        return
    mutants.append(dict(lo=lo, hi=hi, original=orig, mutant=new, kind=kind, line=line_of(lo), function=fn))


def zero_for(n):
    """Literal to substitute for expression n: "0" for integers, None for bools, False to skip."""
    t = (n.get("typeDescriptions") or {}).get("typeString", "")
    if t == "bool":
        return None
    if t.startswith("uint") or t.startswith("int") or t.startswith("int_const") or t.startswith("rational"):
        return "0"
    return False


def walk(n, fn):
    if isinstance(n, list):
        for x in n:
            walk(x, fn)
        return
    if not isinstance(n, dict):
        return
    nt = n.get("nodeType")
    if nt in ("FunctionDefinition", "ModifierDefinition"):
        fn = n.get("name") or n.get("kind")
    if nt == "BinaryOperation":
        op = n["operator"]
        l_lo, l_hi = span(n["leftExpression"])
        r_lo, r_hi = span(n["rightExpression"])
        lo, hi = span(n)
        left = src[l_lo:l_hi].decode()
        right = src[r_lo:r_hi].decode()
        alts = ARITH if op in ARITH else CMP if op in CMP else LOGIC if op in LOGIC else []
        for a in alts:
            if a != op:
                add(lo, hi, f"{left} {a} {right}", "BinaryOp", fn)
    elif nt == "Assignment":
        op = n["operator"]
        r = n["rightHandSide"]
        lo, hi = span(r)
        z = zero_for(r)
        rtxt = src[lo:hi].decode()
        if z is False:
            pass
        elif z is not None and rtxt != "0":
            add(lo, hi, z, "AssignmentLiteral", fn)
        elif z is None:
            if rtxt == "true":
                add(lo, hi, "false", "AssignmentLiteral", fn)
            elif rtxt == "false":
                add(lo, hi, "true", "AssignmentLiteral", fn)
            else:
                add(lo, hi, "false", "AssignmentLiteral", fn)
                add(lo, hi, "true", "AssignmentLiteral", fn)
        if op in ("+=", "-="):
            alo, ahi = span(n)
            lhs_lo, lhs_hi = span(n["leftHandSide"])
            other = "-=" if op == "+=" else "+="
            add(alo, ahi, f"{src[lhs_lo:lhs_hi].decode()} {other} {rtxt}", "CompoundOp", fn)
    elif nt == "VariableDeclarationStatement" and n.get("initialValue") and fn is not None:
        iv = n["initialValue"]
        lo, hi = span(iv)
        z = zero_for(iv)
        if z and src[lo:hi].decode() != "0":
            add(lo, hi, z, "InitializerLiteral", fn)
    elif nt == "UnaryOperation" and n["operator"] == "!":
        lo, hi = span(n)
        s_lo, s_hi = span(n["subExpression"])
        add(lo, hi, src[s_lo:s_hi].decode(), "UnaryNot", fn)
    elif nt == "FunctionCall":
        e = n.get("expression", {})
        if e.get("nodeType") == "Identifier" and e.get("name") == "require" and n.get("arguments"):
            c = n["arguments"][0]
            lo, hi = span(c)
            add(lo, hi, "true", "RequireTrue", fn)
            add(lo, hi, f"!({src[lo:hi].decode()})", "RequireNegated", fn)
    for k, v in n.items():
        if isinstance(v, (dict, list)):
            walk(v, fn)


walk(ast, None)
# de-duplicate identical (span, text) pairs
seen, uniq = set(), []
for m in mutants:
    k = (m["lo"], m["hi"], m["mutant"])
    if k not in seen:
        seen.add(k)
        uniq.append(m)
uniq.sort(key=lambda m: (m["lo"], m["mutant"]))
for i, m in enumerate(uniq):
    m["idx"] = i
    m["file"] = rel
json.dump(uniq, open(out, "w"), indent=0)
from collections import Counter
print(rel, len(uniq), dict(Counter(m["kind"] for m in uniq)))
