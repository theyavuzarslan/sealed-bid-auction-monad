// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "../src/vendor/openzeppelin/token/ERC20/IERC20.sol";
import {DemoVault} from "../src/exit/DemoVault.sol";
import {ExitAuction} from "../src/exit/ExitAuction.sol";
import {AuctionEngine} from "../src/AuctionEngine.sol";
import {EngineBase} from "./AuctionEngine.t.sol";
import {MockWMON} from "./mocks/MockWMON.sol";

/// @notice Window bounds of the exit auction (PROPERTIES.md W2). The symbolic engine cannot execute a
///         constructor with symbolic arguments, so W2 is checked here: exact boundaries, and a fuzzed
///         "accepted if and only if" over every uint64 pair.
contract ExitWindowBoundsTest is Test {
    DemoVault vault;

    function setUp() public {
        vm.warp(1_800_000_000);
        MockWMON wmon = new MockWMON();
        vault = new DemoVault(IERC20(address(wmon)), address(0x5747));
    }

    function _config(uint64 commitDuration, uint64 revealDuration) internal pure returns (ExitAuction.Config memory) {
        return ExitAuction.Config({
            commitDuration: commitDuration,
            revealDuration: revealDuration,
            depositAmount: 1 ether,
            tickBps: 50,
            minExitShares: 1e18,
            maxExitSharesPerRound: type(uint128).max,
            roundGapBlocks: 10,
            allowlistRoot: bytes32(0)
        });
    }

    function _deploys(uint64 c, uint64 r) internal returns (bool ok) {
        try new ExitAuction(vault, _config(c, r)) {
            ok = true;
        } catch {
            ok = false;
        }
    }

    function _inRange(uint64 d) internal pure returns (bool) {
        return d >= 5 minutes && d <= 30 days;
    }

    function test_W2_ExactBoundaries() public {
        uint64[4] memory ds = [uint64(5 minutes - 1), 5 minutes, 30 days, 30 days + 1];
        for (uint256 i; i < 4; ++i) {
            for (uint256 j; j < 4; ++j) {
                assertEq(_deploys(ds[i], ds[j]), _inRange(ds[i]) && _inRange(ds[j]), "window bounds");
            }
        }
    }

    function testFuzz_W2_AcceptedIffBothWindowsInRange(uint64 c, uint64 r) public {
        assertEq(_deploys(c, r), _inRange(c) && _inRange(r));
    }

    /// Same, with both durations drawn from [0, 31 days] so most runs land near or inside the range.
    function testFuzz_W2_AcceptedIffBothWindowsInRange_NearRange(uint64 c, uint64 r) public {
        c = uint64(bound(c, 0, 31 days));
        r = uint64(bound(r, 0, 31 days));
        assertEq(_deploys(c, r), _inRange(c) && _inRange(r));
    }
}

/// @notice Boundary tests added after the mutation run (reports/mutation-summary.md): each one kills a
///         mutant that the earlier suite let survive.
contract EngineWindowBoundsTest is EngineBase {
    /// A backup note of exactly MAX_NOTE_LENGTH bytes is accepted; one byte more is refused.
    function test_Commit_NoteAtMaxLengthAccepted() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        uint256 max = engine.MAX_NOTE_LENGTH();
        vm.prank(alice);
        engine.commit{value: DEPOSIT}(r, keccak256("a"), new bytes32[](0), new bytes(max));
        vm.prank(bob);
        vm.expectRevert("note too long");
        engine.commit{value: DEPOSIT}(r, keccak256("b"), new bytes32[](0), new bytes(max + 1));
    }

    /// The reveal window is [commitEnd, revealEnd): a reveal in its last second succeeds, a reveal at
    /// revealEnd (the second settlement and burning open) is refused.
    function test_Reveal_WindowEndIsExclusive() public {
        uint256 r = _open(_params(AuctionEngine.Preset.Degen));
        _commit(r, alice, 0.005 ether, 100e18);
        _commit(r, bob, 0.005 ether, 100e18);
        uint256 revealEnd = engine.getRound(r).revealEnd;
        vm.warp(revealEnd - 1);
        _reveal(r, alice, 0.005 ether, 100e18);
        vm.warp(revealEnd);
        vm.prank(bob);
        vm.expectRevert("reveal window closed");
        engine.reveal(r, 0.005 ether, 100e18, bytes32(uint256(uint160(bob))));
    }

    /// `openRound` window minimums at their exact boundary (PROPERTIES.md W1; also proved symbolically).
    function test_W1_ExactMinimumWindowsAccepted() public {
        AuctionEngine.OpenParams memory p = _params(AuctionEngine.Preset.Degen);
        p.commitEnd = uint64(block.timestamp + 5 minutes);
        p.revealEnd = p.commitEnd + 5 minutes;
        _open(p); // exactly the minimum: accepted
        p.commitEnd = uint64(block.timestamp + 5 minutes - 1);
        vm.prank(creator);
        vm.expectRevert("commit window too short");
        engine.openRound(p);
        p.commitEnd = uint64(block.timestamp + 5 minutes);
        p.revealEnd = p.commitEnd + 5 minutes - 1;
        vm.prank(creator);
        vm.expectRevert("reveal window too short");
        engine.openRound(p);
    }
}
