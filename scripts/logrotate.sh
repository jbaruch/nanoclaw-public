#!/bin/bash
# Simple log rotation for NanoClaw
# Keeps last 5 rotated copies, compresses old ones
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS_DIR="${1:-$(cd "$SCRIPT_DIR/.." && pwd)/logs}"
MAX_SIZE_MB=10
KEEP=5

for logfile in "$LOGS_DIR"/*.log; do
  [[ -f "$logfile" ]] || continue
  size=$(stat -f '%z' "$logfile" 2>/dev/null || stat -c '%s' "$logfile" 2>/dev/null || echo 0)
  size_mb=$((size / 1048576))
  if (( size_mb >= MAX_SIZE_MB )); then
    # Rotate: .log -> .log.1 -> .log.2 -> ...
    for i in $(seq $((KEEP - 1)) -1 1); do
      [[ -f "${logfile}.$i.gz" ]] && mv "${logfile}.$i.gz" "${logfile}.$((i + 1)).gz"
      [[ -f "${logfile}.$i" ]] && mv "${logfile}.$i" "${logfile}.$((i + 1))"
    done
    cp "$logfile" "${logfile}.1"
    : > "$logfile"  # truncate in place (process keeps writing to same fd)
    gzip "${logfile}.1" 2>/dev/null || true
    # Delete oldest
    rm -f "${logfile}.$((KEEP + 1)).gz" "${logfile}.$((KEEP + 1))"
  fi
done
