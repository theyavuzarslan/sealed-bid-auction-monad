// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

import {SealingLayer} from "../SealingLayer.sol";
import {UniformClearing} from "../UniformClearing.sol";
import {SafeTransferLib} from "../lib/SafeTransferLib.sol";
import {Math} from "../vendor/openzeppelin/utils/math/Math.sol";
import {DemoVault} from "./DemoVault.sol";

/// @title ExitAuction — sealed-bid exit priority for a vault (use case 2, 10-decisions.md #31, #34)
/// @notice Round lifecycle: openExitRound → commit → reveal → settle → claim (exit + refund).
///         A bid is a discount in bps plus a number of vault shares. The clearing core is reused
///         unchanged: price = discount, amount = shares, supply = exit capacity. The highest discounts
///         exit first; every winner pays the clearing discount P, the lowest winning discount.
/// @dev Money flows, per round:
///      - MON in: one uniform deposit per commit, and nothing else (there is no receive()).
///        MON out: the full deposit back once settled (exit bidders pay in discount, not MON), claimable
///        on its own; or burned for non-revealers (#30, inherited).
///      - Shares in: the whole bid, pulled into escrow at reveal. Shares out: allocated shares are
///        redeemed at exit, the rest go back to the bidder. Invariant: escrowed = redeemed + returned.
///        The minimum bid is on shares, which a bid escrows in full whatever its discount (bug #6).
///      - WMON: the redeemed assets never stay here. `(1 − P)` of the allocation's value goes to the
///        bidder, everything else is transferred straight to the vault as a donation (no shares
///        minted), which raises the share price for everyone who stayed.
///      Winners' value is fixed at settlement: each winner is paid on `min(assets now, assets at the
///      settlement share price)`. Without the cap, a winner who claims late would also collect part of
///      the discount donated by winners who claimed earlier (their escrowed shares are still in the
///      supply), so claim order would move money between exiters and away from stayers.
///      Reserve: shares this contract has promised to redeem are reported to the vault
///      (`reservedShares`), and are excluded when sizing the next round, so every settled exit stays
///      payable from the idle buffer.
contract ExitAuction is SealingLayer, UniformClearing {
    using SafeTransferLib for address;

    uint256 public constant BPS = 10_000;

    struct Config {
        uint64 commitDuration; // seconds
        uint64 revealDuration; // seconds
        uint96 depositAmount; // uniform MON deposit per commit, fully refunded once settled
        uint16 tickBps; // discount grid
        uint96 minExitShares; // minimum shares per bid (dust-spam defense, bug #6)
        uint128 maxExitSharesPerRound;
        uint64 roundGapBlocks; // N: blocks between a round's settlement and the next open
        bytes32 allowlistRoot; // Merkle root of holders who may bid; zero = every holder (PRD Vault preset)
    }

    struct ExitRound {
        uint128 capacity; // exit capacity in shares, fixed at open
        uint64 commitEnd;
        uint64 revealEnd;
        uint64 openedBlock;
        uint64 settledBlock;
        uint256 escrowed; // shares pulled in at reveal
        uint256 settleAssets; // vault.convertToAssets(sold) at settlement
        uint256 allocatedTotal; // shares redeemed so far
        uint256 returnedTotal; // shares returned so far
        uint256 assetsRedeemed;
        uint256 paidOut; // WMON sent to exiting holders
        uint256 donated; // WMON sent back to the vault
        uint256 exitsClaimed; // revealed bids whose exit has been claimed
    }

    struct Bid {
        uint96 discountBps;
        uint96 shares;
    }

    DemoVault public immutable vault;
    address public immutable asset; // WMON
    uint64 public immutable commitDuration;
    uint64 public immutable revealDuration;
    uint96 public immutable depositAmount;
    uint16 public immutable tickBps;
    uint96 public immutable minExitShares;
    uint128 public immutable maxExitSharesPerRound;
    uint64 public immutable roundGapBlocks;
    bytes32 public immutable allowlistRoot;

    uint256 public roundCount;
    /// @notice Shares of settled rounds not yet redeemed: an upper bound on what winners can still claim.
    uint256 public pendingExitShares;
    mapping(uint256 => ExitRound) internal _rounds;
    mapping(uint256 => mapping(address => Bid)) public bids;
    mapping(uint256 => mapping(address => bool)) public exitClaimed;

    event ExitRoundOpened(uint256 indexed roundId, uint256 capacity, uint256 commitEnd, uint256 revealEnd);
    event Cleared(uint256 indexed roundId, uint256 clearingDiscountBps, uint256 sold, bool oversubscribed);
    event ExitClaimed(
        uint256 indexed roundId,
        address indexed bidder,
        uint256 allocated,
        uint256 sharesReturned,
        uint256 assets,
        uint256 payout,
        uint256 donated
    );
    event DepositRefunded(uint256 indexed roundId, address indexed bidder, uint256 amount);

    constructor(DemoVault vault_, Config memory c) {
        require(address(vault_).code.length != 0, "vault has no code");
        require(c.commitDuration != 0 && c.revealDuration != 0, "zero window");
        require(c.depositAmount != 0, "zero deposit");
        require(c.tickBps != 0 && c.tickBps < BPS, "bad tick");
        require(c.minExitShares != 0, "zero minimum exit");
        require(c.maxExitSharesPerRound != 0, "zero max capacity");
        vault = vault_;
        asset = vault_.asset();
        commitDuration = c.commitDuration;
        revealDuration = c.revealDuration;
        depositAmount = c.depositAmount;
        tickBps = c.tickBps;
        minExitShares = c.minExitShares;
        maxExitSharesPerRound = c.maxExitSharesPerRound;
        roundGapBlocks = c.roundGapBlocks;
        allowlistRoot = c.allowlistRoot;
    }

    // ─── Open ────────────────────────────────────────────────────────────

    /// @notice Anyone, once the previous round has settled and `roundGapBlocks` blocks have passed
    ///         since its settlement. Capacity = min(free idle buffer in shares, maxExitSharesPerRound).
    function openExitRound() external nonReentrant returns (uint256 roundId) {
        uint256 prev = roundCount;
        if (prev != 0) {
            require(_books[prev].settled, "previous round not settled");
            require(block.number >= uint256(_rounds[prev].settledBlock) + roundGapBlocks, "too soon");
        }
        uint256 idle = vault.idleAssets();
        uint256 owed = vault.previewMint(pendingExitShares);
        uint256 free = idle > owed ? idle - owed : 0;
        uint256 capacity = vault.convertToShares(free);
        if (capacity > maxExitSharesPerRound) capacity = maxExitSharesPerRound;
        require(capacity != 0, "no exit capacity");

        roundId = prev + 1;
        roundCount = roundId;
        ExitRound storage r = _rounds[roundId];
        r.capacity = uint128(capacity);
        r.commitEnd = uint64(block.timestamp + commitDuration);
        r.revealEnd = r.commitEnd + revealDuration;
        r.openedBlock = uint64(block.number);
        _initBook(roundId, uint128(capacity));
        emit ExitRoundOpened(roundId, capacity, r.commitEnd, r.revealEnd);
    }

    // ─── Commit / reveal hooks ──────────────────────────────────────────

    /// @dev One allowlist for every round, fixed at deployment; a zero root lets every holder bid.
    function _sealTerms(uint256 roundId)
        internal
        view
        override
        returns (uint256 deposit, uint256 commitEnd, uint256 revealEnd, bytes32 root)
    {
        ExitRound storage r = _rounds[roundId];
        require(r.commitEnd != 0, "unknown round");
        return (depositAmount, r.commitEnd, r.revealEnd, allowlistRoot);
    }

    /// @dev price = discount in bps, amount = shares. Pulls the shares last; a bidder without them
    ///      cannot reveal, and their deposit is later burnable via `burnUnrevealed`.
    function _onReveal(uint256 roundId, address bidder, uint96 price, uint96 amount, uint256 hint) internal override {
        require(price < BPS && price % tickBps == 0, "discount off grid");
        require(amount >= minExitShares, "below minimum exit");
        bids[roundId][bidder] = Bid(price, amount);
        _rounds[roundId].escrowed += amount;
        _addBid(roundId, price, amount, hint);
        address(vault).safeTransferFrom(bidder, address(this), amount);
    }

    // ─── Settle ─────────────────────────────────────────────────────────

    /// @notice Advance clearing by up to `maxSteps` discount levels. Anyone, after the reveal window.
    function settle(uint256 roundId, uint256 maxSteps) external nonReentrant returns (bool done) {
        ExitRound storage r = _rounds[roundId];
        require(r.commitEnd != 0, "unknown round");
        require(block.timestamp >= r.revealEnd, "reveal window open");
        done = _settleStep(roundId, maxSteps);
        if (done) {
            Book storage b = _books[roundId];
            uint256 sold = b.sold;
            r.settledBlock = uint64(block.number);
            if (sold != 0) {
                r.settleAssets = vault.convertToAssets(sold);
                pendingExitShares += sold;
            }
            emit Cleared(roundId, b.clearingPrice, sold, b.oversubscribed);
        }
    }

    // ─── Claim ──────────────────────────────────────────────────────────
    //
    // Two independent parts, each triggerable by anyone and always paid to the bidder, so one
    // non-claimer never blocks a round's accounting and the MON refund never depends on the vault or
    // WMON transfers succeeding:
    //   - exit:   the allocation redeemed at (1 − P), plus the unfilled shares back;
    //   - refund: the full MON deposit (exit bidders pay in discount, not MON).

    /// @notice Exit and refund for msg.sender, whichever are not yet claimed.
    function claim(uint256 roundId) external nonReentrant {
        bool exited = exitClaimed[roundId][msg.sender];
        bool refunded = accounts[roundId][msg.sender].settled;
        require(!(exited && refunded), "nothing to claim");
        if (!exited) _exit(roundId, msg.sender);
        if (!refunded) _refund(roundId, msg.sender);
    }

    /// @notice The allocation at (1 − P) and the unfilled shares, to `bidder`. Anyone may trigger it.
    function claimExit(uint256 roundId, address bidder) external nonReentrant {
        _exit(roundId, bidder);
    }

    /// @notice The full MON deposit, to `bidder`. Anyone may trigger it once the round is settled.
    function claimRefund(uint256 roundId, address bidder) external nonReentrant {
        _refund(roundId, bidder);
    }

    function _exit(uint256 roundId, address bidder) private {
        require(commitments[roundId][bidder].revealed, "not revealed");
        require(!exitClaimed[roundId][bidder], "exit already claimed");
        (uint256 alloc, uint256 back, uint256 assets, uint256 payout, uint256 donation) = _quote(roundId, bidder);
        exitClaimed[roundId][bidder] = true;

        ExitRound storage r = _rounds[roundId];
        uint256 sold = _books[roundId].sold;
        r.allocatedTotal += alloc;
        r.returnedTotal += back;
        require(r.allocatedTotal <= sold, "over-allocated");
        require(r.allocatedTotal + r.returnedTotal <= r.escrowed, "share accounting");
        r.assetsRedeemed += assets;
        r.paidOut += payout;
        r.donated += donation;
        r.exitsClaimed += 1;
        pendingExitShares -= alloc;
        // Once every revealed bid has exited, the pro-rata dust (sold − allocated) was never owed.
        if (r.exitsClaimed == ledgers[roundId].reveals) pendingExitShares -= sold - r.allocatedTotal;
        emit ExitClaimed(roundId, bidder, alloc, back, assets, payout, donation);

        if (alloc != 0) {
            uint256 got = vault.redeem(alloc, address(this), address(this));
            require(got == assets, "redeem mismatch");
            if (payout != 0) asset.safeTransfer(bidder, payout);
            if (donation != 0) asset.safeTransfer(address(vault), donation);
        }
        if (back != 0) address(vault).safeTransfer(bidder, back);
    }

    function _refund(uint256 roundId, address bidder) private {
        require(_books[roundId].settled, "not settled");
        require(commitments[roundId][bidder].revealed, "not revealed");
        uint256 refund = _settleAccount(roundId, bidder, 0); // reverts on a second refund
        emit DepositRefunded(roundId, bidder, refund);
        SafeTransferLib.sendValue(bidder, refund);
    }

    // ─── Views ──────────────────────────────────────────────────────────

    function getRound(uint256 roundId) external view returns (ExitRound memory) {
        return _rounds[roundId];
    }

    /// @notice What `bidder` would receive by claiming now. Reverts until the round is settled.
    function quote(uint256 roundId, address bidder)
        external
        view
        returns (uint256 allocated, uint256 sharesReturned, uint256 assets, uint256 payout, uint256 donation)
    {
        require(commitments[roundId][bidder].revealed, "not revealed");
        return _quote(roundId, bidder);
    }

    /// @notice Shares this contract has promised to redeem: pending claims of settled rounds plus the
    ///         capacity of an unsettled round. The vault keeps that much idle.
    function reservedShares() external view returns (uint256 shares) {
        shares = pendingExitShares;
        uint256 id = roundCount;
        if (id != 0 && !_books[id].settled) shares += _rounds[id].capacity;
    }

    /// @notice The earliest block at which `openExitRound` may succeed; 0 if the current round is unsettled.
    function nextOpenBlock() external view returns (uint256) {
        uint256 id = roundCount;
        if (id == 0) return block.number;
        if (!_books[id].settled) return 0;
        return uint256(_rounds[id].settledBlock) + roundGapBlocks;
    }

    // ─── Internals ──────────────────────────────────────────────────────

    /// @dev payout = floor(min(assets, assetsAtSettle) × (BPS − P) / BPS); donation = assets − payout.
    ///      Both roundings favour the vault (bug #8). assetsAtSettle is the allocation's pro-rata share
    ///      of `settleAssets`, rounded down.
    function _quote(uint256 roundId, address bidder)
        private
        view
        returns (uint256 alloc, uint256 back, uint256 assets, uint256 payout, uint256 donation)
    {
        Bid memory bid = bids[roundId][bidder];
        alloc = _allocation(roundId, bid.discountBps, bid.shares); // requires settled
        back = uint256(bid.shares) - alloc;
        if (alloc == 0) return (alloc, back, 0, 0, 0);
        Book storage b = _books[roundId];
        assets = vault.previewRedeem(alloc);
        uint256 atSettle = Math.mulDiv(alloc, _rounds[roundId].settleAssets, b.sold);
        uint256 basis = assets < atSettle ? assets : atSettle;
        payout = basis * (BPS - b.clearingPrice) / BPS;
        donation = assets - payout;
    }
}
