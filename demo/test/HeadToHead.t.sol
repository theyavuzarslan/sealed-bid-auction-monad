// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AuctionEngine} from "engine/AuctionEngine.sol";
import {MockToken, MockPositionManager, MockAdapter, MockLocker} from "engine-mocks/Mocks.sol";
import {LocalBondingCurve} from "../src/LocalBondingCurve.sol";
import {SniperBot, ISealedBidAuction} from "../src/SniperBot.sol";
import {Scenario} from "../src/Scenario.sol";

/// @notice The head-to-head claims, checked in memory against the same cast as script/RunScenario.s.sol.
///         Left: LocalBondingCurve + SniperBot. Right: the real AuctionEngine, Degen preset.
contract HeadToHeadTest is Test {
    MockToken token;
    MockAdapter adapter;
    MockLocker locker;
    AuctionEngine engine;
    LocalBondingCurve curve;
    SniperBot bot;

    address creator = makeAddr("creator");
    address operator = makeAddr("operator");
    address[] crowd;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.roll(100);
        vm.deal(creator, 1_000 ether);
        vm.deal(operator, 1_000 ether);
        for (uint256 i; i < Scenario.CROWD; ++i) {
            address a = vm.addr(Scenario.crowdKey(i));
            crowd.push(a);
            vm.deal(a, 250 ether);
        }

        vm.startPrank(creator);
        token = new MockToken();
        MockPositionManager npm = new MockPositionManager();
        adapter = new MockAdapter(npm);
        locker = new MockLocker();
        address[] memory adapters = new address[](1);
        adapters[0] = address(adapter);
        engine = new AuctionEngine(address(locker), adapters, 4102444800, 1 days);
        curve = new LocalBondingCurve(Scenario.VIRTUAL_TOKEN, Scenario.VIRTUAL_MON, Scenario.SUPPLY, Scenario.MIN_BUY);
        token.mint(creator, Scenario.SUPPLY * 10);
        token.approve(address(engine), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(operator);
        bot = new SniperBot(curve, Scenario.botTranches());
        payable(address(bot)).transfer(100 ether);
        vm.stopPrank();
    }

    // ─── Scenario drivers (same order as the script) ────────────────────

    function _runCurve() internal {
        vm.prank(creator);
        curve.open();
        uint256 tranches = Scenario.botTranches().length;
        for (uint256 i; i < tranches; ++i) {
            vm.roll(vm.getBlockNumber() + 1);
            vm.prank(operator);
            bot.attackCurve();
        }
        for (uint256 i; i < Scenario.CROWD; ++i) {
            (, uint96 maxPrice, uint256 budget) = Scenario.buyer(i);
            vm.roll(vm.getBlockNumber() + 1);
            if (curve.sold() < Scenario.SUPPLY && curve.spotPrice() < maxPrice) {
                vm.prank(crowd[i]);
                curve.buy{value: budget}();
            }
        }
    }

    function _open() internal returns (uint256 r) {
        vm.prank(creator);
        r = engine.openRound(Scenario.openParams(address(token), address(adapter), vm.getBlockTimestamp()));
    }

    function _commitBot(uint256 r) internal {
        vm.prank(operator);
        bot.commitAuction{value: Scenario.DEPOSIT}(
            ISealedBidAuction(address(engine)),
            r,
            Scenario.commitHash(Scenario.BOT_PRICE, Scenario.BOT_AMOUNT, Scenario.BOT_SALT, address(bot))
        );
    }

    function _commitCrowd(uint256 r, uint256 i) internal {
        (, uint96 maxPrice, uint256 budget) = Scenario.buyer(i);
        vm.prank(crowd[i]);
        engine.commit{value: Scenario.DEPOSIT}(
            r,
            Scenario.commitHash(maxPrice, Scenario.bidAmount(maxPrice, budget), Scenario.crowdSalt(i), crowd[i]),
            new bytes32[](0),
            ""
        );
    }

    function _revealBot(uint256 r) internal {
        vm.prank(operator);
        bot.revealAuction(
            ISealedBidAuction(address(engine)), r, Scenario.BOT_PRICE, Scenario.BOT_AMOUNT, Scenario.BOT_SALT
        );
    }

    function _revealCrowd(uint256 r, uint256 i) internal {
        (, uint96 maxPrice, uint256 budget) = Scenario.buyer(i);
        vm.prank(crowd[i]);
        engine.reveal(r, maxPrice, Scenario.bidAmount(maxPrice, budget), Scenario.crowdSalt(i));
    }

    /// Full round. `botFirst` puts the bot's commit and reveal ahead of everyone; otherwise last.
    function _runAuction(bool botFirst) internal returns (uint256 r) {
        r = _open();
        if (botFirst) _commitBot(r);
        for (uint256 i; i < Scenario.CROWD; ++i) {
            vm.warp(vm.getBlockTimestamp() + 5);
            _commitCrowd(r, i);
        }
        if (!botFirst) _commitBot(r);

        vm.warp(engine.getRound(r).commitEnd);
        if (botFirst) _revealBot(r);
        for (uint256 i; i < Scenario.CROWD; ++i) {
            _revealCrowd(r, Scenario.CROWD - 1 - i);
        }
        if (!botFirst) _revealBot(r);

        vm.warp(engine.getRound(r).revealEnd);
        assertTrue(engine.settle(r, 100));
        engine.seedLP(r);
        vm.prank(operator);
        bot.claimAuction(ISealedBidAuction(address(engine)), r);
        for (uint256 i; i < Scenario.CROWD; ++i) {
            vm.prank(crowd[i]);
            engine.claim(r);
        }
    }

    function _paid(uint256 r, address who) internal view returns (uint256 paid) {
        (uint128 p,,) = engine.accounts(r, who);
        return p;
    }

    // ─── Left pane: the curve rewards being first ───────────────────────

    function test_Curve_BotBuysFirstAndCheapest() public {
        _runCurve();
        uint256 tranches = Scenario.botTranches().length;
        uint256 n = curve.fillCount();
        assertGt(n, tranches);

        uint256 botPaid;
        uint256 botTokens;
        uint256 crowdPaid;
        uint256 crowdTokens;
        for (uint256 i; i < n; ++i) {
            (address buyer,, uint256 paid, uint256 tokens) = curve.fills(i);
            if (i < tranches) assertEq(buyer, address(bot), "bot owns the first fills");
            else assertTrue(buyer != address(bot));
            if (buyer == address(bot)) {
                botPaid += paid;
                botTokens += tokens;
            } else {
                crowdPaid += paid;
                crowdTokens += tokens;
            }
        }
        // Bot's average price per token is below the crowd's: botPaid/botTokens < crowdPaid/crowdTokens.
        assertLt(botPaid * crowdTokens, crowdPaid * botTokens, "bot avg < crowd avg");
        // And not by a little: the crowd pays at least 1.5x.
        assertGt(crowdPaid * botTokens * 2, botPaid * crowdTokens * 3);
        // The bot ends up with more of the sale than the whole crowd.
        assertGt(botTokens, crowdTokens);
        assertEq(curve.balanceOf(address(bot)), botTokens);
    }

    function test_Curve_PricesOnlyRise() public {
        _runCurve();
        uint256 n = curve.fillCount();
        for (uint256 i; i + 1 < n; ++i) {
            (,, uint256 payA, uint256 outA) = curve.fills(i);
            (,, uint256 payB, uint256 outB) = curve.fills(i + 1);
            assertLt(payA * outB, payB * outA, "each fill costs more per token than the last");
        }
    }

    function test_Curve_SomeOfTheCrowdGetsNothing() public {
        _runCurve();
        uint256 empty;
        for (uint256 i; i < Scenario.CROWD; ++i) {
            if (curve.balanceOf(crowd[i]) == 0) empty++;
        }
        assertGt(empty, 0);
        assertEq(curve.sold(), Scenario.SUPPLY);
    }

    function test_Curve_CapDoesNotOversellAndRefunds() public {
        _runCurve();
        assertEq(curve.sold(), Scenario.SUPPLY);
        assertEq(curve.tokenReserve() + curve.sold(), Scenario.VIRTUAL_TOKEN);
        assertEq(address(curve).balance, curve.raised());
        vm.expectRevert(LocalBondingCurve.SoldOut.selector);
        vm.prank(crowd[0]);
        curve.buy{value: 1 ether}();
    }

    function test_Curve_FirstFillMatchesTheFormula() public {
        vm.prank(creator);
        curve.open();
        vm.prank(operator);
        uint256 out = bot.attackCurve();
        // 2000e18 * 30e18 / (200e18 + 30e18), rounded down against the buyer.
        assertEq(out, uint256(2_000e18) * 30e18 / 230e18);
    }

    function test_Curve_RejectsDustAndClosedTrading() public {
        vm.expectRevert(LocalBondingCurve.NotOpen.selector);
        curve.buy{value: 1 ether}();
        vm.prank(creator);
        curve.open();
        vm.expectRevert(LocalBondingCurve.BelowMin.selector);
        curve.buy{value: 0}();
    }

    function test_Bot_OnlyOperator() public {
        vm.prank(creator);
        curve.open();
        vm.expectRevert(SniperBot.NotOperator.selector);
        bot.attackCurve();
    }

    // ─── Right pane: the auction does not ───────────────────────────────

    function test_Auction_BotPaysTheSamePriceAsEveryone() public {
        uint256 r = _runAuction(true);
        (bool settled, uint256 price,,, bool over,,) = engine.clearingOf(r);
        assertTrue(settled);
        assertTrue(over, "demand exceeds supply");
        assertGt(price, Scenario.RESERVE_PRICE);

        // The bot bid aggressively and filled in full, at the clearing price, not at its bid.
        uint256 botAlloc = token.balanceOf(address(bot));
        uint256 botPaid = _paid(r, address(bot));
        assertEq(botAlloc, Scenario.BOT_AMOUNT);
        assertLt(price, Scenario.BOT_PRICE);
        assertEq(botPaid * 1e18 / botAlloc, price, "bot price per token == clearing price");

        // Every winner pays the same price per token. Payments round up (bug #8), and with allocations
        // of at least one whole token the rounding is under 1 wei per token, so the quotient is exact.
        uint256 winners;
        for (uint256 i; i < Scenario.CROWD; ++i) {
            uint256 alloc = token.balanceOf(crowd[i]);
            uint256 paid = _paid(r, crowd[i]);
            if (alloc == 0) {
                assertEq(paid, 0);
                continue;
            }
            winners++;
            assertGe(alloc, 1e18);
            assertEq(paid * 1e18 / alloc, price, "crowd price per token == clearing price");
            assertEq(paid * 1e18 / alloc, botPaid * 1e18 / botAlloc, "crowd price == bot price");
        }
        assertGe(winners, Scenario.CROWD - 2);
    }

    /// Snipe-resistant: submission timing no longer determines price. The bot committing and revealing
    /// first or last changes nothing — not the clearing price, not its allocation, not what it pays.
    function test_Auction_TimingGivesTheBotNothing() public {
        uint256 first = _runAuction(true);
        uint256 last = _runAuction(false);
        (, uint256 priceFirst,,,,,) = engine.clearingOf(first);
        (, uint256 priceLast,,,,,) = engine.clearingOf(last);
        assertEq(priceFirst, priceLast);
        assertEq(token.balanceOf(address(bot)), 2 * uint256(Scenario.BOT_AMOUNT));
        assertEq(_paid(first, address(bot)), _paid(last, address(bot)));
        for (uint256 i; i < Scenario.CROWD; ++i) {
            assertEq(_paid(first, crowd[i]), _paid(last, crowd[i]));
        }
    }

    function test_Auction_BookBalancesAfterClaims() public {
        uint256 r = _runAuction(true);
        (,, uint256 sold,,,,) = engine.clearingOf(r);
        uint256 allocated = token.balanceOf(address(bot));
        uint256 paidTotal = _paid(r, address(bot));
        for (uint256 i; i < Scenario.CROWD; ++i) {
            allocated += token.balanceOf(crowd[i]);
            paidTotal += _paid(r, crowd[i]);
        }
        assertLe(allocated, sold, "never over-allocates");
        assertGe(allocated + Scenario.CROWD + 1, sold, "pro-rata dust under one unit per bid");
        assertEq(engine.getRound(r).collected, paidTotal);
        assertEq(locker.lockCount(), 1, "LP seeded and locked before claims");
    }

    // ─── Both panes, one comparison ─────────────────────────────────────

    function test_HeadToHead() public {
        _runCurve();
        uint256 r = _runAuction(true);

        uint256 curveBotPaid;
        uint256 curveBotTokens;
        uint256 n = curve.fillCount();
        for (uint256 i; i < n; ++i) {
            (address buyer,, uint256 paid, uint256 tokens) = curve.fills(i);
            if (buyer == address(bot)) {
                curveBotPaid += paid;
                curveBotTokens += tokens;
            }
        }
        (, uint256 price,,,,,) = engine.clearingOf(r);
        // On the curve the bot's head start bought it tokens below the price the auction discovers.
        assertLt(curveBotPaid * 1e18 / curveBotTokens, price);
    }
}
