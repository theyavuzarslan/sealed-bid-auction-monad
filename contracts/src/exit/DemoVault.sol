// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC4626} from "../vendor/openzeppelin/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "../vendor/openzeppelin/token/ERC20/ERC20.sol";
import {IERC20} from "../vendor/openzeppelin/token/ERC20/IERC20.sol";
import {MerkleProofLib} from "../lib/MerkleProofLib.sol";

/// @notice What the vault needs to know from its exit adapter: shares it has promised to redeem.
interface IExitReserve {
    /// @notice The vault the exit adapter serves.
    function vault() external view returns (address);
    /// @notice Shares the exit adapter has promised to redeem.
    function reservedShares() external view returns (uint256);
    /// @notice Merkle root of the holders who may bid to exit; zero lets every holder bid.
    function allowlistRoot() external view returns (bytes32);
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
///      - With an allowlisted exit adapter, only allowlisted holders can ever exit, so only they may
///        receive new shares: a deposit for anyone else could never come out. A holder is proven once
///        (`proveHolder`, by anyone, with the holder's Merkle proof). Shares stay transferable; a holder
///        who sends shares off the list strands only their own.
///      Inflation attack: `_decimalsOffset() = 3` (OpenZeppelin's virtual shares). A first-depositor
///      donation attack then costs the attacker about 1000× what it can take from a victim, so it
///      never pays. Shares have 21 decimals as a result. No seed deposit is needed.
contract DemoVault is ERC4626 {
    /// @notice Virtual-share decimals offset against the inflation attack (shares have 18 + 3 decimals).
    uint8 public constant DECIMALS_OFFSET = 3;

    /// @notice May wire the exit adapter, once.
    address public immutable deployer;
    /// @notice May move the simulated strategy mark.
    address public immutable strategist;
    /// @notice The exit adapter: the only owner whose shares can be redeemed. Zero until set.
    address public exitAuction;
    /// @notice WMON marked as deployed to the simulated strategy.
    uint256 public strategyAssets;
    /// @notice Holders proven to be on the exit adapter's allowlist: with one set, the only receivers of new shares.
    mapping(address => bool) public provenHolder;

    /// @notice The exit adapter was wired.
    event ExitAuctionSet(address indexed exitAuction);
    /// @notice `assets` WMON moved from idle to the strategy mark, now `strategyAssets`.
    event MovedToStrategy(uint256 assets, uint256 strategyAssets);
    /// @notice `assets` WMON moved from the strategy mark back to idle, leaving `strategyAssets`.
    event MovedToIdle(uint256 assets, uint256 strategyAssets);
    /// @notice `account` was proven to be on the exit adapter's allowlist.
    event HolderProven(address indexed account);

    /// @param wmon        The asset (WMON).
    /// @param strategist_ May move the simulated strategy mark.
    constructor(IERC20 wmon, address strategist_) ERC20("Demo Vault MON", "dvMON") ERC4626(wmon) {
        require(address(wmon).code.length != 0, "asset has no code");
        require(strategist_ != address(0), "zero strategist");
        deployer = msg.sender;
        strategist = strategist_;
    }

    /// @notice One-time wiring of the exit adapter. It must point back at this vault.
    /// @param exitAuction_ The exit adapter (ExitAuction) for this vault.
    function setExitAuction(address exitAuction_) external {
        require(msg.sender == deployer, "not deployer");
        require(exitAuction == address(0), "already set");
        require(exitAuction_.code.length != 0, "exit auction has no code");
        require(IExitReserve(exitAuction_).vault() == address(this), "exit auction for another vault");
        exitAuction = exitAuction_;
        emit ExitAuctionSet(exitAuction_);
    }

    /// @notice Anyone: record that `account` is on the exit adapter's allowlist, so it may receive shares.
    /// @param account The holder.
    /// @param proof   Its Merkle proof against the exit adapter's `allowlistRoot`.
    function proveHolder(address account, bytes32[] calldata proof) external {
        address ea = exitAuction;
        require(ea != address(0), "exit auction not set");
        require(
            MerkleProofLib.verify(proof, IExitReserve(ea).allowlistRoot(), MerkleProofLib.leafOf(account)),
            "not on allowlist"
        );
        provenHolder[account] = true;
        emit HolderProven(account);
    }

    // ─── Simulated strategy ─────────────────────────────────────────────

    /// @notice Strategist: mark `assets` idle WMON as deployed. Never idle WMON reserved for exits.
    /// @param assets WMON to mark.
    function moveToStrategy(uint256 assets) external {
        require(msg.sender == strategist, "not strategist");
        uint256 idle = idleAssets();
        uint256 reserved = _reservedAssets();
        require(idle >= reserved && assets <= idle - reserved, "idle reserved for exits");
        strategyAssets += assets;
        emit MovedToStrategy(assets, strategyAssets);
    }

    /// @notice Strategist: mark `assets` of the strategy as idle again.
    /// @param assets WMON to unmark; at most `strategyAssets`.
    function moveToIdle(uint256 assets) external {
        require(msg.sender == strategist, "not strategist");
        strategyAssets -= assets;
        emit MovedToIdle(assets, strategyAssets);
    }

    // ─── Views ──────────────────────────────────────────────────────────

    /// @notice Idle WMON backing shares the exit adapter has promised to redeem (rounded up).
    function reservedAssets() external view returns (uint256) {
        return _reservedAssets();
    }

    /// @notice WMON available for exits right now.
    function idleAssets() public view returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) - strategyAssets;
    }

    /// @dev Idle buffer plus the strategy mark. Equal to the vault's WMON balance, stated explicitly.
    function totalAssets() public view override returns (uint256) {
        return idleAssets() + strategyAssets;
    }

    /// @notice Zero for a receiver that could never exit (see `proveHolder`).
    function maxDeposit(address receiver) public view override returns (uint256) {
        return _mayHold(receiver) ? super.maxDeposit(receiver) : 0;
    }

    /// @notice Zero for a receiver that could never exit (see `proveHolder`).
    function maxMint(address receiver) public view override returns (uint256) {
        return _mayHold(receiver) ? super.maxMint(receiver) : 0;
    }

    /// @notice Only the exit adapter can withdraw, and at most the idle buffer.
    /// @dev `owner == address(0)` matters only while the exit adapter is unset (`exitAuction` is zero).
    function maxWithdraw(address owner) public view override returns (uint256) {
        if (owner != exitAuction || owner == address(0)) return 0;
        uint256 m = super.maxWithdraw(owner);
        uint256 idle = idleAssets();
        return m < idle ? m : idle;
    }

    /// @notice Only the exit adapter can redeem, and at most the idle buffer's worth of shares.
    /// @dev `owner == address(0)` matters only while the exit adapter is unset (`exitAuction` is zero).
    function maxRedeem(address owner) public view override returns (uint256) {
        if (owner != exitAuction || owner == address(0)) return 0;
        uint256 m = super.maxRedeem(owner);
        uint256 idleShares = convertToShares(idleAssets());
        return m < idleShares ? m : idleShares;
    }

    /// @dev See DECIMALS_OFFSET.
    function _decimalsOffset() internal pure override returns (uint8) {
        return DECIMALS_OFFSET;
    }

    /// @dev Whether `account` may receive new shares: everyone while the exit adapter is unset (the
    ///      deploy script wires it in the same broadcast) or open, otherwise proven holders only.
    function _mayHold(address account) private view returns (bool) {
        address ea = exitAuction;
        if (ea == address(0) || provenHolder[account]) return true;
        return IExitReserve(ea).allowlistRoot() == bytes32(0);
    }

    /// @dev `previewMint` of the reserved shares: the WMON they redeem for, rounded up.
    function _reservedAssets() private view returns (uint256) {
        address ea = exitAuction;
        if (ea == address(0)) return 0;
        return previewMint(IExitReserve(ea).reservedShares());
    }
}
