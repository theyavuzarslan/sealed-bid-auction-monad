#!/usr/bin/env bash
# One-shot launcher: scaffold -> opencode server -> 6 herdr panes -> 6 agents -> task prompts.
# Idempotent: safe to re-run; existing panes/agents are reused, not duplicated.
set -euo pipefail

ROOT="/Users/0xatakan/Claude Code/Sealed Bid Auction on Monad"
WT="/Users/0xatakan/Claude Code/sba-agents"
PORT=4096

export PATH="$HOME/.foundry/bin:$PATH"
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false

echo "==> 1/5 scaffold (idempotent)"
(cd "$ROOT" && bash setup.sh)

echo "==> 2/5 opencode serve on :$PORT"
if ! curl -sf -o /dev/null "http://localhost:$PORT"; then
  (nohup opencode serve > /tmp/opencode-serve.log 2>&1 &)
  for _ in $(seq 1 30); do curl -sf -o /dev/null "http://localhost:$PORT" && break; sleep 1; done
fi
curl -sf -o /dev/null "http://localhost:$PORT" || { echo "FATAL: opencode serve not reachable on :$PORT — see /tmp/opencode-serve.log"; exit 1; }
echo "    up"

echo "==> 3/5 panes"
pane_for() { herdr pane list | jq -r --arg c "$1" '.result.panes[] | select(.cwd==$c) | .pane_id' | head -1; }
split()    { herdr pane split --pane "$1" --direction "$2" --cwd "$3" | jq -r '.result.pane.pane_id'; }

CORE=$(pane_for "$WT/core");      [ -n "$CORE" ]    || CORE="w1:p1"
FORK=$(pane_for "$WT/fork");      [ -n "$FORK" ]    || FORK=$(split "$CORE" right "$WT/fork")
SETTLE=$(pane_for "$WT/settle");  [ -n "$SETTLE" ]  || SETTLE=$(split "$FORK" down "$WT/settle")
UI=$(pane_for "$WT/ui");          [ -n "$UI" ]      || UI=$(split "$SETTLE" down "$WT/ui")
SCRIPTS=$(pane_for "$WT/scripts"); [ -n "$SCRIPTS" ] || SCRIPTS=$(split "$CORE" down "$WT/scripts")
DEMO=$(pane_for "$WT/demo");      [ -n "$DEMO" ]    || DEMO=$(split "$SCRIPTS" down "$WT/demo")

herdr pane rename "$FORK" fork >/dev/null 2>&1 || true
herdr pane rename "$SETTLE" settle >/dev/null 2>&1 || true
herdr pane rename "$UI" ui >/dev/null 2>&1 || true
herdr pane rename "$SCRIPTS" scripts >/dev/null 2>&1 || true
herdr pane rename "$DEMO" demo >/dev/null 2>&1 || true
echo "    core=$CORE fork=$FORK settle=$SETTLE ui=$UI scripts=$SCRIPTS demo=$DEMO"

echo "==> 4/5 agents"
running() { herdr agent get "$1" >/dev/null 2>&1; }
running "$CORE"     || herdr agent start core    --kind codex    --pane "$CORE"    --timeout 120000
running "$FORK"     || herdr agent start fork    --kind muse     --pane "$FORK"    --timeout 120000
running "$SETTLE"   || herdr agent start settle  --kind opencode --pane "$SETTLE"  --timeout 120000 -- attach "http://localhost:$PORT" -m openai/gpt-5.6-sol
running "$UI"       || herdr agent start ui      --kind opencode --pane "$UI"      --timeout 120000 -- attach "http://localhost:$PORT" -m nvidia/z-ai/glm-5.3
running "$SCRIPTS"  || herdr agent start scripts --kind opencode --pane "$SCRIPTS" --timeout 120000 -- attach "http://localhost:$PORT" -m nvidia/z-ai/glm-5.3-flash
running "$DEMO"     || herdr agent start demo    --kind grok     --pane "$DEMO"    --timeout 120000

echo "==> 5/5 task prompts"
prompt() { herdr agent prompt "$1" "Read AGENTS.md, README.md, then tasks/$2.md. Do that task. Stay inside the paths it lists."; }
prompt "$CORE" core
prompt "$FORK" fork
prompt "$SETTLE" settle
prompt "$UI" ui
prompt "$SCRIPTS" scripts
prompt "$DEMO" demo

echo
echo "All six agents are working. Watch them with: herdr"
herdr agent list | jq -r '.result.agents[] | "\(.agent_status)\t\(.terminal_title)\t\(.cwd)"'
