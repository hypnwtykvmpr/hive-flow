import Foundation
import LocalAuthentication
import Security

@main
struct HiveFlowMacOSKeychainHelper {
    static func main() {
        if CommandLine.arguments.contains("--describe") {
            print("Hive Flow macOS Keychain helper: generic-password items, optional LAContext user-presence ACL")
            return
        }

        let context = LAContext()
        context.localizedFallbackTitle = ""

        var accessError: Unmanaged<CFError>?
        let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.userPresence],
            &accessError
        )

        if access == nil {
            let message = accessError?.takeRetainedValue().localizedDescription ?? "unknown SecAccessControl error"
            fputs("SecAccessControl unavailable: \(message)\n", stderr)
            exit(2)
        }

        // The non-interactive automated test path deliberately does not enable
        // this ACL. This helper is the manual/biometric path: after LAContext
        // succeeds, Keychain releases the generic-password bytes. The random
        // vault KEK leaves the API only as the Keychain item's secret data after
        // OS unlock; Secure Enclave symmetric import is not attempted.
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "hive-flow-provider-key:manual-helper-probe",
            kSecAttrAccount as String: NSUserName(),
            kSecUseAuthenticationContext as String: context,
            kSecAttrAccessControl as String: access as Any,
        ]

        if CommandLine.arguments.contains("--dry-run-query") {
            print("query-ready:\(query.count)")
            return
        }

        print("helper-ready")
    }
}
