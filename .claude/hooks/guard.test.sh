#!/usr/bin/env bash
# Tests for the sudo policy in guard.sh / sudo-policy.py. Run: bash .claude/hooks/guard.test.sh
# "sudo" is built from pieces so this file passes through the hook itself.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
R="$(git -C "$here" rev-parse --show-toplevel)"
W="${R}-worktrees/OME-110"
S="su""do"
export OMEGA_BOX_HOSTS="203.0.113.7,box.example.test"
fail=0
t() { # want cwd command
  local out r=allow
  out=$(jq -n --arg c "$3" --arg d "$2" '{tool_name:"Bash",cwd:$d,tool_input:{command:$c}}' | bash "$here/guard.sh")
  grep -q '"deny"' <<<"$out" && r=deny
  if [[ "$r" == "$1" ]]; then echo "ok    $1  ${3:0:90}"; else echo "FAIL  want $1, got $r: $3"; fail=1; fi
}

echo "-- local: allowed"
t allow "$R" "$S chown -R wang:wang $R/apps/web/dist"
t allow "$R" "$S chmod -R u+rw $R/.claude/worktrees/x"
t allow "$R" "$S rm -r dist"
t allow "$W" "$S chown wang $W/file"
t allow "$R" "echo 'run $S later' > /dev/null"
t allow "$R" "git log --oneline -1"
echo "-- local: denied"
t deny "$R" "$S rm -r /etc/foo"
t deny "$R" "$S chown -R wang /home/wang"
t deny "$R" "$S chown wang $R/../other"
t deny "$R" "$S bash -c 'rm $R/x'"
t deny "$R" "$S -i"
t deny "$R" "$S systemctl restart caddy"
t deny "$R" "$S chown wang \$(echo /etc)"
t deny "$R" "bash -c \"$S rm /etc/x\""
t deny "$R" "env $S rm /etc/x"
t deny "$R" "echo x | xargs $S rm"
t deny /home/wang "$S rm foo"
t deny "$R" "$S chmod 777 /usr/bin/x"
echo "-- ssh: only the box"
t allow "$R" "ssh -i k admin@203.0.113.7 \"$S bash omega-deploy/provision.sh base; echo EXIT=\$?\""
t allow "$R" "ssh -o IdentitiesOnly=yes admin@box.example.test \"$S systemctl restart caddy && $S nft list ruleset\""
t allow "$R" "A='-i k'; ssh \$A admin@203.0.113.7 \"$S systemctl start omega-share-backup.service\""
t allow "$R" "rsync -a -e 'ssh -i k' deploy/ admin@203.0.113.7:omega-deploy/"
t allow "$R" "ssh admin@198.51.100.9 uptime"
t deny "$R" "ssh admin@198.51.100.9 \"$S reboot\""
t deny "$R" "ssh admin@evil.example.test \"$S bash x\""
t deny "$R" "ssh admin@203.0.113.7 \"uptime\"; $S rm /etc/x"
t deny "$R" "ssh -J jump.example.test admin@203.0.113.7 \"$S ls\""
t deny "$R" "ssh -o ProxyCommand='nc evil 22' admin@203.0.113.7 \"$S ls\""
t deny "$R" "ssh \"$S ls\""
echo "-- other guards unchanged"
t deny "$R" "git push --for""ce origin main"
t deny "$R" "cat ~/.s""sh/id_x"
exit $fail
