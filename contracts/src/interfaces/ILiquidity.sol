// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

/// @notice A DEX venue for seeding launch liquidity (10-decisions.md #23).
/// @dev The adapter pulls `tokenAmount` of `token` from msg.sender (which must approve it first),
///      wraps msg.value MON, makes sure the pool trades at `price`, mints a full-range position owned
///      by `recipient`, and sends every unused token and MON back to msg.sender.
///      `price` is MON wei per 1e18 token units — the clearing price, unscaled.
///      `relaxed` skips the price-deviation check; the engine only sets it after its grace period.
interface IDexAdapter {
    function seed(address token, uint256 tokenAmount, uint256 price, uint24 fee, bool relaxed, address recipient)
        external
        payable
        returns (address positionManager, uint256 nftId);
}

/// @notice GoPlus SafeToken `UniV3LPLocker` (0x24A9eB23De8E6f59BDB981B03E847F0f3ABbFa0d on Monad).
/// @dev Source: https://docs.gopluslabs.io/page/goplus-safetoken-locker. Selectors confirmed in the
///      deployed bytecode on 22 Sep 2026.
interface IUniV3LPLocker {
    function lock(
        address nftManager_,
        uint256 nftId_,
        address owner_,
        address collector_,
        uint256 endTime_,
        string memory feeName_
    ) external payable returns (uint256 lockId);
}

interface IERC721Minimal {
    function approve(address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
}
