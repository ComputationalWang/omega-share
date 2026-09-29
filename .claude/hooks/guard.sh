#!/usr/bin/env bash
# PreToolUse guard for unattended (skip-permissions) agent runs.
# Blocks: sudo, force pushes, rm -rf outside the repo, reading credentials.
set -euo pipefail
input=$(cat)
tool=$(jq -r '.tool_name // ""' <<<"$input")
repo=$(git -C "$(jq -r '.cwd // "."' <<<"$input")" rev-parse --show-toplevel 2>/dev/null || pwd)
# Main checkout root; Paperclip worktrees live in "<root>-worktrees/".
allowed_root=$(dirname "$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || echo "$repo/.git")")

deny() { jq -n --arg r "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'; exit 0; }
secret_path='(\.ssh/|\.config/gh/|\.gnupg/|\.aws/|\.netrc|\.git-credentials|\.paperclip/instances/[^/]+/secrets)'

case "$tool" in
  Bash)
    cmd=$(jq -r '.tool_input.command // ""' <<<"$input")
    grep -Eq '(^|[;&|[:space:]])sudo([[:space:]]|$)' <<<"$cmd" && deny "sudo is not allowed for company agents."
    grep -Eq 'git[[:space:]]+push.*(--force|[[:space:]]-f([[:space:]]|$)|--force-with-lease|[[:space:]]\+[^[:space:]]+)' <<<"$cmd" && deny "Force pushes are not allowed."
    grep -Eq "$secret_path" <<<"$cmd" && deny "Credential directories are off-limits."
    # rm with recursive+force flags: every absolute/home target must live under the repo root.
    if grep -Eq '(^|[;&|[:space:]])rm[[:space:]]+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|-r[[:space:]]+-f|-f[[:space:]]+-r|--recursive)' <<<"$cmd"; then
      for t in $(grep -Eo '(~|\$HOME|/)[^[:space:];&|]*' <<<"$cmd"); do
        t=${t/#\~/$HOME}; t=${t/#\$HOME/$HOME}
        case "$t" in "$allowed_root"/*|"$allowed_root"-worktrees/*|/tmp/*) ;; *) deny "rm -rf outside the project ($t) is not allowed." ;; esac
      done
      grep -Eq '(^|[[:space:]])\.\.(/|[[:space:]]|$)' <<<"$cmd" && deny "rm -rf with parent-directory paths is not allowed."
    fi
    ;;
  Read|Edit|Write|Grep|Glob)
    p=$(jq -r '.tool_input.file_path // .tool_input.path // ""' <<<"$input")
    grep -Eq "$secret_path" <<<"$p" && deny "Credential directories are off-limits."
    ;;
esac
exit 0
