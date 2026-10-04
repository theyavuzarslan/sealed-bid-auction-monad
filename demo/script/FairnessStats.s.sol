// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {AuctionEngine} from "engine/AuctionEngine.sol";
import {MockToken, MockPositionManager, MockAdapter, MockLocker} from "engine-mocks/Mocks.sol";
import {LocalBondingCurve} from "../src/LocalBondingCurve.sol";
import {Scenario} from "../src/Scenario.sol";

/// @notice Fairness statistics over many random launches, each played twice with the same people:
///         on a bonding curve (a sniper bot buys in the first blocks, the crowd arrives in random
///         order) and on the real AuctionEngine (everyone bids sealed; the bot bids high).
///         In memory, no broadcast. Writes per-launch numbers to fairness.json; summarise with
///         `node tools/fairness-summary.mjs`.
/// Run: forge script script/FairnessStats.s.sol      (env: LAUNCHES, default 300; SEED, default 1)
contract FairnessStats is Script {
    uint256 constant E18 = 1e18;
    uint256 constant TICK = 0.001 ether;

    MockToken token;
    MockAdapter adapter;
    AuctionEngine engine;
    address creator = address(0xC0FFEE);

    struct Person {
        address who;
        uint96 maxPrice; // MON wei per token, on the tick grid
        uint256 budget; // MON wei
    }

    function rnd(uint256 seed, uint256 k, uint256 i, string memory tag) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, k, i, tag)));
    }

    function between(uint256 r, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return lo + (r % (hi - lo + 1));
    }

    function run() external {
        vm.pauseGasMetering();
        uint256 launches = vm.envOr("LAUNCHES", uint256(300));
        uint256 seed = vm.envOr("SEED", uint256(1));
        vm.warp(1_800_000_000);
        vm.roll(100);

        vm.deal(creator, 1e30);
        vm.startPrank(creator);
        token = new MockToken();
        MockPositionManager npm = new MockPositionManager();
        adapter = new MockAdapter(npm);
        address[] memory adapters = new address[](1);
        adapters[0] = address(adapter);
        engine = new AuctionEngine(address(new MockLocker()), adapters, 4102444800, 1 days);
        token.mint(creator, 1e40);
        token.approve(address(engine), type(uint256).max);
        vm.stopPrank();

        string memory out = "fairness";
        string memory json;
        for (uint256 k; k < launches; ++k) {
            json = _launch(seed, k, out);
        }
        vm.writeJson(json, "./fairness.json");
    }

    // One launch, both mechanisms, same people. Returns the running JSON object.
    function _launch(uint256 seed, uint256 k, string memory out) internal returns (string memory) {
        uint256 n = between(rnd(seed, k, 0, "n"), 8, 24);
        Person[] memory crowd = new Person[](n);
        for (uint256 i; i < n; ++i) {
            address who = vm.addr(rnd(seed, k, i, "key") % (type(uint128).max) + 1);
            uint96 maxPrice = uint96(between(rnd(seed, k, i, "p"), 150, 600) * TICK); // 0.15–0.60 MON
            uint256 budget = between(rnd(seed, k, i, "b"), 8, 40) * 1 ether; // 8–40 MON
            crowd[i] = Person(who, maxPrice, budget);
            vm.deal(who, 1000 ether);
        }
        address bot = vm.addr(rnd(seed, k, 999, "bot") % (type(uint128).max) + 1);
        vm.deal(bot, 1000 ether);
        uint256 botBudget = between(rnd(seed, k, 0, "botb"), 40, 120) * 1 ether;
        uint96 botPrice = uint96(between(rnd(seed, k, 0, "botp"), 350, 600) * TICK);

        // ── Bonding curve: the bot buys in blocks 1–3, then the crowd in random order ──
        uint256[] memory curveTok = new uint256[](n);
        uint256[] memory curvePaid = new uint256[](n);
        uint256[] memory arrival = new uint256[](n); // arrival[pos] = crowd index
        for (uint256 i; i < n; ++i) arrival[i] = i;
        for (uint256 i = n - 1; i > 0; --i) {
            uint256 j = rnd(seed, k, i, "perm") % (i + 1);
            (arrival[i], arrival[j]) = (arrival[j], arrival[i]);
        }
        (uint256 botTokC, uint256 botPaidC, uint256 soldC) = _curve(crowd, arrival, bot, botBudget, curveTok, curvePaid);

        // ── Even: everyone sealed, real engine ──
        (uint256 r, uint256 P) = _auction(crowd, bot, botPrice, botBudget);
        (uint256 botTokE,,) = engine.quote(r, bot);

        // ── Metrics ──
        string memory o = vm.toString(k);
        vm.serializeUint(o, "crowd", n);
        vm.serializeUint(o, "clearing", P);
        vm.serializeUint(o, "curveBotAvg", botTokC == 0 ? 0 : botPaidC * E18 / botTokC);
        vm.serializeUint(o, "curveBotShareBps", soldC == 0 ? 0 : botTokC * 10_000 / soldC);
        (,, uint256 soldE,,,,) = engine.clearingOf(r);
        vm.serializeUint(o, "evenBotShareBps", soldE == 0 ? 0 : botTokE * 10_000 / soldE);
        // crowd on the curve: average price, spread, early vs late, shut out
        (uint256 crowdAvgC, uint256 minAvg, uint256 maxAvg, uint256 shutC, uint256 interested) = _curveCrowd(crowd, curveTok, curvePaid, P);
        vm.serializeUint(o, "curveCrowdAvg", crowdAvgC);
        vm.serializeUint(o, "curveMinBuyerAvg", minAvg);
        vm.serializeUint(o, "curveMaxBuyerAvg", maxAvg);
        vm.serializeUint(o, "curveShutOut", shutC);
        vm.serializeUint(o, "interested", interested);
        (uint256 early, uint256 late) = _earlyLate(arrival, curveTok, curvePaid);
        vm.serializeUint(o, "curveEarlyAvg", early);
        vm.serializeUint(o, "curveLateAvg", late);
        (uint256 shutE, uint256 maxDevE) = _evenCrowd(r, crowd, bot, P);
        vm.serializeUint(o, "evenShutOut", shutE);
        string memory item = vm.serializeUint(o, "evenMaxPriceDeviationWei", maxDevE);
        return vm.serializeString(out, o, item);
    }

    function _curve(Person[] memory crowd, uint256[] memory arrival, address bot, uint256 botBudget, uint256[] memory tok, uint256[] memory paid)
        internal
        returns (uint256 botTok, uint256 botPaid, uint256 sold)
    {
        vm.prank(creator);
        LocalBondingCurve curve = new LocalBondingCurve(Scenario.VIRTUAL_TOKEN, Scenario.VIRTUAL_MON, Scenario.SUPPLY, Scenario.MIN_BUY);
        vm.prank(creator);
        curve.open();
        uint256[3] memory split = [botBudget * 40 / 100, botBudget * 35 / 100, botBudget - botBudget * 75 / 100];
        for (uint256 t; t < 3; ++t) {
            vm.roll(vm.getBlockNumber() + 1);
            if (curve.sold() >= Scenario.SUPPLY) break;
            uint256 before = bot.balance;
            vm.prank(bot);
            botTok += curve.buy{value: split[t]}();
            botPaid += before - bot.balance;
        }
        for (uint256 pos; pos < arrival.length; ++pos) {
            Person memory p = crowd[arrival[pos]];
            vm.roll(vm.getBlockNumber() + 1);
            if (curve.sold() >= Scenario.SUPPLY || curve.spotPrice() >= p.maxPrice) continue;
            uint256 before = p.who.balance;
            vm.prank(p.who);
            tok[arrival[pos]] = curve.buy{value: p.budget}();
            paid[arrival[pos]] = before - p.who.balance;
        }
        sold = curve.sold();
    }

    function _auction(Person[] memory crowd, address bot, uint96 botPrice, uint256 botBudget) internal returns (uint256 r, uint256 P) {
        vm.prank(creator);
        r = engine.openRound(Scenario.openParams(address(token), address(adapter), vm.getBlockTimestamp()));
        uint96 deposit = Scenario.DEPOSIT;
        uint96 botAmount = uint96(botBudget * E18 / botPrice);
        bytes32 bs = keccak256(abi.encode("bot", r));
        vm.prank(bot);
        engine.commit{value: deposit}(r, keccak256(abi.encode(botPrice, botAmount, bs, bot)), new bytes32[](0), "");
        for (uint256 i; i < crowd.length; ++i) {
            uint96 amt = uint96(crowd[i].budget * E18 / crowd[i].maxPrice);
            vm.prank(crowd[i].who);
            engine.commit{value: deposit}(r, keccak256(abi.encode(crowd[i].maxPrice, amt, bytes32(i), crowd[i].who)), new bytes32[](0), "");
        }
        vm.warp(engine.getRound(r).commitEnd);
        vm.prank(bot);
        engine.reveal(r, botPrice, botAmount, bs);
        for (uint256 i; i < crowd.length; ++i) {
            uint96 amt = uint96(crowd[i].budget * E18 / crowd[i].maxPrice);
            vm.prank(crowd[i].who);
            engine.reveal(r, crowd[i].maxPrice, amt, bytes32(i));
        }
        vm.warp(engine.getRound(r).revealEnd);
        engine.settle(r, 1000);
        (, P,,,,,) = engine.clearingOf(r);
    }

    function _curveCrowd(Person[] memory crowd, uint256[] memory tok, uint256[] memory paid, uint256 P)
        internal
        pure
        returns (uint256 avg, uint256 minAvg, uint256 maxAvg, uint256 shut, uint256 interested)
    {
        uint256 tTok;
        uint256 tPaid;
        minAvg = type(uint256).max;
        for (uint256 i; i < crowd.length; ++i) {
            if (crowd[i].maxPrice >= P) {
                interested++;
                if (tok[i] == 0) shut++;
            }
            if (tok[i] == 0) continue;
            tTok += tok[i];
            tPaid += paid[i];
            uint256 a = paid[i] * E18 / tok[i];
            if (a < minAvg) minAvg = a;
            if (a > maxAvg) maxAvg = a;
        }
        avg = tTok == 0 ? 0 : tPaid * E18 / tTok;
        if (minAvg == type(uint256).max) minAvg = 0;
    }

    /// Average price of the first third of crowd arrivals that bought, and of the last third.
    function _earlyLate(uint256[] memory arrival, uint256[] memory tok, uint256[] memory paid) internal pure returns (uint256 early, uint256 late) {
        uint256 third = arrival.length / 3;
        uint256 eT; uint256 eP; uint256 lT; uint256 lP;
        for (uint256 pos; pos < arrival.length; ++pos) {
            uint256 i = arrival[pos];
            if (tok[i] == 0) continue;
            if (pos < third) { eT += tok[i]; eP += paid[i]; }
            else if (pos >= arrival.length - third) { lT += tok[i]; lP += paid[i]; }
        }
        early = eT == 0 ? 0 : eP * E18 / eT;
        late = lT == 0 ? 0 : lP * E18 / lT;
    }

    /// On Even: winners who bid at or above P but got nothing, and the largest gap between any
    /// winner's price per token and P (rounding only).
    function _evenCrowd(uint256 r, Person[] memory crowd, address bot, uint256 P) internal view returns (uint256 shut, uint256 maxDev) {
        for (uint256 i; i <= crowd.length; ++i) {
            address who = i == crowd.length ? bot : crowd[i].who;
            (uint256 alloc, uint256 paid,) = engine.quote(r, who);
            if (i < crowd.length && crowd[i].maxPrice >= P && alloc == 0) shut++;
            if (alloc == 0) continue;
            uint256 per = paid * E18 / alloc;
            uint256 dev = per > P ? per - P : P - per;
            if (dev > maxDev) maxDev = dev;
        }
    }
}
