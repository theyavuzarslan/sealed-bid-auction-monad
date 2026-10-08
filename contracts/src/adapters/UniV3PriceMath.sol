// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The price arithmetic the Uniswap v3 adapter needs: a 512-bit mulDiv, an integer square
///         root, the Uniswap v3 sqrt-price bounds, and the conversion from the engine's clearing price
///         to a pool's `sqrtPriceX96`.
/// @dev `mulDiv` is the full-precision algorithm by Remco Bloemen (MIT,
///      https://xn--2-umb.com/21/muldiv), the same algorithm as Uniswap v3's FullMath. `sqrt` is the
///      Babylonian method with a bit-length seed, as in ABDK's math library (BSD-4). Both are
///      re-implemented here, not copied, and are fuzzed in `test/UniswapV3Adapter.t.sol`.
///      MIN/MAX_SQRT_RATIO are the constants of Uniswap v3's TickMath (ticks -887272 and 887272).
library UniV3PriceMath {
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
    uint256 internal constant PRICE_SCALE = 1e18;

    /// @notice floor(a × b / d) with a 512-bit intermediate. Reverts if d == 0 or the result overflows.
    function mulDiv(uint256 a, uint256 b, uint256 d) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) {
                require(d != 0, "mulDiv by zero");
                return prod0 / d;
            }
            require(d > prod1, "mulDiv overflow");
            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, d)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = d & (~d + 1);
            assembly {
                d := div(d, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inv = (3 * d) ^ 2; // correct to 4 bits
            inv *= 2 - d * inv; // 8
            inv *= 2 - d * inv; // 16
            inv *= 2 - d * inv; // 32
            inv *= 2 - d * inv; // 64
            inv *= 2 - d * inv; // 128
            inv *= 2 - d * inv; // 256
            result = prod0 * inv;
        }
    }

    /// @notice floor(sqrt(x)).
    function sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        unchecked {
            uint256 xx = x;
            uint256 r = 1;
            if (xx >= 1 << 128) {
                xx >>= 128;
                r <<= 64;
            }
            if (xx >= 1 << 64) {
                xx >>= 64;
                r <<= 32;
            }
            if (xx >= 1 << 32) {
                xx >>= 32;
                r <<= 16;
            }
            if (xx >= 1 << 16) {
                xx >>= 16;
                r <<= 8;
            }
            if (xx >= 1 << 8) {
                xx >>= 8;
                r <<= 4;
            }
            if (xx >= 1 << 4) {
                xx >>= 4;
                r <<= 2;
            }
            if (xx >= 1 << 3) r <<= 1;
            r = (r + x / r) >> 1;
            r = (r + x / r) >> 1;
            r = (r + x / r) >> 1;
            r = (r + x / r) >> 1;
            r = (r + x / r) >> 1;
            r = (r + x / r) >> 1;
            r = (r + x / r) >> 1;
            uint256 r1 = x / r;
            return r < r1 ? r : r1;
        }
    }

    /// @notice The pool `sqrtPriceX96` at which `token` trades at `price` against `quote`.
    /// @param price MON wei per 1e18 raw token units, i.e. raw quote per raw token × 1e18.
    /// @dev Uniswap prices are token1 per token0 in raw units. If token < quote, token is token0 and the
    ///      raw price is price / 1e18; otherwise it is 1e18 / price. sqrtPriceX96 = floor(sqrt(ratio × 2^192)).
    ///      When ratio × 2^192 would overflow 256 bits (ratio ≥ 2^64), the root is taken at 2^128 and
    ///      shifted up by 32 bits; the ratio is then at least 2^64, so the lost precision is below 2^-96.
    function sqrtPriceX96For(address token, address quote, uint256 price) internal pure returns (uint160) {
        require(price != 0, "zero price");
        (uint256 num, uint256 den) = token < quote ? (price, PRICE_SCALE) : (PRICE_SCALE, price);
        uint256 root;
        if (num / den < 1 << 64) {
            root = sqrt(mulDiv(num, 1 << 192, den));
        } else {
            require(num / den < 1 << 128, "price out of range");
            root = sqrt(mulDiv(num, 1 << 128, den)) << 32;
        }
        require(root >= MIN_SQRT_RATIO && root < MAX_SQRT_RATIO, "price out of range");
        return uint160(root);
    }

    /// @notice Whether the price implied by `sqrtPrice` is within `toleranceBps` of the price implied by
    ///         `target` (both sqrtPriceX96 of the same pool), measured on the price, not its root.
    /// @dev q = sqrtPrice / target × 1e18, so the price ratio is q² / 1e36. With toleranceBps < 10000 the
    ///      allowed ratio is below 2, hence q < 1.42e18, and anything at 2e18 or above is out.
    function withinTolerance(uint160 sqrtPrice, uint160 target, uint256 toleranceBps) internal pure returns (bool) {
        uint256 q = mulDiv(sqrtPrice, PRICE_SCALE, target);
        if (q >= 2 * PRICE_SCALE) return false;
        uint256 lhs = q * q * 10_000;
        return lhs <= PRICE_SCALE * PRICE_SCALE * (10_000 + toleranceBps)
            && lhs >= PRICE_SCALE * PRICE_SCALE * (10_000 - toleranceBps);
    }
}
