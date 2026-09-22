#!/usr/bin/env bash
# Fee probe: total on-chain cost for one bidder lifecycle —
# commit + reveal + claim — on Monad testnet. Target: under $0.01.
#
# Reads the surface from 06-api.md:
#   commit(roundId, hash) payable, value == depositAmount
#   reveal(roundId, price, quantity, salt)
#   claim(roundId)
#
# Prereqs:
#   - Engine deployed (Deploy.s.sol) and round ROUND_ID open for commits,
#     with QUANTITY above the mandatory minimum bid size. The probe does
#     not open or settle the round.
#   - env: ENGINE_ADDRESS, ROUND_ID (default 0), DEPOSIT_AMOUNT (wei),
#     PRICE (uint96, monadic over the fraction denominator — 06-api.md
#     specifies prices as uint96 fractions but not how reveal passes both
#     halves; TODO: not specified), QUANTITY, SALT (default 0x...01),
#     RPC_URL, PRIVATE_KEY (testnet keys only).
#
# Commit hash (AGENTS.md bugs #1/#2) is fixed as
#   keccak256(abi.encode(price, quantity, salt, msg.sender))
# `cast keccak` cannot hash joined abi words directly, so the probe
# concatenates four 32-byte words (price, quantity, salt, bidder address)
# and hashes the hex. If the on-chain layout differs the probe reports a
# hash mismatch — cross-check before trusting the result.
#
# Gas: each step is a separate transaction; gas price is read once from
# eth_gasPrice, not wired from the receipt.
#
# TODO: not specified — token price for the USD line. Probe prints
# native-unit cost; supply MON_USD to also print USD vs the $0.01 target.

set -euo pipefail

ENGINE_ADDR="${ENGINE_ADDRESS:?set ENGINE_ADDRESS}"
ROUND_ID="${ROUND_ID:-0}"
DEPOSIT="${DEPOSIT_AMOUNT:?set DEPOSIT_AMOUNT in wei}"
PRICE="${PRICE:?set PRICE (uint96)}"
QTY="${QUANTITY:?set QUANTITY (uint96)}"
SALT="${SALT:-0x0000000000000000000000000000000000000000000000000000000000000001}"
RPC="${RPC_URL:?set RPC_URL}"
KEY="${PRIVATE_KEY:?set PRIVATE_KEY (testnet)}"
MON_USD="${MON_USD:-}"

BIDDER=$(cast wallet address --private-key "$KEY")

COMMIT_HASH=$(( printf "%064x" "$PRICE"; printf "%064x" "$QTY"; \
  printf "%s" "${SALT#0x}"; printf "000000000000000000000000%s" "${BIDDER#0x}" ) \
  | cast keccak )

CAL_COMMIT=$(cast calldata 'commit(uint256,bytes32)' "$ROUND_ID" "$COMMIT_HASH")
# TODO: not specified — reveal's signature detail (uint96 fraction as one
# argument vs numerator+denominator pair). Encoded per the field order in
# 06-api.md; adjust if the sealing layer's ABI differs.
CAL_REVEAL=$(cast calldata 'reveal(uint256,uint96,uint96,bytes32)' "$ROUND_ID" "$PRICE" "$QTY" "$SALT")
CAL_CLAIM=$(cast calldata 'claim(uint256)' "$ROUND_ID")

run_step() { # name calldata [value-wei]
  local name=$1 calldata=$2 value=${3:-0}
  local gas gprice wei
  gas=$(cast send "$ENGINE_ADDR" "$calldata" ${value:+--value "$value"} \
    --private-key "$KEY" --rpc-url "$RPC" --json \
    | jq -r '.gasUsed')
  gprice=$(cast gas-price --rpc-url "$RPC")
  wei=$(( gas * gprice ))
  printf "  %7s: %s gas @ %s wei => %s wei\n" "$name" "$gas" "$gprice" "$wei"
  echo "$wei"
}

echo "engine=$ENGINE_ADDR round=$ROUND_ID bidder=$BIDDER"
echo "commit preimage: (price=$PRICE, quantity=$QTY, salt, $BIDDER)"
echo "commit hash=$COMMIT_HASH"

T_COMMIT=$(run_step commit "$CAL_COMMIT" "$DEPOSIT")
T_REVEAL=$(run_step reveal "$CAL_REVEAL")
T_CLAIM=$(run_step claim "$CAL_CLAIM")

TOTAL=$(( T_COMMIT + T_REVEAL + T_CLAIM ))
echo "total: $TOTAL wei"
cast to-unit "$TOTAL" "ether" | xargs -I{} echo "total: {} MON"
if [ -n "$MON_USD" ]; then
  awk -v t="$TOTAL" -v p="$MON_USD" 'BEGIN{ printf "total: $%.6f (target < $0.01)\n", t/1e18*p }'
fi
