// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {DepositLedger} from "../src/DepositLedger.sol";

/// Exposes the ledger's internal functions. Nothing is re-implemented.
contract LedgerHarness is DepositLedger {
    uint256 internal constant DEPOSIT = 10 ether;

    function _depositOf(uint256) internal pure override returns (uint256) {
        return DEPOSIT;
    }

    function _revealEndOf(uint256) internal pure override returns (uint256) {
        return 0;
    }

    function credit(uint256 roundId) external payable {
        _credit(roundId, msg.value);
    }

    function settle(uint256 roundId, address bidder, uint256 paid) external returns (uint256) {
        return _settleAccount(roundId, bidder, paid);
    }

    function push(address bidder, uint256 amount) external {
        _pushRefund(bidder, amount);
    }
}

contract Rejecter {
    receive() external payable {
        revert("no MON");
    }
}

/// @notice The ledger's defensive checks, exercised directly. Through the engine they are unreachable
///         (a revealed bid can never cost the whole deposit, and a refund is never zero), which is why the
///         mutation run showed them untested (reports/mutation-summary.md).
contract DepositLedgerTest is Test {
    LedgerHarness ledger;

    function setUp() public {
        ledger = new LedgerHarness();
        ledger.credit{value: 30 ether}(1);
    }

    /// `paid` must stay strictly below the deposit: equal or above reverts, one wei below settles.
    function test_SettleAccount_PaidMustBeBelowDeposit() public {
        vm.expectRevert("paid exceeds deposit");
        ledger.settle(1, address(0xA1), 10 ether);
        vm.expectRevert("paid exceeds deposit");
        ledger.settle(1, address(0xA1), 10 ether + 1);
        assertEq(ledger.settle(1, address(0xA1), 10 ether - 1), 1, "refund = deposit - paid");
        vm.expectRevert("already settled");
        ledger.settle(1, address(0xA1), 0);
    }

    /// A zero refund is not pushed at all: no call, no owed balance, no event.
    function test_PushRefund_ZeroIsANoOp() public {
        Rejecter r = new Rejecter();
        vm.recordLogs();
        ledger.push(address(r), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0, "no RefundOwed for a zero refund");
        assertEq(ledger.totalOwed(), 0);
    }

    /// A failed push is owed in full; a successful one moves the MON and owes nothing.
    function test_PushRefund_FailedPushIsOwed() public {
        Rejecter r = new Rejecter();
        ledger.push(address(r), 3 ether);
        assertEq(ledger.refundsOwed(address(r)), 3 ether);
        assertEq(ledger.totalOwed(), 3 ether);
        address eoa = address(0xE0A);
        ledger.push(eoa, 2 ether);
        assertEq(eoa.balance, 2 ether);
        assertEq(ledger.refundsOwed(eoa), 0);
        assertEq(ledger.totalOwed(), 3 ether);
    }
}
