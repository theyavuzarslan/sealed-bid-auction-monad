# RUNBOOK — zero to submission

Operational sequence for running the agent crew. Not part of the 13-document set.

Status: **superseded 23 Sep** — the herdr multi-agent setup was dropped; everything is now built directly on `master`. Kept for the record. See `CLAUDE.md` for current commands.

## Step 0 — two decisions only you can make

Everything else is unblocked. These two are not, and agents cannot guess them:

1. **Which DEX on Monad, and which LP-lock contract?** Blocks the LP seeder, which is P0 for the demo.
2. **Demo baseline: live nad.fun, or a local bonding-curve fork?** Recommendation: local fork. A live dependency during a recording is risk with no upside.

Write the answers into `12-open-questions.md` (Q4, Q10) or tell Claude to. The `demo` and a later `lp` agent stay blocked until then; the other five can start now.

## Step 1 — prerequisites

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
```

Optional, to unblock the Kimi pane: top up the Moonshot account (currently suspended for balance).

## Step 2 — scaffold

```bash
cd "/Users/0xatakan/Claude Code/Sealed Bid Auction on Monad" && bash setup.sh
```

Creates the git repo, a Foundry project in `contracts/`, the EasyAuction clone in `vendor/`, six task briefs in `tasks/`, and six git worktrees under `/Users/0xatakan/Claude Code/sba-agents/`.

Worktrees matter: six agents editing one `contracts/src/` will overwrite each other. Each gets its own checkout and its own branch.

## Step 3 — start the shared opencode server

```bash
opencode serve
```

Leave it running. One process owns the SQLite database, so the concurrency crash cannot happen. Note the port it prints (usually 4096).

## Step 4 — start herdr

```bash
herdr
```

Split into six panes. In each, `cd` to that agent's worktree, then launch its agent.

## Step 5 — the six panes

| Pane | cd to | Launch | Brief |
| --- | --- | --- | --- |
| 1 | `sba-agents/core` | `codex` | `tasks/core.md` |
| 2 | `sba-agents/fork` | `muse` | `tasks/fork.md` |
| 3 | `sba-agents/settle` | `opencode attach http://localhost:4096 -m openai/gpt-5.6-sol` | `tasks/settle.md` |
| 4 | `sba-agents/ui` | `opencode attach http://localhost:4096 -m nvidia/z-ai/glm-5.3` | `tasks/ui.md` |
| 5 | `sba-agents/scripts` | `opencode attach http://localhost:4096 -m nvidia/z-ai/glm-5.3-flash` | `tasks/scripts.md` |
| 6 | `sba-agents/demo` | `grok` | `tasks/demo.md` |

Prompt every agent with the same sentence:

```
Read AGENTS.md, README.md, then tasks/<name>.md. Do that task. Stay inside the paths it lists.
```

If cline works when you test it (its Kimi routing bills through Cline, not the suspended Moonshot key), give it pane 5 and move the `scripts` work to it, freeing glm-5.3-flash for fixtures.

## Step 6 — merge

Agents work on `agent/*` branches. Merge as each finishes:

```bash
cd "/Users/0xatakan/Claude Code/Sealed Bid Auction on Monad" && git merge agent/fork agent/core
```

Merge `core` and `fork` first — everything else depends on them compiling together.

```bash
cd contracts && forge build && forge test
```

## Step 7 — scan

```bash
agentguard scan
```

Installed at `~/.hermes/plugins/agentguard`, also in cline. It covers reentrancy, unlimited approval, signature replay, hidden transfers and access control — five of the eight bugs. Fix what it finds, then put the clean report in the README. Run it *before* the Claude audit so you are not paying Claude tokens to find what a free tool already catches.

## Step 8 — audit

Send Claude only the money path — not the frontend, not the demo:

```bash
wc -l contracts/src/*.sol && cat contracts/src/SealingLayer.sol contracts/src/DepositLedger.sol
```

Then `ClearingCore.sol`, separately, against bug #4. Roughly 5% of your remaining tokens, guarding 80% of the risk.

## Step 9 — submit

A working product with a public project profile: demo, short write-up, code link. Deadline 13 Oct. See `11-roadmap.md` Block E.

The write-up must contain the threat model from `03-architecture.md` — no encrypted mempool, the leader-set adversary, the four remaining leaks — and the claims-to-avoid table. A Category Labs judge will know the details, and stating them first is worth more than a clean claim.

Related files: [README.md](README.md) · [AGENTS.md](AGENTS.md) · [11-roadmap.md](11-roadmap.md) · [12-open-questions.md](12-open-questions.md)
