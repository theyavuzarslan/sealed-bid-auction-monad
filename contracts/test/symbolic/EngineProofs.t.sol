// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AuctionEngine} from "../../src/AuctionEngine.sol";
import {MockToken, MockPositionManager, MockAdapter, MockLocker} from "../mocks/Mocks.sol";

/// A bidder contract that cannot take MON: every push reverts.
contract SymRejecter {
    receive() external payable {
        revert("no MON");
    }
}

/// Symbolic proofs over the deployed engine (PROPERTIES.md P3–P7, O1–O2, W1).
/// `setUp` is concrete: mocks, the engine and one Degen round with fixed terms. Only the bids are
/// symbolic. Every bid goes through the real `commit` and `reveal` (the commitment hash over the
/// symbolic bid is computed here and checked by the engine), and every payment through the real
/// `settle`, `claimRefund` and `withdrawOwed`. Nothing on the money path is stubbed or
/// re-implemented; the test computes its own reference values with independent formulas.
///
/// Run: forge test --symbolic --match-contract EngineProofs --symbolic-loop 8 --symbolic-timeout 600
contract EngineProofs is Test {
    address constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint256 constant SCALE = 1e18;

    uint96 constant DEPOSIT = 10 ether;
    uint96 constant TICK = 0.001 ether;
    uint96 constant RESERVE = 0.001 ether;
    uint96 constant MIN_BID = 0.01 ether;
    uint128 constant SUPPLY = 1000e18;

    MockToken token;
    MockAdapter adapter;
    MockLocker locker;
    AuctionEngine engine;
    uint256 r;

    address creator = address(0xC0);
    address alice = address(0xA1);
    address bob = address(0xB0);
    address carol = address(0xCA);
    address keeper = address(0x4E);

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockToken();
        MockPositionManager npm = new MockPositionManager();
        adapter = new MockAdapter(npm);
        locker = new MockLocker();
        address[] memory adapters = new address[](1);
        adapters[0] = address(adapter);
        engine = new AuctionEngine(address(locker), adapters, 4102444800, 1 days);
        token.mint(creator, 10_000_000e18);
        vm.prank(creator);
        token.approve(address(engine), type(uint256).max);

        vm.prank(creator);
        r = engine.openRound(_params(uint64(block.timestamp + 1 hours), uint64(block.timestamp + 2 hours)));

        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
    }

    function _params(uint64 commitEnd, uint64 revealEnd) internal view returns (AuctionEngine.OpenParams memory p) {
        p.preset = AuctionEngine.Preset.Degen;
        p.token = address(token);
        p.sellAmount = SUPPLY;
        p.depositAmount = DEPOSIT;
        p.minBidSize = MIN_BID;
        p.tickSize = TICK;
        p.reservePrice = RESERVE;
        p.commitEnd = commitEnd;
        p.revealEnd = revealEnd;
        p.lpShareBps = 5000;
        p.dexSplits = new AuctionEngine.DexSplit[](1);
        p.dexSplits[0] = AuctionEngine.DexSplit({adapter: address(adapter), bps: 10_000, fee: 3000});
        p.lockFeeTier = "DEFAULT";
    }

    // ─── Reference arithmetic, written independently of the engine ──────

    /// ceil(x / d) as (x + d - 1) / d. The engine uses (x - 1) / d + 1; the two must agree.
    function _ceilDiv(uint256 x, uint256 d) internal pure returns (uint256) {
        return (x + d - 1) / d;
    }

    /// The conditions `reveal` must accept (and only these): on grid, at or above the reserve,
    /// cost below the deposit, and at least the minimum bid at the reserve price.
    function _valid(uint96 price, uint96 amount) internal pure returns (bool) {
        return amount != 0 && price % TICK == 0 && price >= RESERVE
            && _ceilDiv(uint256(price) * amount, SCALE) < DEPOSIT
            && _ceilDiv(uint256(RESERVE) * amount, SCALE) >= MIN_BID;
    }

    function _salt(address who) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(who)) << 1);
    }

    function _commit(address who, uint96 price, uint96 amount) internal {
        bytes32 h = keccak256(abi.encode(price, amount, _salt(who), who));
        vm.prank(who);
        engine.commit{value: DEPOSIT}(r, h, new bytes32[](0), "");
    }

    function _reveal(address who, uint96 price, uint96 amount) internal {
        vm.prank(who);
        engine.reveal(r, price, amount, _salt(who));
    }

    function _toReveal() internal {
        vm.warp(engine.getRound(r).commitEnd);
    }

    function _toSettle() internal {
        vm.warp(engine.getRound(r).revealEnd);
    }

    // ─── P6b: reveal accepts exactly the valid bids ─────────────────────

    /// A reveal succeeds if and only if the bid is on the tick grid, at or above the reserve,
    /// costs less than the deposit and is at least the minimum bid at the reserve price.
    function prove_P6b_RevealAcceptsExactlyValidBids(uint96 price, uint96 amount) public {
        _p6b(price, amount);
    }

    /// P6b with one side of the product fixed, so the search stays linear: every uint96 price at a
    /// fixed amount (100 tokens), and every uint96 amount at a fixed price (0.005 MON per token).
    function prove_P6b_RevealAcceptsExactlyValidBids_FixedAmount(uint96 price) public {
        _p6b(price, 100e18);
    }

    function prove_P6b_RevealAcceptsExactlyValidBids_FixedPrice(uint96 amount) public {
        _p6b(0.005 ether, amount);
    }

    function _p6b(uint96 price, uint96 amount) internal {
        _commit(alice, price, amount);
        _toReveal();
        vm.prank(alice);
        (bool ok,) = address(engine).call(abi.encodeCall(engine.reveal, (r, price, amount, _salt(alice))));
        assert(ok == _valid(price, amount));
    }

    // ─── P6: the clearing price is on the grid and at or above the reserve

    function prove_P6_ClearingPriceOnGridAboveReserve_2Bids(uint96 p1, uint96 a1, uint96 p2, uint96 a2) public {
        _p6(p1, a1, p2, a2);
    }

    /// P6 with every uint96 price pair and fixed amounts of 600 tokens each (1,200 bid for 1,000 sold:
    /// equal prices are pro-rated, different prices clear at the lower one).
    function prove_P6_ClearingPriceOnGridAboveReserve_2Bids_FixedAmounts(uint96 p1, uint96 p2) public {
        _p6(p1, 600e18, p2, 600e18);
    }

    function _p6(uint96 p1, uint96 a1, uint96 p2, uint96 a2) internal {
        vm.assume(_valid(p1, a1) && _valid(p2, a2));
        _commit(alice, p1, a1);
        _commit(bob, p2, a2);
        _toReveal();
        _reveal(alice, p1, a1);
        _reveal(bob, p2, a2);
        _toSettle();
        assert(engine.settle(r, 8));
        (, uint256 p,,,,,) = engine.clearingOf(r);
        assert(p % TICK == 0);
        assert(p >= RESERVE);
    }

    // ─── P3, P4, P5: what a revealed bidder pays and gets back ──────────

    /// One bidder, symbolic bid: pays ceil(alloc × P / 1e18) (P5), never more than their own bid
    /// would cost (P3), and paid + refund == deposit, with the refund actually received (P4).
    function prove_P3_P4_P5_OneBidder(uint96 price, uint96 amount) public {
        _oneBidder(price, amount);
    }

    /// P3–P5, one bidder, one side of the product fixed (linear search): every uint96 amount at
    /// 0.005 MON per token, and every uint96 price for 100 tokens.
    function prove_P3_P4_P5_OneBidder_FixedPrice(uint96 amount) public {
        _oneBidder(0.005 ether, amount);
    }

    function prove_P3_P4_P5_OneBidder_FixedAmount(uint96 price) public {
        _oneBidder(price, 100e18);
    }

    function _oneBidder(uint96 price, uint96 amount) internal {
        vm.assume(_valid(price, amount));
        _commit(alice, price, amount);
        _toReveal();
        _reveal(alice, price, amount);
        _toSettle();
        assert(engine.settle(r, 8));
        _checkSettlement(alice, price, amount);
    }

    function prove_P3_P4_P5_TwoBidders(uint96 p1, uint96 a1, uint96 p2, uint96 a2) public {
        _twoBidders(p1, a1, p2, a2);
    }

    /// P3–P5 and P4b, two bidders, every uint96 price pair, 600 tokens each: covers the pro-rata case
    /// (equal prices, 1,200 bid for 1,000) and the partial fill at P (different prices).
    function prove_P3_P4_P5_TwoBidders_FixedAmounts(uint96 p1, uint96 p2) public {
        _twoBidders(p1, 600e18, p2, 600e18);
    }

    function _twoBidders(uint96 p1, uint96 a1, uint96 p2, uint96 a2) internal {
        vm.assume(_valid(p1, a1) && _valid(p2, a2));
        _commit(alice, p1, a1);
        _commit(bob, p2, a2);
        _toReveal();
        _reveal(alice, p1, a1);
        _reveal(bob, p2, a2);
        _toSettle();
        assert(engine.settle(r, 8));
        uint256 paidA = _checkSettlement(alice, p1, a1);
        uint256 paidB = _checkSettlement(bob, p2, a2);
        // P4b: once both are settled the round holds exactly what they paid, to the wei.
        assert(engine.roundBalance(r) == paidA + paidB);
        assert(address(engine).balance == paidA + paidB);
    }

    /// Settles `who` through the public `claimRefund` (called by a third party) and checks P3–P5.
    function _checkSettlement(address who, uint96 price, uint96 amount) internal returns (uint256 paid) {
        uint256 balBefore = who.balance;
        uint256 roundBefore = engine.roundBalance(r);
        (uint256 alloc,,) = engine.quote(r, who);
        (, uint256 p,,,,,) = engine.clearingOf(r);

        vm.prank(keeper);
        engine.claimRefund(r, who);

        (uint128 paid_, uint128 refunded, bool settled) = engine.accounts(r, who);
        paid = paid_;
        assert(settled);
        // P4: the deposit splits exactly into paid and refunded; the refund reached the bidder
        // and left this round's balance, and nothing is owed (an EOA always takes the push).
        assert(paid + refunded == DEPOSIT);
        assert(who.balance == balBefore + refunded);
        assert(engine.roundBalance(r) == roundBefore - refunded);
        assert(engine.refundsOwed(who) == 0);
        // P5: paid is the exact ceiling of alloc × P / 1e18.
        assert(paid == _ceilDiv(alloc * p, SCALE));
        // P3: a bidder never pays more than their own bid would cost, and always less than the deposit.
        assert(alloc <= amount);
        assert(paid <= _ceilDiv(uint256(price) * amount, SCALE));
        assert(paid < DEPOSIT);
        // P4c: settlement happens once.
        vm.prank(keeper);
        (bool again,) = address(engine).call(abi.encodeCall(engine.claimRefund, (r, who)));
        assert(!again);
    }

    /// P5 split into its two defining inequalities, one bidder (P = its own price, alloc = amount
    /// or less): paid × 1e18 ≥ alloc × P (never below the exact value) and
    /// (paid − 1) × 1e18 < alloc × P (less than one wei above it).
    function prove_P5_CeilingInequalities_OneBidder(uint96 price, uint96 amount) public {
        _p5(price, amount);
    }

    function prove_P5_CeilingInequalities_OneBidder_FixedPrice(uint96 amount) public {
        _p5(0.005 ether, amount);
    }

    function prove_P5_CeilingInequalities_OneBidder_FixedAmount(uint96 price) public {
        _p5(price, 100e18);
    }

    function _p5(uint96 price, uint96 amount) internal {
        vm.assume(_valid(price, amount));
        _commit(alice, price, amount);
        _toReveal();
        _reveal(alice, price, amount);
        _toSettle();
        assert(engine.settle(r, 8));
        (uint256 alloc, uint256 paid,) = engine.quote(r, alice);
        (, uint256 p,,,,,) = engine.clearingOf(r);
        assert(paid * SCALE >= alloc * p);
        assert(paid == 0 || (paid - 1) * SCALE < alloc * p);
    }

    // ─── P7: an unrevealed deposit can only go to 0x…dEaD ───────────────

    /// Three committers, each of whom may or may not reveal (a fixed valid bid). After the reveal
    /// window: no claim path pays an unrevealed committer, and `burnUnrevealed` sends exactly
    /// (commits − reveals) × deposit to 0x…dEaD, once, and nothing to its caller.
    function prove_P7_UnrevealedDepositOnlyBurned(bool revealA, bool revealB, bool revealC) public {
        uint96 price = 0.002 ether;
        uint96 amount = 100e18;
        _commit(alice, price, amount);
        _commit(bob, price, amount);
        _commit(carol, price, amount);
        _toReveal();
        if (revealA) _reveal(alice, price, amount);
        if (revealB) _reveal(bob, price, amount);
        if (revealC) _reveal(carol, price, amount);
        _toSettle();
        assert(engine.settle(r, 8));

        uint256 unrevealed = (revealA ? 0 : 1) + (revealB ? 0 : 1) + (revealC ? 0 : 1);
        uint256 burnBefore = BURN.balance;
        uint256 keeperBefore = keeper.balance;
        uint256 engineBefore = address(engine).balance;

        _assertNoExit(alice, revealA);
        _assertNoExit(bob, revealB);
        _assertNoExit(carol, revealC);

        vm.prank(keeper);
        (bool ok,) = address(engine).call(abi.encodeCall(engine.burnUnrevealed, (r)));
        assert(ok == (unrevealed != 0));
        assert(BURN.balance == burnBefore + unrevealed * DEPOSIT);
        assert(keeper.balance == keeperBefore);
        assert(address(engine).balance == engineBefore - unrevealed * DEPOSIT);

        // A second burn finds nothing.
        vm.prank(keeper);
        (bool again,) = address(engine).call(abi.encodeCall(engine.burnUnrevealed, (r)));
        assert(!again);
    }

    /// For a committer who did not reveal: claim, claimRefund and claimTokens all revert, so no
    /// MON leaves the engine on their behalf.
    function _assertNoExit(address who, bool revealed) internal {
        if (revealed) return;
        uint256 bal = who.balance;
        vm.prank(who);
        (bool c1,) = address(engine).call(abi.encodeCall(engine.claim, (r)));
        vm.prank(keeper);
        (bool c2,) = address(engine).call(abi.encodeCall(engine.claimRefund, (r, who)));
        vm.prank(keeper);
        (bool c3,) = address(engine).call(abi.encodeCall(engine.claimTokens, (r, who)));
        assert(!c1 && !c2 && !c3);
        assert(who.balance == bal);
    }

    // ─── O1, O2 (v2): a refund that cannot be pushed is owed, then withdrawn once ─

    /// A bidder contract that rejects MON, with a symbolic valid bid, next to an EOA bidder. When a
    /// third party settles it, the failed push credits exactly its refund to `refundsOwed` and to
    /// `totalOwed`; the round's balance falls by the refund but the engine's MON does not move, so
    /// engine MON == roundBalance + totalOwed. `withdrawOwed(to)` then pays exactly the refund to
    /// `to`, once, and clears both counters.
    function prove_O1_O2_FailedPushOwedThenWithdrawnOnce(uint96 price, uint96 amount) public {
        _owed(price, amount);
    }

    /// O1/O2 at every uint96 price for 100 tokens (linear search).
    function prove_O1_O2_FailedPushOwedThenWithdrawnOnce_FixedAmount(uint96 price) public {
        _owed(price, 100e18);
    }

    function _owed(uint96 price, uint96 amount) internal {
        vm.assume(_valid(price, amount));
        address rej = address(new SymRejecter());
        vm.deal(rej, DEPOSIT);
        _commit(rej, price, amount);
        _commit(alice, 0.002 ether, 100e18);
        _toReveal();
        _reveal(rej, price, amount);
        _reveal(alice, 0.002 ether, 100e18);
        _toSettle();
        assert(engine.settle(r, 8));

        (, uint256 paidQ, uint256 refundQ) = engine.quote(r, rej);
        uint256 roundBefore = engine.roundBalance(r);
        uint256 engineBefore = address(engine).balance;

        vm.prank(keeper);
        engine.claimRefund(r, rej);

        (uint128 paid, uint128 refunded, bool settled) = engine.accounts(r, rej);
        assert(settled && paid == paidQ && refunded == refundQ);
        assert(uint256(paid) + refunded == DEPOSIT);
        assert(rej.balance == 0);
        assert(engine.refundsOwed(rej) == refunded);
        assert(engine.totalOwed() == refunded);
        assert(engine.roundBalance(r) == roundBefore - refunded);
        assert(address(engine).balance == engineBefore);
        assert(address(engine).balance == engine.roundBalance(r) + engine.totalOwed());

        // Withdrawing to the rejecting address itself fails and changes nothing.
        vm.prank(rej);
        (bool selfOk,) = address(engine).call(abi.encodeCall(engine.withdrawOwed, (rej)));
        assert(!selfOk);
        assert(engine.refundsOwed(rej) == refunded);

        // Withdrawing to any address that takes MON pays exactly the refund, once.
        address to = address(0x70);
        uint256 toBefore = to.balance;
        vm.prank(rej);
        engine.withdrawOwed(to);
        assert(to.balance == toBefore + refunded);
        assert(engine.refundsOwed(rej) == 0);
        assert(engine.totalOwed() == 0);
        assert(address(engine).balance == engineBefore - refunded);
        assert(address(engine).balance == engine.roundBalance(r));

        vm.prank(rej);
        (bool again,) = address(engine).call(abi.encodeCall(engine.withdrawOwed, (to)));
        assert(!again);
        // Nobody else can withdraw what was owed to the bidder.
        vm.prank(keeper);
        (bool other,) = address(engine).call(abi.encodeCall(engine.withdrawOwed, (keeper)));
        assert(!other);
    }

    // ─── W1 (v2): minimum windows ───────────────────────────────────────

    /// `openRound` accepts the windows if and only if the commit window is at least 5 minutes from
    /// now and the reveal window at least 5 minutes after it (every other term valid).
    function prove_W1_OpenRoundWindowsIff(uint64 commitEnd, uint64 revealEnd) public {
        vm.prank(creator);
        (bool ok,) = address(engine).call(abi.encodeCall(engine.openRound, (_params(commitEnd, revealEnd))));
        bool expected =
            uint256(commitEnd) >= block.timestamp + 5 minutes && uint256(revealEnd) >= uint256(commitEnd) + 5 minutes;
        assert(ok == expected);
    }
}
