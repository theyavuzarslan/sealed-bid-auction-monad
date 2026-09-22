// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {LocalBondingCurve} from "../src/LocalBondingCurve.sol";
import {SniperBot} from "../src/SniperBot.sol";

/// @notice Harness checks for the 20-second cut. Not ClearingCore.
/// @dev Equal-price tie break is not specified. This sort keeps the earlier input first.
///      Bid `tokenAmount` is tokens requested. TODO: 05-data-model says Bid.quantity is
///      bidding-token amount. Screen 4 shows an allocation, which is what this harness fills.
contract HeadToHeadTest is Test {
    uint256 internal constant VIRTUAL_TOKEN = 500_000;
    uint256 internal constant VIRTUAL_PAYMENT = 8_000;
    uint256 internal constant TOKENS_FOR_SALE = 380_000;
    uint256 internal constant MIN_BUY = 1;
    uint256 internal constant PRICE_SCALE = 100;
    uint256 internal constant MIN_BID = 1_000;
    uint256 internal constant SELL_AMOUNT = 380_000;

    LocalBondingCurve internal curve;
    SniperBot internal bot;

    function _spend() internal pure returns (uint256[] memory spends) {
        spends = new uint256[](3);
        spends[0] = 1_200;
        spends[1] = 1_600;
        spends[2] = 2_000;
    }

    function _deploy(uint256 start) internal {
        curve = new LocalBondingCurve(VIRTUAL_TOKEN, VIRTUAL_PAYMENT, TOKENS_FOR_SALE, MIN_BUY);
        bot = new SniperBot(curve, start, _spend(), 800, 120_000, PRICE_SCALE, MIN_BID);
    }

    function _botTakesFirstBlocks(uint256 start) internal {
        vm.roll(start);
        bot.attackCurve();
        vm.roll(start + 1);
        bot.attackCurve();
        vm.roll(start + 2);
        bot.attackCurve();
    }

    function _communityAfter(uint256 start) internal {
        uint256[5] memory pays = [uint256(2_200), 2_400, 2_600, 2_800, 3_000];
        for (uint256 i = 0; i < pays.length; ++i) {
            vm.roll(start + bot.firstBlocks() + 1 + i * 2);
            curve.buy(pays[i]);
        }
    }

    function _cheaper(uint256 payA, uint256 outA, uint256 payB, uint256 outB) internal pure returns (bool) {
        return payA * outB < payB * outA;
    }

    function test_botTakesTheFirstBlocks() public {
        uint256 start = 10;
        _deploy(start);
        vm.roll(start - 1);
        vm.expectRevert(SniperBot.NotFirstBlock.selector);
        bot.attackCurve();

        vm.roll(start);
        bot.attackCurve();
        vm.expectRevert(SniperBot.AlreadyAttacked.selector);
        bot.attackCurve();

        vm.roll(start + 1);
        bot.attackCurve();
        vm.roll(start + 2);
        bot.attackCurve();

        vm.roll(start + 3);
        vm.expectRevert(SniperBot.NotFirstBlock.selector);
        bot.attackCurve();

        assertEq(curve.fillCount(), 3);
        for (uint256 i = 0; i < 3; ++i) {
            (address buyer, uint256 blockNo,,) = curve.fills(i);
            assertEq(buyer, address(bot));
            assertEq(blockNo, start + i);
        }
    }

    function test_laterBuyersPayMore() public {
        uint256 start = 10;
        _deploy(start);
        _botTakesFirstBlocks(start);
        _communityAfter(start);

        assertEq(curve.fillCount(), 8);
        uint256 count = 8;
        for (uint256 i = 0; i < count; ++i) {
            (address buyer,,,) = curve.fills(i);
            if (i < 3) assertEq(buyer, address(bot));
            else assertEq(buyer, address(this));
        }
        for (uint256 i = 0; i < count - 1; ++i) {
            (,, uint256 payA, uint256 outA) = curve.fills(i);
            (,, uint256 payB, uint256 outB) = curve.fills(i + 1);
            assertTrue(_cheaper(payA, outA, payB, outB));
        }

        (,, uint256 botPay, uint256 botOut) = curve.fills(2);
        (,, uint256 humanPay, uint256 humanOut) = curve.fills(3);
        assertTrue(_cheaper(botPay, botOut, humanPay, humanOut));
        assertEq(curve.tokenReserve() + curve.sold(), VIRTUAL_TOKEN);
        assertLe(curve.sold(), TOKENS_FOR_SALE);
    }

    function test_firstFillMatchesHarnessMath() public {
        _deploy(10);
        vm.roll(10);
        uint256 out = bot.attackCurve();
        // (500_000 * 1_200) / (8_000 + 1_200) = 65_217. Rounds against the buyer.
        assertEq(out, 65_217);
    }

    function test_capDoesNotOversell() public {
        uint256 start = 10;
        _deploy(start);
        _botTakesFirstBlocks(start);
        _communityAfter(start);

        uint256 left = curve.tokensForSale() - curve.sold();
        assertGt(left, 0);
        uint256 reserveToken = curve.tokenReserve();
        uint256 reservePayment = curve.paymentReserve();
        uint256 denom = reserveToken - left;
        uint256 need = (left * reservePayment + denom - 1) / denom;

        uint256 out = curve.buy(need + 50_000);
        assertEq(out, left);
        assertEq(curve.sold(), TOKENS_FOR_SALE);
        (,, uint256 paid,) = curve.fills(curve.fillCount() - 1);
        assertEq(paid, need);

        vm.expectRevert(LocalBondingCurve.SoldOut.selector);
        curve.buy(need);
    }

    function test_auctionBidIgnoresTheBlock() public {
        _deploy(10);
        vm.roll(1);
        (uint96 priceA, uint96 amountA) = bot.auctionBid();
        vm.roll(90);
        (uint96 priceB, uint96 amountB) = bot.auctionBid();
        assertEq(priceA, priceB);
        assertEq(amountA, amountB);
        assertEq(priceA, 800);
        assertEq(amountA, 120_000);
    }

    function test_clearingPriceIsUniformAndMarginalIsPartial() public {
        _deploy(10);
        (uint96 botPrice, uint96 botAmount) = bot.auctionBid();

        // Commit order is not price order. The bot is not first.
        Bid[] memory bids = new Bid[](6);
        bids[0] = Bid({price: 640, tokenAmount: 90_000});
        bids[1] = Bid({price: 250, tokenAmount: 80_000});
        bids[2] = Bid({price: 510, tokenAmount: 70_000});
        bids[3] = Bid({price: 360, tokenAmount: 50_000});
        bids[4] = Bid({price: botPrice, tokenAmount: botAmount});
        bids[5] = Bid({price: 430, tokenAmount: 60_000});

        (uint256 clearing, uint256[] memory filled, uint256 remaining) = _clear(bids, SELL_AMOUNT);

        assertEq(remaining, 0);
        assertEq(clearing, 360);
        assertEq(_sum(filled), SELL_AMOUNT);

        uint256 botIndex = 4;
        assertEq(filled[botIndex], 120_000);
        assertEq(filled[0], 90_000);
        assertEq(filled[2], 70_000);
        assertEq(filled[5], 60_000);
        assertEq(filled[3], 40_000);
        assertLt(filled[3], bids[3].tokenAmount);
        assertEq(filled[1], 0);

        for (uint256 i = 0; i < bids.length; ++i) {
            assertLe(filled[i], bids[i].tokenAmount);
            if (filled[i] > 0) {
                assertGe(bids[i].price, clearing);
            }
        }
    }

    function test_exactBoundaryDoesNotOverAllocate() public pure {
        Bid[] memory bids = new Bid[](3);
        bids[0] = Bid({price: 5, tokenAmount: 60});
        bids[1] = Bid({price: 4, tokenAmount: 40});
        bids[2] = Bid({price: 3, tokenAmount: 30});

        (uint256 clearing, uint256[] memory filled, uint256 remaining) = _clear(bids, 100);
        assertEq(remaining, 0);
        assertEq(clearing, 4);
        assertEq(filled[0], 60);
        assertEq(filled[1], 40);
        assertEq(filled[2], 0);
        assertEq(_sum(filled), 100);
    }

    function test_priceTimesQuantityRoundsAgainstTheBidder() public pure {
        uint256 scale = 100;
        uint256 dust = _payment(1, 1, scale);
        assertEq(dust, 1);
        assertGe(dust * scale, uint256(1));
        assertLt((dust - 1) * scale, uint256(1));

        uint256 exact = _payment(50_000, 360, scale);
        assertEq(exact, 180_000);
        assertEq(exact * scale, 50_000 * 360);
    }

    function test_botRejectsABidUnderTheMinimum() public {
        curve = new LocalBondingCurve(VIRTUAL_TOKEN, VIRTUAL_PAYMENT, TOKENS_FOR_SALE, MIN_BUY);
        vm.expectRevert(SniperBot.BelowMinBid.selector);
        new SniperBot(curve, 1, _spend(), 1, 1, PRICE_SCALE, MIN_BID);
    }

    function test_curveRejectsDust() public {
        _deploy(10);
        vm.expectRevert(LocalBondingCurve.BelowMin.selector);
        curve.buy(0);
    }

    struct Bid {
        uint96 price;
        uint96 tokenAmount;
    }

    /// @dev Flow 4, as played by the harness: rank by price, accumulate token volume to the
    ///      sell amount, the crossing bid sets one price, that bid may be partial.
    ///      TODO: not specified — price when revealed demand does not cover the sell amount.
    ///      The clip's cast covers it. `remaining` is returned rather than inventing a price.
    function _clear(Bid[] memory bids, uint256 sellAmount)
        internal
        pure
        returns (uint256 clearingPrice, uint256[] memory filled, uint256 remaining)
    {
        uint256 n = bids.length;
        uint256[] memory order = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            order[i] = i;
        }
        for (uint256 i = 1; i < n; ++i) {
            uint256 key = order[i];
            uint256 j = i;
            while (j > 0) {
                Bid memory prev = bids[order[j - 1]];
                Bid memory cur = bids[key];
                bool curRanksHigher = cur.price > prev.price || (cur.price == prev.price && key < order[j - 1]);
                if (!curRanksHigher) break;
                order[j] = order[j - 1];
                j -= 1;
            }
            order[j] = key;
        }

        filled = new uint256[](n);
        remaining = sellAmount;
        for (uint256 i = 0; i < n; ++i) {
            if (remaining == 0) break;
            uint256 idx = order[i];
            uint256 want = bids[idx].tokenAmount;
            uint256 take = want > remaining ? remaining : want;
            filled[idx] = take;
            remaining -= take;
            clearingPrice = bids[idx].price;
        }
    }

    function _sum(uint256[] memory xs) internal pure returns (uint256 total) {
        for (uint256 i = 0; i < xs.length; ++i) {
            total += xs[i];
        }
    }

    function _payment(uint256 tokenAmount, uint256 price, uint256 scale) internal pure returns (uint256) {
        return (tokenAmount * price + scale - 1) / scale;
    }
}
