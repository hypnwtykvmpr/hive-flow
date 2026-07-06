#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "standalone security package is retired" {
  [ ! -e "$REPO_ROOT/v3/@hive-flow/security" ]

  run git -C "$REPO_ROOT" ls-files v3/@hive-flow/security
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "security source, tests, and docs live under cli" {
  [ -f "$REPO_ROOT/cli/src/security/index.ts" ]
  [ -f "$REPO_ROOT/cli/src/security/input-validator.ts" ]
  [ -f "$REPO_ROOT/cli/src/security/password-hasher.ts" ]
  [ -f "$REPO_ROOT/cli/src/security/__tests__/input-validator.test.ts" ]
  [ -f "$REPO_ROOT/cli/docs/security/README.md" ]
}

@test "cli package exports security subpaths and owns bcrypt deps" {
  run node --input-type=module -e "import { readFileSync } from 'node:fs'; const pkg = JSON.parse(readFileSync('$REPO_ROOT/cli/package.json', 'utf8')); const exports = pkg.exports || {}; if (!exports['./security'] || !exports['./security/application'] || !exports['./security/domain'] || !exports['./security/*']) process.exit(1); if (!pkg.dependencies?.bcrypt) process.exit(2); if (!pkg.devDependencies?.['@types/bcrypt']) process.exit(3);"
  [ "$status" -eq 0 ]
}

@test "root v3 config no longer references standalone security package" {
  run rg -n "@hive-flow/security|./@hive-flow/security" "$REPO_ROOT/v3/package.json" "$REPO_ROOT/v3/tsconfig.json" "$REPO_ROOT/v3/tsconfig.vitest-temp.json"
  [ "$status" -eq 1 ]
}

@test "tracked source and docs no longer reference standalone security package" {
  run git -C "$REPO_ROOT" grep -n -E "@hive-flow/security|v3/@hive-flow/security" -- ':!v3/pnpm-lock.yaml' ':!pnpm-lock.yaml' ':!v3/tests/bats/security-collapse-location.bats'
  [ "$status" -eq 1 ]
}

@test "lockfiles no longer include standalone security importer" {
  run rg -n "['\"]?@hive-flow/security['\"]?:|v3/@hive-flow/security:" "$REPO_ROOT/v3/pnpm-lock.yaml" "$REPO_ROOT/pnpm-lock.yaml"
  [ "$status" -eq 1 ]
}

@test "v3 package count reflects retired security package" {
  count=0
  for package_file in "$REPO_ROOT"/cli/package.json "$REPO_ROOT"/cli/packages/*/package.json; do
    [ -e "$package_file" ] || continue
    count=$((count + 1))
  done
  [ "$count" -eq 5 ]

  run grep -F '5 packages' "$REPO_ROOT/v3/README.md"
  [ "$status" -eq 0 ]
}
