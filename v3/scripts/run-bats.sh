#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v bats >/dev/null 2>&1; then
  cat >&2 <<'EOF'
bats-core is required for executable hook contract tests.
Install it locally (for example: brew install bats-core) and re-run:
  pnpm test:bats
EOF
  exit 127
fi

exec bats "$ROOT/tests/bats"
