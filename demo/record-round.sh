#!/usr/bin/env bash
# Set up a local Even round for a screen recording, then walk it stage by stage.
#   demo/record-round.sh            (from anywhere; press Enter to move to the next stage)
#   NOWAIT=1 demo/record-round.sh   (runs every stage without pausing, as a smoke test)
#
# What it does:
#   1. Starts anvil on 8545 (the port the page and its dev wallet use) and deploys DeployLocal.
#   2. Serves the repo root on WEB_PORT (default 8765), so the page at /web/ finds the fresh local.json.
#   3. As anvil account 1 (the creator): creates a token with the TokenFactory and opens a Degen round.
#   4. Anvil accounts 3–6 commit sealed bids. Accounts 1 and 2 and a passkey account are left for the
#      browser, so the video shows a real bid being sealed, revealed and claimed in the page.
#   5. At each Enter, moves anvil's clock past the next window and prints the URLs for that stage:
#      bidding → reveal (the script reveals its own four bids) → settle, seed and claim → wrap-up
#      (the script settles, seeds and claims whatever the browser left undone).
# Bids from this script carry no recovery note, so only the script can reveal them; bid in the
# browser from account 2 or a passkey account. Every transaction is signed by anvil for its own
# unlocked test accounts (cast send --unlocked); the script holds no keys.
#
# The round: 500,000 of 1,000,000 tokens for sale, floor 0.00001 MON per token, deposit 10 MON.
# Scripted bids (price per token × tokens): 0.00004, 0.00003, 0.000025 and 0.00002, each × 150,000.
# Demand (600,000) exceeds supply, so without browser bids it clears at 0.00002: everyone pays that,
# the lowest bidder is filled pro-rata, and the earliest, highest bid gets no better price.
#
# Env: WEB_PORT, COMMIT_SECS (default 900), REVEAL_SECS (default 900), PASSKEY_ADDR (an address to
# fund with 100 MON, e.g. the one the page shows after a ?passkeytest= sign-in), NOWAIT.
set -euo pipefail

export PATH="$HOME/.foundry/bin:$PATH"
DEMO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DEMO_DIR/.." && pwd)"
cd "$ROOT/contracts"

RPC="http://127.0.0.1:8545"
WEB_PORT="${WEB_PORT:-8765}"
COMMIT_SECS="${COMMIT_SECS:-900}"
REVEAL_SECS="${REVEAL_SECS:-900}"
NOWAIT="${NOWAIT:-}"
SITE="http://127.0.0.1:$WEB_PORT/web/"

SUPPLY=1000000000000000000000000   # 1,000,000 tokens
SELL=500000000000000000000000      # 500,000 for sale
LP_BPS=2000                        # 20% of tokens sold and MON raised seed the pool
DEPOSIT=10000000000000000000       # 10 MON, the same for every bidder
MIN_BID=10000000000000000          # 0.01 MON
TICK=1000000000000                 # 0.000001 MON per token
RESERVE=10000000000000             # 0.00001 MON per token
NAMES=(early crowd-a crowd-b crowd-c)
SLOTS=(3 4 5 6)                    # anvil account numbers of the scripted bidders
PRICES=(40000000000000 30000000000000 25000000000000 20000000000000)
AMOUNT=150000000000000000000000    # 150,000 tokens each

say() { printf '\n\033[1;35m▸ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
pause() { [ -n "$NOWAIT" ] && return; printf '\n\033[2mPress Enter for: %s\033[0m ' "$1"; read -r _; }

for bin in anvil forge cast jq python3; do
  command -v "$bin" >/dev/null || die "missing $bin"
done
cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && die "Port 8545 is already in use. Stop that node first."

PIDS=()
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; done; }
trap cleanup EXIT

anvil --port 8545 --order fifo --silent >"$DEMO_DIR/anvil.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 1 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.1; done
cast chain-id --rpc-url "$RPC" >/dev/null || die "anvil did not start (see demo/anvil.log)"

if curl -s -o /dev/null "http://127.0.0.1:$WEB_PORT/" 2>/dev/null; then
  echo "Port $WEB_PORT already serves something; assuming it is this repo's root."
else
  (cd "$ROOT" && exec python3 -m http.server "$WEB_PORT" --bind 127.0.0.1 >/dev/null 2>&1) &
  PIDS+=($!)
fi

say "Deploying the local stack"
forge script script/DeployLocal.s.sol --rpc-url "$RPC" --broadcast -q >/dev/null
ENGINE=$(jq -r .auctionEngine deployments/local.json)
FACTORY=$(jq -r .tokenFactory deployments/local.json)
ADAPTER=$(jq -r .adapter deployments/local.json)
ACCTS=()
while IFS= read -r a; do ACCTS+=("$a"); done < <(cast rpc eth_accounts --rpc-url "$RPC" | jq -r '.[]')
CREATOR=${ACCTS[1]}
echo "  engine $ENGINE · creator (account 1) $CREATOR"

# send <label> <from> <cast send args…>: anvil signs for its own account; checks the status.
LAST_RECEIPT=""
send() {
  local label=$1 from=$2; shift 2
  local out
  out=$(cast send "$@" --from "$from" --unlocked --rpc-url "$RPC" --json) || die "$label failed"
  [ "$(jq -r .status <<<"$out")" = 0x1 ] || die "$label reverted"
  printf '  %-26s %s\n' "$label" "$(jq -r .transactionHash <<<"$out")"
  LAST_RECEIPT=$out
}
# try_send: only sends when a dry run succeeds, so steps the browser already did are skipped.
try_send() {
  local label=$1 from=$2; shift 2
  if cast call "$@" --from "$from" --rpc-url "$RPC" >/dev/null 2>&1; then send "$label" "$from" "$@"
  else printf '  %-26s already done in the browser\n' "$label"; fi
}
topic1() { jq -r --arg a "$(tr 'A-F' 'a-f' <<<"$1")" '[.logs[] | select((.address|ascii_downcase)==$a)][0].topics[1]' <<<"$LAST_RECEIPT"; }
now() { cast block latest -f timestamp --rpc-url "$RPC"; }
advance_to() {
  local gap=$(( $1 - $(now) + 1 ))
  [ "$gap" -gt 0 ] && cast rpc evm_increaseTime "$gap" --rpc-url "$RPC" >/dev/null
  cast rpc evm_mine --rpc-url "$RPC" >/dev/null
}
url() { printf '    %-34s %s?%s#/round/%s\n' "$1" "$SITE" "$2" "$ROUND"; }

say "Creating the token and opening a Degen round"
send "create DEMO" "$CREATOR" "$FACTORY" "create(string,string,uint256)" "Even Demo" "DEMO" "$SUPPLY"
TOKEN="0x$(topic1 "$FACTORY" | tail -c 41)"
send "approve" "$CREATOR" "$TOKEN" "approve(address,uint256)" "$ENGINE" "$(cast max-uint)"
START=$(now); COMMIT_END=$((START + COMMIT_SECS)); REVEAL_END=$((COMMIT_END + REVEAL_SECS))
send "openRound" "$CREATOR" "$ENGINE" \
  "openRound((uint8,address,uint128,uint96,uint96,uint96,uint96,uint64,uint64,bytes32,string,uint16,(address,uint16,uint24)[],uint64,string,uint16,uint64,uint64))" \
  "(0,$TOKEN,$SELL,$DEPOSIT,$MIN_BID,$TICK,$RESERVE,$COMMIT_END,$REVEAL_END,0x0000000000000000000000000000000000000000000000000000000000000000,\"\",$LP_BPS,[($ADAPTER,10000,3000)],0,DEFAULT,0,0,0)"
ROUND=$(cast to-dec "$(topic1 "$ENGINE")")
echo "  token $TOKEN · round $ROUND"

say "Four sealed bids from anvil accounts 3–6"
SALTS=()
for i in 0 1 2 3; do
  bidder=${ACCTS[${SLOTS[$i]}]}
  SALTS+=("0x$(openssl rand -hex 32)")
  hash=$(cast keccak "$(cast abi-encode "f(uint96,uint96,bytes32,address)" "${PRICES[$i]}" "$AMOUNT" "${SALTS[$i]}" "$bidder")")
  send "commit ${NAMES[$i]}" "$bidder" "$ENGINE" "commit(uint256,bytes32,bytes32[],bytes)" "$ROUND" "$hash" "[]" 0x --value "$DEPOSIT"
done
if [ -n "${PASSKEY_ADDR:-}" ]; then
  cast rpc anvil_setBalance "$PASSKEY_ADDR" 0x56bc75e2d63100000 --rpc-url "$RPC" >/dev/null   # 100 MON
  echo "  funded passkey account $PASSKEY_ADDR with 100 MON"
fi

say "Stage 1 · bidding open ($((COMMIT_SECS / 60)) min of chain time; the script moves the clock for you)"
url "creator (account 1)" "devwallet=1"
url "bidder (account 2)" "devwallet=2"
url "passkey bidder (test seed 1)" "passkeytest=1"
echo "    Fund the passkey account once the page shows its address:"
echo "      cast rpc anvil_setBalance <address> 0x56bc75e2d63100000 --rpc-url $RPC"
pause "close bidding and reveal the scripted bids"

say "Stage 2 · reveal window"
advance_to "$COMMIT_END"
for i in 0 1 2 3; do
  send "reveal ${NAMES[$i]}" "${ACCTS[${SLOTS[$i]}]}" "$ENGINE" "reveal(uint256,uint96,uint96,bytes32)" "$ROUND" "${PRICES[$i]}" "$AMOUNT" "${SALTS[$i]}"
done
url "reveal as account 2" "devwallet=2"
url "reveal as the passkey bidder" "passkeytest=1"
pause "close reveals"

say "Stage 3 · settle, seed the pool, claim"
advance_to "$REVEAL_END"
url "creator settles and seeds" "devwallet=1"
url "account 2 claims" "devwallet=2"
url "passkey bidder claims" "passkeytest=1"
pause "let the script finish whatever the browser left (settle, seed, claims, proceeds)"

say "Stage 4 · wrap-up"
try_send "settle" "$CREATOR" "$ENGINE" "settle(uint256,uint256)" "$ROUND" 100
try_send "seedLP" "$CREATOR" "$ENGINE" "seedLP(uint256)" "$ROUND"
for i in 0 1 2 3; do
  try_send "claim ${NAMES[$i]}" "${ACCTS[${SLOTS[$i]}]}" "$ENGINE" "claim(uint256)" "$ROUND"
done
try_send "withdrawProceeds" "$CREATOR" "$ENGINE" "withdrawProceeds(uint256)" "$ROUND"
read -r settled price sold _ < <(cast call "$ENGINE" "clearingOf(uint256)(bool,uint256,uint256,uint256,bool,uint256,uint256)" "$ROUND" --rpc-url "$RPC" | awk '{printf "%s ", $1} END {print ""}')
[ "$settled" = true ] || die "round $ROUND did not settle"
echo "  cleared at $(cast from-wei "$price") MON per token · $(cast from-wei "$sold") tokens sold"
url "results" "devwallet=1"
pause "stop anvil and the web server"
