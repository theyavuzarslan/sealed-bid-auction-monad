// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LocalBondingCurve} from "./LocalBondingCurve.sol";

/// @title SniperBot
/// @notice One bot. On the curve it buys only in its first blocks.
///         On the auction its limit is fixed at construction and does not read the block.
/// @dev The auction bid is data for the demo harness. It does not call ClearingCore.
contract SniperBot {
    error NoBlocks();
    error ZeroBid();
    error ZeroScale();
    error BelowMinBid();
    error BelowMinBuy();
    error NotFirstBlock();
    error AlreadyAttacked();

    LocalBondingCurve public immutable curve;
    uint256 public immutable startBlock;
    uint96 public immutable limitPrice;
    uint96 public immutable tokenAmount;
    uint256 public immutable priceScale;
    uint256 public immutable minBidSize;

    uint256[] private _spendPerBlock;
    uint256 public nextIndex;

    constructor(
        LocalBondingCurve curve_,
        uint256 startBlock_,
        uint256[] memory spendPerBlock_,
        uint96 limitPrice_,
        uint96 tokenAmount_,
        uint256 priceScale_,
        uint256 minBidSize_
    ) {
        if (spendPerBlock_.length == 0) revert NoBlocks();
        if (priceScale_ == 0) revert ZeroScale();
        if (limitPrice_ == 0 || tokenAmount_ == 0) revert ZeroBid();

        uint256 minPayment = (uint256(tokenAmount_) * uint256(limitPrice_) + priceScale_ - 1) / priceScale_;
        if (minPayment < minBidSize_) revert BelowMinBid();

        uint256 floorBuy = curve_.minBuy();
        uint256 length = spendPerBlock_.length;
        bool underMin = false;
        for (uint256 i = 0; i < length; ++i) {
            if (spendPerBlock_[i] < floorBuy) underMin = true;
        }
        if (underMin) revert BelowMinBuy();

        curve = curve_;
        startBlock = startBlock_;
        _spendPerBlock = spendPerBlock_;
        limitPrice = limitPrice_;
        tokenAmount = tokenAmount_;
        priceScale = priceScale_;
        minBidSize = minBidSize_;
    }

    function firstBlocks() external view returns (uint256) {
        return _spendPerBlock.length;
    }

    function spendPerBlock(uint256 index) external view returns (uint256) {
        return _spendPerBlock[index];
    }

    /// @dev Reverts outside [startBlock, startBlock + firstBlocks). One buy per block, in order.
    function attackCurve() external returns (uint256 tokensOut) {
        uint256 blockNo = block.number;
        if (blockNo < startBlock || blockNo >= startBlock + _spendPerBlock.length) revert NotFirstBlock();
        uint256 index = blockNo - startBlock;
        if (index != nextIndex) revert AlreadyAttacked();
        nextIndex = index + 1;
        tokensOut = curve.buy(_spendPerBlock[index]);
    }

    /// @notice Sealed auction bid. The result does not depend on `block.number`.
    function auctionBid() external view returns (uint96 price, uint96 amount) {
        return (limitPrice, tokenAmount);
    }
}
