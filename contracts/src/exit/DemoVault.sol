// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "../vendor/openzeppelin/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "../vendor/openzeppelin/token/ERC20/ERC20.sol";
import {IERC20} from "../vendor/openzeppelin/token/ERC20/IERC20.sol";

/// @notice What the vault needs to know from its exit adapter: shares it has promised to redeem.
interface IExitReserve {
    function vault() external view returns (address);
    function reservedShares() external view returns (uint256);
}

/// @title DemoVault — ERC-4626 over WMON with an idle buffer and a simulated illiquid strategy
/// @notice The vault behind the Exit-Priority demo (10-decisions.md #31). All share math is
///         OpenZeppelin's ERC4626 v5.1.0, vendored unchanged under `src/vendor/openzeppelin` (MIT).
/// @dev Assets:
///      - Every WMON the vault owns sits in this contract. `strategyAssets` of it is marked as deployed
///        to a simulated illiquid strategy; the rest is the idle buffer. `totalAssets` counts both.
///        The strategist moves the mark in either direction; nothing leaves the vault, so the
///        simulation needs no trusted custodian.
///      - Exits go only through the exit adapter (`exitAuction`): it is the only owner whose shares can
///        be redeemed, and never for more than the idle buffer. That is the point of the product: the
///        auction replaces a FIFO redemption queue.
///      - The strategist cannot move into the strategy any idle WMON that backs shares the exit
///        adapter has promised to redeem (`IExitReserve.reservedShares`), so a settled exit can always
///        be paid.
///      Inflation attack: `_decimalsOffset() = 3` (OpenZeppelin's virtual shares). A first-depositor
///      donation attack then costs the attacker about 1000× what it can take from a victim, so it
///      never pays. Shares have 21 decimals as a result. No seed deposit is needed.
contract DemoVault is ERC4626 {
    uint8 public constant DECIMALS_OFFSET = 3;

    address public immutable deployer;
    address public immutable strategist;
    address public exitAuction;
    uint256 public strategyAssets;

    event ExitAuctionSet(address indexed exitAuction);
    event MovedToStrategy(uint256 assets, uint256 strategyAssets);
    event MovedToIdle(uint256 assets, uint256 strategyAssets);

    constructor(IERC20 wmon, address strategist_) ERC20("Demo Vault MON", "dvMON") ERC4626(wmon) {
        require(address(wmon).code.length != 0, "asset has no code");
        require(strategist_ != address(0), "zero strategist");
        deployer = msg.sender;
        strategist = strategist_;
    }

    /// @notice One-time wiring of the exit adapter. It must point back at this vault.
    function setExitAuction(address exitAuction_) external {
        require(msg.sender == deployer, "not deployer");
        require(exitAuction == address(0), "already set");
        require(exitAuction_.code.length != 0, "exit auction has no code");
        require(IExitReserve(exitAuction_).vault() == address(this), "exit auction for another vault");
        exitAuction = exitAuction_;
        emit ExitAuctionSet(exitAuction_);
    }

    // ─── Simulated strategy ─────────────────────────────────────────────

    function moveToStrategy(uint256 assets) external {
        require(msg.sender == strategist, "not strategist");
        uint256 idle = idleAssets();
        uint256 reserved = _reservedAssets();
        require(idle >= reserved && assets <= idle - reserved, "idle reserved for exits");
        strategyAssets += assets;
        emit MovedToStrategy(assets, strategyAssets);
    }

    function moveToIdle(uint256 assets) external {
        require(msg.sender == strategist, "not strategist");
        strategyAssets -= assets;
        emit MovedToIdle(assets, strategyAssets);
    }

    // ─── Views ──────────────────────────────────────────────────────────

    /// @notice WMON available for exits right now.
    function idleAssets() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) - strategyAssets;
    }

    /// @notice Idle WMON backing shares the exit adapter has promised to redeem (rounded up).
    function reservedAssets() external view returns (uint256) {
        return _reservedAssets();
    }

    /// @dev Idle buffer plus the strategy mark. Equal to the vault's WMON balance, stated explicitly.
    function totalAssets() public view override returns (uint256) {
        return idleAssets() + strategyAssets;
    }

    function maxWithdraw(address owner) public view override returns (uint256) {
        if (owner != exitAuction || owner == address(0)) return 0;
        uint256 m = super.maxWithdraw(owner);
        uint256 idle = idleAssets();
        return m < idle ? m : idle;
    }

    function maxRedeem(address owner) public view override returns (uint256) {
        if (owner != exitAuction || owner == address(0)) return 0;
        uint256 m = super.maxRedeem(owner);
        uint256 idleShares = convertToShares(idleAssets());
        return m < idleShares ? m : idleShares;
    }

    function _reservedAssets() private view returns (uint256) {
        address ea = exitAuction;
        if (ea == address(0)) return 0;
        return previewMint(IExitReserve(ea).reservedShares());
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return DECIMALS_OFFSET;
    }
}
