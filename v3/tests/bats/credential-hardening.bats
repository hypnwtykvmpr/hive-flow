#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "credential helper sources require biometric/consent hardening hooks" {
  mac_helper="$REPO_ROOT/v3/@hive-flow/cli/src/credential-store/helpers/macos-keychain.swift"
  win_helper="$REPO_ROOT/v3/@hive-flow/cli/src/credential-store/helpers/windows-credential-helper/Program.cs"

  run grep -E "LocalAuthentication|canEvaluatePolicy\\(\\.deviceOwnerAuthentication|evaluatePolicy\\(\\.deviceOwnerAuthentication|kSecAttrAccessibleWhenUnlockedThisDeviceOnly" "$mac_helper"
  [ "$status" -eq 0 ]
  [[ "$output" == *"LocalAuthentication"* ]]
  [[ "$output" == *"canEvaluatePolicy(.deviceOwnerAuthentication"* ]]
  [[ "$output" == *"evaluatePolicy(.deviceOwnerAuthentication"* ]]
  [[ "$output" == *"kSecAttrAccessibleWhenUnlockedThisDeviceOnly"* ]]

  run grep -E "SecAccessControlCreateWithFlags|kSecAttrAccessControl|kSecUseAuthenticationContext|kSecUseDataProtectionKeychain" "$mac_helper"
  [ "$status" -eq 1 ]

  run grep -E "FailClosedIfBiometricUnavailable|Console.IsInputRedirected|UserConsentVerifierAvailability\\.Available" "$win_helper"
  [ "$status" -eq 0 ]
  [[ "$output" == *"FailClosedIfBiometricUnavailable"* ]]
  [[ "$output" == *"Console.IsInputRedirected"* ]]
  [[ "$output" == *"UserConsentVerifierAvailability.Available"* ]]
}

@test "provider bridge serializes logs and results through credential redaction" {
  bridge="$REPO_ROOT/v3/@hive-flow/providers/scripts/provider-agent-bridge.mjs"

  run grep -E "redactBridgeCredentialMaterial|safeBridgeJsonStringify|BRIDGE_SECRET_VALUE_PATTERNS" "$bridge"
  [ "$status" -eq 0 ]
  [[ "$output" == *"redactBridgeCredentialMaterial"* ]]
  [[ "$output" == *"safeBridgeJsonStringify"* ]]
  [[ "$output" == *"BRIDGE_SECRET_VALUE_PATTERNS"* ]]

  run grep -F "return typeof result === 'string' ? redactBridgeString(result) : safeBridgeJsonStringify(result)" "$bridge"
  [ "$status" -eq 0 ]

  run grep -F "const rawContent = typeof tr.result === 'string' ? redactBridgeString(tr.result) : safeBridgeJsonStringify(tr.result)" "$bridge"
  [ "$status" -eq 0 ]

  run grep -F "JSON.stringify(errorResponse, null, 2)" "$bridge"
  [ "$status" -eq 1 ]

  run grep -F "return typeof result === 'string' ? result : JSON.stringify(result)" "$bridge"
  [ "$status" -eq 1 ]
}
