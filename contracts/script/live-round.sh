#!/usr/bin/env bash
# One real Even round on Monad mainnet, start to finish, signed by your Foundry keystore.
#
#   cd contracts && ./script/live-round.sh                       # new round (about 10 minutes)
#   cd contracts && ./script/live-round.sh live-round/<folder>   # resume one that stopped
#
# What it does, as the creator (your keystore) and three throwaway bidders it makes and funds:
#   1. Funds three new bidder wallets with 0.7 MON each from the creator.
#   2. Creates a fixed-supply test token with the TokenFactory, approves the engine, opens a Degen round.
#   3. Each bidder commits a sealed bid with the uniform 0.5 MON deposit.
#   4. After the commit window, each bidder reveals.
#   5. After the reveal window: settle, seed the Uniswap v3 pool at the clearing price (LP locked
#      forever in GoPlus), every bidder claims tokens and refund, the creator withdraws proceeds.
#   6. Bidders send their tokens and leftover MON back to the creator.
# Net cost is about 0.6 MON: 0.12 MON goes into the locked pool, the rest is gas.
#
# The round: 500,000 of 1,000,000 tokens for sale, floor 0.000001 MON per token. Bids (price per token):
#   early 0.000002 × 200,000 · crowd-a 0.0000015 × 250,000 · crowd-b 0.0000012 × 200,000
# Demand (650,000) exceeds supply, so it clears at 0.0000012: everyone pays that, crowd-b is filled
# pro-rata, and the early bidder gets no better price for arriving first.
#
# Monad reserve balance: a wallet under 10 MON may spend MON (tx value) only in its first transaction
# within 3 blocks (docs.monad.xyz/developer-essentials/reserve-balance), so value transfers from one
# wallet are spaced SPACING seconds apart.
#
# Keys: your keystore password is read without echo into a temp file (mode 600) that is deleted on
# exit. The throwaway bidder keys are written to live-round/<folder>/bidders.json (mode 600, git-ignored);
# they hold nothing once the run finishes. Never reuse them.
#
# Env overrides (for a fork rehearsal): RPC, ACCOUNT, SIGNER_KEY (instead of the keystore), ENGINE,
# FACTORY, ADAPTER, COMMIT_SECS, REVEAL_SECS, SPACING, NAME, SYMBOL, SITE.
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."

RPC=${RPC:-https://rpc1.monad.xyz}
ACCOUNT=${ACCOUNT:-parity-deployer}
ENGINE=${ENGINE:-$(jq -r .auctionEngine deployments/143.json)}
FACTORY=${FACTORY:-$(jq -r .tokenFactory deployments/143.json)}
ADAPTER=${ADAPTER:-$(jq -r .uniswapV3Adapter deployments/143-adapter.json)}
COMMIT_SECS=${COMMIT_SECS:-360}
REVEAL_SECS=${REVEAL_SECS:-300}
SPACING=${SPACING:-4}
NAME=${NAME:-Even Test Round}
SYMBOL=${SYMBOL:-EVTEST}
SITE=${SITE:-https://even-monad.vercel.app/web/#/round}
SCAN=https://monadscan.com

SUPPLY=1000000000000000000000000   # 1,000,000 tokens
SELL=500000000000000000000000      # 500,000 for sale
LP_BPS=2000                        # 20% of tokens sold and MON raised seed the pool
DEPOSIT=500000000000000000         # 0.5 MON, the same for every bidder
MIN_BID=10000000000000000          # 0.01 MON
TICK=100000000000                  # 0.0000001 MON per token
RESERVE=1000000000000              # 0.000001 MON per token
FUND=700000000000000000            # 0.7 MON per bidder: deposit + gas
NAMES=(early crowd-a crowd-b)
PRICES=(2000000000000 1500000000000 1200000000000)
AMOUNTS=(200000000000000000000000 250000000000000000000000 200000000000000000000000)

say() { printf '\n\033[1;35m▸ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── State: one folder per round, appended KEY=VALUE lines, so a stopped run resumes ──
if [ $# -ge 1 ]; then STATE_DIR=$1; [ -f "$STATE_DIR/state.env" ] || die "no state in $STATE_DIR"
else STATE_DIR=live-round/$(date +%Y%m%d-%H%M%S); mkdir -p "$STATE_DIR"; : > "$STATE_DIR/state.env"; fi
chmod 700 "$STATE_DIR"
# shellcheck disable=SC1091
. "$STATE_DIR/state.env"
put() { printf '%s=%q\n' "$1" "$2" >> "$STATE_DIR/state.env"; eval "$1=\$2"; }

# ── Creator signer ──
if [ -n "${SIGNER_KEY:-}" ]; then
  CREATOR_ARGS=(--private-key "$SIGNER_KEY")
  CREATOR=$(cast wallet address --private-key "$SIGNER_KEY")
else
  KEYSTORE="$HOME/.foundry/keystores/$ACCOUNT"
  [ -f "$KEYSTORE" ] || die "no keystore $KEYSTORE"
  PWFILE=$(mktemp); chmod 600 "$PWFILE"; trap 'rm -f "$PWFILE"' EXIT
  read -rsp "Keystore password for $ACCOUNT: " PW; echo; printf '%s' "$PW" > "$PWFILE"; unset PW
  CREATOR_ARGS=(--keystore "$KEYSTORE" --password-file "$PWFILE")
  CREATOR=$(cast wallet address "${CREATOR_ARGS[@]}") || die "wrong password?"
fi
echo "Creator $CREATOR · balance $(cast balance "$CREATOR" --rpc-url "$RPC" --ether) MON · state in $STATE_DIR"
[ "$(cast chain-id --rpc-url "$RPC")" = 143 ] || echo "(not chain 143: rehearsal)"

# send <label> <signer args…> -- <cast send args…>: sends, checks status, prints and returns the receipt JSON.
LAST_RECEIPT=""
send() {
  local label=$1; shift; local signer=()
  while [ "$1" != "--" ]; do signer+=("$1"); shift; done; shift
  local out
  out=$(cast send "$@" --rpc-url "$RPC" "${signer[@]}" --json) || die "$label failed"
  [ "$(jq -r .status <<<"$out")" = 0x1 ] || die "$label reverted: $(jq -r .transactionHash <<<"$out")"
  printf '  %-28s %s/tx/%s\n' "$label" "$SCAN" "$(jq -r .transactionHash <<<"$out")"
  LAST_RECEIPT=$out
}
topic1() { jq -r --arg a "$(tr 'A-F' 'a-f' <<<"$1")" '[.logs[] | select((.address|ascii_downcase)==$a)][0].topics[1]' <<<"$LAST_RECEIPT"; }
now() { cast block latest -f timestamp --rpc-url "$RPC"; }
wait_until() {
  local t=$1 what=$2 n
  while n=$(now); [ "$n" -lt "$t" ]; do printf '\r  waiting for %s: %3ss ' "$what" $((t - n)); sleep 5; done; printf '\r  %s reached.            \n' "$what"
}

# ── 1. Bidder wallets ──
if [ ! -f "$STATE_DIR/bidders.json" ]; then
  say "Making three throwaway bidder wallets"
  ( umask 077; for _ in 1 2 3; do cast wallet new --json | jq -c '.data[0] | {address, private_key}'; done | jq -s . > "$STATE_DIR/bidders.json" )
fi
ADDR=(); KEY=()
for i in 0 1 2; do
  ADDR+=("$(jq -r ".[$i].address" "$STATE_DIR/bidders.json")"); KEY+=("$(jq -r ".[$i].private_key" "$STATE_DIR/bidders.json")")
  echo "  ${NAMES[$i]} ${ADDR[$i]}"
done

if [ -z "${FUNDED:-}" ]; then
  say "Funding each bidder with 0.7 MON"
  for i in 0 1 2; do
    if [ "$(cast balance "${ADDR[$i]}" --rpc-url "$RPC")" -lt "$FUND" ]; then
      sleep "$SPACING"; send "fund ${NAMES[$i]}" "${CREATOR_ARGS[@]}" -- "${ADDR[$i]}" --value "$FUND"
    fi
  done
  put FUNDED 1
fi

# ── 2. Token and round ──
if [ -z "${TOKEN:-}" ]; then
  say "Creating the token"
  send "create $SYMBOL" "${CREATOR_ARGS[@]}" -- "$FACTORY" "create(string,string,uint256)" "$NAME" "$SYMBOL" "$SUPPLY"
  put TOKEN "0x$(topic1 "$FACTORY" | tail -c 41)"
  echo "  token $TOKEN"
fi
if [ -z "${ROUND:-}" ]; then
  say "Approving the engine and opening the round"
  send "approve" "${CREATOR_ARGS[@]}" -- "$TOKEN" "approve(address,uint256)" "$ENGINE" "$(cast max-uint)"
  START=$(now); COMMIT_END=$((START + COMMIT_SECS)); REVEAL_END=$((COMMIT_END + REVEAL_SECS))
  send "openRound" "${CREATOR_ARGS[@]}" -- "$ENGINE" \
    "openRound((uint8,address,uint128,uint96,uint96,uint96,uint96,uint64,uint64,bytes32,string,uint16,(address,uint16,uint24)[],uint64,string,uint16,uint64,uint64))" \
    "(0,$TOKEN,$SELL,$DEPOSIT,$MIN_BID,$TICK,$RESERVE,$COMMIT_END,$REVEAL_END,0x0000000000000000000000000000000000000000000000000000000000000000,\"\",$LP_BPS,[($ADAPTER,10000,3000)],0,DEFAULT,0,0,0)"
  put ROUND "$(cast to-dec "$(topic1 "$ENGINE")")"
  put COMMIT_END "$COMMIT_END"; put REVEAL_END "$REVEAL_END"
  echo "  round $ROUND · $SITE/$ROUND"
fi

# ── 3. Sealed bids ──
for i in 0 1 2; do
  v="COMMITTED_$i"; [ -n "${!v:-}" ] && continue
  [ "$(now)" -lt "$COMMIT_END" ] || die "commit window closed before ${NAMES[$i]} bid"
  s="SALT_$i"; [ -n "${!s:-}" ] || put "SALT_$i" "0x$(openssl rand -hex 32)"
  salt=${!s}
  hash=$(cast keccak "$(cast abi-encode "f(uint96,uint96,bytes32,address)" "${PRICES[$i]}" "${AMOUNTS[$i]}" "$salt" "${ADDR[$i]}")")
  [ "$i" = 0 ] && say "Sealed bids (nobody can read a price until reveal)"
  send "commit ${NAMES[$i]}" --private-key "${KEY[$i]}" -- "$ENGINE" "commit(uint256,bytes32,bytes32[],bytes)" "$ROUND" "$hash" "[]" 0x --value "$DEPOSIT"
  put "COMMITTED_$i" 1
done

# ── 4. Reveal ──
say "Bidding closes, then the reveal window opens"
wait_until "$COMMIT_END" "end of bidding"
for i in 0 1 2; do
  v="REVEALED_$i"; [ -n "${!v:-}" ] && continue
  s="SALT_$i"
  send "reveal ${NAMES[$i]}" --private-key "${KEY[$i]}" -- "$ENGINE" "reveal(uint256,uint96,uint96,bytes32)" "$ROUND" "${PRICES[$i]}" "${AMOUNTS[$i]}" "${!s}"
  put "REVEALED_$i" 1
done

# ── 5. Settle, seed, claim ──
say "Reveal window closes, then settle"
wait_until "$REVEAL_END" "end of reveals"
if [ -z "${SETTLED:-}" ]; then
  send "settle" "${CREATOR_ARGS[@]}" -- "$ENGINE" "settle(uint256,uint256)" "$ROUND" 100
  put SETTLED 1
fi
if [ -z "${SEEDED:-}" ]; then
  send "seedLP (Uniswap + GoPlus)" "${CREATOR_ARGS[@]}" -- "$ENGINE" "seedLP(uint256)" "$ROUND"
  put SEED_TX "$(jq -r .transactionHash <<<"$LAST_RECEIPT")"; put SEEDED 1
fi
for i in 0 1 2; do
  v="CLAIMED_$i"; [ -n "${!v:-}" ] && continue
  send "claim ${NAMES[$i]}" --private-key "${KEY[$i]}" -- "$ENGINE" "claim(uint256)" "$ROUND"
  put "CLAIMED_$i" 1
done
if [ -z "${WITHDRAWN:-}" ]; then
  send "withdrawProceeds" "${CREATOR_ARGS[@]}" -- "$ENGINE" "withdrawProceeds(uint256)" "$ROUND"
  put WITHDRAWN 1
fi

# ── 6. Return tokens and MON to the creator ──
say "Bidders return tokens and leftover MON to the creator"
GP=$(cast gas-price --rpc-url "$RPC")
for i in 0 1 2; do
  v="SWEPT_$i"; [ -n "${!v:-}" ] && continue
  bal=$(cast call "$TOKEN" "balanceOf(address)(uint256)" "${ADDR[$i]}" --rpc-url "$RPC" | awk '{print $1}')
  [ "$bal" != 0 ] && send "tokens ${NAMES[$i]} → creator" --private-key "${KEY[$i]}" -- "$TOKEN" "transfer(address,uint256)" "$CREATOR" "$bal"
  sleep "$SPACING"
  # Monad charges the whole gas limit, so the limit is fixed up front and the rest is sent.
  gl=$(cast estimate "$CREATOR" --value 1 --from "${ADDR[$i]}" --rpc-url "$RPC")
  mon=$(cast balance "${ADDR[$i]}" --rpc-url "$RPC"); fee=$((gl * GP))
  if [ "$(echo "$mon > $fee" | bc)" = 1 ]; then
    send "MON ${NAMES[$i]} → creator" --private-key "${KEY[$i]}" -- "$CREATOR" --value "$(echo "$mon - $fee" | bc)" --gas-limit "$gl" --gas-price "$GP" --legacy
  fi
  put "SWEPT_$i" 1
done

# ── Summary ──
{
  echo "# Even live round $ROUND"
  echo
  echo "- Round page: $SITE/$ROUND"
  echo "- Token: $SCAN/address/$TOKEN ($NAME, $SYMBOL)"
  echo "- Seed and lock tx: $SCAN/tx/$SEED_TX"
  echo "- Creator: $SCAN/address/$CREATOR"
  echo "- Engine: $SCAN/address/$ENGINE"
} > "$STATE_DIR/summary.md"
say "Done"
cat "$STATE_DIR/summary.md"
echo "Creator balance now $(cast balance "$CREATOR" --rpc-url "$RPC" --ether) MON"
