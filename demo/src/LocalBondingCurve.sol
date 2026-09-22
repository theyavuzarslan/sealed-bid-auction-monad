// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title LocalBondingCurve
/// @notice Demo baseline for the sniper head-to-head. Not nad.fun. Not the auction engine.
/// @dev TODO: not specified — the nad.fun curve formula is not in the docs.
///      This curve is constant-product on the two reserve parameters.
///      Token output rounds down (against the buyer). A buy never sells more than `tokensForSale`.
contract LocalBondingCurve {
    error ZeroReserve();
    error SaleTooLarge();
    error BelowMin();
    error SoldOut();
    error InsufficientPayment();
    error ZeroOut();

    uint256 public immutable virtualTokenReserve;
    uint256 public immutable virtualPaymentReserve;
    uint256 public immutable tokensForSale;
    uint256 public immutable minBuy;

    uint256 public tokenReserve;
    uint256 public paymentReserve;
    uint256 public sold;

    struct Fill {
        address buyer;
        uint256 blockNumber;
        uint256 paymentIn;
        uint256 tokensOut;
    }

    Fill[] public fills;

    constructor(
        uint256 virtualTokenReserve_,
        uint256 virtualPaymentReserve_,
        uint256 tokensForSale_,
        uint256 minBuy_
    ) {
        if (virtualTokenReserve_ == 0 || virtualPaymentReserve_ == 0) revert ZeroReserve();
        if (tokensForSale_ == 0 || tokensForSale_ >= virtualTokenReserve_) revert SaleTooLarge();
        virtualTokenReserve = virtualTokenReserve_;
        virtualPaymentReserve = virtualPaymentReserve_;
        tokensForSale = tokensForSale_;
        minBuy = minBuy_;
        tokenReserve = virtualTokenReserve_;
        paymentReserve = virtualPaymentReserve_;
    }

    function fillCount() external view returns (uint256) {
        return fills.length;
    }

    /// @param paymentIn Payment-token units offered. Excess is not taken when the sale caps the fill.
    function buy(uint256 paymentIn) external returns (uint256 tokensOut) {
        if (paymentIn < minBuy) revert BelowMin();

        uint256 left = tokensForSale - sold;
        if (left == 0) revert SoldOut();

        uint256 reserveToken = tokenReserve;
        uint256 reservePayment = paymentReserve;
        tokensOut = (reserveToken * paymentIn) / (reservePayment + paymentIn);

        if (tokensOut > left) {
            uint256 denom = reserveToken - left;
            uint256 need = (left * reservePayment + denom - 1) / denom;
            if (paymentIn < need) revert InsufficientPayment();
            paymentIn = need;
            tokensOut = left;
        }

        if (tokensOut == 0) revert ZeroOut();

        tokenReserve = reserveToken - tokensOut;
        paymentReserve = reservePayment + paymentIn;
        sold = sold + tokensOut;

        fills.push(
            Fill({buyer: msg.sender, blockNumber: block.number, paymentIn: paymentIn, tokensOut: tokensOut})
        );
    }
}
