import Foundation
import Dispatch
import LocalAuthentication
import Security

struct HelperInput: Decodable {
    let secret: String?
}

@main
struct HiveFlowMacOSKeychainHelper {
    static func main() {
        do {
            try run()
        } catch {
            fputs("\(error.localizedDescription)\n", stderr)
            exit(2)
        }
    }

    private static func run() throws {
        let args = CommandLine.arguments
        if args.contains("--describe") {
            print("Hive Flow macOS Keychain helper: generic-password items; secrets arrive via stdin JSON, never argv")
            return
        }
        guard args.count >= 2 else {
            throw HelperError.usage("usage: macos-keychain-helper status|store|retrieve|delete <service> <account>")
        }

        let command = args[1]
        if command == "status" {
            print("available")
            return
        }

        guard args.count >= 4 else {
            throw HelperError.usage("usage: macos-keychain-helper \(command) <service> <account>")
        }

        let service = args[2]
        let account = args[3]
        let input = try readInput()

        switch command {
        case "store":
            guard let secret = input.secret, let data = Data(base64Encoded: secret) else {
                throw HelperError.usage("store requires stdin JSON with base64 secret")
            }
            try store(service: service, account: account, data: data)
        case "retrieve":
            if let data = try retrieve(service: service, account: account) {
                print(data.base64EncodedString())
            }
        case "delete":
            try delete(service: service, account: account)
        default:
            throw HelperError.usage("unsupported command: \(command)")
        }
    }

    private static func readInput() throws -> HelperInput {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        if data.isEmpty { return HelperInput(secret: nil) }
        return try JSONDecoder().decode(HelperInput.self, from: data)
    }

    private static func query(service: String, account: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private static func store(service: String, account: String, data: Data) throws {
        try authorize(operation: "store", service: service, account: account)
        let base = query(service: service, account: account)
        let deleteStatus = SecItemDelete(base as CFDictionary)
        if deleteStatus != errSecSuccess && deleteStatus != errSecItemNotFound {
            try check(deleteStatus, "delete existing item")
        }

        var item = base
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        try check(SecItemAdd(item as CFDictionary, nil), "store item")
    }

    private static func retrieve(service: String, account: String) throws -> Data? {
        try authorize(operation: "retrieve", service: service, account: account)
        var q = query(service: service, account: account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        try check(status, "retrieve item")
        return result as? Data
    }

    private static func delete(service: String, account: String) throws {
        try authorize(operation: "delete", service: service, account: account)
        let status = SecItemDelete(query(service: service, account: account) as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            try check(status, "delete item")
        }
    }

    private static func check(_ status: OSStatus, _ action: String) throws {
        guard status == errSecSuccess else {
            let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
            throw HelperError.keychain("\(action) failed: \(message)")
        }
    }

    private static func authenticationContext(operation: String, service: String, account: String) -> LAContext {
        let context = LAContext()
        context.localizedReason = "Hive Flow needs your approval to \(operation) a credential for \(service) (\(account))."
        context.localizedFallbackTitle = "Use Password"
        return context
    }

    private static func authorize(operation: String, service: String, account: String) throws {
        let context = authenticationContext(operation: operation, service: service, account: account)
        var availabilityError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &availabilityError) else {
            let message = availabilityError?.localizedDescription ?? "device-owner authentication unavailable"
            throw HelperError.keychain("authentication unavailable: \(message)")
        }

        let semaphore = DispatchSemaphore(value: 0)
        var allowed = false
        var failure: String?
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: context.localizedReason) { success, error in
            allowed = success
            failure = error?.localizedDescription
            semaphore.signal()
        }

        if semaphore.wait(timeout: .now() + .seconds(120)) == .timedOut {
            throw HelperError.keychain("authentication timed out")
        }
        guard allowed else {
            throw HelperError.keychain("authentication failed: \(failure ?? "not authorized")")
        }
    }
}

enum HelperError: LocalizedError {
    case usage(String)
    case keychain(String)

    var errorDescription: String? {
        switch self {
        case .usage(let message), .keychain(let message):
            return message
        }
    }
}
