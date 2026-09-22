// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {AuctionEngine} from "../../src/AuctionEngine.sol";
import {
    UniswapV3Adapter,
    IUniswapV3FactoryLike,
    IUniswapV3PoolLike,
    INonfungiblePositionManagerLike,
    IWMON
} from "../../src/adapters/UniswapV3Adapter.sol";
import {UniV3PriceMath} from "../../src/adapters/UniV3PriceMath.sol";
import {IUniV3LPLocker, IERC721Minimal} from "../../src/interfaces/ILiquidity.sol";
import {MockToken} from "../mocks/Mocks.sol";

interface INPMPositions {
    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );
}

interface INPMNext {
    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    function decreaseLiquidity(DecreaseLiquidityParams calldata params) external payable returns (uint256, uint256);
}

interface IERC20Approve {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Fork tests against Monad mainnet (chain 143): the real engine, the real Uniswap v3
///         deployment, the real GoPlus UniV3LPLocker, and this adapter.
///         Run: forge test --match-path 'test/fork/*' --fork-url https://rpc.monad.xyz
///         Without a Monad fork every test here is skipped.
contract UniswapV3AdapterForkTest is Test {
    address constant FACTORY = 0x204FAca1764B154221e35c0d20aBb3c525710498;
    address constant NPM = 0x7197E214c0b767cFB76Fb734ab638E2c192F4E53;
    address constant WMON = 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A;
    address constant LOCKER = 0x24A9eB23De8E6f59BDB981B03E847F0f3ABbFa0d;
    address constant BURN = 0x000000000000000000000000000000000000dEaD;

    // Fixed token addresses on either side of WMON (0x3bd3…), so both pool orientations are covered.
    address constant LOW_TOKEN = 0x1111111111111111111111111111111111111111;
    address constant HIGH_TOKEN = 0xEEeeeeeEeEEeeeeEEEEeEEeEEEEeEEeeeEEeE123;

    uint256 constant LOCK_END = 4102444800; // 1 Jan 2100, the value Deploy.s.sol uses
    uint256 constant GRACE = 1 days;
    uint256 constant TOLERANCE_BPS = 100; // 1%
    uint24 constant FEE = 3000;
    uint96 constant DEPOSIT = 10 ether;
    uint96 constant TICK = 0.001 ether;
    uint128 constant SUPPLY = 1000e18;
    uint256 constant P = 0.003 ether; // clearing price of the standard book

    bytes32 constant LP_SEEDED_SIG = keccak256("LPSeeded(uint256,address,address,uint256,uint256,uint256,uint256)");

    UniswapV3Adapter adapter;
    AuctionEngine engine;
    MockToken token;

    address creator = makeAddr("creator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    address eve = makeAddr("eve");
    address griefer = makeAddr("griefer");

    struct Seeded {
        uint256 nftId;
        uint256 tokenUsed;
        uint256 monUsed;
        uint256 lockId;
    }

    function setUp() public {
        if (block.chainid != 143) {
            vm.skip(true);
            return;
        }
        adapter = new UniswapV3Adapter(FACTORY, NPM, WMON, TOLERANCE_BPS);
        address[] memory adapters = new address[](1);
        adapters[0] = address(adapter);
        engine = new AuctionEngine(LOCKER, adapters, LOCK_END, GRACE);
        address[7] memory people = [alice, bob, carol, dave, eve, creator, griefer];
        for (uint256 i; i < people.length; ++i) vm.deal(people[i], 1000 ether);
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    function _deployToken(address at) internal {
        deployCodeTo("Mocks.sol:MockToken", at);
        token = MockToken(at);
        token.mint(creator, 10_000_000e18);
        token.mint(griefer, 10_000_000e18);
        vm.prank(creator);
        token.approve(address(engine), type(uint256).max);
    }

    function _params(uint24 fee) internal view returns (AuctionEngine.OpenParams memory p) {
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
        p.dexSplits[0] = AuctionEngine.DexSplit({adapter: address(adapter), bps: 10_000, fee: fee});
        p.lockFeeTier = "DEFAULT";
    }

    function _commit(uint256 r, address who, uint96 price, uint96 amount) internal {
        bytes32 salt = bytes32(uint256(uint160(who)));
        vm.prank(who);
        engine.commit{value: DEPOSIT}(r, keccak256(abi.encode(price, amount, salt, who)), new bytes32[](0), "");
    }

    function _reveal(uint256 r, address who, uint96 price, uint96 amount) internal {
        vm.prank(who);
        engine.reveal(r, price, amount, bytes32(uint256(uint160(who))));
    }

    /// Opens a Degen round, runs the standard book (P = 0.003, Carol and Dave share at P) and settles.
    function _settledRound(AuctionEngine.OpenParams memory p) internal returns (uint256 r) {
        vm.prank(creator);
        r = engine.openRound(p);
        _commit(r, alice, 0.005 ether, 400e18);
        _commit(r, bob, 0.004 ether, 400e18);
        _commit(r, carol, 0.003 ether, 300e18);
        _commit(r, dave, 0.003 ether, 300e18);
        _commit(r, eve, 0.002 ether, 500e18);
        vm.warp(p.commitEnd);
        _reveal(r, alice, 0.005 ether, 400e18);
        _reveal(r, bob, 0.004 ether, 400e18);
        _reveal(r, carol, 0.003 ether, 300e18);
        _reveal(r, dave, 0.003 ether, 300e18);
        _reveal(r, eve, 0.002 ether, 500e18);
        vm.warp(p.revealEnd);
        assertTrue(engine.settle(r, 100));
        (, uint256 price,,,,,) = engine.clearingOf(r);
        assertEq(price, P);
    }

    function _seedLP(uint256 r) internal returns (Seeded[] memory out) {
        vm.recordLogs();
        engine.seedLP(r);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 n;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(engine) && logs[i].topics[0] == LP_SEEDED_SIG) ++n;
        }
        out = new Seeded[](n);
        n = 0;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(engine) && logs[i].topics[0] == LP_SEEDED_SIG) {
                (, uint256 nftId, uint256 t, uint256 m, uint256 lockId) =
                    abi.decode(logs[i].data, (address, uint256, uint256, uint256, uint256));
                out[n++] = Seeded(nftId, t, m, lockId);
            }
        }
    }

    function _claimAll(uint256 r) internal {
        address[5] memory bidders = [alice, bob, carol, dave, eve];
        for (uint256 i; i < bidders.length; ++i) {
            vm.prank(bidders[i]);
            engine.claim(r);
        }
    }

    function _pool(uint24 fee) internal view returns (address) {
        return IUniswapV3FactoryLike(FACTORY).getPool(address(token), WMON, fee);
    }

    function _sqrtPrice(address pool) internal view returns (uint160 s) {
        (s,,,,,,) = IUniswapV3PoolLike(pool).slot0();
    }

    /// MON wei per 1e18 token units implied by a pool price, computed independently of the adapter.
    function _impliedPrice(uint160 sqrtPriceX96) internal view returns (uint256) {
        uint256 ratioX128 = UniV3PriceMath.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64); // token1/token0 × 2^128
        if (address(token) < WMON) return UniV3PriceMath.mulDiv(ratioX128, 1e18, 1 << 128);
        return UniV3PriceMath.mulDiv(1e18, 1 << 128, ratioX128);
    }

    /// One tick is a factor of 1.0001 on price, i.e. 1 bp.
    function _assertWithinOneTickOf(address pool, uint256 price) internal view {
        uint160 s = _sqrtPrice(pool);
        assertTrue(UniV3PriceMath.withinTolerance(s, adapter.targetSqrtPriceX96(address(token), price), 1), "not within a tick");
        uint256 implied = _impliedPrice(s);
        assertApproxEqRel(implied, price, 1e14, "implied price"); // 1e14 / 1e18 = 1 bp
    }

    function _assertAdapterEmpty() internal view {
        assertEq(token.balanceOf(address(adapter)), 0, "adapter tokens");
        assertEq(IWMON(WMON).balanceOf(address(adapter)), 0, "adapter WMON");
        assertEq(address(adapter).balance, 0, "adapter MON");
    }

    function _assertLockedFullRange(Seeded memory s, uint24 fee) internal view {
        assertEq(IERC721Minimal(NPM).ownerOf(s.nftId), LOCKER, "NFT not in locker");
        (,, address t0, address t1, uint24 f, int24 lo, int24 hi, uint128 liq,,,,) = INPMPositions(NPM).positions(s.nftId);
        assertEq(f, fee);
        assertEq(t0, address(token) < WMON ? address(token) : WMON);
        assertEq(t1, address(token) < WMON ? WMON : address(token));
        int24 spacing = IUniswapV3FactoryLike(FACTORY).feeAmountTickSpacing(fee);
        assertEq(hi, (887272 / spacing) * spacing);
        assertEq(lo, -hi);
        assertGt(liq, 0);
    }

    /// Initialise the pool ourselves at `price`, as a griefer would, without liquidity.
    function _griefInit(uint24 fee, uint160 sqrtPriceX96) internal returns (address pool) {
        (address t0, address t1) = address(token) < WMON ? (address(token), WMON) : (WMON, address(token));
        vm.prank(griefer);
        pool = INonfungiblePositionManagerLike(NPM).createAndInitializePoolIfNecessary(t0, t1, fee, sqrtPriceX96);
    }

    /// Mint a position as the griefer in [lo, hi].
    function _griefMint(uint24 fee, int24 lo, int24 hi, uint256 tokenAmt, uint256 monAmt) internal {
        (address t0, address t1) = address(token) < WMON ? (address(token), WMON) : (WMON, address(token));
        (uint256 a0, uint256 a1) = address(token) < WMON ? (tokenAmt, monAmt) : (monAmt, tokenAmt);
        vm.startPrank(griefer);
        IWMON(WMON).deposit{value: monAmt}();
        IERC20Approve(WMON).approve(NPM, type(uint256).max);
        token.approve(NPM, type(uint256).max);
        INonfungiblePositionManagerLike(NPM).mint(
            INonfungiblePositionManagerLike.MintParams(t0, t1, fee, lo, hi, a0, a1, 0, 0, griefer, block.timestamp)
        );
        vm.stopPrank();
    }

    function _fullRange(uint24 fee) internal view returns (int24 lo, int24 hi) {
        int24 spacing = IUniswapV3FactoryLike(FACTORY).feeAmountTickSpacing(fee);
        hi = (887272 / spacing) * spacing;
        lo = -hi;
    }

    // ─── Happy path: a full Degen round on the real stack ──────────────

    function _fullDegenRound(address tokenAt) internal {
        _deployToken(tokenAt);
        uint256 r = _settledRound(_params(FEE));
        assertEq(_pool(FEE), address(0), "pool should not exist yet");

        // Refunds do not wait for the pool; tokens do (no token may exist outside the engine before the pool).
        vm.expectRevert("claims not open");
        engine.claimTokens(r, alice);

        Seeded[] memory s = _seedLP(r);
        assertEq(s.length, 1);
        address pool = _pool(FEE);
        assertTrue(pool != address(0));
        _assertWithinOneTickOf(pool, P);
        _assertLockedFullRange(s[0], FEE);
        _assertAdapterEmpty();

        // Sizing: both sides come from the lower bound of tokens sold at P, so one side is used in
        // full and the other up to rounding.
        (,,, uint256 soldLB,,,) = engine.clearingOf(r);
        uint256 lpTokens = soldLB * 5000 / 10_000;
        uint256 lpMon = (soldLB * P / 1e18) * 5000 / 10_000;
        assertLe(s[0].tokenUsed, lpTokens);
        assertLe(s[0].monUsed, lpMon);
        assertApproxEqRel(s[0].tokenUsed, lpTokens, 1e14);
        assertApproxEqRel(s[0].monUsed, lpMon, 1e14);
        AuctionEngine.Round memory rd = engine.getRound(r);
        assertEq(rd.lpTokensUsed, s[0].tokenUsed);
        assertEq(rd.lpMonSpent, s[0].monUsed);
        assertEq(rd.lpMonBurned, 0);

        _claimAll(r);
        assertEq(token.balanceOf(alice), 400e18);
        assertEq(token.balanceOf(bob), 400e18);
        assertEq(token.balanceOf(carol), 100e18);
        assertEq(token.balanceOf(dave), 100e18);
        assertEq(token.balanceOf(eve), 0);
        assertEq(alice.balance, 1000 ether - 1.2 ether);

        uint256 before = creator.balance;
        uint256 available = engine.creatorAvailable(r);
        assertEq(available, 3 ether - s[0].monUsed);
        vm.prank(creator);
        engine.withdrawProceeds(r);
        assertEq(creator.balance - before, available);
        engine.sweepDust(r);
        assertEq(address(engine).balance, 0);
        assertEq(engine.roundBalance(r), 0);
        assertEq(token.balanceOf(address(engine)), 0);
    }

    function test_Fork_DegenRound_TokenIsToken0() public {
        _fullDegenRound(LOW_TOKEN);
    }

    function test_Fork_DegenRound_TokenIsToken1() public {
        _fullDegenRound(HIGH_TOKEN);
    }

    function test_Fork_SplitAcrossTwoFeeTiers() public {
        _deployToken(HIGH_TOKEN);
        AuctionEngine.OpenParams memory p = _params(FEE);
        p.dexSplits = new AuctionEngine.DexSplit[](2);
        p.dexSplits[0] = AuctionEngine.DexSplit({adapter: address(adapter), bps: 7000, fee: 3000});
        p.dexSplits[1] = AuctionEngine.DexSplit({adapter: address(adapter), bps: 3000, fee: 10_000});
        uint256 r = _settledRound(p);
        Seeded[] memory s = _seedLP(r);
        assertEq(s.length, 2);
        _assertWithinOneTickOf(_pool(3000), P);
        _assertWithinOneTickOf(_pool(10_000), P);
        _assertLockedFullRange(s[0], 3000);
        _assertLockedFullRange(s[1], 10_000);
        _assertAdapterEmpty();
        _claimAll(r);
    }

    // ─── Griefing: pre-initialised empty pool at a bad price ───────────

    function _emptyPoolGrief(address tokenAt, uint256 badPrice) internal {
        _deployToken(tokenAt);
        uint256 r = _settledRound(_params(FEE));
        address pool = _griefInit(FEE, adapter.targetSqrtPriceX96(address(token), badPrice));
        assertEq(IUniswapV3PoolLike(pool).liquidity(), 0);
        assertFalse(UniV3PriceMath.withinTolerance(_sqrtPrice(pool), adapter.targetSqrtPriceX96(address(token), P), 100));

        Seeded[] memory s = _seedLP(r);
        _assertWithinOneTickOf(pool, P);
        _assertLockedFullRange(s[0], FEE);
        _assertAdapterEmpty();
        assertEq(engine.getRound(r).lpMonBurned, 0);
        _claimAll(r);
    }

    function test_Fork_Grief_EmptyPoolPricedHigh_Token0() public {
        _emptyPoolGrief(LOW_TOKEN, P * 1000);
    }

    function test_Fork_Grief_EmptyPoolPricedLow_Token0() public {
        _emptyPoolGrief(LOW_TOKEN, P / 1000);
    }

    function test_Fork_Grief_EmptyPoolPricedHigh_Token1() public {
        _emptyPoolGrief(HIGH_TOKEN, P * 1000);
    }

    function test_Fork_Grief_EmptyPoolPricedLow_Token1() public {
        _emptyPoolGrief(HIGH_TOKEN, P / 1000);
    }

    /// The griefer picks the most extreme price the pool allows; the repricing swap still walks back.
    function test_Fork_Grief_EmptyPoolAtExtremes() public {
        _deployToken(LOW_TOKEN);
        uint256 r1 = _settledRound(_params(FEE));
        address pool = _griefInit(FEE, UniV3PriceMath.MIN_SQRT_RATIO);
        _seedLP(r1);
        _assertWithinOneTickOf(pool, P);
        _assertAdapterEmpty();

        _deployToken(HIGH_TOKEN);
        uint256 r2 = _settledRound(_params(FEE));
        pool = _griefInit(FEE, UniV3PriceMath.MAX_SQRT_RATIO - 1);
        _seedLP(r2);
        _assertWithinOneTickOf(pool, P);
        _assertAdapterEmpty();
    }

    /// Empty in range, but the griefer parks liquidity between the bad price and the target: the 1-wei
    /// swap stops at that liquidity, the price still deviates, and seeding reverts (grace path applies).
    function test_Fork_Grief_EmptyInRangeButLiquidityInTheWay() public {
        _deployToken(LOW_TOKEN);
        uint256 r = _settledRound(_params(FEE));
        uint160 bad = adapter.targetSqrtPriceX96(address(token), P * 100);
        address pool = _griefInit(FEE, bad);
        (, int24 badTick,,,,,) = IUniswapV3PoolLike(pool).slot0();
        // Token is token0, so a lower price is a lower tick: park liquidity below the current tick,
        // which is token1 (WMON) only.
        int24 hi = (badTick / 60 - 10) * 60;
        _griefMint(FEE, hi - 600, hi, 0, 1 ether);
        assertEq(IUniswapV3PoolLike(pool).liquidity(), 0);

        vm.expectRevert("pool price deviates");
        engine.seedLP(r);
    }

    // ─── Griefing: pool with real liquidity at a bad price ─────────────

    function _liquidPoolGrief(address tokenAt) internal {
        _deployToken(tokenAt);
        uint256 r = _settledRound(_params(FEE));
        uint256 bad = P * 2;
        address pool = _griefInit(FEE, adapter.targetSqrtPriceX96(address(token), bad));
        (int24 lo, int24 hi) = _fullRange(FEE);
        _griefMint(FEE, lo, hi, 100e18, 100e18 * bad / 1e18);
        assertGt(IUniswapV3PoolLike(pool).liquidity(), 0);

        vm.expectRevert("pool price deviates");
        engine.seedLP(r);
        vm.expectRevert("grace period not over");
        engine.abandonLP(r);

        // The engine never seeds at the griefer's price: after the grace period the LP is abandoned
        // and its MON share burned, so blocking the pool gains nobody anything.
        vm.warp(block.timestamp + GRACE);
        uint256 burnBefore = BURN.balance;
        engine.abandonLP(r);
        vm.expectRevert("LP already done");
        engine.seedLP(r);
        (,,, uint256 soldLB,,,) = engine.clearingOf(r);
        uint256 lpMon = (soldLB * P / 1e18) * 5000 / 10_000;
        assertEq(BURN.balance - burnBefore, lpMon);
        _assertAdapterEmpty();

        vm.prank(alice);
        engine.claim(r);
        assertEq(token.balanceOf(alice), 400e18);
        vm.prank(bob);
        engine.claim(r);
        vm.prank(carol);
        engine.claim(r);
        vm.prank(dave);
        engine.claim(r);
        vm.prank(eve);
        engine.claim(r);
        vm.prank(creator);
        engine.withdrawProceeds(r);
        engine.sweepDust(r);
        assertEq(address(engine).balance, 0);
        assertEq(token.balanceOf(address(engine)), 0);
    }

    function test_Fork_Grief_LiquidPoolAtBadPrice_Token0() public {
        _liquidPoolGrief(LOW_TOKEN);
    }

    function test_Fork_Grief_LiquidPoolAtBadPrice_Token1() public {
        _liquidPoolGrief(HIGH_TOKEN);
    }

    /// A pool with liquidity inside the tolerance is accepted, and the position is minted at its price.
    function test_Fork_LiquidPoolWithinTolerance() public {
        _deployToken(HIGH_TOKEN);
        uint256 r = _settledRound(_params(FEE));
        uint256 near = P * 10_050 / 10_000; // +0.5%
        address pool = _griefInit(FEE, adapter.targetSqrtPriceX96(address(token), near));
        (int24 lo, int24 hi) = _fullRange(FEE);
        _griefMint(FEE, lo, hi, 100e18, 100e18 * near / 1e18);
        Seeded[] memory s = _seedLP(r);
        _assertLockedFullRange(s[0], FEE);
        _assertAdapterEmpty();
        assertTrue(UniV3PriceMath.withinTolerance(_sqrtPrice(pool), adapter.targetSqrtPriceX96(address(token), P), 100));
        assertEq(engine.getRound(r).lpMonBurned, 0);
    }

    /// Tokens and WMON donated to the adapter do not break the engine's balance-delta accounting.
    function test_Fork_DonationsToAdapterAreIgnored() public {
        _deployToken(LOW_TOKEN);
        uint256 r = _settledRound(_params(FEE));
        vm.startPrank(griefer);
        token.transfer(address(adapter), 1e18);
        IWMON(WMON).deposit{value: 1 ether}();
        IERC20Approve(WMON).transfer(address(adapter), 1 ether);
        vm.stopPrank();

        Seeded[] memory s = _seedLP(r);
        _assertWithinOneTickOf(_pool(FEE), P);
        _assertLockedFullRange(s[0], FEE);
        assertEq(token.balanceOf(address(adapter)), 1e18);
        assertEq(IWMON(WMON).balanceOf(address(adapter)), 1 ether);
        assertEq(address(adapter).balance, 0);
    }

    /// A griefer blocks seeding with liquidity, then pulls it before the grace period ends. The pool is
    /// empty again, so strict seeding moves it to P for free and succeeds.
    function test_Fork_Grief_LiquidityPulled_StrictSeedReprices() public {
        _deployToken(LOW_TOKEN);
        uint256 r = _settledRound(_params(FEE));
        uint256 bad = P * 5;
        address pool = _griefInit(FEE, adapter.targetSqrtPriceX96(address(token), bad));
        (int24 lo, int24 hi) = _fullRange(FEE);
        vm.recordLogs();
        _griefMint(FEE, lo, hi, 100e18, 100e18 * bad / 1e18);
        uint256 griefId = _lastMintedId();
        vm.expectRevert("pool price deviates");
        engine.seedLP(r);

        (,,,,,,, uint128 liq,,,,) = INPMPositions(NPM).positions(griefId);
        vm.prank(griefer);
        INPMNext(NPM).decreaseLiquidity(INPMNext.DecreaseLiquidityParams(griefId, liq, 0, 0, block.timestamp));
        assertEq(IUniswapV3PoolLike(pool).liquidity(), 0);

        Seeded[] memory s = _seedLP(r);
        _assertWithinOneTickOf(pool, P);
        _assertLockedFullRange(s[0], FEE);
        _assertAdapterEmpty();
    }

    function _lastMintedId() internal returns (uint256 id) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 transferSig = keccak256("Transfer(address,address,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == NPM && logs[i].topics[0] == transferSig && logs[i].topics.length == 4) {
                id = uint256(logs[i].topics[3]);
            }
        }
        require(id != 0, "no mint");
    }

    /// Gas of repricing an empty pool that a griefer initialised at the far end of the range, per fee
    /// tier. The 1-wei swap walks the tick bitmap one word at a time, so finer tick spacing costs more.
    function _extremeRepriceGas(uint24 fee) internal returns (uint256 used) {
        _deployToken(LOW_TOKEN);
        _griefInit(fee, UniV3PriceMath.MIN_SQRT_RATIO);
        token.mint(address(this), 1000e18);
        token.approve(address(adapter), type(uint256).max);
        vm.deal(address(this), 10 ether);
        uint256 g = gasleft();
        adapter.seed{value: 3 ether}(address(token), 1000e18, P, fee, address(this));
        used = g - gasleft();
        _assertWithinOneTickOf(_pool(fee), P);
    }

    function test_Fork_ExtremeRepriceGas_Fee10000() public {
        emit log_named_uint("seed gas, fee 10000 from MIN_SQRT_RATIO", _extremeRepriceGas(10_000));
    }

    function test_Fork_ExtremeRepriceGas_Fee3000() public {
        emit log_named_uint("seed gas, fee 3000 from MIN_SQRT_RATIO", _extremeRepriceGas(3000));
    }

    function test_Fork_ExtremeRepriceGas_Fee500() public {
        emit log_named_uint("seed gas, fee 500 from MIN_SQRT_RATIO", _extremeRepriceGas(500));
    }

    /// Fee 100 (tick spacing 1): walking an empty pool back from the far end needs ~41M gas, more than
    /// one Monad transaction allows, and at the extreme price the position is too small for the GoPlus
    /// locker's 0.40% fee. The engine therefore rejects the tier when the round opens.
    function test_Fork_Fee100_RejectedAtOpen() public {
        _deployToken(LOW_TOKEN);
        assertFalse(adapter.supportsFee(100));
        assertTrue(adapter.supportsFee(500));
        assertTrue(adapter.supportsFee(3000));
        assertTrue(adapter.supportsFee(10_000));
        AuctionEngine.OpenParams memory p = _params(100);
        vm.prank(creator);
        vm.expectRevert("fee tier not supported");
        engine.openRound(p);
    }

    address private _keeperPool;

    function _keeperSwap(address pool, uint160 limit, bool zeroForOne) internal {
        _keeperPool = pool;
        IUniswapV3PoolLike(pool).swap(address(this), zeroForOne, 1, limit, "");
        _keeperPool = address(0);
    }

    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        require(msg.sender == _keeperPool, "not pool");
        (address t0, address t1) = address(token) < WMON ? (address(token), WMON) : (WMON, address(token));
        if (d0 > 0) IERC20Approve(t0).transfer(msg.sender, uint256(d0));
        if (d1 > 0) IERC20Approve(t1).transfer(msg.sender, uint256(d1));
    }

    /// sqrtPriceX96 near a tick, via the price math (1.0001^tick), good enough for a chunk boundary.
    function _sqrtAtApprox(int24 tick) internal pure returns (uint160) {
        // sqrt(1.0001)^tick in 1e18 fixed point by square-and-multiply, then scaled to X96.
        uint256 base = 1000049998750062496; // sqrt(1.0001) × 1e18
        bool neg = tick < 0;
        uint256 n = uint256(int256(neg ? -tick : tick));
        uint256 acc = 1e18;
        while (n != 0) {
            if (n & 1 == 1) acc = acc * base / 1e18;
            base = base * base / 1e18;
            n >>= 1;
        }
        // acc = sqrt(1.0001)^|tick| × 1e18
        return neg
            ? uint160(UniV3PriceMath.mulDiv(1 << 96, 1e18, acc))
            : uint160(UniV3PriceMath.mulDiv(1 << 96, acc, 1e18));
    }

    function _tickNear(uint160 sqrtPriceX96) internal pure returns (int24 tick) {
        // Binary search over ticks with _sqrtAtApprox.
        int24 lo = -887272;
        int24 hi = 887272;
        while (hi - lo > 1) {
            int24 mid = int24((int256(lo) + int256(hi)) / 2);
            if (_sqrtAtApprox(mid) <= sqrtPriceX96) lo = mid;
            else hi = mid;
        }
        return lo;
    }

    // ─── GoPlus locker behaviour (findings) ────────────────────────────

    /// The locker pulls the NFT with safeTransferFrom(caller, locker, id), so approve + lock (what the
    /// engine does) works; it accepts any endTime in the future, up to type(uint256).max.
    function test_Fork_Locker_TakesApprovedNFT_AnyFutureEndTime() public {
        _deployToken(LOW_TOKEN);
        token.mint(address(this), 1000e18);
        token.approve(address(adapter), type(uint256).max);
        vm.deal(address(this), 10 ether);
        (address npm, uint256 id) = adapter.seed{value: 3 ether}(address(token), 1000e18, P, FEE, address(this));
        assertEq(IERC721Minimal(npm).ownerOf(id), address(this));

        // Without approval the lock fails: the locker does not own a transfer right by itself.
        vm.expectRevert();
        IUniV3LPLocker(LOCKER).lock(npm, id, address(this), address(this), LOCK_END, "DEFAULT");

        IERC721Minimal(npm).approve(LOCKER, id);
        vm.expectRevert("EndTime <= currentTime");
        IUniV3LPLocker(LOCKER).lock(npm, id, address(this), address(this), block.timestamp, "DEFAULT");

        uint256[3] memory ends = [LOCK_END, type(uint128).max, type(uint256).max];
        for (uint256 i; i < ends.length; ++i) {
            uint256 snap = vm.snapshotState();
            vm.expectCall(npm, abi.encodeWithSignature("safeTransferFrom(address,address,uint256)", address(this), LOCKER, id));
            IUniV3LPLocker(LOCKER).lock(npm, id, address(this), address(this), ends[i], "DEFAULT");
            assertEq(IERC721Minimal(npm).ownerOf(id), LOCKER);
            vm.revertToState(snap);
        }
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    receive() external payable {}
}
