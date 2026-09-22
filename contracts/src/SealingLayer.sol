// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

import {DepositLedger} from "./DepositLedger.sol";

/// @notice Commit/reveal logic; round creation and clearing-core integration must be supplied.
abstract contract SealingLayer is DepositLedger {
    struct Commitment {
        bytes32 hash;
        uint256 depositLocked;
        uint256 committedAt;
        bool revealed;
    }

    mapping(uint256 => mapping(address => Commitment)) public commitments;
    mapping(uint256 => uint256) private biddingVolume;
    uint256 public immutable depositCap;
    bool public immutable windowsUseBlocks;

    event Committed(uint256 indexed roundId, address indexed bidder, bytes32 hash);
    event Revealed(uint256 indexed roundId, address indexed bidder, uint96 price, uint96 quantity);

    constructor(
        address payable slashDestination_,
        address payable fillDestination_,
        uint256 depositCap_,
        bool windowsUseBlocks_,
        uint256 commitmentsPerBidder_
    ) DepositLedger(slashDestination_, fillDestination_) {
        require(depositCap_ > 0 && depositCap_ < 2 ** 96, "invalid deposit cap");
        // TODO: not specified: multiple-commitment addressing; current API has no commitment id.
        require(commitmentsPerBidder_ == 1, "only single commitment supported");
        depositCap = depositCap_;
        // TODO: not specified: are commitEnd/revealEnd timestamps or block numbers?
        windowsUseBlocks = windowsUseBlocks_;
    }

    function commit(uint256 roundId, bytes32 hash) external payable nonReentrant {
        (uint256 amount, uint96 minBidSize, uint64 commitEnd, uint64 revealEnd) = _roundTerms(roundId);
        require(minBidSize != 0 && amount > minBidSize && amount <= depositCap, "invalid round deposit");
        require(commitEnd < revealEnd && _clock() < commitEnd, "commit window closed");
        require(_allowed(roundId, msg.sender), "not on allowlist");
        require(msg.value == amount, "wrong deposit");
        require(commitments[roundId][msg.sender].depositLocked == 0, "already committed");
        commitments[roundId][msg.sender] = Commitment(hash, amount, block.number, false);
        _lockDeposit(roundId, msg.sender, amount);
        emit Committed(roundId, msg.sender, hash);
    }

    function reveal(uint256 roundId, uint96 price, uint96 quantity, bytes32 salt) external nonReentrant {
        (, uint96 minBidSize, uint64 commitEnd, uint64 revealEnd) = _roundTerms(roundId);
        require(_clock() >= commitEnd && _clock() < revealEnd, "reveal window closed");
        Commitment storage commitment = commitments[roundId][msg.sender];
        require(commitment.depositLocked != 0 && !commitment.revealed, "no unrevealed commitment");
        require(keccak256(abi.encode(price, quantity, salt, msg.sender)) == commitment.hash, "hash mismatch");
        require(minBidSize != 0 && quantity >= minBidSize, "below minimum bid");
        // Quantity is the bidding-token amount per 05-data-model.md, not price * quantity.
        require(quantity < commitment.depositLocked, "bid exceeds collateral limit");
        uint256 volume = biddingVolume[roundId] + quantity;
        require(volume < 2 ** 96, "bidding volume overflow");
        biddingVolume[roundId] = volume;
        commitment.revealed = true;
        _placeOrder(roundId, msg.sender, price, quantity);
        emit Revealed(roundId, msg.sender, price, quantity);
    }

    function _canSlash(uint256 roundId, address bidder) internal view override returns (bool) {
        (,,, uint64 revealEnd) = _roundTerms(roundId);
        return _clock() >= revealEnd && !commitments[roundId][bidder].revealed;
    }

    function _canRelease(uint256 roundId, address bidder) internal view override returns (bool) {
        (,,, uint64 revealEnd) = _roundTerms(roundId);
        return _clock() >= revealEnd && commitments[roundId][bidder].revealed && _settled(roundId);
    }

    function _clock() private view returns (uint256) {
        return windowsUseBlocks ? block.number : block.timestamp;
    }

    // TODO: not specified: round registration interface. Must reject unknown rounds and return
    // immutable terms only after openRound has locked supply and registered with the clearing core.
    function _roundTerms(uint256 roundId)
        internal
        view
        virtual
        returns (uint256 depositAmount, uint96 minBidSize, uint64 commitEnd, uint64 revealEnd);

    // TODO: not specified: allowlist format; commit has no proof argument.
    function _allowed(uint256 roundId, address bidder) internal view virtual returns (bool);

    // TODO: not specified: order-placement interface and uint96 price fraction representation.
    // The clearing core must validate price; a revert here rolls back the reveal and volume.
    function _placeOrder(uint256 roundId, address bidder, uint96 price, uint96 quantity) internal virtual;

    // TODO: not specified: clearing-core settled-status interface.
    function _settled(uint256 roundId) internal view virtual returns (bool);
}

// Tests are colocated solely because tasks/core.md permits only these two source paths.
// This harness is test-only and must never be used as a deployed sealing layer.
import {Test} from "forge-std/Test.sol";

contract SealingLayerTest is SealingLayer, Test {
    address private constant BIDDER = address(0xB1D);

    constructor() SealingLayer(payable(address(0x51)), payable(address(0xF1)), 100, false, 1) {}

    function setUp() public {
        vm.warp(1);
        vm.deal(BIDDER, 100);
    }

    function _roundTerms(uint256 roundId) internal pure override returns (uint256, uint96, uint64, uint64) {
        require(roundId == 1, "unknown round");
        return (100, 10, 10, 20);
    }

    function _allowed(uint256, address) internal pure override returns (bool) {
        return true;
    }

    function _placeOrder(uint256, address, uint96 price, uint96) internal pure override {
        require(price != 0, "invalid price");
    }

    function _settled(uint256) internal pure override returns (bool) {
        return true;
    }

    function _commit(uint96 price, uint96 quantity, bytes32 salt) private {
        vm.prank(BIDDER);
        this.commit{value: 100}(1, keccak256(abi.encode(price, quantity, salt, BIDDER)));
    }

    function _reveal(uint96 price, uint96 quantity, bytes32 salt) private {
        vm.warp(10);
        vm.prank(BIDDER);
        this.reveal(1, price, quantity, salt);
    }

    function _assertAccounting() private view {
        Deposit storage deposit = deposits[1][BIDDER];
        assertEq(deposit.locked, deposit.appliedToFill + deposit.refunded + deposit.slashed);
    }

    function testFuzzFillAccounting(uint256 fill) public {
        fill = bound(fill, 0, 99);
        _commit(1, 99, bytes32(uint256(7)));
        _reveal(1, 99, bytes32(uint256(7)));
        vm.warp(20);
        _releaseDeposit(1, BIDDER, fill);
        _assertAccounting();
        assertEq(BIDDER.balance, 100 - fill);
        assertEq(fillDestination.balance, fill);
        vm.expectRevert("already settled");
        this.releaseAgain(fill);
    }

    function releaseAgain(uint256 fill) external {
        require(msg.sender == address(this), "test only");
        _releaseDeposit(1, BIDDER, fill);
    }

    function testSlashAccountingAndBoundaries() public {
        _commit(1, 10, bytes32(0));
        address[] memory bidders = new address[](1);
        bidders[0] = BIDDER;
        vm.warp(19);
        vm.expectRevert("not slashable");
        this.slashUnrevealed(1, bidders);
        vm.warp(20);
        this.slashUnrevealed(1, bidders);
        _assertAccounting();
        assertEq(slashDestination.balance, 100);
        vm.expectRevert("already settled");
        this.slashUnrevealed(1, bidders);
    }

    function testHashSaltSenderAndDuplicateReveal() public {
        _commit(1, 10, bytes32(uint256(7)));
        vm.warp(10);
        vm.expectRevert("hash mismatch");
        vm.prank(BIDDER);
        this.reveal(1, 1, 10, bytes32(uint256(8)));
        vm.expectRevert("no unrevealed commitment");
        this.reveal(1, 1, 10, bytes32(uint256(7)));
        _reveal(1, 10, bytes32(uint256(7)));
        vm.expectRevert("no unrevealed commitment");
        vm.prank(BIDDER);
        this.reveal(1, 1, 10, bytes32(uint256(7)));
        address[] memory bidders = new address[](1);
        bidders[0] = BIDDER;
        vm.warp(20);
        vm.expectRevert("not slashable");
        this.slashUnrevealed(1, bidders);
    }

    function testWrongDepositDuplicateCommitAndWindow() public {
        vm.expectRevert("wrong deposit");
        vm.prank(BIDDER);
        this.commit{value: 99}(1, bytes32(0));
        _commit(1, 10, bytes32(0));
        vm.deal(BIDDER, 100);
        vm.expectRevert("already committed");
        vm.prank(BIDDER);
        this.commit{value: 100}(1, bytes32(0));
        vm.warp(10);
        vm.expectRevert("commit window closed");
        vm.prank(BIDDER);
        this.commit{value: 100}(1, bytes32(0));
        vm.warp(20);
        vm.expectRevert("reveal window closed");
        vm.prank(BIDDER);
        this.reveal(1, 1, 10, bytes32(0));
    }

    function testMinimumBidAndOrderFailureRollback() public {
        _commit(1, 9, bytes32(0));
        vm.warp(10);
        vm.expectRevert("below minimum bid");
        vm.prank(BIDDER);
        this.reveal(1, 1, 9, bytes32(0));
        assertFalse(commitments[1][BIDDER].revealed);
    }

    function testOrderFailureRollback() public {
        _commit(0, 10, bytes32(0));
        vm.warp(10);
        vm.expectRevert("invalid price");
        vm.prank(BIDDER);
        this.reveal(1, 0, 10, bytes32(0));
        assertFalse(commitments[1][BIDDER].revealed);
    }
}
