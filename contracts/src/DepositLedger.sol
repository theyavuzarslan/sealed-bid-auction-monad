// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeTransferLib} from "./lib/SafeTransferLib.sol";

/// @notice Uniform-deposit accounting shared by every sealed-bid product.
/// @dev Every bidder in a round locks the same `deposit`. A revealed bidder settles exactly once,
///      splitting their deposit into `paid` (kept by the round) and `refunded` (sent back).
///      Unrevealed deposits are burned in aggregate (10-decisions.md #30): because deposits are
///      uniform, the amount is `(commits - reveals) * deposit`, so burning is O(1).
///      `roundBalance` tracks the MON each round holds; every outflow is a checked subtraction,
///      so no round can ever spend another round's MON.
abstract contract DepositLedger {
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

    struct Ledger {
        uint64 commits;
        uint64 reveals;
        uint64 claims;
        uint256 burned;
    }

    struct Account {
        uint128 paid;
        uint128 refunded;
        bool settled;
    }

    mapping(uint256 => Ledger) public ledgers;
    mapping(uint256 => mapping(address => Account)) public accounts;
    mapping(uint256 => uint256) public roundBalance;

    uint256 private _lock = 1;

    event UnrevealedBurned(uint256 indexed roundId, uint256 count, uint256 amount);

    modifier nonReentrant() {
        require(_lock == 1, "reentrancy");
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @notice Burn every deposit whose commitment was never revealed. Anyone, after the reveal window.
    function burnUnrevealed(uint256 roundId) external nonReentrant {
        require(block.timestamp >= _revealEndOf(roundId), "reveal window open");
        Ledger storage l = ledgers[roundId];
        uint256 unrevealed = l.commits - l.reveals;
        uint256 due = unrevealed * _depositOf(roundId);
        uint256 amount = due - l.burned;
        require(amount != 0, "nothing to burn");
        l.burned = due;
        _debit(roundId, amount);
        emit UnrevealedBurned(roundId, unrevealed, amount);
        SafeTransferLib.sendValue(BURN, amount);
    }

    /// @dev Records a revealed bidder's settlement. The caller sends the refund after all effects.
    function _settleAccount(uint256 roundId, address bidder, uint256 paid) internal returns (uint256 refund) {
        uint256 deposit = _depositOf(roundId);
        Account storage a = accounts[roundId][bidder];
        require(!a.settled, "already settled");
        require(paid < deposit, "paid exceeds deposit");
        refund = deposit - paid;
        a.settled = true;
        a.paid = uint128(paid);
        a.refunded = uint128(refund);
        ledgers[roundId].claims += 1;
        _debit(roundId, refund);
    }

    function _credit(uint256 roundId, uint256 amount) internal {
        roundBalance[roundId] += amount;
    }

    function _debit(uint256 roundId, uint256 amount) internal {
        roundBalance[roundId] -= amount;
    }

    function _depositOf(uint256 roundId) internal view virtual returns (uint256);
    function _revealEndOf(uint256 roundId) internal view virtual returns (uint256);
}
