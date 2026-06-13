#!/usr/bin/env bash
# Quarantine human-marked DELETE_ files into a tracked TRASH dir via git mv.
# Reversible. Ships nothing. Does NOT commit.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

QUARANTINE="TRASH/posture-20260613/delete-marked"
LIST="${1:-/tmp/delete-list.txt}"

moved=0
skipped=0
while IFS= read -r path; do
  [ -z "$path" ] && continue
  dest="$QUARANTINE/$path"
  if [ ! -e "$path" ]; then
    echo "SKIP (missing): $path" >&2
    skipped=$((skipped+1))
    continue
  fi
  mkdir -p "$(dirname "$dest")"
  # Retry around transient index.lock contention from background daemons.
  tries=0
  until git mv "$path" "$dest" 2>/tmp/gitmv.err; do
    if grep -q 'index.lock' /tmp/gitmv.err; then
      tries=$((tries+1))
      if [ "$tries" -gt 50 ]; then
        echo "FAIL (lock) after $tries tries: $path" >&2
        cat /tmp/gitmv.err >&2
        exit 1
      fi
      sleep 0.3
      continue
    fi
    echo "FAIL: $path" >&2; cat /tmp/gitmv.err >&2; exit 1
  done
  moved=$((moved+1))
done < "$LIST"

echo "MOVED=$moved SKIPPED=$skipped"
