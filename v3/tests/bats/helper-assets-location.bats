#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
  cd "$REPO_ROOT"
}

@test "helper assets live only under the canonical CLI package path" {
  old_paths="$(git ls-files 'v3/helpers/**')"
  if [ -n "$old_paths" ]; then
    echo "retired v3/helpers paths are still tracked:" >&2
    echo "$old_paths" >&2
  fi
  [ -z "$old_paths" ]

  run test -f cli/helpers/hive-flow-v3.sh
  [ "$status" -eq 0 ]

  run test -f cli/helpers/hive-flow-v3.ps1
  [ "$status" -eq 0 ]

  run test -f cli/helpers/templates/progress-manager.sh
  [ "$status" -eq 0 ]
}

@test "package allowlists include canonical helper assets" {
  run grep -Fn '"cli/helpers/**"' package.json
  [ "$status" -eq 1 ]

  run grep -Fn '"helpers/**"' cli/package.json
  [ "$status" -eq 0 ]
}
