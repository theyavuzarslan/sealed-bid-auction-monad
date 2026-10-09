#!/usr/bin/env bash
# A real sealed-bid vault exit on Monad mainnet, start to finish, signed by your Foundry keystore.
#
#   cd contracts && ./script/live-exit.sh                       # deploy the reference vault, run the exit rounds
#   cd contracts && ./script/live-exit.sh live-exit/<folder>    # resume one that stopped
#
# What it does, as the strategist (your keystore) and four throwaway (burner) LP wallets it makes and funds:
#   1. Deploys DemoVault (ERC-4626 over real WMON) and an ExitAuction whose allowlist is the four LPs
#      (DeployExitMainnet.s.sol). The vault's strategy is simulated: its WMON never leaves the contract.
#   2. Each LP wraps MON into WMON and deposits it in the vault. The strategist marks 60% of the vault
#      as deployed to the strategy, so the idle buffer (40%) is smaller than what the LPs want out.
#   3. Round 1: opens an exit round sized to the idle buffer. Each LP commits a sealed bid (a discount
#      and a number of shares) with the same MON deposit; after the commit window each reveals; after
#      the reveal window: settle and claim. Every exiting LP pays the one clearing discount, the
#      discount stays in the vault for the LPs who stayed, and every MON deposit comes back in full.
#   4. Round 2 (DRAIN=1, the default): the strategist unmarks the strategy, a second round opens and
#      every LP exits all its remaining shares at a zero discount, so the WMON comes back, including
#      round 1's discount, which went to whoever stayed.
#   5. LPs unwrap WMON and send their MON back to the strategist.
#
# The scenario (WMON): deposits fund-a 0.20 · desk-b 0.15 · desk-c 0.10 · lp-d 0.05 = 0.50, idle 0.20.
# Round 1 bids (discount × WMON of shares): fund-a 1.50% × 0.12 · desk-b 1.00% × 0.10 · desk-c 0.75% × 0.06
#   · lp-d 0.25% × 0.03. Demand 0.31 > 0.20 idle: it clears at 1.00%, fund-a exits in full, desk-b
#   pro-rata, desk-c and lp-d stay (and gain the discount).
#
# Monad reserve balance: a wallet under 10 MON may spend MON (tx value) only in its first transaction
# within 3 blocks (docs.monad.xyz/developer-essentials/reserve-balance), so value transfers from one
# wallet are spaced SPACING seconds apart.
#
# Keys: your keystore password is read without echo into a temp file (mode 600) that is deleted on
# exit. The throwaway LP keys are written to live-exit/<folder>/lps.json (mode 600, git-ignored); they
# hold nothing once the run finishes. Never reuse them.
#
# Env overrides (for a fork rehearsal): RPC, ACCOUNT, SIGNER_KEY (instead of the keystore), COMMIT_SECS,
# REVEAL_SECS, SPACING, DRAIN, OUT (deployments file name, default 143-exit).
set -euo pipefail
export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "$0")/.."

RPC=${RPC:-https://rpc1.monad.xyz}
ACCOUNT=${ACCOUNT:-parity-deployer}
COMMIT_SECS=${COMMIT_SECS:-300}
REVEAL_SECS=${REVEAL_SECS:-300}
SPACING=${SPACING:-4}
DRAIN=${DRAIN:-1}
OUT=${OUT:-143-exit}
SCAN=https://monadscan.com
WMON=0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A

DEPOSIT=50000000000000000          # 0.05 MON per commit, the same for every LP, refunded in full
TICK_BPS=25                        # 0.25% discount grid
MIN_EXIT=10000000000000000000      # 0.01 WMON of shares (shares have 21 decimals: 1 WMON = 1e21)
GAP_BLOCKS=5
GAS_BUDGET=300000000000000000      # 0.3 MON per LP for gas
NAMES=(fund-a desk-b desk-c lp-d)
VAULT_IN=(200000000000000000 150000000000000000 100000000000000000 50000000000000000)
STRATEGY=300000000000000000        # 0.30 WMON marked as deployed: idle buffer 0.20 of 0.50
DISCOUNTS=(150 100 75 25)
EXIT_WMON=(120000000000000000 100000000000000000 60000000000000000 30000000000000000)
N=${#NAMES[@]}
IDX=$(seq 0 $((N - 1)))

say() { printf '\n\033[1;35m▸ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── State: one folder per run, appended KEY=VALUE lines, so a stopped run resumes ──
if [ $# -ge 1 ]; then STATE_DIR=$1; [ -f "$STATE_DIR/state.env" ] || die "no state in $STATE_DIR"
else STATE_DIR=live-exit/$(date +%Y%m%d-%H%M%S); mkdir -p "$STATE_DIR"; : > "$STATE_DIR/state.env"; fi
chmod 700 "$STATE_DIR"
# shellcheck disable=SC1091
. "$STATE_DIR/state.env"
put() { printf '%s=%q\n' "$1" "$2" >> "$STATE_DIR/state.env"; eval "$1=\$2"; }

# ── Strategist signer ──
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
echo "Strategist $CREATOR · balance $(cast balance "$CREATOR" --rpc-url "$RPC" --ether) MON · state in $STATE_DIR"
[ "$(cast chain-id --rpc-url "$RPC")" = 143 ] || die "not Monad mainnet or a fork of it (chain 143)"

# send <label> <signer args…> -- <cast send args…>: sends, checks status, prints and returns the receipt JSON.
LAST_RECEIPT=""
send() {
  local label=$1; shift; local signer=()
  while [ "$1" != "--" ]; do signer+=("$1"); shift; done; shift
  local out
  out=$(cast send "$@" --rpc-url "$RPC" "${signer[@]}" --json) || die "$label failed"
  [ "$(jq -r .status <<<"$out")" = 0x1 ] || die "$label reverted: $(jq -r .transactionHash <<<"$out")"
  printf '  %-30s %s/tx/%s\n' "$label" "$SCAN" "$(jq -r .transactionHash <<<"$out")"
  LAST_RECEIPT=$out
}
call() { cast call "$@" --rpc-url "$RPC" | awk '{print $1}'; }
now() { cast block latest -f timestamp --rpc-url "$RPC"; }
wait_until() {
  local t=$1 what=$2 n
  while n=$(now); [ "$n" -lt "$t" ]; do printf '\r  waiting for %s: %3ss ' "$what" $((t - n)); sleep 5; done; printf '\r  %s reached.            \n' "$what"
}
wmon() { cast from-wei "$1"; }

# ── 1. LP wallets and the allowlist (a sorted-pair Merkle tree, OpenZeppelin StandardMerkleTree leaves) ──
if [ ! -f "$STATE_DIR/lps.json" ]; then
  say "Making $N burner LP wallets"
  ( umask 077; for _ in $IDX; do cast wallet new --json | jq -c '.data[0] | {address, private_key}'; done | jq -s . > "$STATE_DIR/lps.json" )
fi
ADDR=(); KEY=(); LEAF=()
for i in $IDX; do
  ADDR+=("$(jq -r ".[$i].address" "$STATE_DIR/lps.json")"); KEY+=("$(jq -r ".[$i].private_key" "$STATE_DIR/lps.json")")
  LEAF+=("$(cast keccak "$(cast keccak "$(cast abi-encode "f(address)" "${ADDR[$i]}")")")")
  echo "  ${NAMES[$i]} ${ADDR[$i]}"
done
pair() { if [[ "$1" < "$2" ]]; then cast keccak "$1${2#0x}"; else cast keccak "$2${1#0x}"; fi; }
N01=$(pair "${LEAF[0]}" "${LEAF[1]}"); N23=$(pair "${LEAF[2]}" "${LEAF[3]}"); ROOT=$(pair "$N01" "$N23")
PROOF=("[${LEAF[1]},$N23]" "[${LEAF[0]},$N23]" "[${LEAF[3]},$N01]" "[${LEAF[2]},$N01]")
echo "  allowlist root $ROOT"

if [ -z "${FUNDED:-}" ]; then
  say "Funding each LP: its vault deposit + the 0.05 MON bid deposit + 0.3 MON for gas"
  for i in $IDX; do
    need=$(echo "${VAULT_IN[$i]} + $DEPOSIT + $GAS_BUDGET" | bc)
    if [ "$(echo "$(cast balance "${ADDR[$i]}" --rpc-url "$RPC") < $need" | bc)" = 1 ]; then
      sleep "$SPACING"; send "fund ${NAMES[$i]}" "${CREATOR_ARGS[@]}" -- "${ADDR[$i]}" --value "$need"
    fi
  done
  put FUNDED 1
fi

# ── 2. Deploy the vault and its exit auction ──
if [ -z "${VAULT:-}" ]; then
  say "Deploying DemoVault over WMON and its ExitAuction (allowlist = the four LPs)"
  if [ -n "${SIGNER_KEY:-}" ]; then FORGE_SIGNER=(--private-key "$SIGNER_KEY"); else FORGE_SIGNER=("${CREATOR_ARGS[@]}"); fi
  ALLOWLIST_ROOT=$ROOT COMMIT_SECONDS=$COMMIT_SECS REVEAL_SECONDS=$REVEAL_SECS DEPOSIT_WEI=$DEPOSIT TICK_BPS=$TICK_BPS \
    MIN_EXIT_SHARES=$MIN_EXIT GAP_BLOCKS=$GAP_BLOCKS OUT=$OUT \
    forge script script/DeployExitMainnet.s.sol --rpc-url "$RPC" "${FORGE_SIGNER[@]}" --broadcast --slow >"$STATE_DIR/deploy.log" 2>&1 \
    || { tail -20 "$STATE_DIR/deploy.log"; die "deploy failed (log: $STATE_DIR/deploy.log)"; }
  put VAULT "$(jq -r .vault "deployments/$OUT.json")"; put AUCTION "$(jq -r .exitAuction "deployments/$OUT.json")"
  echo "  vault   $SCAN/address/$VAULT"
  echo "  auction $SCAN/address/$AUCTION"
fi

# ── 3. LPs deposit; the strategist marks part of the vault as deployed ──
if [ -z "${PROVEN:-}" ]; then
  say "Proving each LP is on the allowlist (the vault takes deposits only from LPs who can exit)"
  for i in $IDX; do send "proveHolder ${NAMES[$i]}" "${CREATOR_ARGS[@]}" -- "$VAULT" "proveHolder(address,bytes32[])" "${ADDR[$i]}" "${PROOF[$i]}"; done
  put PROVEN 1
fi
for i in $IDX; do
  v="DEPOSITED_$i"; [ -n "${!v:-}" ] && continue
  [ "$i" = 0 ] && say "LPs wrap MON and deposit WMON in the vault"
  sleep "$SPACING"
  send "wrap ${NAMES[$i]}" --private-key "${KEY[$i]}" -- "$WMON" "deposit()" --value "${VAULT_IN[$i]}"
  send "approve vault ${NAMES[$i]}" --private-key "${KEY[$i]}" -- "$WMON" "approve(address,uint256)" "$VAULT" "${VAULT_IN[$i]}"
  send "deposit ${NAMES[$i]}" --private-key "${KEY[$i]}" -- "$VAULT" "deposit(uint256,address)" "${VAULT_IN[$i]}" "${ADDR[$i]}"
  send "approve auction ${NAMES[$i]}" --private-key "${KEY[$i]}" -- "$VAULT" "approve(address,uint256)" "$AUCTION" "$(cast max-uint)"
  put "DEPOSITED_$i" 1
done
if [ -z "${MARKED:-}" ]; then
  say "Strategist marks $(wmon $STRATEGY) WMON as deployed; the idle buffer is what is left"
  send "moveToStrategy" "${CREATOR_ARGS[@]}" -- "$VAULT" "moveToStrategy(uint256)" "$STRATEGY"
  put MARKED 1
fi
echo "  vault $(wmon "$(call "$VAULT" "totalAssets()(uint256)")") WMON · idle $(wmon "$(call "$VAULT" "idleAssets()(uint256)")") WMON"

# exit_round <n> <discount for LP i> <shares for LP i>: one full sealed exit round.
exit_round() {
  local n=$1 dfun=$2 sfun=$3 i v s
  local R="ROUND_$n" CE="COMMIT_END_$n" RE="REVEAL_END_$n"
  if [ -z "${!R:-}" ]; then
    say "Round $n: opening an exit round sized to the idle buffer"
    send "openExitRound" "${CREATOR_ARGS[@]}" -- "$AUCTION" "openExitRound()"
    put "ROUND_$n" "$(call "$AUCTION" "roundCount()(uint256)")"
    local rd; rd=$(cast call "$AUCTION" "getRound(uint256)((uint128,uint64,uint64,uint64,uint64,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256))" "${!R}" --rpc-url "$RPC")
    put "COMMIT_END_$n" "$(sed -E 's/^\(([0-9]+)[^,]*, ([0-9]+).*/\2/' <<<"$rd")"
    put "REVEAL_END_$n" "$(sed -E 's/^\(([0-9]+)[^,]*, ([0-9]+)[^,]*, ([0-9]+).*/\3/' <<<"$rd")"
    echo "  round ${!R} · capacity $(sed -E 's/^\(([0-9]+).*/\1/' <<<"$rd") shares"
  fi
  for i in $IDX; do
    v="COMMITTED_${n}_$i"; [ -n "${!v:-}" ] && continue
    [ "$(now)" -lt "${!CE}" ] || die "commit window closed before ${NAMES[$i]} bid"
    s="SALT_${n}_$i"; [ -n "${!s:-}" ] || put "SALT_${n}_$i" "0x$(openssl rand -hex 32)"
    put "BID_D_${n}_$i" "$($dfun "$i")"; put "BID_S_${n}_$i" "$($sfun "$i")"
    local d="BID_D_${n}_$i" sh="BID_S_${n}_$i"
    local hash; hash=$(cast keccak "$(cast abi-encode "f(uint96,uint96,bytes32,address)" "${!d}" "${!sh}" "${!s}" "${ADDR[$i]}")")
    [ "$i" = 0 ] && say "Round $n: sealed bids (a hash and the same deposit each; nobody can read a discount or size)"
    sleep "$SPACING"
    send "commit ${NAMES[$i]}" --private-key "${KEY[$i]}" -- "$AUCTION" "commit(uint256,bytes32,bytes32[],bytes)" "${!R}" "$hash" "${PROOF[$i]}" 0x --value "$DEPOSIT"
    put "COMMITTED_${n}_$i" 1
  done
  say "Round $n: bidding closes, then the reveal window opens"
  wait_until "${!CE}" "end of bidding"
  for i in $IDX; do
    v="REVEALED_${n}_$i"; [ -n "${!v:-}" ] && continue
    s="SALT_${n}_$i"; local d="BID_D_${n}_$i" sh="BID_S_${n}_$i"
    send "reveal ${NAMES[$i]} ($(echo "scale=2; ${!d}/100" | bc)% × $(wmon "$(echo "${!sh}/1000" | bc)"))" --private-key "${KEY[$i]}" -- \
      "$AUCTION" "reveal(uint256,uint96,uint96,bytes32)" "${!R}" "${!d}" "${!sh}" "${!s}"
    put "REVEALED_${n}_$i" 1
  done
  say "Round $n: reveal window closes, then settle and claim"
  wait_until "${!RE}" "end of reveals"
  v="SETTLED_$n"
  if [ -z "${!v:-}" ]; then
    send "settle" "${CREATOR_ARGS[@]}" -- "$AUCTION" "settle(uint256,uint256)" "${!R}" 100
    put "SETTLED_$n" 1
  fi
  for i in $IDX; do
    v="CLAIMED_${n}_$i"; [ -n "${!v:-}" ] && continue
    send "claim ${NAMES[$i]}" --private-key "${KEY[$i]}" -- "$AUCTION" "claim(uint256)" "${!R}"
    put "CLAIMED_${n}_$i" 1
  done
}
r1_discount() { echo "${DISCOUNTS[$1]}"; }
r1_shares() { echo "${EXIT_WMON[$1]} * 1000" | bc; }
r2_discount() { echo 0; }
r2_shares() { call "$VAULT" "balanceOf(address)(uint256)" "${ADDR[$1]}"; }

# ── 4. Round 1: the idle buffer is smaller than what the LPs want out ──
exit_round 1 r1_discount r1_shares
CLEAR1=$(cast call "$AUCTION" "getRound(uint256)((uint128,uint64,uint64,uint64,uint64,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256))" "$ROUND_1" --rpc-url "$RPC")
P1=$(cast call "$AUCTION" "clearingOf(uint256)(bool,uint256,uint256,uint256,bool,uint256,uint256)" "$ROUND_1" --rpc-url "$RPC" | sed -n 2p | awk '{print $1}')
echo "  round 1 cleared at a $(echo "scale=2; $P1/100" | bc)% discount for every exit"

# ── 5. Round 2: the strategist unmarks the strategy and everyone exits at no discount ──
if [ "$DRAIN" = 1 ]; then
  if [ -z "${UNMARKED:-}" ]; then
    say "Strategist moves the strategy back to idle"
    send "moveToIdle" "${CREATOR_ARGS[@]}" -- "$VAULT" "moveToIdle(uint256)" "$(call "$VAULT" "strategyAssets()(uint256)")"
    put UNMARKED 1
  fi
  while [ "$(cast block-number --rpc-url "$RPC")" -lt "$(call "$AUCTION" "nextOpenBlock()(uint256)")" ]; do sleep 2; done
  exit_round 2 r2_discount r2_shares
fi

# ── 6. LPs unwrap WMON and send their MON back to the strategist ──
say "LPs unwrap WMON and return their MON to the strategist"
GP=$(cast gas-price --rpc-url "$RPC")
for i in $IDX; do
  v="SWEPT_$i"; [ -n "${!v:-}" ] && continue
  w=$(call "$WMON" "balanceOf(address)(uint256)" "${ADDR[$i]}")
  [ "$w" != 0 ] && send "unwrap ${NAMES[$i]} ($(wmon "$w") WMON)" --private-key "${KEY[$i]}" -- "$WMON" "withdraw(uint256)" "$w"
  sleep "$SPACING"
  # Monad charges the whole gas limit, so the limit is fixed up front and the rest is sent.
  gl=$(cast estimate "$CREATOR" --value 1 --from "${ADDR[$i]}" --rpc-url "$RPC")
  mon=$(cast balance "${ADDR[$i]}" --rpc-url "$RPC"); fee=$((gl * GP))
  if [ "$(echo "$mon > $fee" | bc)" = 1 ]; then
    send "MON ${NAMES[$i]} → strategist" --private-key "${KEY[$i]}" -- "$CREATOR" --value "$(echo "$mon - $fee" | bc)" --gas-limit "$gl" --gas-price "$GP" --legacy
  fi
  put "SWEPT_$i" 1
done

# ── Summary ──
{
  echo "# Even live vault exit"
  echo
  echo "- Vault (DemoVault over WMON): $SCAN/address/$VAULT"
  echo "- ExitAuction: $SCAN/address/$AUCTION"
  echo "- Round 1: clearing discount $(echo "scale=2; $P1/100" | bc)% · $CLEAR1"
  echo "  (capacity, commitEnd, revealEnd, openedBlock, settledBlock, escrowed, settleAssets, allocatedTotal,"
  echo "   returnedTotal, assetsRedeemed, paidOut, donated, exitsClaimed)"
  echo "- Strategist: $SCAN/address/$CREATOR"
  echo "- Vault left: $(wmon "$(call "$VAULT" "totalAssets()(uint256)")") WMON · auction owes $(wmon "$(call "$AUCTION" "totalOwed()(uint256)")") MON"
} > "$STATE_DIR/summary.md"
say "Done"
cat "$STATE_DIR/summary.md"
echo "Strategist balance now $(cast balance "$CREATOR" --rpc-url "$RPC" --ether) MON"
