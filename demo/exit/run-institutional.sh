#!/usr/bin/env bash
# Plays the institutional-vault exit round on a throwaway anvil and writes
# demo/exit/institutional.json (+ institutional.js for file:// viewing).
# Every auction number comes from ExitAuction + DemoVault state, read by demo/script/InstitutionalExit.s.sol;
# the FIFO comparison is a model over the same buffer, computed by the same script.
# Usage: demo/exit/run-institutional.sh        (PORT=8551 by default)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEMO="$HERE/.."
PORT="${PORT:-8551}"
RPC="http://127.0.0.1:$PORT"
COMMIT_SECONDS=600 # InstitutionalExit.config commitDuration
REVEAL_SECONDS=600 # revealDuration
export PATH="$HOME/.foundry/bin:$PATH"

if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "Port $PORT is already in use. Stop that node or set PORT."; exit 1
fi
# 11 accounts: 0 deployer/strategist, 1..9 the vault's LPs, 10 an outsider (not on the allowlist).
anvil --port "$PORT" --accounts 11 --balance 1000000 --silent &
ANVIL_PID=$!
trap 'kill $ANVIL_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.2
done

cd "$DEMO"
rm -rf .scenario/inst
LOG="$(mktemp)"
phase() {
  echo "  $1"
  if ! forge script script/InstitutionalExit.s.sol:InstitutionalExit --rpc-url "$RPC" --broadcast --slow --sig "$1" >"$LOG" 2>&1; then
    cat "$LOG"
    exit 1
  fi
}
advance() {
  cast rpc evm_increaseTime "$1" --rpc-url "$RPC" >/dev/null
  cast rpc evm_mine --rpc-url "$RPC" >/dev/null
}

phase "bootstrap()"
advance "$COMMIT_SECONDS"
phase "reveal()"
advance "$REVEAL_SECONDS"
phase "settle()"

cp .scenario/inst/institutional.json "$HERE/institutional.json"
{
  printf 'window.EXIT_INSTITUTIONAL = '
  cat "$HERE/institutional.json"
  printf ';\n'
} >"$HERE/institutional.js"
rm -rf .scenario/inst
echo "wrote $HERE/institutional.json"
