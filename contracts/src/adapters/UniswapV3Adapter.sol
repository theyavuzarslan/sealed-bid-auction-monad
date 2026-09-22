// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.28;

import {IDexAdapter} from "../interfaces/ILiquidity.sol";
import {SafeTransferLib} from "../lib/SafeTransferLib.sol";
import {UniV3PriceMath} from "./UniV3PriceMath.sol";

interface IUniswapV3FactoryLike {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    function feeAmountTickSpacing(uint24 fee) external view returns (int24);
}

interface IUniswapV3PoolLike {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function liquidity() external view returns (uint128);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

interface INonfungiblePositionManagerLike {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external
        payable
        returns (address pool);
    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}

interface IWMON {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
    function balanceOf(address account) external view returns (uint256);
}

interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
}

/// @title UniswapV3Adapter — seeds a full-range Uniswap v3 position at the clearing price
/// @notice The LP seeder's venue for Uniswap v3 on Monad (10-decisions.md #23). Holds no funds between
///         calls: every call pulls the token side from the caller, wraps the MON side, mints a full-range
///         position owned by `recipient`, and returns everything the pool did not take to the caller.
/// @dev Price safety (bug #7). The position is minted at the pool's price, so the pool must trade at the
///      clearing price before the mint:
///      - No pool, or an uninitialised one: create or initialise it at the target.
///      - An initialised pool with no in-range liquidity: someone may have initialised it at a bad price
///        for free. Move it to the target with a 1-wei exact-input swap limited at the target. With no
///        liquidity in the way the price travels to the limit for free; if out-of-range liquidity sits in
///        between, the swap stops at that tick, the price still deviates, and the call reverts. The swap
///        is gas-capped (REPRICE_GAS); if the cap is hit the pool stays where it was.
///      - An initialised pool with liquidity: revert when it deviates from the target by more than
///        `toleranceBps`. The engine's grace period then lets claims open and retries with `relaxed`.
///      - `relaxed`: skip the deviation check and mint at whatever price the pool has, after moving it
///        to the target if it is empty (same free 1-wei swap; best effort, no check afterwards).
///      The check and the mint happen in the same transaction, which is why the mint's amountMin is 0.
contract UniswapV3Adapter is IDexAdapter {
    using SafeTransferLib for address;

    int24 internal constant MAX_TICK = 887272;
    /// @dev The most a repricing swap may take from the adapter: it is a 1-wei exact-input swap.
    uint256 internal constant MAX_REPRICE_INPUT = 1;
    /// @dev Gas for a repricing swap. Enough to walk an empty pool across the whole tick range at tick
    ///      spacing 10 (fee 500: the whole seed measured 5.1M gas on a Monad fork); fee 100 (spacing 1)
    ///      needs ~41M and does not fit, see `_preparePool`.
    uint256 internal constant REPRICE_GAS = 8_000_000;

    IUniswapV3FactoryLike public immutable factory;
    INonfungiblePositionManagerLike public immutable positionManager;
    address public immutable wmon;
    /// @notice Largest accepted deviation of an existing pool's price from the target, in bps of price.
    uint256 public immutable toleranceBps;

    /// @dev The pool a repricing swap is in flight on; the swap callback pays only this address.
    address private transient _repricingPool;
    bool private transient _entered;

    event PoolRepriced(address indexed pool, uint160 fromSqrtPriceX96, uint160 toSqrtPriceX96);
    event Seeded(
        address indexed pool, address indexed token, uint256 nftId, uint256 tokenUsed, uint256 monUsed, address recipient
    );

    /// @param factory_         UniswapV3Factory.
    /// @param positionManager_ NonfungiblePositionManager of the same deployment.
    /// @param wmon_            Wrapped MON, the quote token of every pool.
    /// @param toleranceBps_    Largest accepted deviation of a pool with liquidity from the target price.
    constructor(address factory_, address positionManager_, address wmon_, uint256 toleranceBps_) {
        require(factory_.code.length != 0 && positionManager_.code.length != 0 && wmon_.code.length != 0, "no code");
        require(toleranceBps_ < 10_000, "tolerance >= 100%");
        factory = IUniswapV3FactoryLike(factory_);
        positionManager = INonfungiblePositionManagerLike(positionManager_);
        wmon = wmon_;
        toleranceBps = toleranceBps_;
    }

    modifier nonReentrant() {
        require(!_entered, "reentrancy");
        _entered = true;
        _;
        _entered = false;
    }

    /// @inheritdoc IDexAdapter
    function seed(address token, uint256 tokenAmount, uint256 price, uint24 fee, bool relaxed, address recipient)
        external
        payable
        nonReentrant
        returns (address, uint256 nftId)
    {
        require(token != wmon && token.code.length != 0, "bad token");
        require(tokenAmount != 0 && msg.value != 0, "zero amount");
        require(recipient != address(0), "zero recipient");
        int24 spacing = factory.feeAmountTickSpacing(fee);
        require(spacing > 0, "fee not enabled");
        uint160 target = UniV3PriceMath.sqrtPriceX96For(token, wmon, price);

        // Balances before this call's funds arrive. Anything already here (a donation) is left alone,
        // so the caller gets back exactly its own unused funds and its balance-delta accounting holds.
        uint256 tokenBase = IERC20Balance(token).balanceOf(address(this));
        uint256 wmonBase = IWMON(wmon).balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), tokenAmount);
        require(IERC20Balance(token).balanceOf(address(this)) - tokenBase == tokenAmount, "fee-on-transfer token");
        IWMON(wmon).deposit{value: msg.value}();

        (address token0, address token1) = token < wmon ? (token, wmon) : (wmon, token);
        address pool = _preparePool(token0, token1, fee, target, relaxed);

        // This call's funds only, net of the (at most 1-wei) repricing payment.
        uint256 tokenHeld = IERC20Balance(token).balanceOf(address(this)) - tokenBase;
        uint256 wmonHeld = IWMON(wmon).balanceOf(address(this)) - wmonBase;
        (uint256 amount0, uint256 amount1) = token == token0 ? (tokenHeld, wmonHeld) : (wmonHeld, tokenHeld);
        nftId = _mintFullRange(token0, token1, fee, spacing, amount0, amount1, recipient);

        // Return what the pool did not take. Capped at what was sent in: a repricing swap takes at most
        // 1 wei and pays out nothing, so the caps only bind if something unexpected reached the adapter.
        uint256 tokenLeft = _min(IERC20Balance(token).balanceOf(address(this)) - tokenBase, tokenAmount);
        uint256 wmonLeft = _min(IWMON(wmon).balanceOf(address(this)) - wmonBase, msg.value);
        emit Seeded(pool, token, nftId, tokenAmount - tokenLeft, msg.value - wmonLeft, recipient);
        if (tokenLeft != 0) token.safeTransfer(msg.sender, tokenLeft);
        if (wmonLeft != 0) {
            IWMON(wmon).withdraw(wmonLeft);
            SafeTransferLib.sendValue(msg.sender, wmonLeft);
        }
        return (address(positionManager), nftId);
    }

    /// @dev Leaves the pool trading at `target` (or within tolerance of it), or at its own price when relaxed.
    function _preparePool(address token0, address token1, uint24 fee, uint160 target, bool relaxed)
        private
        returns (address pool)
    {
        pool = factory.getPool(token0, token1, fee);
        uint160 current;
        if (pool != address(0)) (current,,,,,,) = IUniswapV3PoolLike(pool).slot0();
        if (current == 0) {
            // Missing or uninitialised: nobody can have liquidity in it yet.
            return positionManager.createAndInitializePoolIfNecessary(token0, token1, fee, target);
        }
        if (current != target && IUniswapV3PoolLike(pool).liquidity() == 0) {
            // An empty pool costs nothing to move, so move it even when it is within tolerance, and
            // also when relaxed: otherwise a griefer who blocked seeding with liquidity could pull it
            // after `forceOpenClaims` and have the relaxed seed mint alone at their price, where the
            // first arbitrageur (the griefer) takes the difference out of the LP.
            // Gas-capped: the swap walks the tick bitmap one word at a time, so moving from the far end
            // of a fine-spaced pool (fee 100, tick spacing 1) costs ~41M gas, over a block's tx limit.
            // If the cap is hit the pool is left where it was: seeding then reverts (strict), or tries to
            // mint at the pool's price (relaxed). Anyone can also walk an empty pool back in several
            // transactions with 1-wei swaps of their own, after which a strict seed goes through.
            _repricingPool = pool;
            try IUniswapV3PoolLike(pool).swap{gas: REPRICE_GAS}(
                address(this), target < current, 1, target, abi.encode(token0, token1, fee)
            ) {
                uint160 moved;
                (moved,,,,,,) = IUniswapV3PoolLike(pool).slot0();
                emit PoolRepriced(pool, current, moved);
                current = moved;
            } catch {}
            _repricingPool = address(0);
        }
        if (!relaxed) require(UniV3PriceMath.withinTolerance(current, target, toleranceBps), "pool price deviates");
    }

    function _mintFullRange(
        address token0,
        address token1,
        uint24 fee,
        int24 spacing,
        uint256 amount0,
        uint256 amount1,
        address recipient
    ) private returns (uint256 nftId) {
        int24 tickUpper = (MAX_TICK / spacing) * spacing;
        address npm = address(positionManager);
        token0.safeApprove(npm, amount0);
        token1.safeApprove(npm, amount1);
        // amountMin = 0 is safe only because the pool price was checked (or set) earlier in this same
        // transaction; nothing can move it in between.
        (nftId,,,) = positionManager.mint(
            INonfungiblePositionManagerLike.MintParams({
                token0: token0,
                token1: token1,
                fee: fee,
                tickLower: -tickUpper,
                tickUpper: tickUpper,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: recipient,
                deadline: block.timestamp
            })
        );
        token0.safeApprove(npm, 0);
        token1.safeApprove(npm, 0);
    }

    /// @notice Pays a repricing swap. Only the pool this adapter is repricing, and only up to 1 wei.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        address pool = _repricingPool;
        require(pool != address(0) && msg.sender == pool, "not the pool");
        (address token0, address token1, uint24 fee) = abi.decode(data, (address, address, uint24));
        require(factory.getPool(token0, token1, fee) == msg.sender, "not the pool");
        if (amount0Delta > 0) _payPool(token0, uint256(amount0Delta));
        if (amount1Delta > 0) _payPool(token1, uint256(amount1Delta));
    }

    function _payPool(address token, uint256 amount) private {
        // More than the 1-wei input means the swap did something other than move an empty pool.
        require(amount <= MAX_REPRICE_INPUT, "pool price deviates");
        token.safeTransfer(msg.sender, amount);
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    /// @notice The pool sqrtPriceX96 that corresponds to `price` for `token` against WMON.
    function targetSqrtPriceX96(address token, uint256 price) external view returns (uint160) {
        return UniV3PriceMath.sqrtPriceX96For(token, wmon, price);
    }

    /// @dev MON arrives only from unwrapping WMON.
    receive() external payable {
        require(msg.sender == wmon, "unexpected MON");
    }
}
