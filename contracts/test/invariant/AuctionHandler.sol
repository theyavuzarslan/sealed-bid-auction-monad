// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AuctionEngine} from "../../src/AuctionEngine.sol";
import {MockToken, MockAdapter} from "../mocks/Mocks.sol";

/// A bidder that cannot take MON: its `receive` reverts. Every refund pushed to it becomes owed (v2, O1).
contract RejectingActor {
    receive() external payable {
        revert("no MON");
    }
}

/// A bidder that burns every unit of gas it is forwarded on `receive`. The engine's 50,000-gas push
/// fails, so its refunds become owed too. Never used as a `withdrawOwed` destination: that call forwards
/// all gas, and the loop would run until the test's gas limit.
contract GasBurningActor {
    receive() external payable {
        while (true) {}
    }
}

/// @notice Drives the engine through random interleavings of every external action across several
///         concurrent rounds: open, commit (valid and invalid bids, wrong deposit, double commit),
///         reveal (with no hint, `findHint`, or an arbitrary hint; wrong salt; someone else's bid),
///         warp, settle in random step sizes, seedLP (with a partially-filling or failing adapter),
///         abandonLP, claim / claimRefund / claimTokens by anyone, claimVested, burnUnrevealed,
///         withdrawProceeds, sweepDust, disposeUnsold and withdrawOwed. Two of the twelve bidders are
///         contracts that cannot take MON (one reverts, one burns all forwarded gas), so refunds become
///         owed (v2) and `withdrawOwed` is exercised.
///
///         Every engine call is made with a precise model of whether it must succeed. A call the model
///         says must succeed is made directly (a revert fails the run, `fail_on_revert = true`); a call
///         the model says must fail is wrapped in try/catch and the handler reverts if it succeeds.
///         Ghost state records every MON and token movement out of the engine, measured as balance
///         differences, for the invariants in AuctionEngine.invariant.t.sol.
contract AuctionHandler is Test {
    address constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint256 constant NO_HINT = type(uint256).max;
    uint256 constant GRACE = 1 days;
    uint256 constant MAX_ROUNDS = 4;
    uint256 constant N_EOAS = 10;
    uint256 constant N_ACTORS = 12; // 10 EOAs, then a RejectingActor and a GasBurningActor
    uint96 constant MIN_BID = 0.01 ether;
    uint96 constant TICK = 0.001 ether;

    AuctionEngine public immutable engine;
    MockToken public immutable token;
    MockAdapter public immutable adapter;
    address public immutable creator;

    address[] public actors;
    uint256[] public rounds;

    /// Per (round, actor).
    struct G {
        uint96 price;
        uint96 amount;
        bytes32 salt;
        bool committed;
        bool valid; // the bid satisfies the engine's reveal rules
        bool revealed;
        uint256 monIn; // MON the engine sent to this bidder
        uint256 owed; // refund credited to refundsOwed instead (the push failed)
        uint256 tokensIn; // tokens the engine sent to this bidder (claim + vesting)
        uint256 refunds; // number of refund payouts
        uint256 deliveries; // number of claim-time token deliveries
    }

    /// Per round.
    struct RG {
        uint256 commits;
        uint256 reveals;
        uint256 refunded; // MON refunded to bidders
        uint256 burnedUnrevealed; // MON 0x…dEaD received from burnUnrevealed
        uint256 lpBurned; // MON 0x…dEaD received from abandonLP
        uint256 withdrawn; // MON the creator received
        uint256 delivered; // tokens sent to bidders
        uint256 disposed; // tokens sent by disposeUnsold / sweepDust
    }

    mapping(uint256 => mapping(address => G)) internal _g;
    mapping(uint256 => RG) internal _rg;

    /// Per actor: owed refunds withdrawn with `withdrawOwed`.
    mapping(address => uint256) public owedWithdrawn;

    uint256 public doubleClaims; // a refund or delivery to someone already paid out
    uint256 public unrevealedPayouts; // any MON or tokens to a bidder who never revealed
    uint256 public mustFailChecked; // calls the model said must revert, and did

    // Coverage counters (how deep the random walks reach).
    uint256 public nSettled;
    uint256 public nSeeded;
    uint256 public nAbandoned;
    uint256 public nRefunds;
    uint256 public nDeliveries;
    uint256 public nVested;
    uint256 public nBurned;
    uint256 public nWithdrawn;
    uint256 public nSwept;
    uint256 public nOwed; // refunds that became owed
    uint256 public nOwedWithdrawn;

    constructor(AuctionEngine engine_, MockToken token_, MockAdapter adapter_, address creator_) {
        engine = engine_;
        token = token_;
        adapter = adapter_;
        creator = creator_;
        for (uint256 i; i < N_EOAS; ++i) {
            address a = address(uint160(uint256(keccak256(abi.encode("even.invariant.actor", i)))));
            actors.push(a);
            vm.deal(a, 1_000_000 ether);
        }
        actors.push(address(new RejectingActor()));
        actors.push(address(new GasBurningActor()));
        vm.deal(actors[N_EOAS], 1_000_000 ether);
        vm.deal(actors[N_EOAS + 1], 1_000_000 ether);
        _openRound(0); // Degen
        _openRound(1 | (1 << 96) | (1 << 104)); // Raise with LP and vesting
    }

    // ─── Views for the invariants ───────────────────────────────────────

    function roundsLength() external view returns (uint256) {
        return rounds.length;
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function ghost(uint256 r, address a) external view returns (G memory) {
        return _g[r][a];
    }

    function roundGhost(uint256 r) external view returns (RG memory) {
        return _rg[r];
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    uint8 constant P_COMMIT = 0; // commit window open
    uint8 constant P_REVEAL = 1; // reveal window open
    uint8 constant P_SETTLE = 2; // reveal window over, not settled
    uint8 constant P_SETTLED = 3; // settled
    uint8 constant P_LP = 4; // settled, LP not done
    uint8 constant P_DONE = 5; // LP done
    uint8 constant P_SETTLE_OR_LATER = 6; // reveal window over

    /// Mostly a round in the phase the action needs, so random walks reach deep states; one time in five,
    /// any round, to exercise the failure paths. If no round is in its reveal window yet, one time in
    /// eight time moves forward to the next one's, so the walk keeps progressing through the lifecycle.
    function _pickFor(uint256 seed, uint8 phase) internal returns (uint256 r, bool ok) {
        uint256 n = rounds.length;
        if (n == 0) return (0, false);
        if (_h(seed ^ 0x9a) % 5 != 0) {
            for (uint256 i; i < n; ++i) {
                uint256 c = rounds[(seed % n + i) % n];
                if (_inPhase(c, phase)) return (c, true);
            }
            if (phase == P_REVEAL && _h(seed ^ 0x77) % 8 == 0) {
                for (uint256 i; i < n; ++i) {
                    uint256 c = rounds[(seed % n + i) % n];
                    uint256 target = engine.getRound(c).commitEnd;
                    if (block.timestamp < target) {
                        vm.warp(target);
                        return (c, true);
                    }
                }
            }
            return (0, false); // nothing in this phase: no-op
        }
        return (rounds[seed % n], true);
    }

    function _inPhase(uint256 r, uint8 phase) internal view returns (bool) {
        AuctionEngine.Round memory rd = engine.getRound(r);
        bool settled = _settled(r);
        if (phase == P_COMMIT) return block.timestamp < rd.commitEnd;
        if (phase == P_REVEAL) return block.timestamp >= rd.commitEnd && block.timestamp < rd.revealEnd;
        if (phase == P_SETTLE) return block.timestamp >= rd.revealEnd && !settled;
        if (phase == P_SETTLED) return settled;
        if (phase == P_LP) return settled && !rd.lpDone;
        if (phase == P_DONE) return rd.lpDone;
        return block.timestamp >= rd.revealEnd;
    }

    uint8 constant WANT_UNREVEALED = 0;
    uint8 constant WANT_CLAIMABLE = 1;
    uint8 constant WANT_VESTING = 2;

    /// Mostly a bidder in the state the action needs (committed, valid and unrevealed; revealed with something
    /// left to claim; or vesting), so random walks reach deep states. One time in five, any bidder, to
    /// exercise the failure paths.
    function _find(uint256 r, uint256 seed, uint8 want) internal view returns (address) {
        if (_h(seed) % 5 != 0) {
            for (uint256 i; i < N_ACTORS; ++i) {
                address a = actors[(seed / 4 + i) % N_ACTORS];
                G storage g = _g[r][a];
                if (want == WANT_UNREVEALED && g.committed && !g.revealed && g.valid) return a;
                if (want == WANT_CLAIMABLE && g.revealed && (g.refunds == 0 || g.deliveries == 0)) return a;
                if (want == WANT_VESTING && g.deliveries != 0) {
                    (uint128 total, uint128 released) = engine.vests(r, a);
                    if (total > released) return a;
                }
            }
        }
        return actors[(seed / 4) % N_ACTORS];
    }

    /// The fuzzer favours round numbers; hash seeds before taking a modulo that picks a branch.
    function _h(uint256 x) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(x)));
    }

    function _settled(uint256 r) internal view returns (bool s) {
        (s,,,,,,) = engine.clearingOf(r);
    }

    function _mulDivUp(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        uint256 x = a * b;
        return x == 0 ? 0 : (x - 1) / d + 1;
    }

    /// The engine's reveal rules (`_onReveal`), restated.
    /// Whether `a` is one of the contract bidders that cannot take MON.
    function isContractActor(address a) public view returns (bool) {
        return a == actors[N_EOAS] || a == actors[N_EOAS + 1];
    }

    function _isValid(AuctionEngine.Round memory rd, uint256 price, uint256 amount) internal pure returns (bool) {
        return price % rd.tickSize == 0 && price >= rd.reservePrice && amount != 0
            && _mulDivUp(price, amount, 1e18) < rd.depositAmount
            && _mulDivUp(rd.reservePrice, amount, 1e18) >= rd.minBidSize;
    }

    function _mustFail(bool succeeded, string memory what) internal {
        require(!succeeded, what);
        mustFailChecked += 1;
    }

    // ─── Actions ────────────────────────────────────────────────────────

    function openRound(uint256 seed) external {
        // Keep rounds rare, so each one gets a full lifecycle: mostly only when none is taking commits.
        for (uint256 i; i < rounds.length; ++i) {
            if (block.timestamp < engine.getRound(rounds[i]).commitEnd && _h(seed) % 4 != 0) return;
        }
        _openRound(_h(seed ^ 0x0e));
    }

    function _openRound(uint256 seed) internal {
        if (rounds.length >= MAX_ROUNDS) return;
        AuctionEngine.OpenParams memory p;
        bool degen = seed % 2 == 0;
        p.preset = degen ? AuctionEngine.Preset.Degen : AuctionEngine.Preset.Raise;
        p.token = address(token);
        p.sellAmount = uint128(200e18 + (seed >> 8) % 2800e18);
        p.depositAmount = uint96(5 ether + (seed >> 40) % 15 ether);
        p.minBidSize = MIN_BID;
        p.tickSize = TICK;
        p.reservePrice = uint96(TICK * (1 + (seed >> 72) % 3));
        p.commitEnd = uint64(block.timestamp + 1 hours);
        p.revealEnd = uint64(block.timestamp + 2 hours);
        bool lp = degen || (seed >> 96) % 2 == 1;
        if (lp) {
            p.lpShareBps = uint16(degen ? 1000 + (seed >> 80) % 9001 : 5000);
            p.dexSplits = new AuctionEngine.DexSplit[](1);
            p.dexSplits[0] = AuctionEngine.DexSplit({adapter: address(adapter), bps: 10_000, fee: 3000});
            p.lockFeeTier = "DEFAULT";
            if (!degen) p.lockDuration = 30 days;
        }
        if (!degen && (seed >> 104) % 2 == 1) {
            p.vestDuration = 30 days;
            p.tgeBps = uint16((seed >> 112) % 10_000);
            p.cliff = uint64((seed >> 128) % 7 days);
        }
        vm.prank(creator);
        rounds.push(engine.openRound(p));
    }

    /// Commits for one to six bidders, so books fill up within the commit window.
    function commit(uint256 rs, uint256 as_, uint256 ps, uint256 ams, uint256 kind) external {
        uint256 n = 1 + _h(kind ^ 0xc0) % 6;
        for (uint256 i; i < n; ++i) {
            unchecked {
                _commitOne(rs, as_ + i * 4, _h(ps + i), _h(ams + i), kind + i);
            }
        }
    }

    function _commitOne(uint256 rs, uint256 as_, uint256 ps, uint256 ams, uint256 kind) internal {
        (uint256 r, bool ok) = _pickFor(rs, P_COMMIT);
        if (!ok) return;
        address a = actors[as_ % N_ACTORS];
        AuctionEngine.Round memory rd = engine.getRound(r);
        G storage g = _g[r][a];
        bytes32[] memory proof = new bytes32[](0);

        if (block.timestamp >= rd.commitEnd || g.committed) {
            vm.prank(a);
            try engine.commit{value: rd.depositAmount}(r, keccak256("late or twice"), proof, "") {
                _mustFail(true, "commit after window or twice");
            } catch {
                _mustFail(false, "");
            }
            return;
        }
        kind = _h(kind);
        if (kind % 20 == 19) {
            vm.prank(a);
            try engine.commit{value: rd.depositAmount - 1}(r, keccak256("short"), proof, "") {
                _mustFail(true, "commit with wrong deposit");
            } catch {
                _mustFail(false, "");
            }
            return;
        }

        uint256 price = rd.reservePrice + uint256(rd.tickSize) * (ps % 20);
        uint256 amin = _mulDivUp(rd.minBidSize, 1e18, rd.reservePrice);
        uint256 amax = (uint256(rd.depositAmount) - 1) * 1e18 / price;
        uint256 amount = amin + ams % (amax - amin + 1);
        // One bid in five is invalid in one of five ways; it can be committed but never revealed.
        uint256 k = kind % 5 == 0 ? (kind / 5) % 5 : 5;
        if (k == 0) price += 1; // off the grid
        else if (k == 1) price = rd.reservePrice > rd.tickSize ? rd.reservePrice - rd.tickSize : price + 1; // below reserve
        else if (k == 2) amount = uint256(rd.depositAmount) * 1e18 / price + 1; // more than the deposit covers
        else if (k == 3) amount = amin / 2; // below the minimum bid
        else if (k == 4) amount = 0;

        g.price = uint96(price);
        g.amount = uint96(amount);
        g.salt = keccak256(abi.encode(r, a, ps, ams, kind));
        g.valid = _isValid(rd, price, amount);
        bytes32 h = keccak256(abi.encode(g.price, g.amount, g.salt, a));
        vm.prank(a);
        engine.commit{value: rd.depositAmount}(r, h, proof, "");
        g.committed = true;
        _rg[r].commits += 1;
    }

    /// Reveals for one to six bidders.
    function reveal(uint256 rs, uint256 as_, uint256 mode, uint256 hs) external {
        uint256 n = 1 + _h(mode ^ 0x5e) % 6;
        for (uint256 i; i < n; ++i) {
            unchecked {
                _revealOne(rs, as_ + i * 4, mode + i, hs);
            }
        }
    }

    function _revealOne(uint256 rs, uint256 as_, uint256 mode, uint256 hs) internal {
        (uint256 r, bool ok) = _pickFor(rs, P_REVEAL);
        if (!ok) return;
        address a = _find(r, as_, WANT_UNREVEALED);
        G storage g = _g[r][a];
        AuctionEngine.Round memory rd = engine.getRound(r);
        bool inWindow = block.timestamp >= rd.commitEnd && block.timestamp < rd.revealEnd;

        if (!g.committed || g.revealed || !inWindow) {
            vm.prank(a);
            try engine.reveal(r, g.price, g.amount, g.salt) {
                _mustFail(true, "reveal without open commitment or outside window");
            } catch {
                _mustFail(false, "");
            }
            return;
        }
        // 0: wrong salt; 1: someone else reveals; 2-4: findHint; 5-7: arbitrary hint; 8-9: no hint.
        uint256 m = _h(mode) % 10;
        if (m == 0) {
            vm.prank(a);
            try engine.reveal(r, g.price, g.amount, g.salt ^ bytes32(uint256(1))) {
                _mustFail(true, "reveal with wrong salt");
            } catch {
                _mustFail(false, "");
            }
            return;
        }
        if (m == 1) {
            uint256 idx;
            while (actors[idx] != a) ++idx;
            address other = actors[(idx + 1) % N_ACTORS];
            vm.prank(other);
            try engine.reveal(r, g.price, g.amount, g.salt) {
                _mustFail(true, "revealed someone else's bid");
            } catch {
                _mustFail(false, "");
            }
            return;
        }
        uint256 hint = m <= 4 ? engine.findHint(r, g.price) : (m <= 7 ? hs : NO_HINT);
        if (!g.valid) {
            vm.prank(a);
            try engine.revealWithHint(r, g.price, g.amount, g.salt, hint) {
                _mustFail(true, "invalid bid accepted");
            } catch {
                _mustFail(false, "");
            }
            return;
        }
        vm.prank(a);
        if (m >= 8) engine.reveal(r, g.price, g.amount, g.salt);
        else engine.revealWithHint(r, g.price, g.amount, g.salt, hint);
        g.revealed = true;
        _rg[r].reveals += 1;
    }

    function warp(uint256 s) external {
        s = _h(s);
        // Small steps, so every window gets many actions; a rare jump of a day or two (abandonLP also
        // jumps to the end of the grace period on its own).
        uint256 d = s % 60 == 0 ? 1 days + s % 1 days : 5 minutes + s % 15 minutes;
        vm.warp(block.timestamp + d);
    }

    function settle(uint256 rs, uint256 steps) external {
        (uint256 r, bool ok) = _pickFor(rs, P_SETTLE);
        if (!ok) return;
        AuctionEngine.Round memory rd = engine.getRound(r);
        uint256 n = 1 + steps % 4;
        if (_settled(r) || block.timestamp < rd.revealEnd) {
            try engine.settle(r, n) {
                _mustFail(true, "settle early or twice");
            } catch {
                _mustFail(false, "");
            }
            return;
        }
        if (engine.settle(r, n)) nSettled += 1;
    }

    function seedLP(uint256 rs, uint256 useBps, uint256 failSeed) external {
        (uint256 r, bool ok) = _pickFor(rs, P_LP);
        if (!ok) return;
        AuctionEngine.Round memory rd = engine.getRound(r);
        if (!_settled(r) || rd.lpDone) {
            try engine.seedLP(r) {
                _mustFail(true, "seedLP unsettled or twice");
            } catch {
                _mustFail(false, "");
            }
            return;
        }
        bool fail = _h(failSeed) % 6 == 0;
        adapter.setUseBps(5000 + useBps % 5001);
        adapter.setRevert(fail);
        if (fail) {
            // Reverts only if this round actually has an LP to seed; either outcome is fine.
            try engine.seedLP(r) {
                nSeeded += 1;
            } catch {}
        } else {
            engine.seedLP(r);
            nSeeded += 1;
        }
        adapter.setRevert(false);
    }

    function abandonLP(uint256 rs) external {
        (uint256 r, bool ok) = _pickFor(rs, P_LP);
        if (!ok) return;
        AuctionEngine.Round memory rd = engine.getRound(r);
        if (_settled(r) && !rd.lpDone && _h(rs ^ 0xab) % 6 == 0 && block.timestamp < uint256(rd.settledAt) + GRACE) {
            vm.warp(uint256(rd.settledAt) + GRACE); // seeding stayed blocked for the whole grace period
        }
        if (!_settled(r) || rd.lpDone || block.timestamp < uint256(rd.settledAt) + GRACE) {
            try engine.abandonLP(r) {
                _mustFail(true, "abandonLP early or twice");
            } catch {
                _mustFail(false, "");
            }
            return;
        }
        uint256 b0 = BURN.balance;
        engine.abandonLP(r);
        _rg[r].lpBurned += BURN.balance - b0;
        nAbandoned += 1;
    }

    /// how: 0 = claim by the bidder, 1 = claimRefund by anyone, 2 = claimTokens by anyone.
    /// Claims for one to eight bidders.
    function claim(uint256 rs, uint256 as_, uint256 how, uint256 cs) external {
        uint256 n = 1 + _h(how ^ 0xc1) % 8;
        for (uint256 i; i < n; ++i) {
            unchecked {
                _claimOne(rs, as_ + i * 4, how + i, cs + i);
            }
        }
    }

    function _claimOne(uint256 rs, uint256 as_, uint256 how, uint256 cs) internal {
        (uint256 r, bool ok) = _pickFor(rs, P_SETTLED);
        if (!ok) return;
        address a = _find(r, as_, WANT_CLAIMABLE);
        address caller = actors[cs % N_ACTORS];
        G storage g = _g[r][a];
        AuctionEngine.Round memory rd = engine.getRound(r);
        bool settled = _settled(r);
        (,, bool accSettled) = engine.accounts(r, a);
        bool tokClaimed = engine.tokensClaimed(r, a);

        uint256 m0 = a.balance;
        uint256 o0 = engine.refundsOwed(a);
        uint256 t0 = token.balanceOf(a);
        uint256 e0 = token.balanceOf(address(engine));
        uint256 h = _h(how) % 3;
        bool expectOk;
        if (h == 0) expectOk = settled && g.revealed && (!accSettled || (rd.claimsOpen && !tokClaimed));
        else if (h == 1) expectOk = settled && g.revealed && !accSettled;
        else expectOk = rd.claimsOpen && g.revealed && !tokClaimed;

        if (expectOk) {
            if (h == 0) {
                vm.prank(a);
                engine.claim(r);
            } else if (h == 1) {
                vm.prank(caller);
                engine.claimRefund(r, a);
            } else {
                vm.prank(caller);
                engine.claimTokens(r, a);
            }
        } else {
            bool succeeded;
            if (h == 0) {
                vm.prank(a);
                try engine.claim(r) {
                    succeeded = true;
                } catch {}
            } else if (h == 1) {
                vm.prank(caller);
                try engine.claimRefund(r, a) {
                    succeeded = true;
                } catch {}
            } else {
                vm.prank(caller);
                try engine.claimTokens(r, a) {
                    succeeded = true;
                } catch {}
            }
            _mustFail(succeeded, "claim the model forbids");
            return;
        }

        uint256 mon = a.balance - m0;
        uint256 owedNow = engine.refundsOwed(a) - o0;
        uint256 tok = token.balanceOf(a) - t0;
        require(e0 - token.balanceOf(address(engine)) == tok, "tokens left the engine to someone else");
        (,, bool nowSettled) = engine.accounts(r, a);
        if (!accSettled && nowSettled) {
            g.refunds += 1;
            nRefunds += 1;
        }
        if (mon != 0 || owedNow != 0) {
            if (accSettled) doubleClaims += 1;
            if (!g.revealed) unrevealedPayouts += 1;
            g.monIn += mon;
            g.owed += owedNow;
            _rg[r].refunded += mon + owedNow;
            if (owedNow != 0) nOwed += 1;
        }
        if (!tokClaimed && engine.tokensClaimed(r, a)) {
            g.deliveries += 1;
            nDeliveries += 1;
        }
        if (tok != 0) {
            if (tokClaimed) doubleClaims += 1;
            if (!g.revealed) unrevealedPayouts += 1;
            g.tokensIn += tok;
            _rg[r].delivered += tok;
        }
    }

    function claimVested(uint256 rs, uint256 as_) external {
        (uint256 r, bool ok) = _pickFor(rs, P_DONE);
        if (!ok) return;
        // Prefer a vesting round whose claims are open.
        for (uint256 i; i < rounds.length && _h(rs ^ 0x1e) % 5 != 0; ++i) {
            AuctionEngine.Round memory c = engine.getRound(rounds[i]);
            if (c.vestDuration != 0 && c.claimsOpen) {
                r = rounds[i];
                break;
            }
        }
        address a = _find(r, as_, WANT_VESTING);
        (uint128 total,) = engine.vests(r, a);
        if (total != 0 && _h(as_ ^ 0x7e) % 2 == 0) vm.warp(block.timestamp + 1 days + _h(as_) % 40 days);
        (uint256 vested, uint256 released) = engine.vestedOf(r, a);
        if (vested == released) {
            vm.prank(a);
            try engine.claimVested(r) {
                _mustFail(true, "claimVested with nothing vested");
            } catch {
                _mustFail(false, "");
            }
            return;
        }
        uint256 t0 = token.balanceOf(a);
        vm.prank(a);
        engine.claimVested(r);
        uint256 tok = token.balanceOf(a) - t0;
        require(tok == vested - released, "vested amount");
        _g[r][a].tokensIn += tok;
        _rg[r].delivered += tok;
        nVested += 1;
    }

    function burnUnrevealed(uint256 rs) external {
        (uint256 r, bool ok) = _pickFor(rs, P_SETTLE_OR_LATER);
        if (!ok) return;
        AuctionEngine.Round memory rd = engine.getRound(r);
        (uint64 commits, uint64 reveals,, uint256 burned) = engine.ledgers(r);
        uint256 due = uint256(commits - reveals) * rd.depositAmount;
        if (block.timestamp < rd.revealEnd || due == burned) {
            try engine.burnUnrevealed(r) {
                _mustFail(true, "burnUnrevealed early or with nothing due");
            } catch {
                _mustFail(false, "");
            }
            return;
        }
        uint256 b0 = BURN.balance;
        engine.burnUnrevealed(r);
        require(BURN.balance - b0 == due - burned, "burn amount");
        _rg[r].burnedUnrevealed += BURN.balance - b0;
        nBurned += 1;
    }

    function withdrawProceeds(uint256 rs, uint256 cs) external {
        (uint256 r, bool ok) = _pickFor(rs, P_DONE);
        if (!ok) return;
        AuctionEngine.Round memory rd = engine.getRound(r);
        bool fromCreator = _h(cs) % 4 != 0;
        address caller = fromCreator ? creator : actors[cs % N_ACTORS];
        if (!fromCreator || !rd.lpDone || engine.creatorAvailable(r) == 0) {
            vm.prank(caller);
            try engine.withdrawProceeds(r) {
                _mustFail(true, "withdrawProceeds forbidden");
            } catch {
                _mustFail(false, "");
            }
            return;
        }
        uint256 c0 = creator.balance;
        vm.prank(creator);
        engine.withdrawProceeds(r);
        _rg[r].withdrawn += creator.balance - c0;
        nWithdrawn += 1;
    }

    function sweepDust(uint256 rs) external {
        (uint256 r, bool ok) = _pickFor(rs, P_DONE);
        if (!ok) return;
        AuctionEngine.Round memory rd = engine.getRound(r);
        (, uint64 reveals, uint64 claims,) = engine.ledgers(r);
        if (!rd.lpDone || rd.dustSwept || claims != reveals) {
            try engine.sweepDust(r) {
                _mustFail(true, "sweepDust forbidden");
            } catch {
                _mustFail(false, "");
            }
            return;
        }
        uint256 e0 = token.balanceOf(address(engine));
        engine.sweepDust(r);
        _rg[r].disposed += e0 - token.balanceOf(address(engine));
        nSwept += 1;
    }

    function disposeUnsold(uint256 rs) external {
        (uint256 r, bool ok) = _pickFor(rs, P_DONE);
        if (!ok) return;
        if (engine.getRound(r).unsoldOwed == 0) {
            try engine.disposeUnsold(r) {
                _mustFail(true, "disposeUnsold with nothing owed");
            } catch {
                _mustFail(false, "");
            }
            return;
        }
        uint256 e0 = token.balanceOf(address(engine));
        engine.disposeUnsold(r);
        _rg[r].disposed += e0 - token.balanceOf(address(engine));
    }

    /// A bidder withdraws its owed refunds (v2). Mostly a contract bidder with something owed, to an EOA;
    /// sometimes to the RejectingActor itself (must fail: the transfer reverts), sometimes a bidder with
    /// nothing owed (must fail).
    function withdrawOwed(uint256 as_, uint256 ts) external {
        address a = _h(as_) % 4 == 0 ? actors[as_ % N_ACTORS] : actors[N_EOAS + as_ % 2];
        uint256 owed = engine.refundsOwed(a);
        bool toRejecter = _h(ts) % 5 == 0;
        address to = toRejecter ? actors[N_EOAS] : actors[ts % N_EOAS];
        if (owed == 0 || toRejecter) {
            uint256 totalBefore = engine.totalOwed();
            vm.prank(a);
            try engine.withdrawOwed(to) {
                _mustFail(true, "withdrawOwed with nothing owed or to a MON-rejecting address");
            } catch {
                _mustFail(false, "");
            }
            require(
                engine.refundsOwed(a) == owed && engine.totalOwed() == totalBefore, "failed withdrawOwed changed state"
            );
            return;
        }
        uint256 b0 = to.balance;
        uint256 total0 = engine.totalOwed();
        vm.prank(a);
        engine.withdrawOwed(to);
        require(to.balance - b0 == owed, "withdrawOwed amount");
        require(engine.refundsOwed(a) == 0, "owed not cleared");
        require(total0 - engine.totalOwed() == owed, "totalOwed not reduced by the withdrawal");
        owedWithdrawn[a] += owed;
        nOwedWithdrawn += 1;
    }
}
