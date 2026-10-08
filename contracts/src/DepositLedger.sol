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
    /// @dev Where burned MON goes. Nobody holds its key.
    address internal constant BURN = 0x000000000000000000000000000000000000dEaD;

    /// @dev Per-round counters. `commits − reveals` is the number of burnable deposits.
    struct Ledger {
        uint64 commits; // commitments made
        uint64 reveals; // commitments revealed with a valid bid
        uint64 claims; // revealed bidders whose deposit has been settled (`_settleAccount`)
        uint256 burned; // MON burned so far for unrevealed deposits
    }

    /// @dev A revealed bidder's deposit split, written once by `_settleAccount`. `paid + refunded == deposit`.
    struct Account {
        uint128 paid;
        uint128 refunded;
        bool settled;
    }

    /// @notice Commit, reveal and claim counters of each round.
    mapping(uint256 => Ledger) public ledgers;
    /// @notice How each bidder's deposit was split, once settled.
    mapping(uint256 => mapping(address => Account)) public accounts;
    /// @notice MON each round holds. Every outflow is a checked subtraction from it.
    mapping(uint256 => uint256) public roundBalance;

    /// @dev Reentrancy lock shared by every `nonReentrant` function of the inheriting contract:
    ///      1 = free, 2 = entered. Never 0, so the slot is never cleared.
    uint256 private _lock = 1;

    /// @notice `count` unrevealed deposits of `roundId` were burned, `amount` MON in total this call.
    event UnrevealedBurned(uint256 indexed roundId, uint256 count, uint256 amount);

    modifier nonReentrant() {
        require(_lock == 1, "reentrancy");
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @notice Burn every deposit whose commitment was never revealed. Anyone, after the reveal window.
    /// @dev Idempotent: burns only what is due beyond what earlier calls already burned.
    /// @param roundId The round whose unrevealed deposits are burned.
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
    /// @param paid What the bidder pays out of the deposit; must be below it.
    /// @return refund `deposit − paid`, already debited from `roundBalance`.
    function _settleAccount(uint256 roundId, address bidder, uint256 paid) internal returns (uint256 refund) {
        uint256 deposit = _depositOf(roundId);
        Account storage a = accounts[roundId][bidder];
        require(!a.settled, "already settled");
        require(paid < deposit, "paid exceeds deposit");
        refund = deposit - paid;
        a.settled = true;
        // casting to 'uint128' is safe because paid < deposit and refund <= deposit, and every deposit
        // is a uint96 (`_depositOf` returns a uint96 widened to uint256)
        // forge-lint: disable-next-line(unsafe-typecast)
        a.paid = uint128(paid);
        // forge-lint: disable-next-line(unsafe-typecast)
        a.refunded = uint128(refund);
        ledgers[roundId].claims += 1;
        _debit(roundId, refund);
    }

    /// @dev MON enters a round's balance.
    function _credit(uint256 roundId, uint256 amount) internal {
        roundBalance[roundId] += amount;
    }

    /// @dev MON leaves a round's balance; reverts (checked arithmetic) if the round does not hold it.
    function _debit(uint256 roundId, uint256 amount) internal {
        roundBalance[roundId] -= amount;
    }

    /// @dev The uniform deposit of `roundId`, at most `type(uint96).max`. Must revert for unknown rounds.
    function _depositOf(uint256 roundId) internal view virtual returns (uint256);

    /// @dev The end of the reveal window of `roundId`. Must revert for unknown rounds.
    function _revealEndOf(uint256 roundId) internal view virtual returns (uint256);
}
