#!/usr/bin/env bash
# Shared config for all NanoClaw scripts.
# Sources .env if present, then validates required variables.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[1]:-${BASH_SOURCE[0]}}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Source .env from project root if it exists
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  source "$PROJECT_ROOT/.env"
  set +a
fi

# Required: NAS connection
if [ -z "${NAS_HOST:-}" ]; then
  echo "Error: NAS_HOST not set. Add it to .env or export it."
  exit 1
fi

if [ -z "${NAS_PROJECT_DIR:-}" ]; then
  echo "Error: NAS_PROJECT_DIR not set. Add it to .env or export it."
  exit 1
fi

# Helper: SSH to NAS without consuming stdin
nas() { ssh -n "$NAS_HOST" "$@"; }
