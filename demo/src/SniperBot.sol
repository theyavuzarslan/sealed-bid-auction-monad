// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {LocalBondingCurve} from "./LocalBondingCurve.sol";

/// @notice The slice of the AuctionEngine the bot uses. Same calls a human bidder makes.
interface ISealedBidAuction {
    function commit(uint256 roundId, bytes32 hash, bytes32[] calldata proof, bytes calldata note) external payable;
    function reveal(uint256 roundId, uint96 price, uint96 amount, bytes32 salt) external;
    function claim(uint256 roundId) external;
}

/// @title SniperBot
/// @notice One bot, two launches. On the curve it fires its buys the moment trading opens, ahead
///         of every human. On the auction it is the first to commit a sealed bid, and it bids
///         aggressively — and the engine charges it the same clearing price as everyone else.
/// @dev The bot is a contract, so its commitment hash binds the bot's address, not the operator's:
///      keccak256(abi.encode(price, amount, salt, address(bot))).
contract SniperBot {
    error NotOperator();
    error NoTranches();
    error Done();

    LocalBondingCurve public immutable curve;
    address public immutable operator;

    uint256[] private _tranches;
    uint256 public nextTranche;

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(LocalBondingCurve curve_, uint256[] memory tranches_) {
        if (tranches_.length == 0) revert NoTranches();
        curve = curve_;
        operator = msg.sender;
        _tranches = tranches_;
    }

    receive() external payable {}

    function tranches() external view returns (uint256[] memory) {
        return _tranches;
    }

    /// @notice Buy the next tranche with the bot's own MON. The operator fires these the moment
    ///         trading opens, ahead of any human.
    function attackCurve() external onlyOperator returns (uint256 tokensOut) {
        uint256 i = nextTranche;
        if (i >= _tranches.length) revert Done();
        nextTranche = i + 1;
        tokensOut = curve.buy{value: _tranches[i]}();
    }

    /// @notice Commit a sealed bid. `hash` is built off-chain with this contract's address as sender.
    function commitAuction(ISealedBidAuction engine, uint256 roundId, bytes32 hash) external payable onlyOperator {
        engine.commit{value: msg.value}(roundId, hash, new bytes32[](0), "");
    }

    function revealAuction(ISealedBidAuction engine, uint256 roundId, uint96 price, uint96 amount, bytes32 salt)
        external
        onlyOperator
    {
        engine.reveal(roundId, price, amount, salt);
    }

    function claimAuction(ISealedBidAuction engine, uint256 roundId) external onlyOperator {
        engine.claim(roundId);
    }
}
