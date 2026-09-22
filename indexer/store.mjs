// In-memory store of decoded engine events plus the derived per-round views served by the API.
// Pure: no RPC here. The indexer feeds it decoded logs, transaction costs and round configs.
//
// Units: all token amounts and MON amounts are wei-scale integers (BigInt, serialised as decimal
// strings). Prices are MON wei per 1e18 token units, as in the contract (AuctionEngine.PRICE_SCALE).

import { PRESETS } from "./events.mjs";

const BURN = "0x000000000000000000000000000000000000dead";

function emptyRound(roundId) {
  return {
    roundId,
    opened: null,
    config: null,
    commits: [],
    reveals: [],
    cleared: null,
    lpSeeds: [],
    abandoned: null,
    claimsOpened: null,
    unsold: [],
    burns: [],
    refunds: [],
    tokens: [],
    vested: [],
    proceeds: [],
  };
}

export class Store {
  constructor() {
    this.rounds = new Map(); // roundId (decimal string) -> round
    this.txs = new Map(); // txHash -> { from, gasUsed, gasLimit, effectiveGasPrice, status }
    this.seen = new Set(); // txHash:logIndex, so re-ingesting a block range is harmless
    this.head = { blockNumber: null, timestamp: null };
  }

  round(roundId) {
    const id = String(roundId);
    if (!this.rounds.has(id)) this.rounds.set(id, emptyRound(id));
    return this.rounds.get(id);
  }

  hasRound(roundId) {
    return this.rounds.has(String(roundId));
  }

  setTx(txHash, info) {
    this.txs.set(txHash.toLowerCase(), info);
  }

  setConfig(roundId, config) {
    this.round(roundId).config = config;
  }

  setHead(blockNumber, timestamp) {
    this.head = { blockNumber, timestamp };
  }

  /** Add one decoded log (output of abi.decodeLog). Returns false if it was already ingested. */
  ingest(rec) {
    const key = `${rec.txHash}:${rec.logIndex}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    const a = rec.args;
    const r = this.round(a.roundId);
    const meta = { blockNumber: rec.blockNumber, timestamp: rec.blockTimestamp, txHash: rec.txHash, logIndex: rec.logIndex };
    switch (rec.event) {
      case "RoundOpened":
        r.opened = { ...meta, creator: a.creator, token: a.token, preset: PRESETS[Number(a.preset)] ?? Number(a.preset), allowlistURI: a.allowlistURI };
        break;
      case "Committed":
        r.commits.push({ ...meta, bidder: a.bidder, hash: a.hash, note: a.note });
        break;
      case "Revealed":
        r.reveals.push({ ...meta, bidder: a.bidder, price: a.price, amount: a.amount });
        break;
      case "UnrevealedBurned":
        r.burns.push({ ...meta, count: a.count, amount: a.amount });
        break;
      case "Cleared":
        r.cleared = { ...meta, clearingPrice: a.clearingPrice, sold: a.sold, oversubscribed: a.oversubscribed };
        break;
      case "LPSeeded":
        r.lpSeeds.push({ ...meta, adapter: a.adapter, positionManager: a.positionManager, nftId: a.nftId, tokenAmount: a.tokenAmount, monAmount: a.monAmount, lockId: a.lockId });
        break;
      case "LPAbandoned":
        r.abandoned = { ...meta, monBurned: a.monBurned };
        break;
      case "ClaimsOpened":
        r.claimsOpened = { ...meta, lpSeeded: a.lpSeeded };
        break;
      case "UnsoldDisposed":
        r.unsold.push({ ...meta, to: a.to, amount: a.amount, burned: a.to === BURN });
        break;
      case "Claimed": // emitted at the refund step (claimRefund, or the first half of claim/claimTokens)
        r.refunds.push({ ...meta, bidder: a.bidder, allocated: a.allocated, paid: a.paid, refund: a.refund });
        break;
      case "TokensClaimed":
        r.tokens.push({ ...meta, bidder: a.bidder, amount: a.amount });
        break;
      case "VestedClaimed":
        r.vested.push({ ...meta, bidder: a.bidder, amount: a.amount });
        break;
      case "ProceedsWithdrawn":
        r.proceeds.push({ ...meta, amount: a.amount });
        break;
      default:
        return false;
    }
    return true;
  }

  // ─── Views ───────────────────────────────────────────────────────────

  listRounds() {
    return [...this.rounds.keys()]
      .sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1))
      .map((id) => this.summary(id));
  }

  phase(r) {
    if (r.claimsOpened) return "claims-open";
    if (r.cleared) return "cleared";
    const now = this.head.timestamp;
    if (r.config && now != null) {
      if (now < Number(r.config.commitEnd)) return "commit";
      if (now < Number(r.config.revealEnd)) return "reveal";
      return "awaiting-settlement";
    }
    return "open";
  }

  summary(roundId) {
    const r = this.round(roundId);
    const burned = this.burnTotals(r);
    return {
      roundId: r.roundId,
      phase: this.phase(r),
      creator: r.opened?.creator ?? null,
      token: r.opened?.token ?? null,
      preset: r.opened?.preset ?? null,
      allowlistURI: r.opened?.allowlistURI ?? null,
      opened: r.opened ? pickMeta(r.opened) : null,
      config: r.config,
      commitCount: r.commits.length,
      revealCount: r.reveals.length,
      refundCount: r.refunds.length,
      tokensClaimedCount: r.tokens.length,
      clearing: this.clearing(roundId).clearing,
      lpSeeded: r.lpSeeds.length > 0,
      lpAbandoned: r.abandoned != null,
      claimsOpen: r.claimsOpened != null,
      unrevealedBurned: burned,
      proceedsWithdrawn: sum(r.proceeds.map((p) => p.amount)),
    };
  }

  /** Commitment count over time. Public by design: it is the round's one demand signal. */
  commitments(roundId) {
    const r = this.round(roundId);
    return { roundId: r.roundId, total: r.commits.length, series: cumulativeByBlock(r.commits) };
  }

  reveals(roundId) {
    const r = this.round(roundId);
    return {
      roundId: r.roundId,
      commitCount: r.commits.length,
      revealCount: r.reveals.length,
      unrevealedCount: r.commits.length - r.reveals.length,
      series: cumulativeByBlock(r.reveals),
    };
  }

  /** Revealed demand per price level, highest price first, with the running total. */
  demand(roundId) {
    const r = this.round(roundId);
    const byPrice = new Map();
    for (const rv of r.reveals) {
      const lvl = byPrice.get(rv.price) ?? { price: rv.price, amount: 0n, bids: 0 };
      lvl.amount += rv.amount;
      lvl.bids += 1;
      byPrice.set(rv.price, lvl);
    }
    let cumulative = 0n;
    const levels = [...byPrice.values()]
      .sort((x, y) => (x.price > y.price ? -1 : x.price < y.price ? 1 : 0))
      .map((l) => ({ ...l, cumulativeAmount: (cumulative += l.amount) }));
    return {
      roundId: r.roundId,
      final: this.phase(r) !== "commit" && this.phase(r) !== "reveal" && this.phase(r) !== "open",
      supply: r.config?.sellAmount ?? null,
      revealCount: r.reveals.length,
      totalAmount: cumulative,
      clearingPrice: r.cleared?.clearingPrice ?? null,
      levels,
    };
  }

  clearing(roundId) {
    const r = this.round(roundId);
    const c = r.cleared;
    return {
      roundId: r.roundId,
      clearing: c
        ? { clearingPrice: c.clearingPrice, sold: c.sold, oversubscribed: c.oversubscribed, ...pickMeta(c) }
        : null,
    };
  }

  lp(roundId) {
    const r = this.round(roundId);
    return {
      roundId: r.roundId,
      seeds: r.lpSeeds.map((s) => ({
        adapter: s.adapter,
        positionManager: s.positionManager,
        nftId: s.nftId,
        tokenAmount: s.tokenAmount,
        monAmount: s.monAmount,
        lockId: s.lockId,
        ...pickMeta(s),
      })),
      lockIds: r.lpSeeds.map((s) => s.lockId),
      totals: { tokenAmount: sum(r.lpSeeds.map((s) => s.tokenAmount)), monAmount: sum(r.lpSeeds.map((s) => s.monAmount)) },
      abandoned: r.abandoned ? { monBurned: r.abandoned.monBurned, ...pickMeta(r.abandoned) } : null,
      claimsOpened: r.claimsOpened ? { lpSeeded: r.claimsOpened.lpSeeded, ...pickMeta(r.claimsOpened) } : null,
      unsoldDisposed: r.unsold.map((u) => ({ to: u.to, amount: u.amount, burned: u.burned, ...pickMeta(u) })),
    };
  }

  burnTotals(r) {
    if (!r.burns.length) return null;
    return { count: r.burns[r.burns.length - 1].count, amount: sum(r.burns.map((b) => b.amount)), ...pickMeta(r.burns[r.burns.length - 1]) };
  }

  /**
   * Per-bidder journey: commit -> reveal -> refund -> tokens, each with gas used and fee paid.
   * Refund and tokens are one transaction (claim, or claimTokens before any refund) or two
   * (claimRefund after settlement, then claimTokens once claims open). Anyone may send them, so
   * each step carries `from`; journey totals count each transaction once.
   */
  journey(roundId, bidder) {
    const r = this.round(roundId);
    const who = bidder.toLowerCase();
    const commit = r.commits.find((c) => c.bidder === who);
    if (!commit) return null;
    const reveal = r.reveals.find((c) => c.bidder === who);
    const refund = r.refunds.find((c) => c.bidder === who);
    const tokens = r.tokens.find((c) => c.bidder === who);
    const vested = r.vested.filter((c) => c.bidder === who);

    let status = "committed";
    if (tokens) status = "claimed";
    else if (refund) status = "refunded";
    else if (reveal) status = "revealed";
    else if (r.burns.length) status = "burned";
    else if (["awaiting-settlement", "cleared", "claims-open"].includes(this.phase(r))) status = "unrevealed";

    const steps = {
      commit: { hash: commit.hash, note: commit.note, noteBytes: (commit.note.length - 2) / 2, ...this.cost(commit) },
      reveal: reveal ? { price: reveal.price, amount: reveal.amount, ...this.cost(reveal) } : null,
      refund: refund ? { allocated: refund.allocated, paid: refund.paid, refund: refund.refund, ...this.cost(refund) } : null,
      tokens: tokens ? { amount: tokens.amount, sameTxAsRefund: tokens.txHash === refund?.txHash, ...this.cost(tokens) } : null,
    };
    // A losing bid has nothing to deliver, so its journey ends at the refund.
    const complete = Boolean(reveal && refund && (tokens || refund.allocated === 0n));
    const txs = [...new Map(Object.values(steps).filter(Boolean).map((st) => [st.txHash, st])).values()];
    const known = txs.every((t) => t.gasUsed != null);
    const total = (key, xs = txs) => (known ? sum(xs.map((t) => t[key] ?? 0n)) : null);
    const own = txs.filter((t) => t.from === who);
    return {
      roundId: r.roundId,
      bidder: who,
      status,
      ...steps,
      vested: vested.map((v) => ({ amount: v.amount, ...this.cost(v) })),
      journey: {
        complete,
        transactions: txs.length,
        gasUsed: total("gasUsed"),
        gasLimit: total("gasLimit"),
        fee: total("fee"),
        feeAtGasLimit: total("feeAtGasLimit"),
        paidByBidder: { transactions: own.length, fee: total("fee", own), feeAtGasLimit: total("feeAtGasLimit", own) },
      },
    };
  }

  bidders(roundId) {
    const r = this.round(roundId);
    const journeys = r.commits.map((c) => this.journey(roundId, c.bidder));
    const stat = (xs) => {
      const v = xs.filter((x) => x != null).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return v.length ? { count: v.length, min: v[0], max: v[v.length - 1] } : { count: 0, min: null, max: null };
    };
    return {
      roundId: r.roundId,
      bidders: journeys,
      gas: {
        commit: stat(journeys.map((j) => j.commit.gasUsed)),
        reveal: stat(journeys.map((j) => j.reveal?.gasUsed)),
        refund: stat(journeys.map((j) => (j.refund && !j.tokens?.sameTxAsRefund ? j.refund.gasUsed : null))),
        tokens: stat(journeys.map((j) => (j.tokens && !j.tokens.sameTxAsRefund ? j.tokens.gasUsed : null))),
        refundAndTokens: stat(journeys.map((j) => (j.tokens?.sameTxAsRefund ? j.tokens.gasUsed : null))),
        completeJourney: stat(journeys.filter((j) => j.journey.complete).map((j) => j.journey.gasUsed)),
      },
    };
  }

  /** Transaction cost of the tx that emitted `rec`. Monad charges gasLimit x price, so both are given. */
  cost(rec) {
    const tx = this.txs.get(rec.txHash);
    const base = { ...pickMeta(rec) };
    if (!tx) return { ...base, from: null, gasUsed: null, gasLimit: null, effectiveGasPrice: null, fee: null, feeAtGasLimit: null };
    return {
      ...base,
      from: tx.from,
      gasUsed: tx.gasUsed,
      gasLimit: tx.gasLimit,
      effectiveGasPrice: tx.effectiveGasPrice,
      fee: tx.gasUsed * tx.effectiveGasPrice,
      feeAtGasLimit: tx.gasLimit == null ? null : tx.gasLimit * tx.effectiveGasPrice,
    };
  }

  /** All decoded events of a round, in chain order. */
  events(roundId) {
    const r = this.round(roundId);
    const tag = (name, xs) => xs.map((x) => ({ event: name, ...x }));
    const all = [
      ...tag("RoundOpened", r.opened ? [r.opened] : []),
      ...tag("Committed", r.commits),
      ...tag("Revealed", r.reveals),
      ...tag("UnrevealedBurned", r.burns),
      ...tag("Cleared", r.cleared ? [r.cleared] : []),
      ...tag("LPSeeded", r.lpSeeds),
      ...tag("LPAbandoned", r.abandoned ? [r.abandoned] : []),
      ...tag("ClaimsOpened", r.claimsOpened ? [r.claimsOpened] : []),
      ...tag("UnsoldDisposed", r.unsold),
      ...tag("Claimed", r.refunds),
      ...tag("TokensClaimed", r.tokens),
      ...tag("VestedClaimed", r.vested),
      ...tag("ProceedsWithdrawn", r.proceeds),
    ];
    all.sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
    return { roundId: r.roundId, events: all };
  }
}

function pickMeta(x) {
  return { blockNumber: x.blockNumber, timestamp: x.timestamp, txHash: x.txHash };
}

function sum(xs) {
  return xs.reduce((a, b) => a + b, 0n);
}

function cumulativeByBlock(records) {
  const series = [];
  let count = 0;
  const sorted = [...records].sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
  for (const rec of sorted) {
    count += 1;
    const last = series[series.length - 1];
    if (last && last.blockNumber === rec.blockNumber) {
      last.count = count;
      last.added += 1;
    } else {
      series.push({ blockNumber: rec.blockNumber, timestamp: rec.timestamp, added: 1, count });
    }
  }
  return series;
}
