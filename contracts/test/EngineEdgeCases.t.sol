// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AuctionEngine} from "../src/AuctionEngine.sol";
import {EngineBase} from "./AuctionEngine.t.sol";
import {MockToken, MockAdapter, MockPositionManager} from "./mocks/Mocks.sol";

/// A token whose transfers credit the recipient one unit more than sent (a rebasing or bonus token).
contract BonusToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount + 1;
        return true;
    }
}

/// A token that, once armed, takes one extra unit from `victim` on every transferFrom out of it: the
/// engine sees its balance fall by more than the adapter was approved for.
contract GreedyToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public victim;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function arm(address v) external {
        victim = v;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        uint256 extra = from == victim ? 1 : 0;
        balanceOf[from] -= amount + extra;
        balanceOf[to] += amount;
        return true;
    }
}

/// An adapter that seeds normally but mints the position to someone other than the engine.
contract MisdirectingAdapter {
    MockPositionManager public immutable npm;

    constructor(MockPositionManager npm_) {
        npm = npm_;
    }

    function supportsFee(uint24) external pure returns (bool) {
        return true;
    }

    function seed(address token, uint256 tokenAmount, uint256, uint24, address)
        external
        payable
        returns (address, uint256 nftId)
    {
        MockToken(token).transferFrom(msg.sender, address(this), tokenAmount);
        nftId = npm.mint(address(0xD1));
        return (address(npm), nftId);
    }
}

/// @notice Engine edge cases added after the mutation run (reports/mutation-summary.md). Each test kills
///         mutants of `AuctionEngine.sol` that the earlier suite let survive: every `openRound` and
///         constructor rule at its boundary, LP seeding across several venues with rounding, the LP sides
///         that round to zero, adapter and position checks, and the access and one-shot guards.
contract EngineEdgeCasesTest is EngineBase {
    function _expectOpenRevert(AuctionEngine.OpenParams memory p, string memory reason) internal {
        vm.prank(creator);
        vm.expectRevert(bytes(reason));
        engine.openRound(p);
    }

    function _splits(uint256 n, uint16 each) internal view returns (AuctionEngine.DexSplit[] memory s) {
        s = new AuctionEngine.DexSplit[](n);
        for (uint256 i; i < n; ++i) {
            s[i] = AuctionEngine.DexSplit({adapter: address(adapter), bps: each, fee: 3000});
        }
    }

    function _raiseNoLp() internal view returns (AuctionEngine.OpenParams memory p) {
        p = _params(AuctionEngine.Preset.Raise);
        p.lpShareBps = 0;
        p.dexSplits = new AuctionEngine.DexSplit[](0);
        p.lockDuration = 0;
    }

    // ─── Constructor ────────────────────────────────────────────────────

    function test_Constructor_EveryCheck() public {
        address[] memory adapters = new address[](1);
        adapters[0] = address(adapter);
        try new AuctionEngine(address(0xBEEF), adapters, LOCK_END, GRACE) {
            revert("deployment should have reverted");
        } catch Error(string memory why) {
            assertEq(why, "locker has no code");
        }
        try new AuctionEngine(address(locker), adapters, block.timestamp, GRACE) {
            revert("deployment should have reverted");
        } catch Error(string memory why) {
            assertEq(why, "lock end in past");
        }
        try new AuctionEngine(address(locker), adapters, block.timestamp - 1, GRACE) {
            revert("deployment should have reverted");
        } catch Error(string memory why) {
            assertEq(why, "lock end in past");
        }
        try new AuctionEngine(address(locker), adapters, LOCK_END, 0) {
            revert("deployment should have reverted");
        } catch Error(string memory why) {
            assertEq(why, "zero grace period");
        }
        adapters[0] = address(0xBEEF);
        try new AuctionEngine(address(locker), adapters, LOCK_END, GRACE) {
            revert("deployment should have reverted");
        } catch Error(string memory why) {
            assertEq(why, "adapter has no code");
        }
        adapters[0] = address(adapter);
        new AuctionEngine(address(locker), adapters, block.timestamp + 1, GRACE); // the earliest valid end
    }

    // ─── openRound: every rule, at its boundary ─────────────────────────

    function test_OpenRules_Amounts() public {
        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Degen);
        p.token = address(0xBEEF);
        _expectOpenRevert(p, "token has no code");

        p = _params(AuctionEngine.Preset.Degen);
        p.sellAmount = 0;
        _expectOpenRevert(p, "zero sell amount");

        p = _params(AuctionEngine.Preset.Degen);
        p.tickSize = 0;
        _expectOpenRevert(p, "zero tick");

        p = _params(AuctionEngine.Preset.Degen);
        p.reservePrice = 0;
        _expectOpenRevert(p, "reserve off grid");

        p = _params(AuctionEngine.Preset.Degen);
        p.minBidSize = 0;
        _expectOpenRevert(p, "deposit must exceed min bid");

        p = _params(AuctionEngine.Preset.Degen);
        p.minBidSize = p.depositAmount;
        _expectOpenRevert(p, "deposit must exceed min bid");

        // Some amount at the reserve price must cost in [minBidSize, deposit): with deposit − minBidSize
        // = 2 wei, the highest reserve is exactly 2 MON per token.
        p = _params(AuctionEngine.Preset.Degen);
        p.minBidSize = p.depositAmount - 2;
        p.reservePrice = 2e18 + uint96(TICK);
        _expectOpenRevert(p, "no valid bid possible");
        p.reservePrice = 2e18;
        _open(p);
    }

    function test_OpenRules_LpAndSplits() public {
        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Degen);
        p.lpShareBps = 10_001;
        _expectOpenRevert(p, "lp share > 100%");
        p.lpShareBps = 10_000;
        _open(p); // 100% is allowed

        p = _raiseNoLp();
        p.dexSplits = _splits(1, 10_000);
        _expectOpenRevert(p, "splits without LP");

        p = _params(AuctionEngine.Preset.Degen);
        p.dexSplits = new AuctionEngine.DexSplit[](0);
        _expectOpenRevert(p, "bad split count");
        p.dexSplits = _splits(5, 2000);
        _expectOpenRevert(p, "bad split count");
        p.dexSplits = _splits(4, 2500);
        _open(p); // MAX_SPLITS venues

        p = _params(AuctionEngine.Preset.Degen);
        p.dexSplits[0].fee = 100;
        _expectOpenRevert(p, "fee tier not supported");

        p = _params(AuctionEngine.Preset.Degen);
        p.dexSplits = _splits(2, 10_000);
        p.dexSplits[1].bps = 0;
        _expectOpenRevert(p, "zero split");

        p = _params(AuctionEngine.Preset.Degen);
        p.dexSplits = _splits(2, 6000);
        _expectOpenRevert(p, "splits must sum to 100%");

        p = _params(AuctionEngine.Preset.Degen);
        p.lockFeeTier = "";
        _expectOpenRevert(p, "missing lock fee tier");
    }

    function test_OpenRules_Presets() public {
        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Degen);
        p.tgeBps = 1;
        _expectOpenRevert(p, "degen has no vesting");
        p = _params(AuctionEngine.Preset.Degen);
        p.cliff = 1;
        _expectOpenRevert(p, "degen has no vesting");
        p = _params(AuctionEngine.Preset.Degen);
        p.vestDuration = 1;
        _expectOpenRevert(p, "degen has no vesting");
        p = _params(AuctionEngine.Preset.Degen);
        p.lockDuration = 1;
        _expectOpenRevert(p, "degen lock is permanent");

        p = _params(AuctionEngine.Preset.Raise);
        p.tgeBps = 1;
        _expectOpenRevert(p, "vesting fields without duration");
        p = _params(AuctionEngine.Preset.Raise);
        p.cliff = 1;
        _expectOpenRevert(p, "vesting fields without duration");

        p = _params(AuctionEngine.Preset.Raise);
        p.vestDuration = 30 days;
        p.tgeBps = 10_000;
        _expectOpenRevert(p, "tge must be below 100%");
        p.tgeBps = 9999;
        _open(p);

        p = _params(AuctionEngine.Preset.Raise);
        p.lockDuration = 30 days - 1;
        _expectOpenRevert(p, "lock too short");
        p.lockDuration = 30 days;
        _open(p);

        p = _raiseNoLp();
        p.lockDuration = 1;
        _expectOpenRevert(p, "lock without LP");
        p.lockDuration = 0;
        _open(p);
    }

    function test_OpenRules_TokenCreditingMoreIsRejected() public {
        BonusToken t = new BonusToken();
        t.mint(creator, 10_000e18);
        vm.prank(creator);
        t.approve(address(engine), type(uint256).max);
        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Degen);
        p.token = address(t);
        _expectOpenRevert(p, "fee-on-transfer token");
    }

    // ─── Unknown rounds and bad reveals ─────────────────────────────────

    function test_UnknownRound() public {
        vm.prank(alice);
        vm.expectRevert("unknown round");
        engine.commit{value: DEPOSIT}(999, keccak256("x"), new bytes32[](0), "");
        vm.expectRevert("unknown round");
        engine.settle(999, 1);
    }

    function test_Reveal_ZeroAmountRefusedForThatReason() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _commit(r, alice, 0.005 ether, 0);
        _toReveal(r);
        vm.prank(alice);
        vm.expectRevert("zero amount");
        engine.reveal(r, 0.005 ether, 0, bytes32(uint256(uint160(alice))));
    }

    // ─── LP seeding ─────────────────────────────────────────────────────

    /// Two venues, 33.33% / 66.67%, with amounts that do not divide evenly: the first venue gets its
    /// rounded-down share, the last gets exactly what is left, and the pools take every unit offered.
    function test_LP_TwoVenues_LastTakesTheRemainder() public {
        MockAdapter a1 = new MockAdapter(npm);
        MockAdapter a2 = new MockAdapter(npm);
        address[] memory adapters = new address[](2);
        adapters[0] = address(a1);
        adapters[1] = address(a2);
        engine = new AuctionEngine(address(locker), adapters, LOCK_END, GRACE);
        vm.prank(creator);
        token.approve(address(engine), type(uint256).max);

        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Degen);
        p.dexSplits = new AuctionEngine.DexSplit[](2);
        p.dexSplits[0] = AuctionEngine.DexSplit({adapter: address(a1), bps: 3333, fee: 3000});
        p.dexSplits[1] = AuctionEngine.DexSplit({adapter: address(a2), bps: 6667, fee: 3000});
        uint256 r = _open(p);
        uint96 amount = 777e18 + 12_347;
        _commit(r, alice, 0.003 ether, amount);
        _toReveal(r);
        _reveal(r, alice, 0.003 ether, amount);
        _toSettle(r);
        engine.settle(r, 10);
        engine.seedLP(r);

        uint256 lpTokens = uint256(amount) * 5000 / 10_000;
        uint256 lpMon = (uint256(amount) * 0.003 ether / 1e18) * 5000 / 10_000;
        uint256 tok1 = lpTokens * 3333 / 10_000;
        uint256 mon1 = lpMon * 3333 / 10_000;
        assertTrue(lpTokens * 3333 % 10_000 != 0 && lpMon * 3333 % 10_000 != 0, "amounts must not divide evenly");
        assertEq(a1.tokensHeld(), tok1, "first venue: rounded-down share");
        assertEq(a2.tokensHeld(), lpTokens - tok1, "last venue: the remainder");
        assertEq(a1.monHeld(), mon1);
        assertEq(a2.monHeld(), lpMon - mon1);
        assertEq(a1.lastPrice(), 0.003 ether);
        assertEq(a2.lastPrice(), 0.003 ether);
        AuctionEngine.Round memory rd = engine.getRound(r);
        assertEq(rd.lpTokensUsed, lpTokens);
        assertEq(rd.lpMonSpent, lpMon);
    }

    /// A 100% LP share on a book that sells out exactly: the pool takes the whole reserve, and the engine
    /// measures that correctly although its remaining balance equals what the pool took.
    function test_LP_FullShare_SoldOut_WholeReserveUsed() public {
        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Degen);
        p.lpShareBps = 10_000;
        uint256 r = _open(p);
        _commit(r, alice, 0.004 ether, uint96(SUPPLY));
        _toReveal(r);
        _reveal(r, alice, 0.004 ether, uint96(SUPPLY));
        _toSettle(r);
        engine.settle(r, 10);
        engine.seedLP(r);
        assertEq(engine.getRound(r).lpTokensUsed, SUPPLY);
        _claim(r, alice);
        assertEq(token.balanceOf(alice), SUPPLY);
        assertEq(token.balanceOf(address(engine)), 0);
    }

    /// The MON side rounds to zero (price 1 wei per token): nothing is seeded, claims still open.
    function test_LP_MonSideZero_NotSeeded() public {
        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Degen);
        p.tickSize = 1;
        p.reservePrice = 1;
        p.minBidSize = 1;
        uint256 r = _open(p);
        _commit(r, alice, 1, 5e17);
        _toReveal(r);
        _reveal(r, alice, 1, 5e17);
        _toSettle(r);
        engine.settle(r, 10);
        engine.seedLP(r);
        AuctionEngine.Round memory rd = engine.getRound(r);
        assertTrue(rd.claimsOpen);
        assertEq(rd.lpTokensUsed, 0);
        assertEq(adapter.tokensHeld(), 0);
    }

    /// The token side rounds to zero (1 wei of tokens sold): nothing is seeded, no MON leaves.
    function test_LP_TokenSideZero_NotSeeded() public {
        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Degen);
        p.tickSize = 1e18;
        p.reservePrice = 1e18;
        p.minBidSize = 1;
        uint256 r = _open(p);
        _commit(r, alice, 4e18, 1);
        _toReveal(r);
        _reveal(r, alice, 4e18, 1);
        _toSettle(r);
        engine.settle(r, 10);
        engine.seedLP(r);
        AuctionEngine.Round memory rd = engine.getRound(r);
        assertTrue(rd.claimsOpen);
        assertEq(rd.lpMonSpent, 0);
        assertEq(adapter.monHeld(), 0);
    }

    function test_LP_AdapterOverspendRejected() public {
        GreedyToken t = new GreedyToken();
        t.mint(creator, 10_000e18);
        vm.prank(creator);
        t.approve(address(engine), type(uint256).max);
        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Degen);
        p.token = address(t);
        uint256 r = _open(p);
        _standardBook(r);
        _toSettle(r);
        engine.settle(r, 10);
        t.arm(address(engine));
        vm.expectRevert("adapter overspent");
        engine.seedLP(r);
    }

    function test_LP_PositionMustReachTheEngine() public {
        MisdirectingAdapter bad = new MisdirectingAdapter(npm);
        address[] memory adapters = new address[](1);
        adapters[0] = address(bad);
        engine = new AuctionEngine(address(locker), adapters, LOCK_END, GRACE);
        vm.prank(creator);
        token.approve(address(engine), type(uint256).max);
        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Degen);
        p.dexSplits[0].adapter = address(bad);
        uint256 r = _open(p);
        _standardBook(r);
        _toSettle(r);
        engine.settle(r, 10);
        vm.expectRevert("position not received");
        engine.seedLP(r);
    }

    /// The engine takes MON from an adapter only while it is seeding; after `seedLP`, never.
    function test_LP_NoMonFromAdapterAfterSeeding() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _standardBook(r);
        _toSettle(r);
        engine.settle(r, 10);
        engine.seedLP(r);
        vm.deal(address(adapter), 1 ether);
        vm.prank(address(adapter));
        (bool ok,) = address(engine).call{value: 1}("");
        assertFalse(ok, "unexpected MON accepted");
    }

    function test_AbandonLP_RecordsAbandonment() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _standardBook(r);
        _toSettle(r);
        engine.settle(r, 10);
        vm.warp(block.timestamp + GRACE);
        engine.abandonLP(r);
        AuctionEngine.Round memory rd = engine.getRound(r);
        assertTrue(rd.lpAbandoned && rd.lpDone && rd.claimsOpen);
    }

    // ─── Access and one-shot guards ─────────────────────────────────────

    function test_WithdrawProceeds_OnlyCreator_OnlyAfterLp() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _standardBook(r);
        _toSettle(r);
        engine.settle(r, 10);
        _claim(r, alice); // collected > 0 before the LP is done
        vm.prank(creator);
        vm.expectRevert("LP not done");
        engine.withdrawProceeds(r);
        engine.seedLP(r);
        vm.prank(address(1)); // an address below the creator's
        vm.expectRevert("not creator");
        engine.withdrawProceeds(r);
        vm.prank(address(type(uint160).max));
        vm.expectRevert("not creator");
        engine.withdrawProceeds(r);
    }

    function test_SweepDust_OnlyOnce() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _standardBook(r);
        _toSettle(r);
        engine.settle(r, 10);
        engine.seedLP(r);
        address[5] memory people = [alice, bob, carol, dave, eve];
        for (uint256 i; i < 5; ++i) {
            _claim(r, people[i]);
        }
        engine.sweepDust(r);
        assertTrue(engine.getRound(r).dustSwept);
        vm.expectRevert("not sweepable");
        engine.sweepDust(r);
    }

    function test_Quote_MatchesSettlement_AndNeedsAReveal() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        vm.deal(makeAddr("silent"), DEPOSIT);
        _commit(r, makeAddr("silent"), 0.005 ether, 100e18); // commits, never reveals
        _standardBook(r);
        _toSettle(r);
        engine.settle(r, 10);
        vm.expectRevert("not revealed");
        engine.quote(r, makeAddr("silent"));
        (uint256 alloc, uint256 paid, uint256 refund) = engine.quote(r, carol);
        assertGt(paid, 0);
        assertEq(paid + refund, DEPOSIT);
        engine.claimRefund(r, carol);
        (uint128 p_, uint128 refunded,) = engine.accounts(r, carol);
        assertEq(p_, paid);
        assertEq(refunded, refund);
        assertGt(alloc, 0);
    }

    function test_ClaimVested_NoVestingRefusedForThatReason() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _standardBook(r);
        _toSettle(r);
        engine.settle(r, 10);
        engine.seedLP(r);
        _claim(r, alice);
        vm.prank(alice);
        vm.expectRevert("no vesting");
        engine.claimVested(r);
    }
}
