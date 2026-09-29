#!/usr/bin/env bash
# Enforces the subagent pool: max 4 live subagents per main agent session,
# max 20 across the company (5 main agents x 4). State lives in a shared dir
# so every worktree/session sees the same pool.
set -euo pipefail
PER_AGENT_MAX=${OMEGA_SUBAGENTS_PER_AGENT:-4}
GLOBAL_MAX=${OMEGA_SUBAGENTS_GLOBAL:-20}
STALE_MIN=${OMEGA_SUBAGENT_STALE_MIN:-180}
POOL=${OMEGA_POOL_DIR:-${XDG_RUNTIME_DIR:-/tmp}/omega-share-pool}
mkdir -p "$POOL"
input=$(cat)
[[ -n "${OMEGA_POOL_LOG:-}" ]] && jq -c "{e:.hook_event_name,s:.session_id,a:.agent_id,t:.tool_name}" <<<"$input" >>"$OMEGA_POOL_LOG"
event=$(jq -r '.hook_event_name // ""' <<<"$input")
session=$(jq -r '.session_id // "unknown"' <<<"$input")
agent=$(jq -r '.agent_id // ""' <<<"$input")

exec 9>"$POOL/.lock"
flock -w 10 9
find "$POOL" -maxdepth 1 -type f -name '*.slot' -mmin +"$STALE_MIN" -delete

case "$event" in
  PreToolUse)
    mine=$(find "$POOL" -maxdepth 1 -name "$session--*.slot" | wc -l)
    total=$(find "$POOL" -maxdepth 1 -name '*.slot' | wc -l)
    if (( mine >= PER_AGENT_MAX )); then
      reason="Subagent pool: you already run $mine/$PER_AGENT_MAX subagents. Wait for one to finish or do this step yourself."
    elif (( total >= GLOBAL_MAX )); then
      reason="Subagent pool: company-wide pool is full ($total/$GLOBAL_MAX). Retry later or do this step yourself."
    else
      exit 0
    fi
    jq -n --arg r "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
    ;;
  SubagentStart)
    [[ -n "$agent" ]] && touch "$POOL/$session--$agent.slot"
    ;;
  SubagentStop)
    [[ -n "$agent" ]] && rm -f "$POOL/$session--$agent.slot"
    ;;
esac
exit 0
