#!/usr/bin/env bash
# Sniper head-to-head: run both launches as real transactions on a local anvil and write results.json.
#   Left pane:  LocalBondingCurve + SniperBot
#   Right pane: the real AuctionEngine (Degen preset) with the mock DEX adapter and locker
# Usage: demo/run.sh            (from anywhere)
set -euo pipefail

export PATH="$HOME/.foundry/bin:$PATH"
DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DEMO_DIR"

PORT="${ANVIL_PORT:-8547}"
RPC="http://127.0.0.1:$PORT"
SCRIPT="script/RunScenario.s.sol:RunScenario"
# One block per transaction, so the curve's block numbers read as arrival order.
ANVIL_ARGS=(--port "$PORT" --silent --order fifo)

for bin in anvil forge cast; do
  command -v "$bin" >/dev/null || { echo "missing $bin — install Foundry (https://getfoundry.sh)"; exit 1; }
done
if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "Port $PORT is already in use. Stop that node or set ANVIL_PORT."; exit 1
fi

anvil "${ANVIL_ARGS[@]}" >anvil.log 2>&1 &
ANVIL_PID=$!
trap 'kill "$ANVIL_PID" 2>/dev/null || true; wait "$ANVIL_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.1
done
cast chain-id --rpc-url "$RPC" >/dev/null || { echo "anvil did not start (see demo/anvil.log)"; exit 1; }

mkdir -p .scenario
rm -f .scenario/state.json

phase() {
  echo "==> $1"
  forge script "$SCRIPT" --sig "$1()" --rpc-url "$RPC" "${@:2}" -q >/dev/null
}
# Commit and reveal windows are 10 minutes each; move anvil's clock past each one.
advance() {
  cast rpc --rpc-url "$RPC" evm_increaseTime "$1" >/dev/null
  cast rpc --rpc-url "$RPC" evm_mine >/dev/null
}

forge build -q
phase launch --broadcast --slow
advance 601
phase reveal --broadcast --slow
advance 601
phase settle --broadcast --slow
phase report

# Stamp how many real transactions produced these numbers (from forge's broadcast receipts), and
# pretty-print. Then a copy the page can load straight from file:// (browsers block fetch() there).
if command -v jq >/dev/null; then
  CHAIN_ID=$(cast chain-id --rpc-url "$RPC")
  B="broadcast/RunScenario.s.sol/$CHAIN_ID"
  TXS=$(jq -s '[.[].receipts[]] | length' "$B/launch-latest.json" "$B/reveal-latest.json" "$B/settle-latest.json")
  OK=$(jq -s '[.[].receipts[] | select(.status == "0x1")] | length' "$B/launch-latest.json" "$B/reveal-latest.json" "$B/settle-latest.json")
  [ "$TXS" = "$OK" ] || { echo "some transactions reverted ($OK of $TXS succeeded)"; exit 1; }
  jq --argjson txs "$TXS" '.meta.transactions = $txs' results.json > results.json.tmp && mv results.json.tmp results.json
fi
{ printf 'window.RESULTS = '; cat results.json; printf ';\n'; } > results.js

if command -v jq >/dev/null; then
  jq -r '
    def mon: (tonumber / 1e18 * 1000 | round) / 1000;
    "",
    "Bonding curve   bot avg \(.curve.bot.avgPrice | mon) MON   crowd avg \(.curve.crowd.avgPrice | mon) MON",
    "Auction         bot paid \(.auction.bot.avgPrice | mon) MON  crowd paid \(.auction.crowd.avgPrice | mon) MON  (clearing \(.auction.clearingPrice | mon))"
  ' results.json
fi

cat <<EOF

Wrote demo/results.json (and results.js). Open the head-to-head:
  open "$DEMO_DIR/index.html"
or serve it:
  python3 -m http.server 8000 --directory "$DEMO_DIR"   then open http://localhost:8000
EOF
