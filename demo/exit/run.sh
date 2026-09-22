#!/usr/bin/env bash
# Plays the Exit-Priority bank run on a throwaway anvil and writes demo/exit/results.json (+ results.js).
# Every number comes from ExitAuction + DemoVault state, read by contracts/script/ExitDemo.s.sol.
# Usage: demo/exit/run.sh            (ROUNDS=8 PORT=8547 by default)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CONTRACTS="$HERE/../../contracts"
PORT="${PORT:-8547}"
RPC="http://127.0.0.1:$PORT"
ROUNDS="${ROUNDS:-8}"
COMMIT_SECONDS=600 # ExitAuction commitDuration in DeployExit.defaultConfig
REVEAL_SECONDS=600 # revealDuration
GAP_BLOCKS=5       # roundGapBlocks
export PATH="$HOME/.foundry/bin:$PATH"

anvil --port "$PORT" --accounts 13 --balance 100000 --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.2
done

cd "$CONTRACTS"
rm -rf deployments/exit-demo

LOG="$(mktemp)"
phase() {
  echo "  $*"
  if ! forge script script/ExitDemo.s.sol:ExitDemo --rpc-url "$RPC" --broadcast --slow --sig "$@" >"$LOG" 2>&1; then
    cat "$LOG"
    exit 1
  fi
}

advance() {
  cast rpc evm_increaseTime "$1" --rpc-url "$RPC" >/dev/null
  cast rpc evm_mine --rpc-url "$RPC" >/dev/null
}

phase "bootstrap()"
for k in $(seq 1 "$ROUNDS"); do
  echo "round $k"
  if [ "$k" -gt 1 ]; then cast rpc anvil_mine "$GAP_BLOCKS" --rpc-url "$RPC" >/dev/null; fi
  phase "open(uint256)" "$k"
  advance "$COMMIT_SECONDS"
  phase "reveal(uint256)" "$k"
  advance "$REVEAL_SECONDS"
  phase "settle(uint256)" "$k"
  phase "claim(uint256)" "$k"
  phase "snapshot(uint256)" "$k"
done
phase "report(uint256)" "$ROUNDS"

cp deployments/exit-demo/results.json "$HERE/results.json"
{
  printf 'window.EXIT_RESULTS = '
  cat "$HERE/results.json"
  printf ';\n'
} >"$HERE/results.js"
rm -rf deployments/exit-demo deployments/exit-local.json
echo "wrote $HERE/results.json"
