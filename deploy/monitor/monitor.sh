#!/usr/bin/env bash
# Off-box monitor (runbook: docs/ops/hosting.md § Monitoring). Runs on the operator's machine from a user timer
# every 5 min, next to deploy/backup/pull.sh. Needs no root. Pushes to ntfy only when a state changes:
#
#   health   GET $PUBLIC_ORIGIN/healthz (10 s). 2 failures in a row: "omega-share is down"; back: "omega-share recovered".
#   tls      the origin's certificate: < 14 days left pushes once, again every 3 more days until it is renewed.
#   reports  at most hourly, ssh admin@$SERVER_IP → admin CLI `reports list`, counted on the box. A rise pushes
#            "N new abuse reports". Only the number leaves the box: no content, titles, ids or addresses.
#
#   PUBLIC_ORIGIN=https://… SERVER_IP=… deploy/monitor/monitor.sh
#
# The ntfy topic is read from ~/.config/omega-share/ntfy-topic and handed to curl on stdin, never in argv or output.
# State: $XDG_STATE_HOME/omega-share/monitor.state. Overrides: OMEGA_MONITOR_URL (health URL),
# OMEGA_MONITOR_CHECKS ("health tls reports"), OMEGA_MONITOR_PREFIX (e.g. "[drill]"), OMEGA_MONITOR_SSH_KEY,
# OMEGA_NTFY_SERVER (https://ntfy.sh), OMEGA_MONITOR_REPORTS_CMD and OMEGA_MONITOR_NOW (tests).
set -euo pipefail

origin=${PUBLIC_ORIGIN:-}
health_url=${OMEGA_MONITOR_URL:-${origin:+$origin/healthz}}
checks=" ${OMEGA_MONITOR_CHECKS:-health tls reports} "
prefix=${OMEGA_MONITOR_PREFIX:+$OMEGA_MONITOR_PREFIX }
ntfy=${OMEGA_NTFY_SERVER:-https://ntfy.sh}
ssh_key=${OMEGA_MONITOR_SSH_KEY:-$HOME/.config/omega-share/admin-key}
reports_cmd=${OMEGA_MONITOR_REPORTS_CMD:-cd /opt/omega-share/current && sudo -n -u omega-share env DB_PATH=/var/lib/omega-share/omega.db /usr/local/bin/bun apps/server/src/cli.ts reports list}
now=${OMEGA_MONITOR_NOW:-$(date +%s)}
topic_file=$HOME/.config/omega-share/ntfy-topic
state_dir=${XDG_STATE_HOME:-$HOME/.local/state}/omega-share
state_file=$state_dir/monitor.state

die() { echo "monitor.sh: $1" >&2; exit 2; }
[[ -r $topic_file ]] || die "no ntfy topic: put it in ~/.config/omega-share/ntfy-topic (mode 0600)"
topic=$(tr -d '[:space:]' < "$topic_file")
[[ $topic =~ ^[A-Za-z0-9_-]{1,64}$ ]] || die "~/.config/omega-share/ntfy-topic is not a topic name ([A-Za-z0-9_-], at most 64)"
[[ $now =~ ^[0-9]+$ ]] || die "OMEGA_MONITOR_NOW must be epoch seconds"
[[ $checks != *" health "* || -n $health_url ]] || die "set PUBLIC_ORIGIN (or OMEGA_MONITOR_URL)"

umask 077
mkdir -p -- "$state_dir"
exec 9> "$state_dir/monitor.lock"
flock -n 9 || exit 0 # the previous run is still going

# State: known keys only, each value checked; anything else in the file is ignored.
health=up fails=0 tls_alert="" reports_at=0 reports=""
if [[ -r $state_file ]]; then
  while IFS='=' read -r key value; do
    case $key in
      health) [[ $value == up || $value == down ]] && health=$value ;;
      fails | reports_at) [[ $value =~ ^[0-9]+$ ]] && printf -v "$key" '%s' "$value" ;;
      tls_alert | reports) [[ $value =~ ^-?[0-9]*$ ]] && printf -v "$key" '%s' "$value" ;;
    esac
  done < "$state_file"
fi
save() {
  printf 'health=%s\nfails=%s\ntls_alert=%s\nreports_at=%s\nreports=%s\n' \
    "$health" "$fails" "$tls_alert" "$reports_at" "$reports" > "$state_file.tmp"
  mv -f -- "$state_file.tmp" "$state_file"
}

status=0
# One push. The URL (with the topic) goes in a curl config on stdin so it never shows in argv, ps or logs.
push() {
  if printf 'url = "%s/%s"\n' "$ntfy" "$topic" | curl -fsS --max-time 10 -o /dev/null -K - \
    -H "Title: omega-share" -H "Tags: rotating_light" --data-raw "$prefix$1"; then
    echo "pushed: $prefix$1"
    return 0
  fi
  echo "monitor.sh: push failed, retrying next run: $prefix$1" >&2
  status=1
  return 1
}

if [[ $checks == *" health "* ]]; then
  if curl -fsS --max-time 10 -o /dev/null -- "$health_url"; then
    fails=0
    if [[ $health == down ]] && push "omega-share recovered"; then health=up; fi
  else
    fails=$((fails + 1))
    echo "health check failed ($fails in a row)" >&2
    if [[ $health == up ]] && ((fails >= 2)) && push "omega-share is down"; then health=down; fi
  fi
  save
fi

if [[ $checks == *" tls "* && $origin =~ ^https://([A-Za-z0-9.-]+)(:([0-9]+))?(/.*)?$ ]]; then
  host=${BASH_REMATCH[1]} port=${BASH_REMATCH[3]:-443}
  end=$(openssl s_client -connect "$host:$port" -servername "$host" < /dev/null 2> /dev/null |
    openssl x509 -noout -enddate 2> /dev/null || true)
  end=${end#notAfter=}
  if [[ -n $end ]] && expires=$(date -d "$end" +%s 2> /dev/null); then
    days=$(((expires - now) / 86400))
    if ((days >= 14)); then
      tls_alert=""
    elif [[ -z $tls_alert ]] || ((days <= tls_alert - 3)); then
      if push "TLS certificate expires in $days days"; then tls_alert=$days; fi
    fi
    save
  else
    echo "could not read the TLS certificate of $host:$port" >&2
  fi
fi

if [[ $checks == *" reports "* ]] && ((now - reports_at >= 3600)); then
  if [[ -z ${SERVER_IP:-} ]]; then
    echo "SERVER_IP unset: skipping the report count" >&2
  else
    reports_at=$now
    # Counted on the box: report lines are the indented ones (user text is escaped, so it never starts a line).
    remote="out=\$($reports_cmd) && printf '%s\n' \"\$out\" | awk '/^  /{n++} END{print n+0}'"
    if count=$(ssh -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 -i "$ssh_key" \
      "admin@$SERVER_IP" "$remote" 2> /dev/null) && [[ $count =~ ^[0-9]+$ ]]; then
      rose=$((count - ${reports:-0}))
      if ((rose > 0)); then
        if push "$rose new abuse report$( ((rose == 1)) || echo s)"; then reports=$count; else reports_at=0; fi
      else
        reports=$count
      fi
    else
      echo "could not read the report count from the box" >&2
    fi
    save
  fi
fi

exit $status
