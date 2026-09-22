// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

import {SealingLayer} from "./SealingLayer.sol";
import {UniformClearing} from "./UniformClearing.sol";
import {SafeTransferLib} from "./lib/SafeTransferLib.sol";
import {IDexAdapter, IUniV3LPLocker, IERC721Minimal, IERC20Minimal} from "./interfaces/ILiquidity.sol";

/// @title AuctionEngine — sealed-bid fair launch (Degen and Raise presets)
/// @notice Round lifecycle: openRound → commit → reveal → settle → seedLP → claim.
///         A bid is a max price per token plus a token amount (10-decisions.md #22). Winners pay the
///         uniform clearing price; the overpayment is refunded from their uniform deposit.
/// @dev Money flows, all per round and all checked by `roundBalance` / `tokensOut`:
///      - MON in: one uniform deposit per commit.
///      - MON out: refunds at claim; unrevealed deposits burned (#30); the LP share (#25); creator proceeds.
///      - Tokens in: `sellAmount` for the auction plus the worst-case LP reserve, pulled at open.
///      - Tokens out: allocations at claim (or vested, Raise #32); the LP position; unsold supply,
///        burned for Degen and returned for Raise (#29), or returned if nothing sold at all.
///      Claims open only after the LP is seeded, so no auctioned token exists outside the contract
///      before the pool does (#27, bug #7). If seeding is blocked — for example someone initialised
///      the pool at a bad price — anyone can open claims after `lpGracePeriod`; seeding then retries
///      at the pool's own price, and unused LP MON is burned so nobody profits from the griefing.
contract AuctionEngine is SealingLayer, UniformClearing {
    using SafeTransferLib for address;

    uint256 public constant PRICE_SCALE = 1e18;
    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_SPLITS = 4;

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
        uint96 minBidSize; // on a bid's max spend, in MON wei
        uint96 tickSize; // price grid, MON wei per 1e18 token units
        uint96 reservePrice;
        uint64 commitEnd;
        uint64 revealEnd;
        bytes32 allowlistRoot; // Raise only; zero = open
        string allowlistURI; // where bidders fetch the tree to build proofs
        uint16 lpShareBps; // share of tokens sold and MON raised that goes to the LP
        DexSplit[] dexSplits;
        uint64 lockEnd; // Raise only; Degen locks are permanent
        string lockFeeTier; // GoPlus fee name: DEFAULT, LVP or LLP
        uint16 tgeBps; // Raise vesting: share paid at claim
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
        uint64 lockEnd;
        uint64 cliff;
        uint64 vestDuration;
        uint64 settledAt;
        bytes32 allowlistRoot;
        string lockFeeTier;
        bool claimsOpen;
        bool lpDone;
        bool auctionUnsoldDisposed;
        bool dustSwept;
        uint256 lpMonSpent;
        uint256 lpMonBurned;
        uint256 lpTokensUsed;
        uint256 collected;
        uint256 withdrawn;
        uint256 allocatedTotal;
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
    event ClaimsOpened(uint256 indexed roundId, bool lpSeeded);
    event UnsoldDisposed(uint256 indexed roundId, address indexed to, uint256 amount);
    event Claimed(uint256 indexed roundId, address indexed bidder, uint256 allocated, uint256 paid, uint256 refund);
    event VestedClaimed(uint256 indexed roundId, address indexed bidder, uint256 amount);
    event ProceedsWithdrawn(uint256 indexed roundId, uint256 amount);

    /// @param locker_           GoPlus UniV3LPLocker.
    /// @param adapters_         The only DEX adapters creators may choose; fixed forever, so no creator can
    ///                          route LP proceeds to a contract of their own.
    /// @param permanentLockEnd_ Unlock time passed to the locker for Degen rounds. The engine is the lock
    ///                          owner and has no unlock path, so the lock is permanent regardless.
    /// @param lpGracePeriod_    How long after settlement seeding may stay blocked before anyone can open claims.
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
        r.lockEnd = p.lockEnd;
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
        require(p.commitEnd > block.timestamp && p.revealEnd > p.commitEnd, "bad windows");
        require(p.lpShareBps <= BPS, "lp share > 100%");
        if (p.lpShareBps == 0) {
            require(p.dexSplits.length == 0, "splits without LP");
        } else {
            require(p.dexSplits.length != 0 && p.dexSplits.length <= MAX_SPLITS, "bad split count");
            uint256 sum;
            for (uint256 i; i < p.dexSplits.length; ++i) {
                require(isAdapter[p.dexSplits[i].adapter], "adapter not allowed");
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
            require(p.lockEnd == 0, "degen lock is permanent");
        } else {
            if (p.vestDuration == 0) require(p.tgeBps == 0 && p.cliff == 0, "vesting fields without duration");
            else require(p.tgeBps < BPS, "tge must be below 100%");
            if (p.lpShareBps != 0) require(p.lockEnd > p.revealEnd, "lock ends before reveal");
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
        uint256 maxSpend = _mulDivUp(price, amount, PRICE_SCALE);
        require(maxSpend >= r.minBidSize, "below minimum bid");
        require(maxSpend < r.depositAmount, "bid exceeds deposit");
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

    /// @notice Seed and lock the LP, dispose of unsold supply, and open claims. Anyone, once settled.
    function seedLP(uint256 roundId) external nonReentrant {
        Round storage r = _rounds[roundId];
        Book storage b = _books[roundId];
        require(b.settled, "not settled");
        require(!r.lpDone, "already seeded");
        bool relaxed = r.claimsOpen;
        bool seeded;
        uint256 soldLB = _soldLowerBound(roundId);
        if (r.lpShareBps != 0 && soldLB != 0) {
            uint256 price = b.clearingPrice;
            uint256 lpTokens = soldLB * r.lpShareBps / BPS;
            uint256 lpMon = (soldLB * price / PRICE_SCALE) * r.lpShareBps / BPS;
            if (lpTokens != 0 && lpMon != 0) {
                _seed(roundId, r, price, lpTokens, lpMon, relaxed);
                seeded = true;
            }
        }
        r.lpDone = true;
        r.claimsOpen = true;
        _disposeUnsold(roundId, r, b);
        emit ClaimsOpened(roundId, seeded);
    }

    /// @notice Liveness escape: if seeding stays blocked for `lpGracePeriod` after settlement,
    ///         anyone may open claims. `seedLP` stays callable and then seeds at the pool's own price.
    function forceOpenClaims(uint256 roundId) external nonReentrant {
        Round storage r = _rounds[roundId];
        Book storage b = _books[roundId];
        require(b.settled, "not settled");
        require(!r.claimsOpen, "claims already open");
        require(block.timestamp >= uint256(r.settledAt) + lpGracePeriod, "grace period not over");
        r.claimsOpen = true;
        _disposeUnsold(roundId, r, b);
        emit ClaimsOpened(roundId, false);
    }

    function _seed(uint256 roundId, Round storage r, uint256 price, uint256 lpTokens, uint256 lpMon, bool relaxed)
        private
    {
        _debit(roundId, lpMon); // reverts if this round cannot cover it
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
            (uint256 t, uint256 m) = _seedOne(roundId, r, s, price, tok, mon, relaxed);
            tokensUsed += t;
            monUsed += m;
        }
        r.lpTokensUsed = tokensUsed;
        r.lpMonSpent = monUsed;
        _tokensOut(r, tokensUsed);
        uint256 unused = lpMon - monUsed;
        if (unused != 0) {
            if (relaxed) {
                // Seeding was blocked and now happens at someone else's price: burn what the pool
                // didn't take, so neither the creator nor the griefer gains from the block.
                r.lpMonBurned = unused;
                SafeTransferLib.sendValue(BURN, unused);
            } else {
                _credit(roundId, unused); // rounding dust: stays with the round, reaches the creator
            }
        }
    }

    function _seedOne(
        uint256 roundId,
        Round storage r,
        DexSplit memory s,
        uint256 price,
        uint256 tok,
        uint256 mon,
        bool relaxed
    ) private returns (uint256 tokUsed, uint256 monUsed) {
        address token = r.token;
        uint256 tokBefore = IERC20Minimal(token).balanceOf(address(this));
        uint256 monBefore = address(this).balance;
        token.safeApprove(s.adapter, tok);
        (address npm, uint256 nftId) = IDexAdapter(s.adapter).seed{value: mon}(token, tok, price, s.fee, relaxed, address(this));
        token.safeApprove(s.adapter, 0);
        tokUsed = tokBefore - IERC20Minimal(token).balanceOf(address(this));
        monUsed = monBefore - address(this).balance;
        require(tokUsed <= tok && monUsed <= mon, "adapter overspent");
        require(IERC721Minimal(npm).ownerOf(nftId) == address(this), "position not received");

        bool permanent = r.preset == Preset.Degen;
        IERC721Minimal(npm).approve(address(locker), nftId);
        uint256 lockId = locker.lock(
            npm, nftId, permanent ? address(this) : r.creator, r.creator, permanent ? permanentLockEnd : r.lockEnd, r.lockFeeTier
        );
        emit LPSeeded(roundId, s.adapter, npm, nftId, tokUsed, monUsed, lockId);
    }

    function _disposeUnsold(uint256 roundId, Round storage r, Book storage b) private {
        uint256 amount;
        if (!r.auctionUnsoldDisposed) {
            r.auctionUnsoldDisposed = true;
            amount += uint256(r.sellAmount) - b.sold;
        }
        if (r.lpDone) amount += uint256(r.tokenReserve) - r.lpTokensUsed;
        if (amount == 0) return;
        address to = _unsoldRecipient(r, b);
        _tokensOut(r, amount);
        r.token.safeTransfer(to, amount);
        emit UnsoldDisposed(roundId, to, amount);
    }

    /// @dev Decision #29: Degen burns unsold supply, Raise returns it. A round that sold nothing
    ///      returns everything to the creator: there are no buyers to protect.
    function _unsoldRecipient(Round storage r, Book storage b) private view returns (address) {
        if (b.sold == 0 || r.preset == Preset.Raise) return r.creator;
        return BURN;
    }

    // ─── Claim ──────────────────────────────────────────────────────────

    /// @notice Tokens won plus the refund of `deposit − paid`. Revealed bidders only, once claims open.
    function claim(uint256 roundId) external nonReentrant {
        Round storage r = _rounds[roundId];
        require(r.claimsOpen, "claims not open");
        require(commitments[roundId][msg.sender].revealed, "not revealed");
        Bid memory bid = bids[roundId][msg.sender];
        uint256 alloc = _allocation(roundId, bid.price, bid.amount);
        uint256 paid = _mulDivUp(alloc, _books[roundId].clearingPrice, PRICE_SCALE);
        uint256 refund = _settleAccount(roundId, msg.sender, paid);
        r.collected += paid;
        r.allocatedTotal += alloc;

        uint256 release = alloc;
        if (r.vestDuration != 0 && alloc != 0) {
            release = alloc * r.tgeBps / BPS;
            vests[roundId][msg.sender] = Vest(uint128(alloc), uint128(release));
        }
        if (release != 0) {
            _tokensOut(r, release);
            r.token.safeTransfer(msg.sender, release);
        }
        emit Claimed(roundId, msg.sender, alloc, paid, refund);
        if (refund != 0) SafeTransferLib.sendValue(msg.sender, refund);
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
        r.token.safeTransfer(msg.sender, amount);
        emit VestedClaimed(roundId, msg.sender, amount);
    }

    /// @notice Creator's share of the MON raised: payments collected so far, minus what went to the LP.
    function withdrawProceeds(uint256 roundId) external nonReentrant {
        Round storage r = _rounds[roundId];
        require(msg.sender == r.creator, "not creator");
        require(r.lpDone, "LP not seeded");
        uint256 amount = _creatorAvailable(r);
        require(amount != 0, "nothing to withdraw");
        r.withdrawn += amount;
        _debit(roundId, amount);
        emit ProceedsWithdrawn(roundId, amount);
        SafeTransferLib.sendValue(r.creator, amount);
    }

    /// @notice After every revealed bidder has claimed, dispose of pro-rata rounding dust like unsold supply.
    function sweepDust(uint256 roundId) external nonReentrant {
        Round storage r = _rounds[roundId];
        Ledger storage l = ledgers[roundId];
        require(r.lpDone && !r.dustSwept, "not sweepable");
        require(l.claims == l.reveals, "claims outstanding");
        r.dustSwept = true;
        Book storage b = _books[roundId];
        uint256 dust = b.sold - r.allocatedTotal;
        if (dust == 0) return;
        address to = _unsoldRecipient(r, b);
        _tokensOut(r, dust);
        r.token.safeTransfer(to, dust);
        emit UnsoldDisposed(roundId, to, dust);
    }

    // ─── Views ──────────────────────────────────────────────────────────

    function getRound(uint256 roundId) external view returns (Round memory) {
        return _rounds[roundId];
    }

    function splitsOf(uint256 roundId) external view returns (DexSplit[] memory) {
        return _splits[roundId];
    }

    /// @notice What `bidder` would receive at claim. Reverts until the round is settled.
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
        return entitled - r.withdrawn;
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

    /// @dev Only adapters return MON (unused LP funds).
    receive() external payable {
        require(isAdapter[msg.sender], "unexpected MON");
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
