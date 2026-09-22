// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

import {SealingLayer} from "./SealingLayer.sol";
import {ClearingCore, IterableOrderedOrderSet} from "./ClearingCore.sol";

/// @title AuctionEngine
/// @notice Coordinating contract for one round = commit -> reveal -> clear -> settle cycle.
/// @dev Wires SealingLayer (commit/reveal + deposit ledger, inherited unchanged) to
///      ClearingCore (price discovery + fill accounting, composed unchanged).
///      No logic in either contract is modified here; this contract only supplies the
///      abstract hooks (_roundTerms, _allowed, _placeOrder, _settled) and the
///      lifecycle entry points (openRound, precalculate, settle, claim).
///
///      Reveal mapping: reveal(price, quantity) places one clearing-core order with
///      buyAmount = price and sellAmount = quantity, so the limit price
///      (bidding per auctioning) is quantity / price. This is the only mapping that
///      uses both reveal fields without inventing scaling arithmetic (bug #8), and it
///      keeps the core's price ordering intact. If the docs mean a different encoding
///      for `price`, say so — the mapping lives in exactly one place (_placeOrder).
///
///      Money path: deposits are native value. The uniform deposit covers the bid
///      (reveal requires quantity < depositLocked), so at claim the filled bidding
///      amount (quantity - biddingRefund from the core) is forwarded to fillDestination
///      and the remainder is refunded. The auctioning-token leg is recorded as a
///      fill entitlement, not transferred:
///      // TODO: not specified: auctioning-token custody — standard, escrow vs mint,
///      // and who funds it at openRound. Flow 1 says the creator locks supply, but no
///      // token is named, so no transfer is implemented.
///
///      Unspecified items are constructor parameters (reserve price, funding threshold,
///      atomic closure, core address, slash/fill destinations, deposit cap, clock mode).
///      Per-round specified items live on openRound (06-api.md).
///      // TODO: not specified (Q7): allowlistRoot is stored and emitted but not
///      // enforced — commit has no proof argument, so there is nothing to verify against.
///      // TODO: not specified (Q4/Q5): autoLP is stored and emitted only. LPSeeder is an
///      // empty stub; DEX, pool type, lock duration and sandwich mitigation are unknown.
///      // TODO: not specified: vesting schedule shape for the Raise preset — no param.
///      // TODO: not specified (Q1): what slash/fill destinations mean (creator, stayers,
///      // burn) — the deployer chooses the addresses; this contract only pays them.
///      // TODO: not specified (Q2): one commitment per bidder per round is pinned by
///      // SealingLayer (commitmentsPerBidder must be 1), so each bidder places one order.
contract AuctionEngine is SealingLayer {
    // Preset set per 05-data-model.md: Degen / Raise / Vault.
    enum Preset {
        Degen,
        Raise,
        Vault
    }

    struct Round {
        uint256 coreRoundId;
        Preset preset;
        address auctioningToken;
        address biddingToken;
        uint96 sellAmount;
        uint96 minBidSize;
        uint256 depositAmount;
        uint64 commitEnd;
        uint64 revealEnd;
        bytes32 allowlistRoot;
        bool autoLP;
        bool exists;
    }

    struct RevealedBid {
        uint96 price;
        uint96 quantity;
        uint64 coreUserId;
        bool claimed;
    }

    ClearingCore public immutable core;
    uint96 public immutable reserveMinBuyAmount;
    uint256 public immutable minFundingThreshold;
    bool public immutable atomicClosureAllowed;

    uint256 public roundCounter;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => uint256) public coreRoundIds;
    mapping(uint256 => mapping(address => RevealedBid)) public bids;
    mapping(uint256 => mapping(address => uint256)) public fillEntitlement;

    event RoundOpened(uint256 indexed roundId, Preset preset, uint96 sellAmount, uint64 commitEnd, uint64 revealEnd);
    event Cleared(uint256 indexed roundId, uint96 clearingPriceNum, uint96 clearingPriceDen, uint96 filledVolume);
    event Claimed(uint256 indexed roundId, address indexed bidder, uint256 filled, uint256 refunded);

    constructor(
        address clearingCore_,
        address payable slashDestination_,
        address payable fillDestination_,
        uint256 depositCap_,
        bool windowsUseBlocks_,
        uint256 commitmentsPerBidder_,
        uint96 reserveMinBuyAmount_,
        uint256 minFundingThreshold_,
        bool atomicClosureAllowed_
    ) SealingLayer(slashDestination_, fillDestination_, depositCap_, windowsUseBlocks_, commitmentsPerBidder_) {
        require(clearingCore_ != address(0), "zero clearing core");
        require(reserveMinBuyAmount_ > 0, "zero reserve price");
        core = ClearingCore(clearingCore_);
        reserveMinBuyAmount = reserveMinBuyAmount_;
        minFundingThreshold = minFundingThreshold_;
        atomicClosureAllowed = atomicClosureAllowed_;
    }

    /// @notice Open a round per Flow 1 / 06-api.md openRound(params).
    /// @dev Fail-fast mirror of commit's round-deposit checks so a DOA round cannot open.
    function openRound(
        Preset preset,
        address auctioningToken,
        address biddingToken,
        uint96 sellAmount,
        uint96 minBidSize,
        uint256 depositAmount,
        uint64 commitEnd,
        uint64 revealEnd,
        bytes32 allowlistRoot,
        bool autoLP
    ) external nonReentrant returns (uint256 roundId) {
        require(minBidSize != 0, "missing minBidSize");
        require(sellAmount > 0, "zero sell amount");
        require(depositAmount > minBidSize, "deposit must exceed minBid");
        require(depositAmount <= depositCap, "deposit exceeds cap");
        require(commitEnd > _now(), "commit window closed");
        require(commitEnd < revealEnd, "bad windows");
        uint256 coreRoundId = _createCoreRound(sellAmount, minBidSize);

        roundCounter += 1;
        roundId = roundCounter;
        Round storage r = rounds[roundId];
        r.coreRoundId = coreRoundId;
        r.preset = preset;
        r.auctioningToken = auctioningToken;
        r.biddingToken = biddingToken;
        r.sellAmount = sellAmount;
        r.minBidSize = minBidSize;
        r.depositAmount = depositAmount;
        r.commitEnd = commitEnd;
        r.revealEnd = revealEnd;
        r.allowlistRoot = allowlistRoot;
        r.autoLP = autoLP;
        r.exists = true;
        coreRoundIds[roundId] = coreRoundId;
        emit RoundOpened(roundId, preset, sellAmount, commitEnd, revealEnd);
    }

    /// @dev Creates the clearing-core round. Split out of openRound to avoid
    ///      stack-too-deep with 10 openRound params; no logic lives here beyond
    ///      the minimum-bid-size wiring below.
    function _createCoreRound(uint96 sellAmount, uint96 minBidSize) private returns (uint256) {
        // The core rejects sellAmount <= its minimum with strict > (gas-DoS floor),
        // while the sealing layer admits quantity >= minBidSize. Passing minBidSize - 1
        // as the core minimum makes the documented "quantity >= minBidSize" true
        // end to end: any reveal that passes the sealing check also passes the core
        // check, so no bidder is trapped in a commitment they can never reveal.
        uint256 coreMinimum = uint256(minBidSize) - 1;
        require(coreMinimum >= core.minimumBiddingAmountPerOrderFloor(), "minBidSize below core floor");
        return core.createRound(sellAmount, reserveMinBuyAmount, coreMinimum, minFundingThreshold, atomicClosureAllowed);
    }

    /// @notice Advance multi-transaction settlement (EasyAuction pattern). Anyone.
    function precalculate(uint256 roundId, uint256 iterationSteps) external nonReentrant {
        Round storage r = rounds[roundId];
        require(r.exists, "unknown round");
        require(_now() >= r.revealEnd, "reveal window open");
        core.precalculateSellAmountSum(r.coreRoundId, iterationSteps);
    }

    /// @notice Find the crossing bid and set the uniform clearing price. Anyone.
    function settle(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        require(r.exists, "unknown round");
        require(_now() >= r.revealEnd, "reveal window open");
        core.settleAuction(r.coreRoundId);
        (uint96 num, uint96 den, uint96 vol) = core.getClearingPrice(r.coreRoundId);
        emit Cleared(roundId, num, den, vol);
    }

    /// @notice Pay a revealed bidder their fill entitlement and release the deposit
    ///         net of the fill (Flow 4 step 4). Winners get fills, losers get refunds.
    /// @dev No nonReentrant here: _releaseDeposit is itself guarded and would revert
    ///      if nested. Reentrancy is blocked by effects-first ordering (claimed = true
    ///      plus the core removing the order) before any native transfer.
    function claim(uint256 roundId) external {
        Round storage r = rounds[roundId];
        require(r.exists, "unknown round");
        require(_settled(roundId), "not settled");
        require(commitments[roundId][msg.sender].revealed, "not revealed");
        RevealedBid storage bid = bids[roundId][msg.sender];
        require(bid.quantity != 0 && !bid.claimed, "nothing to claim");
        bid.claimed = true;

        bytes32 order = IterableOrderedOrderSet.encodeOrder(bid.coreUserId, bid.price, bid.quantity);
        bytes32[] memory orders = new bytes32[](1);
        orders[0] = order;
        (uint256 auctioningFill, uint256 biddingRefund) = core.claimFromParticipantOrder(r.coreRoundId, orders);
        require(biddingRefund <= bid.quantity, "refund exceeds bid");
        uint256 appliedToFill = uint256(bid.quantity) - biddingRefund;

        fillEntitlement[roundId][msg.sender] = auctioningFill;
        _releaseDeposit(roundId, msg.sender, appliedToFill);
        emit Claimed(roundId, msg.sender, auctioningFill, deposits[roundId][msg.sender].refunded);
    }

    // ─── SealingLayer hooks ──────────────────────────────────────────────

    function _roundTerms(uint256 roundId)
        internal
        view
        override
        returns (uint256 depositAmount, uint96 minBidSize, uint64 commitEnd, uint64 revealEnd)
    {
        Round storage r = rounds[roundId];
        require(r.exists, "unknown round");
        return (r.depositAmount, r.minBidSize, r.commitEnd, r.revealEnd);
    }

    function _allowed(uint256, address) internal pure override returns (bool) {
        // TODO: not specified (Q7): allowlist format and proof verification.
        return true;
    }

    function _placeOrder(uint256 roundId, address bidder, uint96 price, uint96 quantity) internal override {
        Round storage r = rounds[roundId];
        require(r.exists, "unknown round");
        uint96[] memory buys = new uint96[](1);
        buys[0] = price;
        uint96[] memory sells = new uint96[](1);
        sells[0] = quantity;
        bytes32[] memory prevs = new bytes32[](1);
        // QUEUE_START is always a valid hint (smaller than every order); the core
        // walks forward to the sorted position. A caller-supplied hint would save gas
        // but commit/reveal carry no hint argument — unspecified, so not implemented.
        prevs[0] = IterableOrderedOrderSet.QUEUE_START;
        uint64 userId = core.placeSellOrdersOnBehalf(r.coreRoundId, buys, sells, prevs, bidder);
        bids[roundId][bidder] = RevealedBid(price, quantity, userId, false);
    }

    function _settled(uint256 roundId) internal view override returns (bool) {
        Round storage r = rounds[roundId];
        if (!r.exists) return false;
        // getClearingPrice reverts unless the core round is settled; reading the
        // full roundData tuple would hold 12 fields on the stack at once.
        try core.getClearingPrice(r.coreRoundId) returns (uint96, uint96, uint96) {
            return true;
        } catch {
            return false;
        }
    }

    function _now() private view returns (uint256) {
        return windowsUseBlocks ? block.number : block.timestamp;
    }
}
