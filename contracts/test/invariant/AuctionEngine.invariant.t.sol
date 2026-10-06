// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {AuctionEngine} from "../../src/AuctionEngine.sol";
import {EngineBase} from "../AuctionEngine.t.sol";
import {AuctionHandler} from "./AuctionHandler.sol";

/// @notice Invariants of the launch engine under random interleavings of every action across up to five
///         concurrent Degen and Raise rounds (see AuctionHandler). The handler runs with
///         `fail_on_revert = true`: every action its model says must succeed did succeed, and every action
///         it says must fail did fail.
///
///         Default profile: 32 runs × depth 128. Deep (500 × 256):
///           FOUNDRY_PROFILE=deep forge test --match-contract AuctionEngineInvariantTest
contract AuctionEngineInvariantTest is EngineBase {
    AuctionHandler handler;

    struct Ref {
        uint256 price;
        uint256 qtyAbove;
        uint256 qtyAt;
        uint256 total;
        bool over;
        bool reached;
    }

    function setUp() public override {
        super.setUp();
        handler = new AuctionHandler(engine, token, adapter, creator);
        targetContract(address(handler));
        bytes4[] memory s = new bytes4[](22);
        s[0] = AuctionHandler.openRound.selector;
        s[1] = AuctionHandler.commit.selector;
        s[2] = AuctionHandler.reveal.selector;
        s[3] = AuctionHandler.warp.selector;
        s[4] = AuctionHandler.settle.selector;
        s[5] = AuctionHandler.seedLP.selector;
        s[6] = AuctionHandler.abandonLP.selector;
        s[7] = AuctionHandler.claim.selector;
        s[8] = AuctionHandler.claimVested.selector;
        s[9] = AuctionHandler.burnUnrevealed.selector;
        s[10] = AuctionHandler.withdrawProceeds.selector;
        s[11] = AuctionHandler.sweepDust.selector;
        s[12] = AuctionHandler.disposeUnsold.selector;
        // Weight the lifecycle so books fill up before time runs out and claims get exercised.
        s[13] = AuctionHandler.commit.selector;
        s[14] = AuctionHandler.commit.selector;
        s[15] = AuctionHandler.reveal.selector;
        s[16] = AuctionHandler.reveal.selector;
        s[17] = AuctionHandler.claim.selector;
        s[18] = AuctionHandler.claim.selector;
        s[19] = AuctionHandler.settle.selector;
        s[20] = AuctionHandler.warp.selector;
        s[21] = AuctionHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: s}));
    }

    // ─── Reference clearing, from the handler's record of revealed bids ──

    function _reference(uint256 r) internal view returns (Ref memory ref) {
        uint256 n = handler.actorsLength();
        uint256[] memory ps = new uint256[](n);
        uint256[] memory qs = new uint256[](n);
        uint256 m;
        for (uint256 i; i < n; ++i) {
            AuctionHandler.G memory g = handler.ghost(r, handler.actors(i));
            if (!g.revealed) continue;
            ref.total += g.amount;
            uint256 j;
            while (j < m && ps[j] != g.price) ++j;
            if (j == m) {
                ps[m] = g.price;
                ++m;
            }
            qs[j] += g.amount;
        }
        // Sort levels descending (m <= 10).
        for (uint256 i; i < m; ++i) {
            for (uint256 j = i + 1; j < m; ++j) {
                if (ps[j] > ps[i]) {
                    (ps[i], ps[j]) = (ps[j], ps[i]);
                    (qs[i], qs[j]) = (qs[j], qs[i]);
                }
            }
        }
        uint256 supply = engine.getRound(r).sellAmount;
        uint256 cum;
        for (uint256 i; i < m; ++i) {
            if (cum + qs[i] >= supply) {
                ref.price = ps[i];
                ref.qtyAbove = cum;
                ref.qtyAt = qs[i];
                ref.over = cum + qs[i] > supply;
                ref.reached = true;
                return ref;
            }
            cum += qs[i];
        }
        if (m != 0) {
            ref.price = ps[m - 1];
            ref.qtyAt = qs[m - 1];
            ref.qtyAbove = cum - qs[m - 1];
        }
    }

    function _refAlloc(Ref memory ref, uint256 supply, uint256 price, uint256 amount) internal pure returns (uint256) {
        if (price > ref.price) return amount;
        if (price < ref.price) return 0;
        if (!ref.over) return amount;
        return amount * (supply - ref.qtyAbove) / ref.qtyAt;
    }

    function _mulDivUp(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        uint256 x = a * b;
        return x == 0 ? 0 : (x - 1) / d + 1;
    }

    // ─── Invariants ─────────────────────────────────────────────────────

    /// The engine holds exactly the MON its rounds account for: nothing stranded, nothing owed uncovered.
    function invariant_MonBalanceEqualsSumOfRoundBalances() public view {
        uint256 sum;
        uint256 n = engine.roundCount();
        for (uint256 r = 1; r <= n; ++r) {
            sum += engine.roundBalance(r);
        }
        assertEq(address(engine).balance, sum, "engine MON != sum of roundBalance");
    }

    /// Per round: roundBalance = deposits − burned − refunds − LP MON (spent or burned) − proceeds withdrawn,
    /// each outflow measured independently by the handler as a balance change.
    function invariant_RoundBalanceDecomposes() public view {
        uint256 n = engine.roundCount();
        for (uint256 r = 1; r <= n; ++r) {
            AuctionEngine.Round memory rd = engine.getRound(r);
            AuctionHandler.RG memory rg = handler.roundGhost(r);
            (uint64 commits,,, uint256 burned) = engine.ledgers(r);
            assertEq(burned, rg.burnedUnrevealed, "ledger.burned != MON received by 0xdEaD");
            assertEq(rd.lpMonBurned, rg.lpBurned, "lpMonBurned != MON received by 0xdEaD");
            assertEq(
                engine.roundBalance(r),
                uint256(commits) * rd.depositAmount - rg.burnedUnrevealed - rg.refunded - rd.lpMonSpent - rg.lpBurned
                    - rg.withdrawn,
                "roundBalance decomposition"
            );
            assertEq(rd.withdrawn, rg.withdrawn, "withdrawn");
        }
    }

    /// The engine holds exactly the tokens its rounds have not yet sent out, and every token out is
    /// accounted for as a delivery, LP or disposal.
    function invariant_TokensAccountedFor() public view {
        uint256 sum;
        uint256 n = engine.roundCount();
        for (uint256 r = 1; r <= n; ++r) {
            AuctionEngine.Round memory rd = engine.getRound(r);
            AuctionHandler.RG memory rg = handler.roundGhost(r);
            uint256 pulled = uint256(rd.sellAmount) + rd.tokenReserve;
            assertLe(rd.tokensOut, pulled, "tokensOut > pulled");
            assertEq(rd.tokensOut, rg.delivered + rd.lpTokensUsed + rg.disposed, "tokensOut decomposition");
            assertLe(rd.lpTokensUsed, rd.tokenReserve, "LP used more than its reserve");
            sum += pulled - rd.tokensOut;
        }
        assertEq(token.balanceOf(address(engine)), sum, "engine tokens != sum of rounds' unsent tokens");
    }

    /// Clearing matches a reference computed from the revealed bids; P is on the grid and >= reserve;
    /// allocations never exceed the supply.
    function invariant_ClearingAndAllocations() public view {
        uint256 nr = handler.roundsLength();
        uint256 na = handler.actorsLength();
        for (uint256 k; k < nr; ++k) {
            uint256 r = handler.rounds(k);
            (bool settled, uint256 price, uint256 sold,, bool over, uint256 totalQty,) = engine.clearingOf(r);
            if (!settled) continue;
            AuctionEngine.Round memory rd = engine.getRound(r);
            Ref memory ref = _reference(r);
            assertEq(totalQty, ref.total, "totalQty");
            if (totalQty != 0) {
                assertGe(price, rd.reservePrice, "P below reserve");
                assertEq(price % rd.tickSize, 0, "P off grid");
                assertEq(price, ref.price, "P != reference");
                assertEq(over, ref.over, "oversubscribed != reference");
            }
            assertEq(sold, ref.reached ? rd.sellAmount : ref.total, "sold");
            assertLe(sold, rd.sellAmount, "sold > sellAmount");
            uint256 sumAlloc;
            for (uint256 i; i < na; ++i) {
                AuctionHandler.G memory g = handler.ghost(r, handler.actors(i));
                if (g.revealed) sumAlloc += _refAlloc(ref, rd.sellAmount, g.price, g.amount);
            }
            assertLe(sumAlloc, rd.sellAmount, "allocations > sellAmount");
            assertLe(rd.allocatedTotal, sumAlloc, "allocatedTotal > allocations");
        }
    }

    /// Every settled bidder paid exactly ceil(allocation × P / 1e18), never more than their own bid,
    /// was refunded the rest of the deposit, and received exactly their allocation in tokens.
    function invariant_SettledBiddersPaidExactly() public view {
        uint256 nr = handler.roundsLength();
        uint256 na = handler.actorsLength();
        for (uint256 k; k < nr; ++k) {
            uint256 r = handler.rounds(k);
            (bool settled, uint256 price,,,,,) = engine.clearingOf(r);
            if (!settled) continue;
            AuctionEngine.Round memory rd = engine.getRound(r);
            Ref memory ref = _reference(r);
            for (uint256 i; i < na; ++i) {
                address a = handler.actors(i);
                AuctionHandler.G memory g = handler.ghost(r, a);
                (uint128 paid, uint128 refunded, bool accSettled) = engine.accounts(r, a);
                uint256 alloc = g.revealed ? _refAlloc(ref, rd.sellAmount, g.price, g.amount) : 0;
                if (accSettled) {
                    uint256 due = _mulDivUp(alloc, price, 1e18);
                    assertEq(paid, due, "paid != ceil(alloc x P)");
                    assertLe(paid, _mulDivUp(alloc, g.price, 1e18), "paid above own bid");
                    assertEq(uint256(paid) + refunded, rd.depositAmount, "paid + refunded != deposit");
                    assertEq(g.monIn, refunded, "MON received != refund");
                } else {
                    assertEq(g.monIn, 0, "MON before settlement");
                }
                if (engine.tokensClaimed(r, a)) {
                    (uint128 vTotal, uint128 vReleased) = engine.vests(r, a);
                    if (vTotal != 0) {
                        assertEq(vTotal, alloc, "vest total != allocation");
                        assertLe(vReleased, vTotal, "released > total");
                        assertEq(g.tokensIn, vReleased, "tokens received != released");
                    } else {
                        assertEq(g.tokensIn, alloc, "tokens received != allocation");
                    }
                } else {
                    assertEq(g.tokensIn, 0, "tokens before delivery");
                }
            }
        }
    }

    /// Refunds never exceed deposits, per bidder or per round.
    function invariant_RefundsNeverExceedDeposits() public view {
        uint256 nr = handler.roundsLength();
        uint256 na = handler.actorsLength();
        for (uint256 k; k < nr; ++k) {
            uint256 r = handler.rounds(k);
            AuctionEngine.Round memory rd = engine.getRound(r);
            (, uint64 reveals, uint64 claims,) = engine.ledgers(r);
            AuctionHandler.RG memory rg = handler.roundGhost(r);
            assertLe(rg.refunded, uint256(reveals) * rd.depositAmount, "round refunds > revealed deposits");
            uint256 settledCount;
            for (uint256 i; i < na; ++i) {
                (, uint128 refunded, bool accSettled) = engine.accounts(r, handler.actors(i));
                assertLe(refunded, rd.depositAmount, "refund > deposit");
                if (accSettled) ++settledCount;
            }
            assertEq(claims, settledCount, "ledger.claims != settled accounts");
            assertLe(claims, reveals, "claims > reveals");
        }
    }

    /// A deposit that was never revealed only ever goes to 0x…dEaD: its bidder gets no MON and no tokens.
    function invariant_UnrevealedDepositsOnlyBurned() public view {
        assertEq(handler.unrevealedPayouts(), 0, "payout to an unrevealed bidder");
        uint256 nr = handler.roundsLength();
        uint256 na = handler.actorsLength();
        for (uint256 k; k < nr; ++k) {
            uint256 r = handler.rounds(k);
            AuctionEngine.Round memory rd = engine.getRound(r);
            (uint64 commits, uint64 reveals,, uint256 burned) = engine.ledgers(r);
            assertLe(burned, uint256(commits - reveals) * rd.depositAmount, "burned more than unrevealed deposits");
            if (burned != 0) {
                assertEq(burned, uint256(commits - reveals) * rd.depositAmount, "partial burn after reveal end");
            }
            for (uint256 i; i < na; ++i) {
                address a = handler.actors(i);
                AuctionHandler.G memory g = handler.ghost(r, a);
                if (!g.committed || g.revealed) continue;
                (,, bool accSettled) = engine.accounts(r, a);
                assertFalse(accSettled, "unrevealed bidder settled");
                assertFalse(engine.tokensClaimed(r, a), "unrevealed bidder got tokens");
                assertEq(g.monIn + g.tokensIn, 0, "unrevealed bidder received something");
            }
        }
    }

    /// Nobody is refunded or delivered twice.
    function invariant_NoDoubleClaim() public view {
        assertEq(handler.doubleClaims(), 0, "double claim");
        uint256 nr = handler.roundsLength();
        uint256 na = handler.actorsLength();
        for (uint256 k; k < nr; ++k) {
            uint256 r = handler.rounds(k);
            for (uint256 i; i < na; ++i) {
                AuctionHandler.G memory g = handler.ghost(r, handler.actors(i));
                assertLe(g.refunds, 1, "two refunds");
                assertLe(g.deliveries, 1, "two deliveries");
            }
        }
    }

    /// The ledger counts agree with what actually happened.
    function invariant_LedgerMatchesHistory() public view {
        uint256 nr = handler.roundsLength();
        for (uint256 k; k < nr; ++k) {
            uint256 r = handler.rounds(k);
            (uint64 commits, uint64 reveals,,) = engine.ledgers(r);
            AuctionHandler.RG memory rg = handler.roundGhost(r);
            assertEq(commits, rg.commits, "commits");
            assertEq(reveals, rg.reveals, "reveals");
        }
    }
}
