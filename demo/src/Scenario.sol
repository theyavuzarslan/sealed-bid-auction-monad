// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AuctionEngine} from "engine/AuctionEngine.sol";

/// @title Scenario
/// @notice The one cast both panes share: the same token, the same supply, the same twelve buyers
///         and one sniper bot that acts first. Used by script/RunScenario.s.sol (anvil, real
///         transactions) and test/HeadToHead.t.sol (in-memory, same numbers).
/// @dev Clip parameters, not protocol defaults. Prices are MON wei per 1e18 token units — the
///      engine's unit — so 0.22 ether means 0.22 MON per token.
///      Each buyer has a budget (MON) and a maximum price per token. On the curve a buyer spends the
///      budget if the spot price is still below their maximum. On the auction the same buyer bids
///      their maximum price for `budget / maxPrice` tokens, so the most they can spend is the budget.
library Scenario {
    // ─── The token and its supply ───────────────────────────────────────
    string internal constant TOKEN_SYMBOL = "DEMO";
    uint256 internal constant SUPPLY = 1_000e18; // tokens for sale, both panes

    // ─── Bonding curve (left pane) ──────────────────────────────────────
    uint256 internal constant VIRTUAL_TOKEN = 2_000e18; // opens at 200 / 2000 = 0.10 MON per token
    uint256 internal constant VIRTUAL_MON = 200 ether;
    uint256 internal constant MIN_BUY = 0.01 ether;

    // ─── Auction, Degen preset (right pane) ─────────────────────────────
    uint96 internal constant TICK = 0.001 ether;
    uint96 internal constant RESERVE_PRICE = 0.1 ether; // the curve's opening price
    uint96 internal constant DEPOSIT = 150 ether; // uniform; must exceed the largest bid's max spend
    uint96 internal constant MIN_BID = 1 ether;
    uint16 internal constant LP_SHARE_BPS = 2_000;
    uint64 internal constant COMMIT_WINDOW = 10 minutes;
    uint64 internal constant REVEAL_WINDOW = 10 minutes;

    // ─── The sniper bot ─────────────────────────────────────────────────
    /// Curve: three buys, fired the moment trading opens, before any human arrives.
    function botTranches() internal pure returns (uint256[] memory t) {
        t = new uint256[](3);
        t[0] = 30 ether;
        t[1] = 25 ether;
        t[2] = 20 ether;
    }

    /// Auction: the bot bids aggressively — the joint-highest price in the book, for a quarter of supply.
    uint96 internal constant BOT_PRICE = 0.5 ether;
    uint96 internal constant BOT_AMOUNT = 250e18;
    bytes32 internal constant BOT_SALT = keccak256("sniper-bot-salt");

    // ─── The crowd ──────────────────────────────────────────────────────
    uint256 internal constant CROWD = 12;

    /// @return name   Display name.
    /// @return maxPrice Highest price per token they will pay (on the tick grid).
    /// @return budget MON they bring.
    function buyer(uint256 i) internal pure returns (string memory name, uint96 maxPrice, uint256 budget) {
        if (i == 0) return ("ana", 0.4 ether, 30 ether);
        if (i == 1) return ("ben", 0.22 ether, 18 ether);
        if (i == 2) return ("chloe", 0.35 ether, 36 ether);
        if (i == 3) return ("dev", 0.2 ether, 14 ether);
        if (i == 4) return ("emi", 0.5 ether, 32 ether);
        if (i == 5) return ("finn", 0.26 ether, 20 ether);
        if (i == 6) return ("gia", 0.3 ether, 24 ether);
        if (i == 7) return ("hugo", 0.24 ether, 16 ether);
        if (i == 8) return ("ines", 0.45 ether, 28 ether);
        if (i == 9) return ("jay", 0.28 ether, 22 ether);
        if (i == 10) return ("kai", 0.32 ether, 26 ether);
        if (i == 11) return ("lea", 0.38 ether, 20 ether);
        revert("no such buyer");
    }

    /// Tokens a buyer bids for: as many as the budget covers at their maximum price (rounded down).
    function bidAmount(uint96 maxPrice, uint256 budget) internal pure returns (uint96) {
        return uint96(budget * 1e18 / maxPrice);
    }

    function crowdSalt(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode("crowd-salt", i));
    }

    /// Deterministic throwaway keys for the crowd. Funded by the deployer on anvil.
    function crowdKey(uint256 i) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode("sealed-bid-demo-crowd", i))) % 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140 + 1;
    }

    /// The sealing layer's preimage: all four fields (AGENTS.md bugs #1, #2).
    function commitHash(uint96 price, uint96 amount, bytes32 salt, address bidder) internal pure returns (bytes32) {
        return keccak256(abi.encode(price, amount, salt, bidder));
    }

    function openParams(address token, address adapter, uint256 nowTs)
        internal
        pure
        returns (AuctionEngine.OpenParams memory p)
    {
        p.preset = AuctionEngine.Preset.Degen;
        p.token = token;
        p.sellAmount = uint128(SUPPLY);
        p.depositAmount = DEPOSIT;
        p.minBidSize = MIN_BID;
        p.tickSize = TICK;
        p.reservePrice = RESERVE_PRICE;
        p.commitEnd = uint64(nowTs) + COMMIT_WINDOW;
        p.revealEnd = uint64(nowTs) + COMMIT_WINDOW + REVEAL_WINDOW;
        p.lpShareBps = LP_SHARE_BPS;
        p.dexSplits = new AuctionEngine.DexSplit[](1);
        p.dexSplits[0] = AuctionEngine.DexSplit({adapter: adapter, bps: 10_000, fee: 3000});
        p.lockFeeTier = "DEFAULT";
    }
}
