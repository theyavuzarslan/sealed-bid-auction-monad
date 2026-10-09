// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "../../src/vendor/openzeppelin/token/ERC20/IERC20.sol";
import {DemoVault} from "../../src/exit/DemoVault.sol";

/// A DemoVault whose `redeem` can pay less than, or more than, `previewRedeem` (ERC-4626 allows more).
contract PayoutVault is DemoVault {
    int256 public adjust; // added to what redeem pays; type(int256).max = pay twice
    constructor(IERC20 wmon, address strategist_) DemoVault(wmon, strategist_) {}

    function setAdjust(int256 a) external {
        adjust = a;
    }

    function redeem(uint256 shares, address receiver, address owner) public override returns (uint256) {
        if (adjust == 0) return super.redeem(shares, receiver, owner);
        uint256 assets = super.redeem(shares, address(this), owner);
        uint256 pay = adjust == type(int256).max ? 2 * assets : uint256(int256(assets) + adjust);
        IERC20(asset()).transfer(receiver, pay);
        return pay;
    }
}
