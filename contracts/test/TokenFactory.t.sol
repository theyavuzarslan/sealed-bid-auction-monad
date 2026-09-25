// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

import {EngineBase} from "./AuctionEngine.t.sol";
import {AuctionEngine} from "../src/AuctionEngine.sol";
import {TokenFactory, LaunchToken} from "../src/launch/TokenFactory.sol";

contract TokenFactoryTest is EngineBase {
    TokenFactory factory;

    event TokenCreated(address indexed token, address indexed creator, string name, string symbol, uint256 supply);

    function setUp() public override {
        super.setUp();
        factory = new TokenFactory();
    }

    function test_Create_MintsFixedSupplyToCreator() public {
        vm.expectEmit(false, true, false, true);
        emit TokenCreated(address(0), creator, "Monad Cat", "MCAT", 1_000_000_000e18);
        vm.prank(creator);
        LaunchToken t = LaunchToken(factory.create("Monad Cat", "MCAT", 1_000_000_000e18));

        assertEq(t.name(), "Monad Cat");
        assertEq(t.symbol(), "MCAT");
        assertEq(t.decimals(), 18);
        assertEq(t.totalSupply(), 1_000_000_000e18);
        assertEq(t.balanceOf(creator), 1_000_000_000e18, "all supply to the creator");
        assertEq(t.balanceOf(address(factory)), 0, "the factory keeps nothing");
        assertTrue(factory.isFactoryToken(address(t)));
        assertEq(factory.tokenCount(), 1);
        assertEq(factory.allTokens(0), address(t));
    }

    /// Nothing a creator could use against buyers after launch: no mint, no owner, no pause.
    function test_Token_HasNoAdminFunctions() public {
        vm.prank(creator);
        address t = factory.create("Monad Cat", "MCAT", 1e27);
        bytes4[5] memory admin = [
            bytes4(keccak256("mint(address,uint256)")),
            bytes4(keccak256("owner()")),
            bytes4(keccak256("pause()")),
            bytes4(keccak256("burn(uint256)")),
            bytes4(keccak256("transferOwnership(address)"))
        ];
        for (uint256 i; i < admin.length; ++i) {
            (bool ok,) = t.call(abi.encodeWithSelector(admin[i], creator, 1));
            assertFalse(ok);
        }
        assertEq(LaunchToken(t).totalSupply(), 1e27, "supply can never change");
    }

    function test_Create_RejectsBadInput() public {
        vm.expectRevert("bad name");
        factory.create("", "MCAT", 1e27);
        vm.expectRevert("bad name");
        factory.create("a name that is longer than thirty-two bytes", "MCAT", 1e27);
        vm.expectRevert("bad symbol");
        factory.create("Monad Cat", "", 1e27);
        vm.expectRevert("bad symbol");
        factory.create("Monad Cat", "THIRTEENCHARS", 1e27);
        vm.expectRevert("bad supply");
        factory.create("Monad Cat", "MCAT", 0);
        vm.expectRevert("bad supply");
        factory.create("Monad Cat", "MCAT", uint256(type(uint96).max) + 1);
        factory.create("Monad Cat", "MCAT", type(uint96).max);
    }

    /// Create → approve → open → bid → settle → seed → claim, with the engine's creator being the
    /// person who made the token (not the factory), and the token passing the fee-on-transfer check.
    function test_FactoryToken_FullLaunch() public {
        vm.startPrank(creator);
        LaunchToken t = LaunchToken(factory.create("Monad Cat", "MCAT", 1_000_000e18));
        t.approve(address(engine), type(uint256).max);
        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Degen);
        p.token = address(t);
        uint256 r = engine.openRound(p);
        vm.stopPrank();
        assertEq(engine.getRound(r).creator, creator);

        _commit(r, alice, 0.005 ether, 600e18);
        _commit(r, bob, 0.004 ether, 600e18);
        _toReveal(r);
        _reveal(r, alice, 0.005 ether, 600e18);
        _reveal(r, bob, 0.004 ether, 600e18);
        _toSettle(r);
        engine.settle(r, 100);
        engine.seedLP(r);
        _claim(r, alice);
        _claim(r, bob);
        assertEq(t.balanceOf(alice), 600e18);
        assertEq(t.balanceOf(bob), 400e18, "the rest of the supply at the clearing price");
    }
}
