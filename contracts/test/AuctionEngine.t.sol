// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AuctionEngine} from "../src/AuctionEngine.sol";
import {MerkleProofLib} from "../src/lib/MerkleProofLib.sol";
import {MockToken, MockPositionManager, MockAdapter, MockLocker} from "./mocks/Mocks.sol";

contract ReentrantBidder {
    AuctionEngine public engine;
    uint256 public roundId;
    bool public attempted;
    bool public blocked;

    constructor(AuctionEngine e) {
        engine = e;
    }

    function commit(uint256 r, bytes32 h, uint256 deposit) external {
        roundId = r;
        engine.commit{value: deposit}(r, h, new bytes32[](0), "");
    }

    function reveal(uint96 p, uint96 a, bytes32 s) external {
        engine.reveal(roundId, p, a, s);
    }

    function claim() external {
        engine.claim(roundId);
    }

    receive() external payable {
        if (!attempted) {
            attempted = true;
            try engine.claim(roundId) {} catch Error(string memory why) {
                blocked = keccak256(bytes(why)) == keccak256("reentrancy");
            }
        }
    }
}

/// State, setup and helpers shared by the engine suites, so each suite runs only its own tests.
abstract contract EngineBase is Test {
    address constant BURN = 0x000000000000000000000000000000000000dEaD;
    uint256 constant NONE = type(uint256).max;

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

    uint96 constant DEPOSIT = 10 ether;
    uint96 constant TICK = 0.001 ether; // MON per 1e18 token units
    uint128 constant SUPPLY = 1000e18;
    uint256 constant LOCK_END = 4102444800; // 1 Jan 2100
    uint256 constant GRACE = 1 days;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        token = new MockToken();
        npm = new MockPositionManager();
        adapter = new MockAdapter(npm);
        locker = new MockLocker();
        address[] memory adapters = new address[](1);
        adapters[0] = address(adapter);
        engine = new AuctionEngine(address(locker), adapters, LOCK_END, GRACE);
        token.mint(creator, 10_000_000e18);
        vm.prank(creator);
        token.approve(address(engine), type(uint256).max);
        address[6] memory people = [alice, bob, carol, dave, eve, creator];
        for (uint256 i; i < people.length; ++i) vm.deal(people[i], 1000 ether);
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _params(AuctionEngine.Preset preset) internal view returns (AuctionEngine.OpenParams memory p) {
        p.preset = preset;
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
        if (preset == AuctionEngine.Preset.Raise) p.lockDuration = 365 days;
    }

    function _open(AuctionEngine.OpenParams memory p) internal returns (uint256) {
        vm.prank(creator);
        return engine.openRound(p);
    }

    function _hash(uint96 price, uint96 amount, bytes32 salt, address who) internal pure returns (bytes32) {
        return keccak256(abi.encode(price, amount, salt, who));
    }

    function _commit(uint256 r, address who, uint96 price, uint96 amount) internal {
        vm.prank(who);
        engine.commit{value: DEPOSIT}(r, _hash(price, amount, bytes32(uint256(uint160(who))), who), new bytes32[](0), "");
    }

    function _reveal(uint256 r, address who, uint96 price, uint96 amount) internal {
        vm.prank(who);
        engine.reveal(r, price, amount, bytes32(uint256(uint160(who))));
    }

    function _toReveal(uint256 r) internal {
        vm.warp(engine.getRound(r).commitEnd);
    }

    function _toSettle(uint256 r) internal {
        vm.warp(engine.getRound(r).revealEnd);
    }

    function _claim(uint256 r, address who) internal {
        vm.prank(who);
        engine.claim(r);
    }

    /// The four-bidder book from the clearing tests, scaled: P = 0.003, Carol and Dave tie at P.
    function _standardBook(uint256 r) internal {
        _commit(r, alice, 0.005 ether, 400e18);
        _commit(r, bob, 0.004 ether, 400e18);
        _commit(r, carol, 0.003 ether, 300e18);
        _commit(r, dave, 0.003 ether, 300e18);
        _commit(r, eve, 0.002 ether, 500e18);
        _toReveal(r);
        _reveal(r, alice, 0.005 ether, 400e18);
        _reveal(r, bob, 0.004 ether, 400e18);
        _reveal(r, carol, 0.003 ether, 300e18);
        _reveal(r, dave, 0.003 ether, 300e18);
        _reveal(r, eve, 0.002 ether, 500e18);
    }

}

contract AuctionEngineTest is EngineBase {
    // ─── Full lifecycle ─────────────────────────────────────────────────

    function test_Degen_OversubscribedLifecycle() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _standardBook(r);
        _toSettle(r);
        assertTrue(engine.settle(r, 100));
        (, uint256 p, uint256 sold,, bool over,,) = engine.clearingOf(r);
        assertEq(p, 0.003 ether);
        assertEq(sold, SUPPLY);
        assertTrue(over);

        // Refunds do not wait for the LP; tokens do.
        uint256 aliceBefore = alice.balance;
        _claim(r, alice);
        assertEq(alice.balance - aliceBefore, uint256(DEPOSIT) - 1.2 ether);
        assertEq(token.balanceOf(alice), 0);
        vm.prank(alice);
        vm.expectRevert("claims not open");
        engine.claimTokens(r, alice);

        engine.seedLP(r);
        // LP: 50% of the lower bound of tokens sold, and the matching MON at the clearing price.
        uint256 soldLB = uint256(SUPPLY) - 2;
        assertEq(adapter.tokensHeld(), soldLB * 5000 / 10_000);
        assertEq(adapter.monHeld(), (soldLB * 0.003 ether / 1e18) * 5000 / 10_000);
        assertEq(adapter.lastPrice(), 0.003 ether);
        // Permanent lock: the engine owns it, the creator collects fees.
        (address mgr, uint256 nftId, address owner, address collector, uint256 endTime, string memory fee) = locker.locks(0);
        assertEq(mgr, address(npm));
        assertEq(npm.ownerOf(nftId), address(locker));
        assertEq(owner, address(engine));
        assertEq(collector, creator);
        assertEq(endTime, LOCK_END);
        assertEq(fee, "DEFAULT");

        _claim(r, alice);
        _claim(r, bob);
        _claim(r, carol);
        _claim(r, dave);
        _claim(r, eve);
        assertEq(token.balanceOf(alice), 400e18);
        assertEq(token.balanceOf(bob), 400e18);
        assertEq(token.balanceOf(carol), 100e18); // 200 left at P, shared 300:300
        assertEq(token.balanceOf(dave), 100e18);
        assertEq(token.balanceOf(eve), 0);
        // Everyone pays the clearing price; the rest of the deposit comes back.
        assertEq(alice.balance, 1000 ether - 1.2 ether);
        assertEq(carol.balance, 1000 ether - 0.3 ether);
        assertEq(eve.balance, 1000 ether);

        uint256 collected = 1.2 ether + 1.2 ether + 0.3 ether + 0.3 ether;
        uint256 available = engine.creatorAvailable(r);
        assertEq(available, collected - adapter.monHeld());
        uint256 before = creator.balance;
        vm.prank(creator);
        engine.withdrawProceeds(r);
        assertEq(creator.balance - before, available);

        // Everything is accounted for: the engine holds no MON and no tokens for this round.
        engine.sweepDust(r);
        assertEq(address(engine).balance, 0);
        assertEq(engine.roundBalance(r), 0);
        assertEq(token.balanceOf(address(engine)), 0);
    }

    function test_Degen_Undersubscribed_UnsoldBurned() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _commit(r, alice, 0.005 ether, 100e18);
        _commit(r, bob, 0.002 ether, 200e18);
        _toReveal(r);
        _reveal(r, alice, 0.005 ether, 100e18);
        _reveal(r, bob, 0.002 ether, 200e18);
        _toSettle(r);
        engine.settle(r, 10);
        (, uint256 p, uint256 sold,, bool over,,) = engine.clearingOf(r);
        assertEq(p, 0.002 ether); // lowest bid
        assertEq(sold, 300e18);
        assertFalse(over);
        engine.seedLP(r);
        engine.disposeUnsold(r);
        // Unsold auction supply (700) plus the unused LP reserve (500 - 150) are burned.
        assertEq(token.balanceOf(BURN), 700e18 + (500e18 - 150e18));
        _claim(r, alice);
        _claim(r, bob);
        assertEq(token.balanceOf(alice), 100e18);
        assertEq(token.balanceOf(bob), 200e18);
        assertEq(alice.balance, 1000 ether - 0.2 ether); // pays 0.002 per token, not their 0.005
    }

    function test_NoBids_EverythingBackToCreator() public {
        uint256 before = token.balanceOf(creator);
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _toSettle(r);
        engine.settle(r, 1);
        engine.seedLP(r);
        engine.disposeUnsold(r);
        assertEq(token.balanceOf(creator), before);
        assertEq(token.balanceOf(BURN), 0);
        assertEq(locker.lockCount(), 0);
    }

    function test_Raise_UnsoldReturnedAndVesting() public {
        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Raise);
        p.tgeBps = 2500;
        p.cliff = 1 days;
        p.vestDuration = 10 days;
        uint256 r = _open(p);
        _commit(r, alice, 0.004 ether, 400e18);
        _toReveal(r);
        _reveal(r, alice, 0.004 ether, 400e18);
        _toSettle(r);
        engine.settle(r, 10);
        uint256 creatorBefore = token.balanceOf(creator);
        engine.seedLP(r);
        engine.disposeUnsold(r);
        // Raise: unsold 600 + unused reserve (500 - 200) go back to the creator; LP lock is the creator's.
        assertEq(token.balanceOf(creator) - creatorBefore, 600e18 + 300e18);
        (,, address owner,, uint256 endTime,) = locker.locks(0);
        assertEq(owner, creator);
        assertEq(endTime, block.timestamp + 365 days); // counted from seeding

        _claim(r, alice);
        assertEq(token.balanceOf(alice), 100e18); // 25% at claim
        vm.prank(alice);
        vm.expectRevert("nothing vested");
        engine.claimVested(r);

        vm.warp(block.timestamp + 1 days + 5 days); // cliff passed, half of the vesting period
        vm.prank(alice);
        engine.claimVested(r);
        assertEq(token.balanceOf(alice), 100e18 + 150e18);

        vm.warp(block.timestamp + 30 days);
        vm.prank(alice);
        engine.claimVested(r);
        assertEq(token.balanceOf(alice), 400e18);
    }

    // ─── Burning unrevealed deposits (#30) ─────────────────────────────

    function test_BurnUnrevealed() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _commit(r, alice, 0.005 ether, 100e18);
        _commit(r, bob, 0.005 ether, 100e18);
        _commit(r, carol, 0.005 ether, 100e18);
        _toReveal(r);
        _reveal(r, alice, 0.005 ether, 100e18);
        vm.expectRevert("reveal window open");
        engine.burnUnrevealed(r);
        _toSettle(r);
        engine.burnUnrevealed(r);
        assertEq(BURN.balance, 2 * uint256(DEPOSIT));
        vm.expectRevert("nothing to burn");
        engine.burnUnrevealed(r);
        // A revealed deposit is never burned: Alice still gets her refund.
        engine.settle(r, 10);
        engine.seedLP(r);
        _claim(r, alice);
        assertEq(alice.balance, 1000 ether - 0.5 ether);
    }

    // ─── The three AUDIT criticals are impossible now ───────────────────

    function test_Security_NoSettleBeforeRevealEnd() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _commit(r, alice, 0.005 ether, 100e18);
        vm.expectRevert("reveal window open");
        engine.settle(r, 10);
        _toReveal(r);
        vm.expectRevert("reveal window open");
        engine.settle(r, 10);
        _reveal(r, alice, 0.005 ether, 100e18); // an honest reveal still works
    }

    function test_Security_NobodyClaimsForSomeoneElse() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _standardBook(r);
        _toSettle(r);
        engine.settle(r, 10);
        engine.seedLP(r);
        vm.prank(makeAddr("attacker"));
        vm.expectRevert("not revealed");
        engine.claim(r);
        _claim(r, alice); // unaffected
        vm.expectRevert("nothing to claim");
        _claim(r, alice);
    }

    function test_Security_NoBidWithoutCommitAndDeposit() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _commit(r, alice, 0.005 ether, 100e18);
        _toReveal(r);
        // Someone replays Alice's revealed preimage from their own address: rejected (bug #2).
        vm.prank(eve);
        vm.expectRevert("no unrevealed commitment");
        engine.reveal(r, 0.005 ether, 100e18, bytes32(uint256(uint160(alice))));
        // There is no other entry point into the book.
        (,,,,, uint256 total,) = engine.clearingOf(r);
        assertEq(total, 0);
    }

    function test_Security_ReentrantClaimBlocked() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        ReentrantBidder rb = new ReentrantBidder(engine);
        vm.deal(address(rb), 100 ether);
        bytes32 salt = bytes32(uint256(1));
        rb.commit(r, _hash(0.005 ether, 100e18, salt, address(rb)), DEPOSIT);
        _toReveal(r);
        rb.reveal(0.005 ether, 100e18, salt);
        _toSettle(r);
        engine.settle(r, 10);
        engine.seedLP(r);
        rb.claim();
        assertTrue(rb.attempted());
        assertTrue(rb.blocked());
        (,, bool settled) = engine.accounts(r, address(rb));
        assertTrue(settled);
    }

    // ─── Bid validation at reveal ──────────────────────────────────────

    function test_RevealRules() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _commit(r, alice, 0.0055 ether, 100e18); // off the tick grid
        _commit(r, bob, 0.02 ether, 600e18); // max spend 12 MON >= 10 MON deposit
        _commit(r, carol, 0.001 ether, 1e18); // max spend 0.001 MON < 0.01 min bid
        _toReveal(r);
        vm.prank(alice);
        vm.expectRevert("price off grid or below reserve");
        engine.reveal(r, 0.0055 ether, 100e18, bytes32(uint256(uint160(alice))));
        vm.prank(bob);
        vm.expectRevert("bid exceeds deposit");
        engine.reveal(r, 0.02 ether, 600e18, bytes32(uint256(uint160(bob))));
        vm.prank(carol);
        vm.expectRevert("below minimum bid");
        engine.reveal(r, 0.001 ether, 1e18, bytes32(uint256(uint160(carol))));
        vm.prank(alice);
        vm.expectRevert("hash mismatch");
        engine.reveal(r, 0.005 ether, 100e18, bytes32(uint256(uint160(alice))));
    }

    function test_CommitRules() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        vm.prank(alice);
        vm.expectRevert("wrong deposit");
        engine.commit{value: 1 ether}(r, bytes32(uint256(1)), new bytes32[](0), "");
        vm.prank(alice);
        vm.expectRevert("empty hash");
        engine.commit{value: DEPOSIT}(r, bytes32(0), new bytes32[](0), "");
        vm.prank(alice);
        vm.expectRevert("note too long");
        engine.commit{value: DEPOSIT}(r, bytes32(uint256(1)), new bytes32[](0), new bytes(257));
        _commit(r, alice, 0.005 ether, 1e18);
        vm.prank(alice);
        vm.expectRevert("already committed");
        engine.commit{value: DEPOSIT}(r, bytes32(uint256(2)), new bytes32[](0), "");
        _toReveal(r);
        vm.prank(bob);
        vm.expectRevert("commit window closed");
        engine.commit{value: DEPOSIT}(r, bytes32(uint256(3)), new bytes32[](0), "");
    }

    function test_NoteIsEmittedNotStored() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        bytes memory note = hex"deadbeef";
        bytes32 h = _hash(0.005 ether, 1e18, bytes32(uint256(9)), alice);
        vm.expectEmit(true, true, false, true);
        emit Committed(r, alice, h, note);
        vm.prank(alice);
        engine.commit{value: DEPOSIT}(r, h, new bytes32[](0), note);
    }

    event Committed(uint256 indexed roundId, address indexed bidder, bytes32 hash, bytes note);

    // ─── Allowlist (#32) ───────────────────────────────────────────────

    function test_Raise_Allowlist() public {
        bytes32 la = MerkleProofLib.leafOf(alice);
        bytes32 lb = MerkleProofLib.leafOf(bob);
        bytes32 root = la < lb ? keccak256(abi.encode(la, lb)) : keccak256(abi.encode(lb, la));
        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Raise);
        p.allowlistRoot = root;
        uint256 r = _open(p);

        bytes32[] memory proofAlice = new bytes32[](1);
        proofAlice[0] = lb;
        vm.prank(alice);
        engine.commit{value: DEPOSIT}(r, bytes32(uint256(1)), proofAlice, "");

        vm.prank(carol);
        vm.expectRevert("not on allowlist");
        engine.commit{value: DEPOSIT}(r, bytes32(uint256(1)), proofAlice, "");

        vm.prank(bob); // Alice's proof does not work for Bob
        vm.expectRevert("not on allowlist");
        engine.commit{value: DEPOSIT}(r, bytes32(uint256(1)), proofAlice, "");
    }

    // ─── LP seeding: partial use, blocked pools, the grace escape ──────

    function test_LP_PartialUse_DustToCreatorAndUnsoldBurned() public {
        adapter.setUseBps(9000); // the pool takes 90% of both sides
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _standardBook(r);
        _toSettle(r);
        engine.settle(r, 10);
        engine.seedLP(r);
        engine.disposeUnsold(r);
        uint256 lpMon = ((uint256(SUPPLY) - 2) * 0.003 ether / 1e18) * 5000 / 10_000;
        assertEq(adapter.monHeld(), lpMon * 9000 / 10_000);
        uint256 lpTok = (uint256(SUPPLY) - 2) * 5000 / 10_000;
        assertEq(token.balanceOf(BURN), 500e18 - lpTok * 9000 / 10_000); // unused reserve burned
        _claim(r, alice);
        _claim(r, bob);
        _claim(r, carol);
        _claim(r, dave);
        // The 10% of LP MON the pool didn't take stays with the round and reaches the creator.
        assertEq(engine.creatorAvailable(r), 3 ether - adapter.monHeld());
    }

    function test_LP_Blocked_AbandonBurnsLpShare() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _standardBook(r);
        _toSettle(r);
        engine.settle(r, 10);
        adapter.setRevert(true); // someone holds the pool at a bad price
        vm.expectRevert("pool price deviates");
        engine.seedLP(r);
        vm.expectRevert("grace period not over");
        engine.abandonLP(r);

        vm.warp(block.timestamp + GRACE);
        engine.abandonLP(r);
        uint256 lpMon = ((uint256(SUPPLY) - 2) * 0.003 ether / 1e18) * 5000 / 10_000;
        assertEq(BURN.balance, lpMon); // the LP's MON is burned, not handed to anyone
        vm.expectRevert("LP already done");
        engine.seedLP(r); // and it can never be seeded at an unchecked price later

        _claim(r, alice);
        _claim(r, bob);
        _claim(r, carol);
        _claim(r, dave);
        _claim(r, eve);
        assertEq(token.balanceOf(alice), 400e18);
        assertEq(engine.creatorAvailable(r), 3 ether - lpMon);
        vm.prank(creator);
        engine.withdrawProceeds(r);
        engine.sweepDust(r); // also disposes the unsold reserve
        assertEq(token.balanceOf(BURN), 500e18); // the whole LP reserve (200/600 splits exactly: no dust)
        assertEq(address(engine).balance, 0);
        assertEq(token.balanceOf(address(engine)), 0);
    }

    // ─── Open validation ───────────────────────────────────────────────

    function test_OpenRules() public {
        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Degen);
        p.dexSplits[0].adapter = address(0xBEEF);
        vm.prank(creator);
        vm.expectRevert("adapter not allowed");
        engine.openRound(p);

        p = _params(AuctionEngine.Preset.Degen);
        p.dexSplits[0].bps = 9000;
        vm.prank(creator);
        vm.expectRevert("splits must sum to 100%");
        engine.openRound(p);

        p = _params(AuctionEngine.Preset.Degen);
        p.lpShareBps = 0;
        p.dexSplits = new AuctionEngine.DexSplit[](0);
        vm.prank(creator);
        vm.expectRevert("degen needs LP");
        engine.openRound(p);

        p = _params(AuctionEngine.Preset.Degen);
        p.allowlistRoot = bytes32(uint256(1));
        vm.prank(creator);
        vm.expectRevert("degen is open");
        engine.openRound(p);

        p = _params(AuctionEngine.Preset.Degen);
        p.reservePrice = TICK + 1;
        vm.prank(creator);
        vm.expectRevert("reserve off grid");
        engine.openRound(p);
    }

    function test_FeeOnTransferTokenRejected() public {
        token.setFeeBps(100);
        vm.prank(creator);
        vm.expectRevert("fee-on-transfer token");
        engine.openRound(_params(AuctionEngine.Preset.Degen));
    }

    function test_UnexpectedMonRejected() public {
        vm.prank(alice);
        (bool ok,) = address(engine).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // ─── Multi-transaction settlement ──────────────────────────────────

    function test_SettleInSteps_SameResult() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _standardBook(r);
        _toSettle(r);
        uint256 calls;
        while (!engine.settle(r, 1)) ++calls;
        assertEq(calls, 2); // three levels visited, one per call, before crossing at the third
        (, uint256 p,,,,,) = engine.clearingOf(r);
        assertEq(p, 0.003 ether);
    }

    // ─── Round isolation ───────────────────────────────────────────────

    function test_RoundsCannotSpendEachOther() public {
        uint256 r1 = _open(_params(AuctionEngine.Preset.Degen));
        uint256 r2 = _open(_params(AuctionEngine.Preset.Degen));
        _commit(r1, alice, 0.005 ether, 100e18);
        _commit(r2, bob, 0.005 ether, 100e18);
        assertEq(engine.roundBalance(r1), DEPOSIT);
        assertEq(engine.roundBalance(r2), DEPOSIT);
        _toSettle(r1);
        engine.burnUnrevealed(r1);
        assertEq(engine.roundBalance(r1), 0);
        assertEq(engine.roundBalance(r2), DEPOSIT);
        assertEq(address(engine).balance, DEPOSIT);
    }

    // ─── Fuzz: full lifecycle conservation ─────────────────────────────

    function testFuzz_LifecycleConservesEverything(uint256 seed) public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        uint256 n = 1 + seed % 12;
        address[] memory who = new address[](n);
        uint96[] memory price = new uint96[](n);
        uint96[] memory amount = new uint96[](n);
        bool[] memory reveals = new bool[](n);
        for (uint256 i; i < n; ++i) {
            uint256 x = uint256(keccak256(abi.encode(seed, i)));
            who[i] = address(uint160(0x10000 + i));
            vm.deal(who[i], 100 ether);
            price[i] = uint96((1 + x % 8) * TICK);
            // Max spend below the deposit: amount <= 9.9 MON / price. Minimum on amount × reserve: >= 0.01 MON.
            uint256 maxAmt = uint256(9.9 ether) * 1e18 / price[i];
            uint256 minAmt = uint256(0.01 ether) * 1e18 / TICK + 1;
            amount[i] = uint96(minAmt + (x >> 16) % (maxAmt - minAmt));
            reveals[i] = (x >> 200) % 5 != 0; // ~20% never reveal
            _commit(r, who[i], price[i], amount[i]);
        }
        _toReveal(r);
        for (uint256 i; i < n; ++i) if (reveals[i]) _reveal(r, who[i], price[i], amount[i]);
        _toSettle(r);
        while (!engine.settle(r, 2)) {}
        // Some bidders take their refund before the LP exists; anyone may trigger it for them.
        for (uint256 i; i < n; ++i) if (reveals[i] && (seed >> (i + 8)) & 1 == 1) engine.claimRefund(r, who[i]);
        engine.seedLP(r);
        uint256 revealedCount;
        for (uint256 i; i < n; ++i) {
            if (!reveals[i]) continue;
            ++revealedCount;
            (uint256 alloc, uint256 paid,) = engine.quote(r, who[i]);
            assertLe(paid, _mulDivUp(price[i], amount[i]), "paid above own bid");
            engine.claimTokens(r, who[i]);
            assertEq(token.balanceOf(who[i]), alloc);
            assertEq(who[i].balance, 100 ether - paid);
        }
        if (revealedCount < n) engine.burnUnrevealed(r);
        if (engine.creatorAvailable(r) != 0) {
            vm.prank(creator);
            engine.withdrawProceeds(r);
        }
        engine.sweepDust(r);
        if (engine.getRound(r).unsoldOwed != 0) engine.disposeUnsold(r);
        // MON: nothing left behind, and every wei is accounted for.
        assertEq(address(engine).balance, 0, "MON left in engine");
        assertEq(engine.roundBalance(r), 0);
        // Tokens: nothing left behind.
        assertEq(token.balanceOf(address(engine)), 0, "tokens left in engine");
    }

    function _mulDivUp(uint256 a, uint256 b) internal pure returns (uint256) {
        uint256 x = a * b;
        return x == 0 ? 0 : (x - 1) / 1e18 + 1;
    }

    // ─── Reveal hints ───────────────────────────────────────────────────

    /// A hint only saves gas: a good hint, a stale one, one below the price, or garbage all build the
    /// same book as a plain reveal. Round A reveals plainly, round B with fuzzed hints; the clearing
    /// result and every allocation must match.
    function testFuzz_RevealWithHint_AnyHintSameBook(uint256 seed) public {
        uint256 ra = _open(_params(AuctionEngine.Preset.Degen));
        uint256 rb = _open(_params(AuctionEngine.Preset.Degen));
        address[5] memory who = [alice, bob, carol, dave, eve];
        uint96[5] memory price;
        uint96[5] memory amount;
        for (uint256 i; i < 5; ++i) {
            price[i] = uint96((1 + uint256(keccak256(abi.encode(seed, "p", i))) % 9) * TICK);
            amount[i] = uint96((10 + uint256(keccak256(abi.encode(seed, "a", i))) % 500) * 1e18);
            _commit(ra, who[i], price[i], amount[i]);
            _commit(rb, who[i], price[i], amount[i]);
        }
        _toReveal(ra);
        for (uint256 i; i < 5; ++i) {
            _reveal(ra, who[i], price[i], amount[i]);
            uint256 kind = uint256(keccak256(abi.encode(seed, "h", i))) % 4;
            uint256 hint = kind == 0 ? engine.findHint(rb, price[i]) // the right hint
                : kind == 1 ? uint256(price[i]) - TICK // at or below the price: ignored
                : kind == 2 ? uint256(keccak256(abi.encode(seed, i))) // not a level: ignored
                : NONE; // no hint
            vm.prank(who[i]);
            engine.revealWithHint(rb, price[i], amount[i], bytes32(uint256(uint160(who[i]))), hint);
        }
        _toSettle(ra);
        engine.settle(ra, 100);
        engine.settle(rb, 100);
        (, uint256 pa, uint256 sa,, bool oa, uint256 qa, uint256 la) = engine.clearingOf(ra);
        (, uint256 pb, uint256 sb,, bool ob, uint256 qb, uint256 lb) = engine.clearingOf(rb);
        assertEq(pa, pb);
        assertEq(sa, sb);
        assertEq(oa, ob);
        assertEq(qa, qb);
        assertEq(la, lb);
        for (uint256 i; i < 5; ++i) {
            (uint256 aa, uint256 paidA,) = engine.quote(ra, who[i]);
            (uint256 ab, uint256 paidB,) = engine.quote(rb, who[i]);
            assertEq(aa, ab);
            assertEq(paidA, paidB);
        }
    }

    function test_SplitsOf_ReturnsTheCreatorsSplit() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        AuctionEngine.DexSplit[] memory s = engine.splitsOf(r);
        assertEq(s.length, 1);
        assertEq(s[0].adapter, address(adapter));
        assertEq(s[0].bps, 10_000);
        assertEq(s[0].fee, 3000);
    }
}
