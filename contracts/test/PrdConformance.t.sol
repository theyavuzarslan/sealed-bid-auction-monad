// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {AuctionEngine} from "../src/AuctionEngine.sol";
import {MockToken, MockPositionManager, MockAdapter, MockLocker} from "./mocks/Mocks.sol";

/// @notice One test per promise in the PRD ("Monad Sealed-Bid Auction Engine.md"), named after the
///         clause it checks. The matrix that maps every PRD clause to code and tests is PRD-CONFORMANCE.md.
///         These tests only observe the engine from outside: balances, events, views and reverts.
contract PrdConformanceTest is Test {
    address constant BURN = 0x000000000000000000000000000000000000dEaD;

    MockToken token;
    MockPositionManager npm;
    MockAdapter adapter;
    MockLocker locker;
    AuctionEngine engine;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    address eve = makeAddr("eve");
    address mallory = makeAddr("mallory");

    uint96 constant DEPOSIT = 10 ether;
    uint96 constant TICK = 0.001 ether;
    uint128 constant SUPPLY = 1000e18;
    uint256 constant LOCK_END = 4102444800;
    uint256 constant ONE = 1e18;

    function setUp() public {
        vm.warp(1_800_000_000);
        token = new MockToken();
        npm = new MockPositionManager();
        adapter = new MockAdapter(npm);
        locker = new MockLocker();
        address[] memory adapters = new address[](1);
        adapters[0] = address(adapter);
        engine = new AuctionEngine(address(locker), adapters, LOCK_END, 1 days);
        token.mint(creator, 10_000_000e18);
        vm.prank(creator);
        token.approve(address(engine), type(uint256).max);
        address[7] memory people = [alice, bob, carol, dave, eve, mallory, creator];
        for (uint256 i; i < people.length; ++i) vm.deal(people[i], 1000 ether);
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _open() internal returns (uint256) {
        AuctionEngine.OpenParams memory p;
        p.preset = AuctionEngine.Preset.Degen;
        p.token = address(token);
        p.sellAmount = SUPPLY;
        p.depositAmount = DEPOSIT;
        p.minBidSize = 0.01 ether;
        p.tickSize = TICK;
        p.reservePrice = TICK;
        p.commitEnd = uint64(block.timestamp + 1 hours);
        p.revealEnd = uint64(block.timestamp + 2 hours);
        p.lpShareBps = 5000;
        p.dexSplits = new AuctionEngine.DexSplit[](1);
        p.dexSplits[0] = AuctionEngine.DexSplit({adapter: address(adapter), bps: 10_000, fee: 3000});
        p.lockFeeTier = "DEFAULT";
        vm.prank(creator);
        return engine.openRound(p);
    }

    function _salt(address who, uint256 r) internal pure returns (bytes32) {
        return keccak256(abi.encode("salt", who, r));
    }

    function _hash(uint96 price, uint96 amount, bytes32 salt, address who) internal pure returns (bytes32) {
        return keccak256(abi.encode(price, amount, salt, who));
    }

    function _commit(uint256 r, address who, uint96 price, uint96 amount) internal {
        vm.prank(who);
        engine.commit{value: DEPOSIT}(r, _hash(price, amount, _salt(who, r), who), new bytes32[](0), "");
    }

    function _reveal(uint256 r, address who, uint96 price, uint96 amount) internal {
        vm.prank(who);
        engine.reveal(r, price, amount, _salt(who, r));
    }

    function _settleAndSeed(uint256 r) internal {
        vm.warp(engine.getRound(r).revealEnd);
        assertTrue(engine.settle(r, type(uint256).max), "settles in one call");
        engine.seedLP(r);
    }

    /// Claims for `who` and returns what actually moved: tokens received and MON paid (deposit − refund).
    function _claim(uint256 r, address who) internal returns (uint256 tokensIn, uint256 monPaid) {
        uint256 t0 = token.balanceOf(who);
        uint256 m0 = who.balance;
        vm.prank(who);
        engine.claim(r);
        tokensIn = token.balanceOf(who) - t0;
        monPaid = DEPOSIT - (who.balance - m0);
    }

    function _price(uint256 r) internal view returns (uint256 p) {
        (, p,,,,,) = engine.clearingOf(r);
    }

    // Five bidders; Carol and Dave tie at the clearing price 0.003 and share what is left pro-rata.
    address[5] internal who_;
    uint96[5] internal price_;
    uint96[5] internal amount_;

    function _book() internal {
        who_ = [alice, bob, carol, dave, eve];
        price_ = [uint96(0.005 ether), 0.004 ether, 0.003 ether, 0.003 ether, 0.002 ether];
        amount_ = [uint96(400e18), 400e18, 300e18, 300e18, 500e18];
    }

    // ─── Goal: blind bidding ────────────────────────────────────────────

    /// PRD "Blind bidding. No bidder sees another's price before clearing." During the commit window
    /// the chain holds only the hash: no bid, no price, no amount, in storage or in the event.
    function test_PRD_BlindBidding_OnlyTheHashIsOnChainBeforeReveal() public {
        uint256 r = _open();
        bytes32 h = _hash(0.005 ether, 400e18, _salt(alice, r), alice);
        vm.recordLogs();
        _commit(r, alice, 0.005 ether, 400e18);

        (bytes32 stored, bool revealed) = engine.commitments(r, alice);
        assertEq(stored, h);
        assertFalse(revealed);
        (uint96 p, uint96 a) = engine.bids(r, alice);
        assertEq(p, 0, "no price stored before reveal");
        assertEq(a, 0, "no amount stored before reveal");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1);
        (bytes32 evHash, bytes memory note) = abi.decode(logs[0].data, (bytes32, bytes));
        assertEq(evHash, h, "the event carries the hash");
        assertEq(note.length, 0, "and nothing else when no note is sent");
    }

    // ─── Commit: all four preimage fields are load-bearing (bugs #1, #2) ─

    /// PRD "without the salt a memecoin bid price has few enough plausible values to brute-force".
    /// The same bid under two salts gives two unrelated hashes, and the wrong salt cannot open it.
    function test_PRD_Bug1_SaltIsPartOfTheCommitment() public {
        uint256 r = _open();
        assertTrue(_hash(0.005 ether, 400e18, bytes32(uint256(1)), alice) != _hash(0.005 ether, 400e18, bytes32(uint256(2)), alice));
        _commit(r, alice, 0.005 ether, 400e18);
        vm.warp(engine.getRound(r).commitEnd);
        vm.prank(alice);
        vm.expectRevert("hash mismatch");
        engine.reveal(r, 0.005 ether, 400e18, bytes32(uint256(0)));
        _reveal(r, alice, 0.005 ether, 400e18);
    }

    /// PRD "without msg.sender a commitment can be replayed". Mallory copies Alice's hash; once Alice
    /// reveals, the preimage is public, yet Mallory cannot use it: the hash binds Alice's address.
    function test_PRD_Bug2_CopiedCommitmentCannotBeReplayed() public {
        uint256 r = _open();
        bytes32 h = _hash(0.005 ether, 400e18, _salt(alice, r), alice);
        _commit(r, alice, 0.005 ether, 400e18);
        vm.prank(mallory);
        engine.commit{value: DEPOSIT}(r, h, new bytes32[](0), "");

        vm.warp(engine.getRound(r).commitEnd);
        _reveal(r, alice, 0.005 ether, 400e18);
        vm.prank(mallory);
        vm.expectRevert("hash mismatch");
        engine.reveal(r, 0.005 ether, 400e18, _salt(alice, r));
    }

    /// PRD "or its reveal front-run". Mallory sees Alice's reveal pending and submits the same
    /// preimage first: it fails from Mallory's address, and Alice's reveal still lands.
    function test_PRD_Bug2_RevealCannotBeFrontRun() public {
        uint256 r = _open();
        bytes32 h = _hash(0.005 ether, 400e18, _salt(alice, r), alice);
        _commit(r, alice, 0.005 ether, 400e18);
        vm.prank(mallory);
        engine.commit{value: DEPOSIT}(r, h, new bytes32[](0), "");
        vm.warp(engine.getRound(r).commitEnd);

        vm.prank(mallory);
        vm.expectRevert("hash mismatch");
        engine.reveal(r, 0.005 ether, 400e18, _salt(alice, r));
        _reveal(r, alice, 0.005 ether, 400e18);
        (uint96 p,) = engine.bids(r, alice);
        assertEq(p, 0.005 ether);
    }

    // ─── Uniform deposits ───────────────────────────────────────────────

    /// PRD "Every bidder locks the same capped amount, larger than their bid ... if collateral scaled
    /// with the bid, the deposit itself would leak the bid." A tiny and a large bid lock the same
    /// amount; any other amount is refused; a bid that could spend the whole deposit is refused.
    function test_PRD_UniformDeposit_SameForEveryBid_AndLargerThanTheBid() public {
        uint256 r = _open();
        uint256 a0 = alice.balance;
        uint256 b0 = bob.balance;
        _commit(r, alice, 0.001 ether, 10e18); // pays at most 0.01 MON
        _commit(r, bob, 0.009 ether, 1000e18); // pays at most 9 MON
        assertEq(a0 - alice.balance, DEPOSIT);
        assertEq(b0 - bob.balance, a0 - alice.balance, "deposit does not depend on the bid");

        bytes32 h = _hash(0.005 ether, 1e18, _salt(carol, r), carol);
        vm.startPrank(carol);
        vm.expectRevert("wrong deposit");
        engine.commit{value: DEPOSIT - 1}(r, h, new bytes32[](0), "");
        vm.expectRevert("wrong deposit");
        engine.commit{value: DEPOSIT + 1}(r, h, new bytes32[](0), "");
        vm.stopPrank();

        // max spend = 10 MON = the deposit: not "larger than their bid", so it cannot be revealed.
        _commit(r, carol, 0.01 ether, 1000e18);
        vm.warp(engine.getRound(r).commitEnd);
        vm.prank(carol);
        vm.expectRevert("bid exceeds deposit");
        engine.reveal(r, 0.01 ether, 1000e18, _salt(carol, r));
    }

    // ─── Goal: uniform clearing price ───────────────────────────────────

    /// PRD "Everyone who clears in a window pays the same price" and "Bids at or above clear; the
    /// rest are refunded". Checked on what actually moved, not on a view: every winner's MON paid is
    /// its tokens times the one clearing price (rounded up), and the loser pays nothing.
    function test_PRD_UniformPrice_EveryWinnerPaysTheClearingPrice() public {
        _book();
        uint256 r = _open();
        for (uint256 i; i < 5; ++i) _commit(r, who_[i], price_[i], amount_[i]);
        vm.warp(engine.getRound(r).commitEnd);
        for (uint256 i; i < 5; ++i) _reveal(r, who_[i], price_[i], amount_[i]);
        _settleAndSeed(r);

        uint256 P = _price(r);
        assertEq(P, 0.003 ether, "clearing price is the level where demand covers supply");
        uint256 sold;
        for (uint256 i; i < 5; ++i) {
            (uint256 got, uint256 paid) = _claim(r, who_[i]);
            sold += got;
            if (price_[i] >= P) {
                assertGt(got, 0, "every bid at or above P fills");
                assertEq(paid, (got * P + ONE - 1) / ONE, "pays exactly P per token, rounded up");
                if (price_[i] > P) assertEq(got, amount_[i], "bids above P fill in full");
            } else {
                assertEq(got, 0, "bids below P get nothing");
                assertEq(paid, 0, "and are refunded in full");
            }
        }
        assertLe(sold, SUPPLY);
        assertGe(sold, SUPPLY - 2, "at most rounding dust stays unsold");
    }

    // ─── Goal: snipe resistance ─────────────────────────────────────────

    /// PRD "Snipe resistance. Submission timing no longer determines price." The same five bids in two
    /// rounds, committed and revealed in opposite orders at different times, give the same clearing
    /// price and the same tokens and payment to every bidder, including the two tied at the price.
    function test_PRD_SnipeResistance_OrderAndTimingDoNotMatter() public {
        _book();
        uint256 ra = _open();
        uint256 rb = _open();

        uint256 commitEnd = engine.getRound(ra).commitEnd;
        for (uint256 i; i < 5; ++i) _commit(ra, who_[i], price_[i], amount_[i]);
        vm.warp(commitEnd - 10 minutes);
        for (uint256 i = 5; i > 0; --i) _commit(rb, who_[i - 1], price_[i - 1], amount_[i - 1]);

        vm.warp(commitEnd);
        for (uint256 i = 5; i > 0; --i) _reveal(rb, who_[i - 1], price_[i - 1], amount_[i - 1]);
        vm.warp(commitEnd + 50 minutes);
        for (uint256 i; i < 5; ++i) _reveal(ra, who_[i], price_[i], amount_[i]);

        _settleAndSeed(ra);
        _settleAndSeed(rb);
        assertEq(_price(ra), _price(rb), "same price");
        for (uint256 i; i < 5; ++i) {
            (uint256 ga, uint256 pa) = _claim(ra, who_[i]);
            (uint256 gb, uint256 pb) = _claim(rb, who_[i]);
            assertEq(ga, gb, "same tokens whatever the order");
            assertEq(pa, pb, "same payment whatever the order");
        }
    }

    /// The same property over random reveal orders of round B.
    function testFuzz_PRD_SnipeResistance_AnyRevealOrder(uint256 seed) public {
        _book();
        uint256 ra = _open();
        uint256 rb = _open();
        for (uint256 i; i < 5; ++i) {
            _commit(ra, who_[i], price_[i], amount_[i]);
            _commit(rb, who_[i], price_[i], amount_[i]);
        }
        uint256[5] memory order = [uint256(0), 1, 2, 3, 4];
        for (uint256 i = 4; i > 0; --i) {
            uint256 j = uint256(keccak256(abi.encode(seed, i))) % (i + 1);
            (order[i], order[j]) = (order[j], order[i]);
        }
        uint256 commitEnd = engine.getRound(ra).commitEnd;
        vm.warp(commitEnd);
        for (uint256 i; i < 5; ++i) _reveal(ra, who_[i], price_[i], amount_[i]);
        for (uint256 i; i < 5; ++i) {
            uint256 k = order[i];
            vm.warp(commitEnd + (i + 1) * 1 minutes);
            _reveal(rb, who_[k], price_[k], amount_[k]);
        }
        _settleAndSeed(ra);
        _settleAndSeed(rb);
        assertEq(_price(ra), _price(rb));
        for (uint256 i; i < 5; ++i) {
            (uint256 ga, uint256 pa) = _claim(ra, who_[i]);
            (uint256 gb, uint256 pb) = _claim(rb, who_[i]);
            assertEq(ga, gb);
            assertEq(pa, pb);
        }
    }

    // ─── Reveal refusal (bug #3) ────────────────────────────────────────

    /// PRD "Non-revealers are slashed, which is what makes reveal-refusal unprofitable rather than
    /// free." A bidder who does not reveal loses exactly the deposit, which is burned (not paid to
    /// anyone who could profit from it), and can claim nothing.
    function test_PRD_Bug3_NonRevealerLosesExactlyTheDeposit() public {
        uint256 r = _open();
        _commit(r, alice, 0.005 ether, 400e18);
        _commit(r, mallory, 0.009 ether, 900e18);
        vm.warp(engine.getRound(r).commitEnd);
        _reveal(r, alice, 0.005 ether, 400e18);
        vm.warp(engine.getRound(r).revealEnd);

        uint256 burnt0 = BURN.balance;
        engine.burnUnrevealed(r);
        assertEq(BURN.balance - burnt0, DEPOSIT, "exactly one deposit burned");

        engine.settle(r, type(uint256).max);
        engine.seedLP(r);
        vm.prank(mallory);
        vm.expectRevert("not revealed");
        engine.claim(r);
        (uint256 got, uint256 paid) = _claim(r, alice);
        assertEq(got, 400e18, "the revealer is unaffected");
        assertEq(paid, 2 ether, "at the clearing price, her own 0.005");
    }

    // ─── Goal: one-click flow to a locked pool (bug #7) ─────────────────

    /// PRD "Auction → distribution → liquid pool with locked LP" and bug #7 "Sandwichable LP seed".
    /// No auctioned token can leave the engine before the pool exists; the pool is seeded at the
    /// clearing price; the position is locked permanently (Degen) with the creator collecting fees.
    function test_PRD_Bug7_PoolFirst_AtTheClearingPrice_Locked() public {
        _book();
        uint256 r = _open();
        for (uint256 i; i < 5; ++i) _commit(r, who_[i], price_[i], amount_[i]);
        vm.warp(engine.getRound(r).commitEnd);
        for (uint256 i; i < 5; ++i) _reveal(r, who_[i], price_[i], amount_[i]);
        vm.warp(engine.getRound(r).revealEnd);
        engine.settle(r, type(uint256).max);

        vm.expectRevert("claims not open");
        engine.claimTokens(r, alice);
        uint256 before = alice.balance;
        engine.claimRefund(r, alice); // refunds never wait for the pool
        assertGt(alice.balance, before);

        engine.seedLP(r);
        assertEq(adapter.lastPrice(), _price(r), "pool opens at the clearing price");
        assertEq(locker.lockCount(), 1);
        (, uint256 nftId, address owner, address collector, uint256 endTime,) = locker.locks(0);
        assertEq(npm.ownerOf(nftId), address(locker), "position is held by the locker");
        assertEq(owner, address(engine), "Degen: nobody can withdraw it");
        assertEq(endTime, LOCK_END, "permanent lock");
        assertEq(collector, creator, "creator collects trading fees");
        engine.claimTokens(r, alice);
        assertEq(token.balanceOf(alice), 400e18);
    }

    // ─── Bug #8: price × amount precision never favors the bidder ───────

    /// PRD "Truncation favoring the bidder in aggregate drains the contract." With random amounts tied
    /// at the clearing price: allocations round down (never more than supply), payments round up
    /// (never below allocation × price), and the engine can pay every refund and token it owes.
    function testFuzz_PRD_Bug8_RoundingNeverFavorsTheBidder(uint96 a, uint96 c, uint96 d) public {
        a = uint96(bound(a, 10e18, 900e18));
        c = uint96(bound(c, 10e18, 999e18));
        d = uint96(bound(d, 10e18, 999e18));
        uint256 r = _open();
        _commit(r, alice, 0.004 ether, a);
        _commit(r, carol, 0.003 ether, c);
        _commit(r, dave, 0.003 ether, d);
        vm.warp(engine.getRound(r).commitEnd);
        _reveal(r, alice, 0.004 ether, a);
        _reveal(r, carol, 0.003 ether, c);
        _reveal(r, dave, 0.003 ether, d);
        _settleAndSeed(r);

        uint256 P = _price(r);
        address[3] memory ws = [alice, carol, dave];
        uint256 sold;
        for (uint256 i; i < 3; ++i) {
            (uint256 got, uint256 paid) = _claim(r, ws[i]);
            sold += got;
            assertGe(paid * ONE, got * P, "payment never below tokens x price");
            assertLt(paid * ONE, got * P + ONE, "and at most one wei above");
        }
        assertLe(sold, SUPPLY, "never allocates more than the supply");
    }
}

