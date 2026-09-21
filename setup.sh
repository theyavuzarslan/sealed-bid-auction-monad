#!/usr/bin/env bash
# Zero-to-agents scaffold for the Sealed-Bid Auction Engine.
# Idempotent: safe to run more than once.
set -euo pipefail

ROOT="/Users/0xatakan/Claude Code/Sealed Bid Auction on Monad"
WT="/Users/0xatakan/Claude Code/sba-agents"
cd "$ROOT"

echo "==> 1. checking prerequisites"
command -v forge >/dev/null || {
  echo "MISSING: foundry. Run this first, then re-run setup.sh:"
  echo '  curl -L https://foundry.paradigm.xyz | bash && foundryup'
  exit 1
}
command -v herdr >/dev/null || { echo "MISSING: herdr"; exit 1; }
echo "    forge $(forge --version | head -1 | awk '{print $2}')  herdr ok"

echo "==> 2. git repo"
if [ ! -d .git ]; then
  git init -q
  cat > .gitignore <<'EOF'
node_modules/
out/
cache/
broadcast/
.env
*.log
sealed-bid-auction-docs.zip
EOF
  git add -A && git commit -qm "Docs, agent brief, setup script"
  echo "    initialised"
else
  echo "    already a repo"
fi

echo "==> 3. contract scaffold"
if [ ! -f contracts/foundry.toml ]; then
  mkdir -p contracts && (cd contracts && forge init --no-git --no-commit . >/dev/null 2>&1 || true)
  rm -f contracts/src/Counter.sol contracts/test/Counter.t.sol contracts/script/Counter.s.sol
  echo "    forge project created"
else
  echo "    contracts/ exists"
fi

echo "==> 4. vendor EasyAuction reference (read-only)"
if [ ! -d vendor/easyauction ]; then
  mkdir -p vendor
  git clone -q --depth 1 https://github.com/Gnosis-Auction/auction-contracts vendor/easyauction
  rm -rf vendor/easyauction/.git
  echo "    cloned (LGPL-3.0 — keep the licence header on any forked file)"
else
  echo "    vendor/easyauction exists"
fi

echo "==> 5. placeholder source files"
mkdir -p contracts/src contracts/test contracts/script web indexer demo tasks
for f in SealingLayer ClearingCore DepositLedger LPSeeder ExitAdapter; do
  [ -f "contracts/src/$f.sol" ] || printf '// SPDX-License-Identifier: LGPL-3.0\npragma solidity ^0.8.24;\n\n// TODO: see AGENTS.md and 06-api.md\ncontract %s {}\n' "$f" > "contracts/src/$f.sol"
done

echo "==> 6. agent task briefs"
write_task () { # $1 = name, $2 = body
  cat > "tasks/$1.md" <<EOF
# Task: $1

Read \`AGENTS.md\` and \`README.md\` first. They are the contract for this repo.

$2

## Rules
- Work ONLY in the paths listed above. Do not touch the 13 numbered .md files.
- If something is unspecified, make it a constructor parameter and name it in your final message. Do not guess.
- When done: run \`forge build\` (and \`forge test\` if you added tests), then summarise what you changed in 5 lines.
EOF
}

write_task core "## Scope
\`contracts/src/SealingLayer.sol\`, \`contracts/src/DepositLedger.sol\`

Implement commit/reveal and the deposit ledger per \`04-flows.md\` (Flows 2–3) and \`06-api.md\`.

- Preimage is exactly \`keccak256(abi.encode(price, quantity, salt, msg.sender))\`. All four fields.
- Deposits are a uniform capped amount, identical for every bidder. Reject any other value.
- Ledger invariant, assert it in tests: \`locked == appliedToFill + refunded + slashed\`.
- Slash destination is a constructor parameter. Do not pick one.
- This is money-path code. Small diffs, no cleverness, no unchecked blocks."

write_task fork "## Scope
\`vendor/easyauction/\` (read) → \`contracts/src/ClearingCore.sol\` (write)

Port EasyAuction's clearing loop. You have the context window to hold the whole contract — use it.

- Keep the logic identical: price ordering, volume accumulation to the sell amount, the crossing bid sets the uniform price, partial fill at the marginal bid, multi-transaction settlement.
- Keep the mandatory minimum bid size. It is the gas-DoS defence, not an option.
- Keep the LGPL-3.0 header.
- Write down every place the marginal-bid arithmetic could be off by one, as comments. That is the single highest-risk line in this repo."

write_task settle "## Scope
\`contracts/test/\` — tests only, no source edits

Write Foundry tests against the eight bugs in \`AGENTS.md\`, prioritising 3, 4 and 8:
- slashing accounting strands no funds (fuzz the ledger invariant)
- marginal bid: over-allocation is insolvency, under-allocation strands tokens — test both directions at the boundary
- \`price * quantity\` truncation must never favour the bidder in aggregate
- reentrancy on claim and refund
- dust-commit spam cannot push settlement past the block gas limit"

write_task ui "## Scope
\`web/\`

Build the bidder and creator screens from \`08-ui-notes.md\`. Screens 1, 2, 3.

- The salt is generated client-side and must survive a page reload. Offer a download-backup.
- Show commitment COUNT and timing (intentionally public). Never show revealed prices before clearing.
- Copy the wording table in \`AGENTS.md\` exactly. Writing \"no sniping\" anywhere is a bug."

write_task scripts "## Scope
\`contracts/script/\`, \`indexer/\`

Deploy scripts for Monad testnet, plus an event indexer that decodes RoundOpened, Committed, Revealed, Cleared, Claimed, Slashed, LPSeeded (see \`06-api.md\`).

Also: a fee probe that measures commit + reveal + claim for one bidder and prints the total. The target is under \$0.01."

write_task demo "## Scope
\`demo/\`

The sniper head-to-head from \`04-flows.md\` Flow 6 and \`08-ui-notes.md\` Screen 4.

- A local bonding curve, the auction, and one bot that attacks both.
- Two panes side by side. On the curve the bot takes the first blocks; on the auction it gets the clearing price like everyone else.
- Twenty seconds, no narration. This is the pitch — it matters more than the code behind it."

echo "    6 briefs in tasks/"

echo "==> 7. git worktrees (one per agent)"
git add -A >/dev/null 2>&1 || true
git diff --cached --quiet || git commit -qm "Scaffold: contracts, vendor, task briefs"
mkdir -p "$WT"
for a in core fork settle ui scripts demo; do
  if [ ! -d "$WT/$a" ]; then
    git worktree add -q -b "agent/$a" "$WT/$a" 2>/dev/null && echo "    $a -> $WT/$a"
  else
    echo "    $a exists"
  fi
done

echo
echo "Done. Next: read RUNBOOK.md"
