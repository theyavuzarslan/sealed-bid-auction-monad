// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {UniswapV3Adapter} from "../src/adapters/UniswapV3Adapter.sol";
import {UniV3PriceMath} from "../src/adapters/UniV3PriceMath.sol";
import {MockToken} from "./mocks/Mocks.sol";

/// @notice Factory stand-in: only fee 3000 is enabled, and no pool exists.
contract MockV3Factory {
    function feeAmountTickSpacing(uint24 fee) external pure returns (int24) {
        return fee == 3000 ? int24(60) : int24(0);
    }

    function getPool(address, address, uint24) external pure returns (address) {
        return address(0);
    }
}

/// @notice Exposes the library for testing.
contract MathHarness {
    function mulDiv(uint256 a, uint256 b, uint256 d) external pure returns (uint256) {
        return UniV3PriceMath.mulDiv(a, b, d);
    }

    function sqrtPriceX96For(address token, address quote, uint256 price) external pure returns (uint160) {
        return UniV3PriceMath.sqrtPriceX96For(token, quote, price);
    }
}

/// @notice Unit tests: the price math, and the adapter's input checks with local mocks. Pool behaviour
///         (create, reprice, mint, refund, lock) runs against the real Uniswap v3 deployment in
///         `test/fork/UniswapV3AdapterFork.t.sol`.
contract UniswapV3AdapterTest is Test {
    address constant LOW = address(0x1000);
    address constant HIGH = address(0xF000);

    MathHarness h = new MathHarness();

    // ─── Math ───────────────────────────────────────────────────────────

    function testFuzz_Sqrt_IsFloor(uint256 x) public pure {
        uint256 r = UniV3PriceMath.sqrt(x);
        assertLe(r * r, x);
        if (r < type(uint128).max) assertGt((r + 1) * (r + 1), x);
    }

    function test_Sqrt_Edges() public pure {
        assertEq(UniV3PriceMath.sqrt(0), 0);
        assertEq(UniV3PriceMath.sqrt(1), 1);
        assertEq(UniV3PriceMath.sqrt(3), 1);
        assertEq(UniV3PriceMath.sqrt(4), 2);
        assertEq(UniV3PriceMath.sqrt(type(uint256).max), type(uint128).max);
        assertEq(UniV3PriceMath.sqrt(uint256(1) << 192), uint256(1) << 96);
    }

    function testFuzz_MulDiv_MatchesNaive(uint128 a, uint128 b, uint256 d) public pure {
        vm.assume(d != 0);
        assertEq(UniV3PriceMath.mulDiv(a, b, d), uint256(a) * b / d);
    }

    function testFuzz_MulDiv_FullWidth(uint256 a, uint256 b) public pure {
        vm.assume(b != 0);
        assertEq(UniV3PriceMath.mulDiv(a, b, b), a);
        // (a × 2^128) / 2^128 == a even when a × 2^128 overflows 256 bits
        if (a < type(uint256).max >> 1) assertEq(UniV3PriceMath.mulDiv(a, 1 << 128, 1 << 128), a);
    }

    function test_MulDiv_Reverts() public {
        vm.expectRevert("mulDiv by zero");
        h.mulDiv(1, 1, 0);
        vm.expectRevert("mulDiv overflow");
        h.mulDiv(type(uint256).max, type(uint256).max, 1);
    }

    function test_SqrtPrice_KnownValues() public pure {
        // price 1 (1 MON per token): 2^96 in both orientations
        assertEq(UniV3PriceMath.sqrtPriceX96For(LOW, HIGH, 1e18), 1 << 96);
        assertEq(UniV3PriceMath.sqrtPriceX96For(HIGH, LOW, 1e18), 1 << 96);
        // price 4: token0 → sqrt(4) = 2; token1 → sqrt(1/4) = 1/2
        assertEq(UniV3PriceMath.sqrtPriceX96For(LOW, HIGH, 4e18), 1 << 97);
        assertEq(UniV3PriceMath.sqrtPriceX96For(HIGH, LOW, 4e18), 1 << 95);
        assertEq(UniV3PriceMath.sqrtPriceX96For(LOW, HIGH, 0.25e18), 1 << 95);
    }

    /// Round trip: squaring the result gives back the price, to the precision of the root.
    function testFuzz_SqrtPrice_RoundTrip(uint256 price, bool tokenIsToken0) public view {
        price = bound(price, 1e12, 1e36);
        (address token, address quote) = tokenIsToken0 ? (LOW, HIGH) : (HIGH, LOW);
        uint256 s = h.sqrtPriceX96For(token, quote, price);
        uint256 ratioX128 = UniV3PriceMath.mulDiv(s, s, 1 << 64);
        uint256 back = tokenIsToken0
            ? UniV3PriceMath.mulDiv(ratioX128, 1e18, 1 << 128)
            : UniV3PriceMath.mulDiv(1e18, 1 << 128, ratioX128);
        assertApproxEqRel(back, price, 1e9); // 1e-9 relative
    }

    /// The X128 branch (raw ratio ≥ 2^64) agrees with the X192 branch at the boundary.
    function test_SqrtPrice_HighRatioBranch() public pure {
        uint256 p = (uint256(1) << 64) * 1e18; // raw ratio exactly 2^64
        assertEq(UniV3PriceMath.sqrtPriceX96For(LOW, HIGH, p), uint256(1) << 128);
        uint256 below = p - 1e18;
        uint256 s = UniV3PriceMath.sqrtPriceX96For(LOW, HIGH, below);
        assertLt(s, uint256(1) << 128);
        assertGt(s, (uint256(1) << 128) - (uint256(1) << 64));
    }

    function test_SqrtPrice_OutOfRange() public {
        vm.expectRevert("zero price");
        h.sqrtPriceX96For(LOW, HIGH, 0);
        // Raw ratio 1e18 / 2^200 is below 2^-128: under MIN_SQRT_RATIO.
        vm.expectRevert("price out of range");
        h.sqrtPriceX96For(HIGH, LOW, uint256(1) << 200);
        // Raw ratio 2^128 and above: at or over MAX_SQRT_RATIO.
        vm.expectRevert("price out of range");
        h.sqrtPriceX96For(LOW, HIGH, (uint256(1) << 128) * 1e18);
        vm.expectRevert("price out of range");
        h.sqrtPriceX96For(LOW, HIGH, type(uint256).max);
        vm.expectRevert("price out of range");
        h.sqrtPriceX96For(HIGH, LOW, type(uint256).max);
    }

    function test_WithinTolerance_Boundaries() public pure {
        uint160 target = uint160(1 << 96); // price 1
        uint160 up = uint160(UniV3PriceMath.sqrt(UniV3PriceMath.mulDiv(10_099, 1 << 192, 10_000)));
        uint160 upOut = uint160(UniV3PriceMath.sqrt(UniV3PriceMath.mulDiv(10_101, 1 << 192, 10_000)));
        uint160 down = uint160(UniV3PriceMath.sqrt(UniV3PriceMath.mulDiv(9901, 1 << 192, 10_000)));
        uint160 downOut = uint160(UniV3PriceMath.sqrt(UniV3PriceMath.mulDiv(9899, 1 << 192, 10_000)));
        assertTrue(UniV3PriceMath.withinTolerance(target, target, 0));
        assertTrue(UniV3PriceMath.withinTolerance(up, target, 100));
        assertFalse(UniV3PriceMath.withinTolerance(upOut, target, 100));
        assertTrue(UniV3PriceMath.withinTolerance(down, target, 100));
        assertFalse(UniV3PriceMath.withinTolerance(downOut, target, 100));
        assertFalse(UniV3PriceMath.withinTolerance(UniV3PriceMath.MAX_SQRT_RATIO - 1, target, 9999));
        assertFalse(UniV3PriceMath.withinTolerance(UniV3PriceMath.MIN_SQRT_RATIO, target, 9999));
    }

    // ─── Adapter input checks (mocks) ──────────────────────────────────

    function _adapter() internal returns (UniswapV3Adapter a, MockToken wmon, MockToken token) {
        wmon = new MockToken();
        token = new MockToken();
        a = new UniswapV3Adapter(address(new MockV3Factory()), address(new MockToken()), address(wmon), 100);
    }

    function test_Constructor_Checks() public {
        MockToken t = new MockToken();
        vm.expectRevert("no code");
        new UniswapV3Adapter(address(0xBEEF), address(t), address(t), 100);
        vm.expectRevert("tolerance >= 100%");
        new UniswapV3Adapter(address(t), address(t), address(t), 10_000);
    }

    function test_Seed_InputChecks() public {
        (UniswapV3Adapter a, MockToken wmon, MockToken token) = _adapter();
        vm.deal(address(this), 10 ether);
        vm.expectRevert("bad token");
        a.seed{value: 1 ether}(address(wmon), 1e18, 1e18, 3000, address(this));
        vm.expectRevert("bad token");
        a.seed{value: 1 ether}(address(0xBEEF), 1e18, 1e18, 3000, address(this));
        vm.expectRevert("zero amount");
        a.seed{value: 1 ether}(address(token), 0, 1e18, 3000, address(this));
        vm.expectRevert("zero amount");
        a.seed(address(token), 1e18, 1e18, 3000, address(this));
        vm.expectRevert("zero recipient");
        a.seed{value: 1 ether}(address(token), 1e18, 1e18, 3000, address(0));
        vm.expectRevert("fee not supported");
        a.seed{value: 1 ether}(address(token), 1e18, 1e18, 500, address(this));
        vm.expectRevert("zero price");
        a.seed{value: 1 ether}(address(token), 1e18, 0, 3000, address(this));
    }

    function test_Seed_RejectsFeeOnTransferToken() public {
        (UniswapV3Adapter a,, MockToken token) = _adapter();
        token.setFeeBps(100);
        token.mint(address(this), 1e18);
        token.approve(address(a), type(uint256).max);
        vm.deal(address(this), 1 ether);
        vm.expectRevert("fee-on-transfer token");
        a.seed{value: 1 ether}(address(token), 1e18, 1e18, 3000, address(this));
    }

    function test_SwapCallback_OnlyDuringRepricing() public {
        (UniswapV3Adapter a,,) = _adapter();
        vm.expectRevert("not the pool");
        a.uniswapV3SwapCallback(1, 0, abi.encode(address(1), address(2), uint24(3000)));
        vm.prank(address(0));
        vm.expectRevert("not the pool");
        a.uniswapV3SwapCallback(1, 0, abi.encode(address(1), address(2), uint24(3000)));
    }

    function test_Receive_OnlyFromWmon() public {
        (UniswapV3Adapter a, MockToken wmon,) = _adapter();
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(a).call{value: 1}("");
        assertFalse(ok);
        vm.deal(address(wmon), 1 ether);
        vm.prank(address(wmon));
        (ok,) = address(a).call{value: 1}("");
        assertTrue(ok);
    }

    function test_TargetSqrtPrice_UsesWmonOrdering() public {
        (UniswapV3Adapter a, MockToken wmon, MockToken token) = _adapter();
        uint160 expected = UniV3PriceMath.sqrtPriceX96For(address(token), address(wmon), 4e18);
        assertEq(a.targetSqrtPriceX96(address(token), 4e18), expected);
        assertEq(expected, address(token) < address(wmon) ? uint160(1 << 97) : uint160(1 << 95));
    }
}
