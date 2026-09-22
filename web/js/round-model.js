// Round page logic without the DOM: reading a round, its phase, the bid form, and which
// transactions are available to whom. The screen (screens/round.js) only renders this.
import { ZERO32 } from "./engine.js";
import {
  parseUnits, perTokenToWire, wireToPerToken, snapToTick, maxSpend, bidProblems, minAmount, maxAmountAt,
} from "./bid.js";

// Read once per round.
export async function loadRoundMeta(engine, roundId) {
  const r = await engine.getRound(roundId);
  if (/^0x0+$/.test(r.creator)) throw new Error(`Round ${roundId} does not exist on this engine.`);
  const [decimals, symbol, opened, grace] = await Promise.all([
    engine.erc20.decimals(r.token).catch(() => 18n),
    engine.erc20.symbol(r.token).catch(() => "TOKEN"),
    engine.roundOpened(roundId).catch(() => null),
    engine.lpGracePeriod(),
  ]);
  return { decimals: Number(decimals), symbol, allowlistURI: opened?.args.allowlistURI ?? "", grace };
}

// Everything the page shows, at one point in time. `bidder` may be null.
export async function loadRoundState(engine, roundId, bidder) {
  const [round, clearing, ledger, commits] = await Promise.all([
    engine.getRound(roundId), engine.clearingOf(roundId), engine.ledgers(roundId), engine.committedLogs(roundId),
  ]);
  const s = { round, clearing, ledger, commits, me: null };
  if (bidder) {
    const [commitment, account, tokensClaimed] = await Promise.all([
      engine.commitment(roundId, bidder), engine.account(roundId, bidder), engine.tokensClaimed(roundId, bidder),
    ]);
    const me = { commitment, committed: commitment.hash !== ZERO32, revealed: commitment.revealed, refunded: account.settled, tokensClaimed };
    if (clearing.settled && commitment.revealed) me.quote = await engine.quote(roundId, bidder);
    if (round.vestDuration !== 0n) me.vest = await engine.vestedOf(roundId, bidder);
    s.me = me;
  }
  // Post-clear transparency: revealed bids are loaded only once the round is settled.
  if (clearing.settled) s.revealed = await engine.revealedLogs(roundId);
  return s;
}

export const PHASE = { Commit: "Commit", Reveal: "Reveal", Clearing: "Clearing", Settled: "Settled", ClaimsOpen: "Claims open" };

export function phaseOf(s, now) {
  const { round, clearing } = s;
  if (now < Number(round.commitEnd)) return { phase: PHASE.Commit, nextAt: Number(round.commitEnd), next: "Reveal window opens" };
  if (now < Number(round.revealEnd)) return { phase: PHASE.Reveal, nextAt: Number(round.revealEnd), next: "Reveal window closes" };
  if (!clearing.settled) return { phase: PHASE.Clearing, nextAt: null };
  if (!round.claimsOpen) return { phase: PHASE.Settled, nextAt: null };
  return { phase: PHASE.ClaimsOpen, nextAt: null };
}

export function unrevealedDue(s) {
  const { ledger, round } = s;
  return (ledger.commits - ledger.reveals) * round.depositAmount - ledger.burned;
}

export function abandonAt(s, meta) {
  return Number(s.round.settledAt) + Number(meta.grace);
}

// Transactions anyone may send, with the contract's own preconditions.
// Each: {id, label, build(engine, roundId)}.
export function publicActions(s, meta, now, { settleSteps = 100n } = {}) {
  const { round, clearing, ledger } = s;
  const out = [];
  const afterReveal = now >= Number(round.revealEnd);
  if (afterReveal && unrevealedDue(s) > 0n) {
    out.push({ id: "burn", label: `Burn unrevealed deposits (${ledger.commits - ledger.reveals})`, build: (e, id) => e.tx.burnUnrevealed(id) });
  }
  if (afterReveal && !clearing.settled) {
    out.push({ id: "settle", label: "Settle", build: (e, id) => e.tx.settle(id, BigInt(settleSteps)) });
  }
  if (clearing.settled && !round.lpDone) {
    out.push({ id: "seed", label: "Seed liquidity", build: (e, id) => e.tx.seedLP(id) });
    if (now >= abandonAt(s, meta)) {
      out.push({ id: "abandon", label: "Abandon liquidity and open token delivery", build: (e, id) => e.tx.abandonLP(id) });
    }
  }
  if (round.unsoldOwed > 0n) {
    out.push({ id: "dispose", label: round.preset === 0n ? "Burn unsold supply" : "Return unsold supply to the creator", build: (e, id) => e.tx.disposeUnsold(id) });
  }
  if (round.lpDone && !round.dustSwept && ledger.claims === ledger.reveals && ledger.reveals > 0n) {
    out.push({ id: "sweep", label: "Sweep rounding dust", build: (e, id) => e.tx.sweepDust(id) });
  }
  return out;
}

// Transactions for the connected bidder after settlement.
export function bidderActions(s, bidder) {
  const me = s.me;
  if (!me || !s.clearing.settled || !me.revealed) return [];
  const out = [];
  if (!me.refunded) {
    out.push({ id: "refund", label: "Claim refund", build: (e, id) => e.tx.claimRefund(id, bidder) });
  }
  if (s.round.claimsOpen && !me.tokensClaimed && me.quote?.allocated > 0n) {
    out.push({ id: "tokens", label: "Claim tokens", build: (e, id) => e.tx.claimTokens(id, bidder) });
  }
  if (me.vest && me.vest[0] > me.vest[1]) {
    out.push({ id: "vested", label: "Claim vested tokens", build: (e, id) => e.tx.claimVested(id) });
  }
  return out;
}

// Parses the two form fields into a bid on the round's grid, with every blocking condition.
// Returns {empty} | {error} | {price, amount, spend, problems, notes, minAmount, maxAmount}.
export function parseBidInput({ priceText, amountText }, round, tokenDecimals) {
  const p = String(priceText ?? "").trim();
  const a = String(amountText ?? "").trim();
  if (!p || !a) return { empty: true, minAmount: minAmount(round) };
  let perTokenWei, amount;
  try { perTokenWei = parseUnits(p, 18); } catch (e) { return { error: `Price: ${e.message}` }; }
  try { amount = parseUnits(a, tokenDecimals); } catch (e) { return { error: `Amount: ${e.message}` }; }
  const wire = perTokenToWire(perTokenWei, tokenDecimals);
  const price = snapToTick(wire, round.tickSize);
  const snapped = price !== wire || wireToPerToken(wire, tokenDecimals) !== perTokenWei;
  return {
    price,
    amount,
    snapped,
    spend: maxSpend(price, amount),
    problems: bidProblems(round, price, amount),
    minAmount: minAmount(round),
    maxAmount: price > 0n ? maxAmountAt(round, price) : null,
  };
}
