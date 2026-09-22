// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AuctionEngine} from "engine/AuctionEngine.sol";
import {MockToken, MockPositionManager, MockAdapter, MockLocker} from "engine-mocks/Mocks.sol";
import {LocalBondingCurve} from "../src/LocalBondingCurve.sol";
import {SniperBot, ISealedBidAuction} from "../src/SniperBot.sol";
import {Scenario} from "../src/Scenario.sol";

/// @title RunScenario — the sniper head-to-head, as real transactions on anvil
/// @notice Both panes of the demo come from here. Left: LocalBondingCurve + SniperBot. Right: the real
///         AuctionEngine (Degen preset) with the mock DEX adapter and locker from contracts/test/mocks.
///         The auction has on-chain time windows, so the run is four phases with anvil's clock moved
///         forward in between (demo/run.sh does this):
///
///           launch  deploy everything, fund the crowd, open both launches; the bot buys the curve
///                   first and commits first; the crowd follows on both
///           reveal  everyone reveals
///           settle  settle, seed + lock the LP, everyone claims, creator withdraws
///           report  read the chain and write demo/results.json (no transactions)
///
///         forge script script/RunScenario.s.sol --sig "launch()" --rpc-url $RPC --broadcast --slow
contract RunScenario is Script {
    // anvil's default accounts 0 and 1
    uint256 constant CREATOR_KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 constant BOT_OPERATOR_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d;

    string constant STATE = "./.scenario/state.json";
    string constant RESULTS = "./results.json";

    uint256 constant CROWD_FUNDING = 250 ether;
    uint256 constant BOT_FUNDING = 100 ether; // curve tranches; the auction deposit is sent with the commit

    struct State {
        MockToken token;
        MockAdapter adapter;
        MockLocker locker;
        AuctionEngine engine;
        LocalBondingCurve curve;
        SniperBot bot;
        uint256 roundId;
    }

    // ─── Phase 1: launch ────────────────────────────────────────────────

    function launch() external {
        address creator = vm.addr(CREATOR_KEY);
        State memory s;

        vm.startBroadcast(CREATOR_KEY);
        s.token = new MockToken();
        MockPositionManager npm = new MockPositionManager();
        s.adapter = new MockAdapter(npm);
        s.locker = new MockLocker();
        address[] memory adapters = new address[](1);
        adapters[0] = address(s.adapter);
        s.engine = new AuctionEngine(address(s.locker), adapters, 4102444800, 1 days);
        s.curve = new LocalBondingCurve(Scenario.VIRTUAL_TOKEN, Scenario.VIRTUAL_MON, Scenario.SUPPLY, Scenario.MIN_BUY);
        s.token.mint(creator, Scenario.SUPPLY * 2);
        s.token.approve(address(s.engine), type(uint256).max);
        for (uint256 i; i < Scenario.CROWD; ++i) {
            payable(vm.addr(Scenario.crowdKey(i))).transfer(CROWD_FUNDING);
        }
        vm.stopBroadcast();

        vm.startBroadcast(BOT_OPERATOR_KEY);
        s.bot = new SniperBot(s.curve, Scenario.botTranches());
        payable(address(s.bot)).transfer(BOT_FUNDING);
        vm.stopBroadcast();

        // Both launches open. The curve opens last, so the very next block is the bot's.
        vm.startBroadcast(CREATOR_KEY);
        s.roundId = s.engine.openRound(Scenario.openParams(address(s.token), address(s.adapter), block.timestamp));
        s.curve.open();
        vm.stopBroadcast();

        // The bot moves first on both: every curve tranche, then the first sealed commitment.
        vm.startBroadcast(BOT_OPERATOR_KEY);
        uint256 tranches = Scenario.botTranches().length;
        for (uint256 i; i < tranches; ++i) {
            s.bot.attackCurve();
        }
        s.bot.commitAuction{value: Scenario.DEPOSIT}(
            ISealedBidAuction(address(s.engine)),
            s.roundId,
            Scenario.commitHash(Scenario.BOT_PRICE, Scenario.BOT_AMOUNT, Scenario.BOT_SALT, address(s.bot))
        );
        vm.stopBroadcast();

        // The crowd arrives. On the curve each buyer spends their budget unless the price has already
        // passed their maximum or the sale is gone. On the auction each commits a sealed bid.
        for (uint256 i; i < Scenario.CROWD; ++i) {
            (, uint96 maxPrice, uint256 budget) = Scenario.buyer(i);
            uint256 key = Scenario.crowdKey(i);
            vm.startBroadcast(key);
            if (s.curve.sold() < Scenario.SUPPLY && s.curve.spotPrice() < maxPrice) {
                s.curve.buy{value: budget}();
            }
            s.engine.commit{value: Scenario.DEPOSIT}(
                s.roundId,
                Scenario.commitHash(maxPrice, Scenario.bidAmount(maxPrice, budget), Scenario.crowdSalt(i), vm.addr(key)),
                new bytes32[](0),
                ""
            );
            vm.stopBroadcast();
        }

        _saveState(s);
        console2.log("curve sold", s.curve.sold());
        console2.log("round", s.roundId, "commits", _commits(s));
    }

    // ─── Phase 2: reveal ────────────────────────────────────────────────

    function reveal() external {
        State memory s = _loadState();
        vm.broadcast(BOT_OPERATOR_KEY);
        s.bot.revealAuction(
            ISealedBidAuction(address(s.engine)), s.roundId, Scenario.BOT_PRICE, Scenario.BOT_AMOUNT, Scenario.BOT_SALT
        );
        for (uint256 i; i < Scenario.CROWD; ++i) {
            (, uint96 maxPrice, uint256 budget) = Scenario.buyer(i);
            vm.broadcast(Scenario.crowdKey(i));
            s.engine.reveal(s.roundId, maxPrice, Scenario.bidAmount(maxPrice, budget), Scenario.crowdSalt(i));
        }
    }

    // ─── Phase 3: settle, seed, claim ───────────────────────────────────

    function settle() external {
        State memory s = _loadState();
        vm.startBroadcast(CREATOR_KEY);
        require(s.engine.settle(s.roundId, 100), "settle not done in one step");
        s.engine.seedLP(s.roundId);
        vm.stopBroadcast();

        vm.broadcast(BOT_OPERATOR_KEY);
        s.bot.claimAuction(ISealedBidAuction(address(s.engine)), s.roundId);
        for (uint256 i; i < Scenario.CROWD; ++i) {
            vm.broadcast(Scenario.crowdKey(i));
            s.engine.claim(s.roundId);
        }

        vm.broadcast(CREATOR_KEY);
        s.engine.withdrawProceeds(s.roundId);
    }

    // ─── Phase 4: report ────────────────────────────────────────────────

    struct Totals {
        uint256 tokens;
        uint256 paid;
    }

    function report() external {
        State memory s = _loadState();
        string memory json = string.concat(
            "{",
            _meta(s),
            ",",
            _curveSection(s),
            ",",
            _auctionSection(s),
            ",",
            _participants(s),
            "}"
        );
        vm.writeFile(RESULTS, json);
        console2.log("wrote", RESULTS);
    }

    function _meta(State memory s) internal view returns (string memory) {
        AuctionEngine.Round memory r = s.engine.getRound(s.roundId);
        return string.concat(
            '"meta":{"source":"demo/script/RunScenario.s.sol on anvil","chainId":',
            vm.toString(block.chainid),
            ',"token":"',
            Scenario.TOKEN_SYMBOL,
            '","payment":"MON","supply":"',
            vm.toString(Scenario.SUPPLY),
            '","crowd":',
            vm.toString(Scenario.CROWD),
            ',"engine":"',
            vm.toString(address(s.engine)),
            '","curve":"',
            vm.toString(address(s.curve)),
            '","bot":"',
            vm.toString(address(s.bot)),
            '","roundId":',
            vm.toString(s.roundId),
            ',"preset":"Degen","deposit":"',
            vm.toString(uint256(r.depositAmount)),
            '","tick":"',
            vm.toString(uint256(r.tickSize)),
            '","commitWindowSec":',
            vm.toString(uint256(Scenario.COMMIT_WINDOW)),
            ',"revealWindowSec":',
            vm.toString(uint256(Scenario.REVEAL_WINDOW)),
            "}"
        );
    }

    function _curveSection(State memory s) internal view returns (string memory out) {
        LocalBondingCurve c = s.curve;
        uint256 n = c.fillCount();
        uint256 t = Scenario.VIRTUAL_TOKEN;
        uint256 p = Scenario.VIRTUAL_MON;
        string memory fills;
        Totals memory bot;
        Totals memory crowd;
        for (uint256 i; i < n; ++i) {
            (address buyerAddr, uint256 blockNo, uint256 paid, uint256 tokens) = c.fills(i);
            t -= tokens;
            p += paid;
            bool isBot = buyerAddr == address(s.bot);
            if (isBot) {
                bot.tokens += tokens;
                bot.paid += paid;
            } else {
                crowd.tokens += tokens;
                crowd.paid += paid;
            }
            fills = string.concat(
                fills,
                i == 0 ? "" : ",",
                '{"who":"',
                _nameOf(s, buyerAddr),
                '","bot":',
                isBot ? "true" : "false",
                ',"block":',
                vm.toString(blockNo - c.openBlock()),
                ',"paid":"',
                vm.toString(paid),
                '","tokens":"',
                vm.toString(tokens),
                '","spotAfter":"',
                vm.toString(p * 1e18 / t),
                '"}'
            );
        }
        out = string.concat(
            '"curve":{"virtualToken":"',
            vm.toString(Scenario.VIRTUAL_TOKEN),
            '","virtualMon":"',
            vm.toString(Scenario.VIRTUAL_MON),
            '","openPrice":"',
            vm.toString(Scenario.VIRTUAL_MON * 1e18 / Scenario.VIRTUAL_TOKEN),
            '","finalSpot":"',
            vm.toString(c.spotPrice()),
            '","sold":"',
            vm.toString(c.sold()),
            '","raised":"',
            vm.toString(c.raised()),
            '","fills":[',
            fills,
            "],"
        );
        out = string.concat(out, _sideTotals(bot, crowd), "}");
    }

    function _auctionSection(State memory s) internal view returns (string memory out) {
        (bool settled, uint256 price, uint256 sold,, bool over, uint256 demand,) = s.engine.clearingOf(s.roundId);
        require(settled, "not settled");
        Totals memory bot;
        Totals memory crowd;
        (bot.tokens, bot.paid) = _claimed(s, address(s.bot));
        for (uint256 i; i < Scenario.CROWD; ++i) {
            (uint256 tok, uint256 paid) = _claimed(s, vm.addr(Scenario.crowdKey(i)));
            crowd.tokens += tok;
            crowd.paid += paid;
        }
        AuctionEngine.Round memory r = s.engine.getRound(s.roundId);
        out = string.concat(
            '"auction":{"clearingPrice":"',
            vm.toString(price),
            '","sold":"',
            vm.toString(sold),
            '","demand":"',
            vm.toString(demand),
            '","oversubscribed":',
            over ? "true" : "false",
            ',"collected":"',
            vm.toString(r.collected),
            '","lpTokens":"',
            vm.toString(r.lpTokensUsed),
            '","lpMon":"',
            vm.toString(r.lpMonSpent),
            '","lpLocked":',
            s.locker.lockCount() == 1 ? "true" : "false",
            ","
        );
        out = string.concat(out, _sideTotals(bot, crowd), "}");
    }

    function _sideTotals(Totals memory bot, Totals memory crowd) internal pure returns (string memory) {
        return string.concat(
            '"bot":{"tokens":"',
            vm.toString(bot.tokens),
            '","paid":"',
            vm.toString(bot.paid),
            '","avgPrice":"',
            vm.toString(bot.tokens == 0 ? 0 : bot.paid * 1e18 / bot.tokens),
            '"},"crowd":{"tokens":"',
            vm.toString(crowd.tokens),
            '","paid":"',
            vm.toString(crowd.paid),
            '","avgPrice":"',
            vm.toString(crowd.tokens == 0 ? 0 : crowd.paid * 1e18 / crowd.tokens),
            '"}'
        );
    }

    /// One row per participant, bot first: both panes side by side.
    function _participants(State memory s) internal view returns (string memory out) {
        out = string.concat('"participants":[', _participant(s, address(s.bot), "SNIPER BOT", true, 0, 0, 0));
        for (uint256 i; i < Scenario.CROWD; ++i) {
            (string memory name, uint96 maxPrice, uint256 budget) = Scenario.buyer(i);
            out = string.concat(
                out, ",", _participant(s, vm.addr(Scenario.crowdKey(i)), name, false, maxPrice, budget, i + 1)
            );
        }
        out = string.concat(out, "]");
    }

    function _participant(
        State memory s,
        address who,
        string memory name,
        bool isBot,
        uint96 maxPrice,
        uint256 budget,
        uint256 arrival
    ) internal view returns (string memory) {
        return string.concat(
            '{"name":"',
            name,
            '","address":"',
            vm.toString(who),
            '","bot":',
            isBot ? "true" : "false",
            ',"arrival":',
            vm.toString(arrival),
            ',"maxPrice":"',
            vm.toString(uint256(isBot ? Scenario.BOT_PRICE : maxPrice)),
            '","budget":"',
            vm.toString(isBot ? _sum(Scenario.botTranches()) : budget),
            '",',
            _curveOf(s, who, maxPrice),
            ",",
            _auctionOf(s, who),
            "}"
        );
    }

    /// Curve outcome for one participant, from the fills. A crowd member with no fill either found the
    /// price already past their maximum ("priced out") or the sale gone ("sold out"); both are read
    /// back from the chain state at their arrival, replayed from the fills.
    function _curveOf(State memory s, address who, uint96 maxPrice) internal view returns (string memory) {
        LocalBondingCurve c = s.curve;
        uint256 n = c.fillCount();
        uint256 t = Scenario.VIRTUAL_TOKEN;
        uint256 p = Scenario.VIRTUAL_MON;
        uint256 soldBefore;
        uint256 spotAtArrival;
        bool arrived;
        uint256 tokens;
        uint256 paid;
        uint256 firstBlock;
        for (uint256 i; i < n; ++i) {
            (address b, uint256 blockNo, uint256 pay, uint256 tok) = c.fills(i);
            if (b == who) {
                if (!arrived) {
                    arrived = true;
                    spotAtArrival = p * 1e18 / t;
                    firstBlock = blockNo - c.openBlock();
                }
                tokens += tok;
                paid += pay;
            }
            t -= tok;
            p += pay;
            soldBefore += tok;
        }
        string memory status = "filled";
        if (!arrived) {
            (spotAtArrival, soldBefore) = _stateAtArrival(s, who);
            status = soldBefore >= Scenario.SUPPLY ? "sold out" : (spotAtArrival >= maxPrice ? "priced out" : "none");
        }
        return string.concat(
            '"curve":{"status":"',
            status,
            '","block":',
            arrived ? vm.toString(firstBlock) : "null",
            ',"spotAtArrival":"',
            vm.toString(spotAtArrival),
            '","tokens":"',
            vm.toString(tokens),
            '","paid":"',
            vm.toString(paid),
            '","avgPrice":"',
            vm.toString(tokens == 0 ? 0 : paid * 1e18 / tokens),
            '"}'
        );
    }

    /// Replays the fills up to a non-buyer's place in the arrival order (bot first, then crowd 0..11).
    function _stateAtArrival(State memory s, address who) internal view returns (uint256 spot, uint256 soldBefore) {
        uint256 idx = type(uint256).max;
        for (uint256 i; i < Scenario.CROWD; ++i) {
            if (vm.addr(Scenario.crowdKey(i)) == who) idx = i;
        }
        require(idx != type(uint256).max, "unknown buyer");
        LocalBondingCurve c = s.curve;
        uint256 n = c.fillCount();
        uint256 t = Scenario.VIRTUAL_TOKEN;
        uint256 p = Scenario.VIRTUAL_MON;
        for (uint256 i; i < n; ++i) {
            (address b,, uint256 pay, uint256 tok) = c.fills(i);
            if (b != address(s.bot) && _crowdIndex(b) >= idx) break;
            t -= tok;
            p += pay;
            soldBefore += tok;
        }
        spot = p * 1e18 / t;
    }

    function _auctionOf(State memory s, address who) internal view returns (string memory) {
        (bytes32 hash, bool revealed) = s.engine.commitments(s.roundId, who);
        (uint96 price, uint96 amount) = s.engine.bids(s.roundId, who);
        (uint128 paid, uint128 refunded, bool claimed) = s.engine.accounts(s.roundId, who);
        uint256 alloc = s.token.balanceOf(who);
        string memory status = alloc == 0 ? "refunded" : (alloc < amount ? "partial" : "full");
        return string.concat(
            '"auction":{"hash":"',
            vm.toString(hash),
            '","revealed":',
            revealed ? "true" : "false",
            ',"claimed":',
            claimed ? "true" : "false",
            ',"bidPrice":"',
            vm.toString(uint256(price)),
            '","bidAmount":"',
            vm.toString(uint256(amount)),
            '","allocated":"',
            vm.toString(alloc),
            '","paid":"',
            vm.toString(uint256(paid)),
            '","refund":"',
            vm.toString(uint256(refunded)),
            '","pricePerToken":"',
            vm.toString(alloc == 0 ? 0 : uint256(paid) * 1e18 / alloc),
            '","status":"',
            status,
            '"}'
        );
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _claimed(State memory s, address who) internal view returns (uint256 tokens, uint256 paid) {
        (uint128 p,,) = s.engine.accounts(s.roundId, who);
        return (s.token.balanceOf(who), p);
    }

    function _crowdIndex(address who) internal pure returns (uint256) {
        for (uint256 i; i < Scenario.CROWD; ++i) {
            if (vm.addr(Scenario.crowdKey(i)) == who) return i;
        }
        return type(uint256).max;
    }

    function _nameOf(State memory s, address who) internal pure returns (string memory name) {
        if (who == address(s.bot)) return "SNIPER BOT";
        uint256 i = _crowdIndex(who);
        require(i != type(uint256).max, "unknown buyer");
        (name,,) = Scenario.buyer(i);
    }

    function _sum(uint256[] memory xs) internal pure returns (uint256 total) {
        for (uint256 i; i < xs.length; ++i) {
            total += xs[i];
        }
    }

    function _commits(State memory s) internal view returns (uint256 commits) {
        (commits,,,) = s.engine.ledgers(s.roundId);
    }

    function _saveState(State memory s) internal {
        string memory k = "state";
        vm.serializeAddress(k, "token", address(s.token));
        vm.serializeAddress(k, "adapter", address(s.adapter));
        vm.serializeAddress(k, "locker", address(s.locker));
        vm.serializeAddress(k, "engine", address(s.engine));
        vm.serializeAddress(k, "curve", address(s.curve));
        vm.serializeAddress(k, "bot", address(s.bot));
        string memory json = vm.serializeUint(k, "roundId", s.roundId);
        vm.writeJson(json, STATE);
    }

    function _loadState() internal view returns (State memory s) {
        string memory json = vm.readFile(STATE);
        s.token = MockToken(vm.parseJsonAddress(json, ".token"));
        s.adapter = MockAdapter(payable(vm.parseJsonAddress(json, ".adapter")));
        s.locker = MockLocker(vm.parseJsonAddress(json, ".locker"));
        s.engine = AuctionEngine(payable(vm.parseJsonAddress(json, ".engine")));
        s.curve = LocalBondingCurve(vm.parseJsonAddress(json, ".curve"));
        s.bot = SniperBot(payable(vm.parseJsonAddress(json, ".bot")));
        s.roundId = vm.parseJsonUint(json, ".roundId");
    }
}
