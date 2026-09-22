// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title LocalBondingCurve
/// @notice Demo baseline for the sniper head-to-head: a first-come launch curve that takes real MON.
///         Not nad.fun and not the auction engine.
/// @dev TODO: not specified — the nad.fun curve formula is not in the docs. This curve is
///      constant-product on two virtual reserves. Token output rounds down (against the buyer).
///      A buy never sells more than `tokensForSale`; when a buy hits the cap, the unused MON is
///      refunded. Bought tokens are recorded in `balanceOf`; the demo needs no transferable token.
contract LocalBondingCurve {
    error ZeroReserve();
    error SaleTooLarge();
    error NotOwner();
    error NotOpen();
    error AlreadyOpen();
    error BelowMin();
    error SoldOut();
    error ZeroOut();
    error RefundFailed();

    uint256 public immutable virtualTokenReserve;
    uint256 public immutable virtualPaymentReserve;
    uint256 public immutable tokensForSale;
    uint256 public immutable minBuy;
    address public immutable owner;

    uint256 public tokenReserve;
    uint256 public paymentReserve;
    uint256 public sold;
    uint256 public raised;
    uint256 public openBlock;
    bool public isOpen;
    mapping(address => uint256) public balanceOf;

    struct Fill {
        address buyer;
        uint256 blockNumber;
        uint256 paymentIn;
        uint256 tokensOut;
    }

    Fill[] public fills;

    event Opened(uint256 blockNumber);
    event Bought(address indexed buyer, uint256 blockNumber, uint256 paymentIn, uint256 tokensOut);

    constructor(uint256 virtualTokenReserve_, uint256 virtualPaymentReserve_, uint256 tokensForSale_, uint256 minBuy_) {
        if (virtualTokenReserve_ == 0 || virtualPaymentReserve_ == 0) revert ZeroReserve();
        if (tokensForSale_ == 0 || tokensForSale_ >= virtualTokenReserve_) revert SaleTooLarge();
        virtualTokenReserve = virtualTokenReserve_;
        virtualPaymentReserve = virtualPaymentReserve_;
        tokensForSale = tokensForSale_;
        minBuy = minBuy_;
        owner = msg.sender;
        tokenReserve = virtualTokenReserve_;
        paymentReserve = virtualPaymentReserve_;
    }

    /// @notice Trading starts. The block this lands in is block zero of the launch.
    function open() external {
        if (msg.sender != owner) revert NotOwner();
        if (isOpen) revert AlreadyOpen();
        isOpen = true;
        openBlock = block.number;
        emit Opened(block.number);
    }

    function fillCount() external view returns (uint256) {
        return fills.length;
    }

    /// @notice Marginal price, MON wei per 1e18 token units.
    function spotPrice() external view returns (uint256) {
        return paymentReserve * 1e18 / tokenReserve;
    }

    /// @notice Buy with msg.value. If the sale caps the fill, the unused MON is refunded.
    function buy() external payable returns (uint256 tokensOut) {
        if (!isOpen) revert NotOpen();
        uint256 paymentIn = msg.value;
        if (paymentIn < minBuy) revert BelowMin();

        uint256 left = tokensForSale - sold;
        if (left == 0) revert SoldOut();

        uint256 reserveToken = tokenReserve;
        uint256 reservePayment = paymentReserve;
        tokensOut = (reserveToken * paymentIn) / (reservePayment + paymentIn);

        if (tokensOut > left) {
            uint256 denom = reserveToken - left;
            uint256 need = (left * reservePayment + denom - 1) / denom; // rounds up, against the buyer
            paymentIn = need;
            tokensOut = left;
        }

        if (tokensOut == 0) revert ZeroOut();

        tokenReserve = reserveToken - tokensOut;
        paymentReserve = reservePayment + paymentIn;
        sold += tokensOut;
        raised += paymentIn;
        balanceOf[msg.sender] += tokensOut;
        fills.push(Fill({buyer: msg.sender, blockNumber: block.number, paymentIn: paymentIn, tokensOut: tokensOut}));
        emit Bought(msg.sender, block.number, paymentIn, tokensOut);

        uint256 refund = msg.value - paymentIn;
        if (refund != 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }
}
