// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SealingLayer} from "./SealingLayer.sol";
import {UniformClearing} from "./UniformClearing.sol";
import {SafeTransferLib} from "./lib/SafeTransferLib.sol";
import {IDexAdapter, IUniV3LPLocker, IERC721Minimal, IERC20Minimal} from "./interfaces/ILiquidity.sol";

/// @title AuctionEngine — sealed-bid fair launch (Degen and Raise presets)
/// @notice Round lifecycle: openRound → commit → reveal → settle → seedLP (or abandonLP) → claim.
///         A bid is a max price per token plus a token amount (10-decisions.md #22). Winners pay the
///         uniform clearing price; the overpayment is refunded from their uniform deposit.
/// @dev Money flows, all per round and all checked by `roundBalance` / `tokensOut`:
///      - MON in: one uniform deposit per commit.
///      - MON out: refunds (available as soon as the round is settled, independent of the token);
///        unrevealed deposits burned (#30); the LP share (#25), or burned if the LP is abandoned;
///        creator proceeds.
///      - Tokens in: `sellAmount` for the auction plus the worst-case LP reserve, pulled at open.
///      - Tokens out: allocations (or vested, Raise #32); the LP position; unsold supply, burned for
///        Degen and returned for Raise (#29), or returned if nothing sold at all.
///      Tokens are delivered only after the LP is seeded, so no auctioned token exists outside the
///      contract before the pool does (#27, bug #7). The LP is only ever seeded at the clearing price.
///      If seeding stays blocked for `lpGracePeriod`, anyone can abandon the LP: its MON share is
///      burned and token delivery opens. Burning, rather than returning, means nobody — least of all
///      the creator — gains from blocking the pool (AUDIT.md, second review, H1).
///      Refunds never depend on the token: a paused or blacklisting token cannot hold MON hostage (M2).
contract AuctionEngine is SealingLayer, UniformClearing {
    using SafeTransferLib for address;

    uint256 public constant PRICE_SCALE = 1e18;
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_SPLITS = 4;
    uint256 public constant MIN_RAISE_LOCK = 30 days;

    enum Preset {
        Degen,
        Raise
    }

    struct DexSplit {
        address adapter;
        uint16 bps;
        uint24 fee;
    }

    struct OpenParams {
        Preset preset;
        address token;
        uint128 sellAmount;
        uint96 depositAmount;
        uint96 minBidSize; // minimum of amount × reservePrice, in MON wei
        uint96 tickSize; // price grid, MON wei per 1e18 token units
        uint96 reservePrice;
        uint64 commitEnd;
        uint64 revealEnd;
        bytes32 allowlistRoot; // Raise only; zero = open
        string allowlistURI; // where bidders fetch the tree to build proofs
        uint16 lpShareBps; // share of tokens sold and MON raised that goes to the LP
        DexSplit[] dexSplits;
        uint64 lockDuration; // Raise only: LP lock length from seeding; Degen locks are permanent
        string lockFeeTier; // GoPlus fee name: DEFAULT, LVP or LLP
        uint16 tgeBps; // Raise vesting: share delivered at claim
        uint64 cliff;
        uint64 vestDuration; // 0 = no vesting
    }

    struct Round {
        address creator;
        address token;
        Preset preset;
        uint16 lpShareBps;
        uint16 tgeBps;
        uint128 sellAmount;
        uint128 tokenReserve;
        uint96 depositAmount;
        uint96 minBidSize;
        uint96 tickSize;
        uint96 reservePrice;
        uint64 commitEnd;
        uint64 revealEnd;
        uint64 lockDuration;
        uint64 cliff;
        uint64 vestDuration;
        uint64 settledAt;
        bytes32 allowlistRoot;
        string lockFeeTier;
        bool claimsOpen;
        bool lpDone;
        bool lpAbandoned;
        bool dustSwept;
        uint256 lpMonSpent;
        uint256 lpMonBurned;
        uint256 lpTokensUsed;
        uint256 collected;
        uint256 withdrawn;
        uint256 allocatedTotal;
        uint256 unsoldOwed;
        uint256 tokensOut;
    }

    struct Bid {
        uint96 price;
        uint96 amount;
    }

    struct Vest {
        uint128 total;
        uint128 released;
    }

    IUniV3LPLocker public immutable locker;
    uint256 public immutable permanentLockEnd;
    uint256 public immutable lpGracePeriod;
    mapping(address => bool) public isAdapter;

    uint256 public roundCount;
    mapping(uint256 => Round) internal _rounds;
    mapping(uint256 => DexSplit[]) internal _splits;
    mapping(uint256 => mapping(address => Bid)) public bids;
    mapping(uint256 => mapping(address => Vest)) public vests;
    mapping(uint256 => mapping(address => bool)) public tokensClaimed;
    bool private _seeding;

    event RoundOpened(
        uint256 indexed roundId, address indexed creator, address indexed token, Preset preset, string allowlistURI
    );
    event Cleared(uint256 indexed roundId, uint256 clearingPrice, uint256 sold, bool oversubscribed);
    event LPSeeded(
        uint256 indexed roundId,
        address indexed adapter,
        address positionManager,
        uint256 nftId,
        uint256 tokenAmount,
        uint256 monAmount,
        uint256 lockId
    );
    event LPAbandoned(uint256 indexed roundId, uint256 monBurned);
    event ClaimsOpened(uint256 indexed roundId, bool lpSeeded);
    event UnsoldDisposed(uint256 indexed roundId, address indexed to, uint256 amount);
    event Claimed(uint256 indexed roundId, address indexed bidder, uint256 allocated, uint256 paid, uint256 refund);
    event TokensClaimed(uint256 indexed roundId, address indexed bidder, uint256 amount);
    event VestedClaimed(uint256 indexed roundId, address indexed bidder, uint256 amount);
    event ProceedsWithdrawn(uint256 indexed roundId, uint256 amount);

    /// @param locker_           GoPlus UniV3LPLocker.
    /// @param adapters_         The only DEX adapters creators may choose; fixed forever, so no creator can
    ///                          route LP proceeds to a contract of their own.
    /// @param permanentLockEnd_ Unlock time passed to the locker for Degen rounds. The engine is the lock
    ///                          owner and has no unlock path, so the lock is permanent regardless.
    /// @param lpGracePeriod_    How long after settlement seeding may stay blocked before anyone can abandon it.
    constructor(address locker_, address[] memory adapters_, uint256 permanentLockEnd_, uint256 lpGracePeriod_) {
        require(locker_.code.length != 0, "locker has no code");
        require(permanentLockEnd_ > block.timestamp, "lock end in past");
        require(lpGracePeriod_ != 0, "zero grace period");
        locker = IUniV3LPLocker(locker_);
        permanentLockEnd = permanentLockEnd_;
        lpGracePeriod = lpGracePeriod_;
        for (uint256 i; i < adapters_.length; ++i) {
            require(adapters_[i].code.length != 0, "adapter has no code");
            isAdapter[adapters_[i]] = true;
        }
    }

    // ─── Open ────────────────────────────────────────────────────────────

    function openRound(OpenParams calldata p) external nonReentrant returns (uint256 roundId) {
        _validate(p);
        roundId = ++roundCount;
        Round storage r = _rounds[roundId];
        r.creator = msg.sender;
        r.token = p.token;
        r.preset = p.preset;
        r.lpShareBps = p.lpShareBps;
        r.tgeBps = p.tgeBps;
        r.sellAmount = p.sellAmount;
        r.tokenReserve = uint128(uint256(p.sellAmount) * p.lpShareBps / BPS);
        r.depositAmount = p.depositAmount;
        r.minBidSize = p.minBidSize;
        r.tickSize = p.tickSize;
        r.reservePrice = p.reservePrice;
        r.commitEnd = p.commitEnd;
        r.revealEnd = p.revealEnd;
        r.lockDuration = p.lockDuration;
        r.cliff = p.cliff;
        r.vestDuration = p.vestDuration;
        r.allowlistRoot = p.allowlistRoot;
        r.lockFeeTier = p.lockFeeTier;
        for (uint256 i; i < p.dexSplits.length; ++i) {
            _splits[roundId].push(p.dexSplits[i]);
        }
        _initBook(roundId, p.sellAmount);

        uint256 need = uint256(p.sellAmount) + r.tokenReserve;
        uint256 before = IERC20Minimal(p.token).balanceOf(address(this));
        p.token.safeTransferFrom(msg.sender, address(this), need);
        require(IERC20Minimal(p.token).balanceOf(address(this)) - before == need, "fee-on-transfer token");
        emit RoundOpened(roundId, msg.sender, p.token, p.preset, p.allowlistURI);
    }

    function _validate(OpenParams calldata p) private view {
        require(p.token.code.length != 0, "token has no code");
        require(p.sellAmount != 0, "zero sell amount");
        require(p.tickSize != 0, "zero tick");
        require(p.reservePrice != 0 && p.reservePrice % p.tickSize == 0, "reserve off grid");
        require(p.minBidSize != 0 && p.depositAmount > p.minBidSize, "deposit must exceed min bid");
        // Some amount at the reserve price must land in [minBidSize, depositAmount); otherwise no
        // bid can ever be valid and every deposit would be burned (second review, L2).
        require(
            uint256(p.reservePrice) <= (uint256(p.depositAmount) - p.minBidSize) * PRICE_SCALE, "no valid bid possible"
        );
        require(p.commitEnd > block.timestamp && p.revealEnd > p.commitEnd, "bad windows");
        require(p.lpShareBps <= BPS, "lp share > 100%");
        if (p.lpShareBps == 0) {
            require(p.dexSplits.length == 0, "splits without LP");
        } else {
            require(p.dexSplits.length != 0 && p.dexSplits.length <= MAX_SPLITS, "bad split count");
            uint256 sum;
            for (uint256 i; i < p.dexSplits.length; ++i) {
                require(isAdapter[p.dexSplits[i].adapter], "adapter not allowed");
                require(IDexAdapter(p.dexSplits[i].adapter).supportsFee(p.dexSplits[i].fee), "fee tier not supported");
                require(p.dexSplits[i].bps != 0, "zero split");
                sum += p.dexSplits[i].bps;
            }
            require(sum == BPS, "splits must sum to 100%");
            require(bytes(p.lockFeeTier).length != 0, "missing lock fee tier");
        }
        if (p.preset == Preset.Degen) {
            require(p.lpShareBps != 0, "degen needs LP");
            require(p.allowlistRoot == bytes32(0), "degen is open");
            require(p.tgeBps == 0 && p.cliff == 0 && p.vestDuration == 0, "degen has no vesting");
            require(p.lockDuration == 0, "degen lock is permanent");
        } else {
            if (p.vestDuration == 0) require(p.tgeBps == 0 && p.cliff == 0, "vesting fields without duration");
            else require(p.tgeBps < BPS, "tge must be below 100%");
            if (p.lpShareBps != 0) require(p.lockDuration >= MIN_RAISE_LOCK, "lock too short");
            else require(p.lockDuration == 0, "lock without LP");
        }
    }

    // ─── Commit / reveal hooks ──────────────────────────────────────────

    function _sealTerms(uint256 roundId)
        internal
        view
        override
        returns (uint256 deposit, uint256 commitEnd, uint256 revealEnd, bytes32 allowlistRoot)
    {
        Round storage r = _rounds[roundId];
        require(r.creator != address(0), "unknown round");
        return (r.depositAmount, r.commitEnd, r.revealEnd, r.allowlistRoot);
    }

    function _onReveal(uint256 roundId, address bidder, uint96 price, uint96 amount, uint256 hint) internal override {
        Round storage r = _rounds[roundId];
        require(price % r.tickSize == 0 && price >= r.reservePrice, "price off grid or below reserve");
        require(amount != 0, "zero amount");
        require(_mulDivUp(price, amount, PRICE_SCALE) < r.depositAmount, "bid exceeds deposit");
        // The minimum applies to what the bid would pay at the reserve price, so every bid — and
        // every price level it creates — is worth at least minBidSize if it wins (second review, L3).
        require(_mulDivUp(r.reservePrice, amount, PRICE_SCALE) >= r.minBidSize, "below minimum bid");
        bids[roundId][bidder] = Bid(price, amount);
        _addBid(roundId, price, amount, hint);
    }

    // ─── Settle ─────────────────────────────────────────────────────────

    /// @notice Advance clearing by up to `maxSteps` price levels. Anyone, after the reveal window.
    function settle(uint256 roundId, uint256 maxSteps) external nonReentrant returns (bool done) {
        Round storage r = _rounds[roundId];
        require(r.creator != address(0), "unknown round");
        require(block.timestamp >= r.revealEnd, "reveal window open");
        done = _settleStep(roundId, maxSteps);
        if (done) {
            r.settledAt = uint64(block.timestamp);
            Book storage b = _books[roundId];
            emit Cleared(roundId, b.clearingPrice, b.sold, b.oversubscribed);
        }
    }

    // ─── LP ─────────────────────────────────────────────────────────────

    /// @notice Seed and lock the LP at the clearing price, then open token delivery. Anyone, once settled.
    function seedLP(uint256 roundId) external nonReentrant {
        Round storage r = _rounds[roundId];
        Book storage b = _books[roundId];
        require(b.settled, "not settled");
        require(!r.lpDone, "LP already done");
        (uint256 lpTokens, uint256 lpMon) = _lpTargets(roundId, r, b);
        bool seeded = lpTokens != 0 && lpMon != 0;
        if (seeded) _seed(roundId, r, b.clearingPrice, lpTokens, lpMon);
        r.lpDone = true;
        r.claimsOpen = true;
        _recordUnsold(r, b);
        emit ClaimsOpened(roundId, seeded);
    }

    /// @notice Liveness escape: if seeding stays blocked for `lpGracePeriod` after settlement, anyone may
    ///         abandon the LP. Its MON share is burned — not returned to anyone — so blocking the pool
    ///         never pays. Makes no token transfers, so a misbehaving token cannot block it either.
    function abandonLP(uint256 roundId) external nonReentrant {
        Round storage r = _rounds[roundId];
        Book storage b = _books[roundId];
        require(b.settled, "not settled");
        require(!r.lpDone, "LP already done");
        require(block.timestamp >= uint256(r.settledAt) + lpGracePeriod, "grace period not over");
        (, uint256 lpMon) = _lpTargets(roundId, r, b);
        r.lpDone = true;
        r.lpAbandoned = true;
        r.claimsOpen = true;
        r.lpMonBurned = lpMon;
        _recordUnsold(r, b); // the whole reserve is unused
        if (lpMon != 0) _debit(roundId, lpMon);
        emit LPAbandoned(roundId, lpMon);
        emit ClaimsOpened(roundId, false);
        if (lpMon != 0) SafeTransferLib.sendValue(BURN, lpMon);
    }

    /// @notice Transfer unsold supply and dust owed to its recipient (burn for Degen, creator for Raise).
    ///         Separate and retryable, so opening claims never depends on this transfer succeeding.
    function disposeUnsold(uint256 roundId) external nonReentrant {
        _disposeOwed(roundId, _rounds[roundId]);
    }

    function _lpTargets(uint256 roundId, Round storage r, Book storage b)
        private
        view
        returns (uint256 lpTokens, uint256 lpMon)
    {
        uint256 soldLB = _soldLowerBound(roundId);
        if (r.lpShareBps == 0 || soldLB == 0) return (0, 0);
        lpTokens = soldLB * r.lpShareBps / BPS;
        lpMon = (soldLB * b.clearingPrice / PRICE_SCALE) * r.lpShareBps / BPS;
    }

    function _seed(uint256 roundId, Round storage r, uint256 price, uint256 lpTokens, uint256 lpMon) private {
        _debit(roundId, lpMon); // reverts if this round cannot cover it
        _seeding = true;
        DexSplit[] storage splits = _splits[roundId];
        uint256 tokensLeft = lpTokens;
        uint256 monLeft = lpMon;
        uint256 tokensUsed;
        uint256 monUsed;
        for (uint256 i; i < splits.length; ++i) {
            DexSplit memory s = splits[i];
            bool isLast = i == splits.length - 1;
            uint256 tok = isLast ? tokensLeft : lpTokens * s.bps / BPS;
            uint256 mon = isLast ? monLeft : lpMon * s.bps / BPS;
            tokensLeft -= tok;
            monLeft -= mon;
            (uint256 t, uint256 m) = _seedOne(roundId, r, s, price, tok, mon);
            tokensUsed += t;
            monUsed += m;
        }
        _seeding = false;
        r.lpTokensUsed = tokensUsed;
        r.lpMonSpent = monUsed;
        _tokensOut(r, tokensUsed);
        // Rounding dust the pool did not take stays with the round and reaches the creator.
        if (lpMon > monUsed) _credit(roundId, lpMon - monUsed);
    }

    function _seedOne(uint256 roundId, Round storage r, DexSplit memory s, uint256 price, uint256 tok, uint256 mon)
        private
        returns (uint256 tokUsed, uint256 monUsed)
    {
        address token = r.token;
        uint256 tokBefore = IERC20Minimal(token).balanceOf(address(this));
        uint256 monBefore = address(this).balance;
        token.safeApprove(s.adapter, tok);
        (address npm, uint256 nftId) = IDexAdapter(s.adapter).seed{value: mon}(token, tok, price, s.fee, address(this));
        token.safeApprove(s.adapter, 0);
        tokUsed = tokBefore - IERC20Minimal(token).balanceOf(address(this));
        monUsed = monBefore - address(this).balance;
        require(tokUsed <= tok && monUsed <= mon, "adapter overspent");
        require(IERC721Minimal(npm).ownerOf(nftId) == address(this), "position not received");

        bool permanent = r.preset == Preset.Degen;
        IERC721Minimal(npm).approve(address(locker), nftId);
        uint256 lockId = locker.lock(
            npm,
            nftId,
            permanent ? address(this) : r.creator,
            r.creator,
            permanent ? permanentLockEnd : block.timestamp + r.lockDuration,
            r.lockFeeTier
        );
        emit LPSeeded(roundId, s.adapter, npm, nftId, tokUsed, monUsed, lockId);
    }

    /// @dev Called exactly once, when the LP is seeded or abandoned.
    function _recordUnsold(Round storage r, Book storage b) private {
        r.unsoldOwed += (uint256(r.sellAmount) - b.sold) + (uint256(r.tokenReserve) - r.lpTokensUsed);
    }

    function _disposeOwed(uint256 roundId, Round storage r) private {
        uint256 amount = r.unsoldOwed;
        require(amount != 0, "nothing to dispose");
        r.unsoldOwed = 0;
        address to = _unsoldRecipient(r, _books[roundId]);
        _tokensOut(r, amount);
        emit UnsoldDisposed(roundId, to, amount);
        r.token.safeTransfer(to, amount);
    }

    /// @dev Decision #29: Degen burns unsold supply, Raise returns it. A round that sold nothing
    ///      returns everything to the creator: there are no buyers to protect.
    function _unsoldRecipient(Round storage r, Book storage b) private view returns (address) {
        if (b.sold == 0 || r.preset == Preset.Raise) return r.creator;
        return BURN;
    }

    // ─── Claim ──────────────────────────────────────────────────────────

    /// @notice Refund and tokens for msg.sender, whichever are available and not yet claimed.
    function claim(uint256 roundId) external nonReentrant {
        bool refunded = accounts[roundId][msg.sender].settled;
        if (!refunded) _refund(roundId, msg.sender);
        if (_rounds[roundId].claimsOpen && !tokensClaimed[roundId][msg.sender]) {
            _deliver(roundId, msg.sender);
        } else {
            require(!refunded, "nothing to claim");
        }
    }

    /// @notice Refund of `deposit − paid` to `bidder`. Anyone may trigger it; funds always go to the bidder.
    ///         Available as soon as the round is settled, whatever state the token or the LP is in.
    function claimRefund(uint256 roundId, address bidder) external nonReentrant {
        _refund(roundId, bidder);
    }

    /// @notice Tokens won, to `bidder`. Anyone may trigger it; tokens always go to the bidder.
    function claimTokens(uint256 roundId, address bidder) external nonReentrant {
        if (!accounts[roundId][bidder].settled) _refund(roundId, bidder);
        _deliver(roundId, bidder);
    }

    function _refund(uint256 roundId, address bidder) private {
        Round storage r = _rounds[roundId];
        require(_books[roundId].settled, "not settled");
        require(commitments[roundId][bidder].revealed, "not revealed");
        Bid memory bid = bids[roundId][bidder];
        uint256 alloc = _allocation(roundId, bid.price, bid.amount);
        uint256 paid = _mulDivUp(alloc, _books[roundId].clearingPrice, PRICE_SCALE);
        uint256 refund = _settleAccount(roundId, bidder, paid);
        r.collected += paid;
        r.allocatedTotal += alloc;
        emit Claimed(roundId, bidder, alloc, paid, refund);
        if (refund != 0) SafeTransferLib.sendValue(bidder, refund);
    }

    function _deliver(uint256 roundId, address bidder) private {
        Round storage r = _rounds[roundId];
        require(r.claimsOpen, "claims not open");
        require(!tokensClaimed[roundId][bidder], "tokens already claimed");
        tokensClaimed[roundId][bidder] = true;
        Bid memory bid = bids[roundId][bidder];
        uint256 alloc = _allocation(roundId, bid.price, bid.amount);
        uint256 release = alloc;
        if (r.vestDuration != 0 && alloc != 0) {
            release = alloc * r.tgeBps / BPS;
            vests[roundId][bidder] = Vest(uint128(alloc), uint128(release));
        }
        emit TokensClaimed(roundId, bidder, release);
        if (release != 0) {
            _tokensOut(r, release);
            r.token.safeTransfer(bidder, release);
        }
    }

    /// @notice Raise rounds: release tokens vested since the last call.
    function claimVested(uint256 roundId) external nonReentrant {
        Round storage r = _rounds[roundId];
        Vest storage v = vests[roundId][msg.sender];
        require(v.total != 0, "no vesting");
        uint256 vested = _vestedAmount(r, v.total);
        uint256 amount = vested - v.released;
        require(amount != 0, "nothing vested");
        v.released = uint128(vested);
        _tokensOut(r, amount);
        emit VestedClaimed(roundId, msg.sender, amount);
        r.token.safeTransfer(msg.sender, amount);
    }

    /// @notice Creator's share of the MON raised: payments collected so far, minus the LP's share
    ///         (spent on the pool, or burned if the LP was abandoned).
    function withdrawProceeds(uint256 roundId) external nonReentrant {
        Round storage r = _rounds[roundId];
        require(msg.sender == r.creator, "not creator");
        require(r.lpDone, "LP not done");
        uint256 amount = _creatorAvailable(r);
        require(amount != 0, "nothing to withdraw");
        r.withdrawn += amount;
        _debit(roundId, amount);
        emit ProceedsWithdrawn(roundId, amount);
        SafeTransferLib.sendValue(r.creator, amount);
    }

    /// @notice Once every revealed bidder has been refunded, dispose of pro-rata rounding dust like unsold supply.
    function sweepDust(uint256 roundId) external nonReentrant {
        Round storage r = _rounds[roundId];
        Ledger storage l = ledgers[roundId];
        require(r.lpDone && !r.dustSwept, "not sweepable");
        require(l.claims == l.reveals, "refunds outstanding");
        r.dustSwept = true;
        r.unsoldOwed += _books[roundId].sold - r.allocatedTotal;
        if (r.unsoldOwed != 0) _disposeOwed(roundId, r);
    }

    // ─── Views ──────────────────────────────────────────────────────────

    function getRound(uint256 roundId) external view returns (Round memory) {
        return _rounds[roundId];
    }

    function splitsOf(uint256 roundId) external view returns (DexSplit[] memory) {
        return _splits[roundId];
    }

    /// @notice What `bidder` receives: tokens allocated, MON paid, MON refunded. Reverts until settled.
    function quote(uint256 roundId, address bidder)
        external
        view
        returns (uint256 allocated, uint256 paid, uint256 refund)
    {
        require(commitments[roundId][bidder].revealed, "not revealed");
        Bid memory bid = bids[roundId][bidder];
        allocated = _allocation(roundId, bid.price, bid.amount);
        paid = _mulDivUp(allocated, _books[roundId].clearingPrice, PRICE_SCALE);
        refund = uint256(_rounds[roundId].depositAmount) - paid;
    }

    function vestedOf(uint256 roundId, address bidder) external view returns (uint256 vested, uint256 released) {
        Vest storage v = vests[roundId][bidder];
        if (v.total == 0) return (0, 0);
        return (_vestedAmount(_rounds[roundId], v.total), v.released);
    }

    function creatorAvailable(uint256 roundId) external view returns (uint256) {
        return _creatorAvailable(_rounds[roundId]);
    }

    // ─── Internals ──────────────────────────────────────────────────────

    function _creatorAvailable(Round storage r) private view returns (uint256) {
        uint256 lpCost = r.lpMonSpent + r.lpMonBurned;
        uint256 entitled = r.collected > lpCost ? r.collected - lpCost : 0;
        return entitled > r.withdrawn ? entitled - r.withdrawn : 0;
    }

    function _vestedAmount(Round storage r, uint256 total) private view returns (uint256) {
        uint256 tge = total * r.tgeBps / BPS;
        uint256 start = uint256(r.settledAt) + r.cliff;
        if (block.timestamp <= start) return tge;
        uint256 elapsed = block.timestamp - start;
        if (elapsed >= r.vestDuration) return total;
        return tge + (total - tge) * elapsed / r.vestDuration;
    }

    function _tokensOut(Round storage r, uint256 amount) private {
        r.tokensOut += amount;
        require(r.tokensOut <= uint256(r.sellAmount) + r.tokenReserve, "token accounting");
    }

    function _mulDivUp(uint256 a, uint256 b, uint256 d) private pure returns (uint256) {
        uint256 x = a * b;
        return x == 0 ? 0 : (x - 1) / d + 1;
    }

    /// @dev Only adapters return MON, and only while seeding: anything else would be unaccounted.
    receive() external payable {
        require(_seeding && isAdapter[msg.sender], "unexpected MON");
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
