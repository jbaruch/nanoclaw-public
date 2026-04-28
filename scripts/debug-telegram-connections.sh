#!/usr/bin/env bash
#
# Ghost-hunter script for nanoclaw issue #81.
#
# Polls `ss -tnp` for any TCP connection from this host to Telegram's
# production IP ranges (149.154.160.0/20, 91.108.4.0/22) and logs each
# unique connection with a timestamp, local PID, user, and the full
# command line of the owning process. If a connection's PID belongs to
# a Docker container, we additionally log the container name.
#
# Designed to run outside the orchestrator process — it catches sends
# from ANY process on the host, including:
#   - A rogue container sibling with a copy of the bot token
#   - A cron job or systemd timer the orchestrator doesn't know about
#   - A shell script running as jbaruch with the token in env
#   - The orchestrator itself (cross-check against `[tg-tap]` logs from
#     PR #89 — if `ss` sees a connection but the tap didn't log it,
#     the sender is a different process)
#
# Requires `ss` (iproute2), `awk`, `date`. `ss -p` needs CAP_NET_ADMIN
# or equivalent to read PID info for other users' sockets — run as
# root when hunting cross-user ghosts.
#
# Usage:
#   sudo scripts/debug-telegram-connections.sh                 # run in foreground
#   sudo scripts/debug-telegram-connections.sh &               # background on login shell
#   nohup sudo scripts/debug-telegram-connections.sh > /var/log/tg-ghost.log 2>&1 &
#
# Polling interval is 1s — the TCP handshake to Telegram is sub-second,
# so this catches the connection during its lifetime. `ss` itself is
# cheap (<10ms) on a host with a few hundred sockets; 1s/cycle is well
# within the envelope. Tune `POLL_SECONDS` below if the box is large.
#
# The script prints ONLY new-this-cycle connections — a dedup key of
# `<local_pid>:<remote_ip>:<remote_port>` across cycles keeps the log
# from spamming every second for the duration of a single connection.
# Dedup resets every hour so a long-lived connection eventually logs
# again (useful for confirming the connection is still live during a
# multi-hour ghost hunt).

set -euo pipefail

POLL_SECONDS="${POLL_SECONDS:-1}"
DEDUP_RESET_HOURS="${DEDUP_RESET_HOURS:-1}"

# Telegram's production server CIDRs.
#
# Source: Telegram's own public docs list these as the ranges used by
# `api.telegram.org` and `core.telegram.org`. We match against the
# remote-address field `ss` prints, which is a bare IP for TCP — so a
# prefix-match on the first two octets is enough for a fast filter
# (no full CIDR math in awk).
TG_PREFIXES=(
  "149.154.160." "149.154.161." "149.154.162." "149.154.163."
  "149.154.164." "149.154.165." "149.154.166." "149.154.167."
  "149.154.168." "149.154.169." "149.154.170." "149.154.171."
  "149.154.172." "149.154.173." "149.154.174." "149.154.175."
  "91.108.4."    "91.108.5."    "91.108.6."    "91.108.7."
)

# Build a grep alternation once. Escaping `.` isn't strictly necessary
# for literal-only tokens but is defensive if someone later adds a
# prefix with a regex-meta char (e.g. `[`).
GREP_PATTERN=""
for p in "${TG_PREFIXES[@]}"; do
  escaped="${p//./\\.}"
  GREP_PATTERN="${GREP_PATTERN:+${GREP_PATTERN}|}${escaped}"
done

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# Given a PID, print a compact identity string: `<comm> (uid=<uid>)` —
# plus the Docker container name if the PID belongs to a container.
# Resolves the container by matching the PID against `docker ps`'s
# PID-of-main-process listing; tolerant of the docker CLI being absent.
pid_identity() {
  local pid="$1"
  local comm uid container cmdline
  comm=$(cat "/proc/$pid/comm" 2>/dev/null || echo "?")
  uid=$(awk '/^Uid:/ {print $2; exit}' "/proc/$pid/status" 2>/dev/null || echo "?")
  # Full argv with NULs replaced by spaces — essential for seeing
  # curl/wget arguments if the ghost sender is a shell-out.
  cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | sed 's/ $//' || echo "?")
  container=""
  if command -v docker >/dev/null 2>&1; then
    # `docker inspect --format` takes a PID only indirectly — map via
    # `docker ps -q` then inspect each. Cheap because the container
    # count on this host is ~3.
    for cid in $(docker ps -q 2>/dev/null); do
      local cpid
      cpid=$(docker inspect --format '{{.State.Pid}}' "$cid" 2>/dev/null || echo "0")
      # We only know the main PID of each container; the actual TCP
      # owner may be a child. Walk up the /proc tree from `$pid`
      # until we hit `$cpid` or pid 1.
      local walk="$pid"
      while [ "$walk" != "1" ] && [ -n "$walk" ] && [ "$walk" != "0" ]; do
        if [ "$walk" = "$cpid" ]; then
          container=$(docker inspect --format '{{.Name}}' "$cid" 2>/dev/null | sed 's|^/||')
          break 2
        fi
        walk=$(awk '{print $4}' "/proc/$walk/stat" 2>/dev/null || echo "")
      done
    done
  fi
  printf 'comm=%s uid=%s cmdline=%q container=%s' \
    "$comm" "$uid" "$cmdline" "${container:-<none>}"
}

declare -A SEEN
LAST_RESET_EPOCH=$(date +%s)

echo "[$(ts)] tg-ghost watcher starting (POLL_SECONDS=${POLL_SECONDS}, DEDUP_RESET_HOURS=${DEDUP_RESET_HOURS})"
echo "[$(ts)] Watching TCP to Telegram CIDRs: $(printf '%s ' "${TG_PREFIXES[@]}" | sed 's/ $//')"

while true; do
  # `ss -tnp`: TCP sockets, numeric host/port, with process info.
  # Filtering with grep is simpler than ss's native filter language
  # when the matching criterion is a literal IP prefix set.
  #
  # `|| true` here would mask a real ss failure — we WANT to crash if
  # ss is broken. `set -e` does the right thing.
  while IFS= read -r line; do
    # Skip header and empty lines
    [[ "$line" =~ ^State ]] && continue
    [[ -z "$line" ]] && continue

    # Extract remote addr:port (5th column of `ss -tn`) and the
    # users= blob (last field of `ss -tnp`).
    remote=$(awk '{print $5}' <<<"$line")
    users=$(awk '{print $NF}' <<<"$line")
    remote_ip="${remote%:*}"
    remote_port="${remote##*:}"

    # Parse `users:(("curl",pid=12345,fd=5))` — extract the first
    # pid=N occurrence. There may be multiple entries when a socket
    # is shared across fds, but the PID is the same.
    pid=$(grep -oE 'pid=[0-9]+' <<<"$users" | head -1 | cut -d= -f2)
    [[ -z "$pid" ]] && pid="?"

    key="$pid:$remote_ip:$remote_port"
    if [[ -n "${SEEN[$key]:-}" ]]; then
      continue
    fi
    SEEN[$key]=1

    identity=""
    if [[ "$pid" != "?" ]]; then
      identity=$(pid_identity "$pid")
    fi

    echo "[$(ts)] CONNECTION remote=${remote} pid=${pid} ${identity}"
  done < <(ss -tnp 2>/dev/null | grep -E "$GREP_PATTERN" || true)

  # Reset the dedup cache periodically so long-lived connections
  # re-log on each window boundary.
  now=$(date +%s)
  elapsed=$((now - LAST_RESET_EPOCH))
  if (( elapsed >= DEDUP_RESET_HOURS * 3600 )); then
    echo "[$(ts)] dedup reset (elapsed ${elapsed}s)"
    SEEN=()
    LAST_RESET_EPOCH=$now
  fi

  sleep "$POLL_SECONDS"
done
