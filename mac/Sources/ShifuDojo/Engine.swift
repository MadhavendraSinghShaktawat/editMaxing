import AppKit
import Foundation

/// The engine runs as a background service (a launchd agent), like T3 Code's server, so closing the
/// window, quitting the app or the app crashing never stops an editor mid-edit. The app installs
/// the service, starts it, and connects to it. launchd starts it at login and again if it crashes.
final class Engine: @unchecked Sendable {
    enum Failure: LocalizedError {
        case missing
        case noStart(String)
        var errorDescription: String? {
            switch self {
            case .missing: "The engine is missing from this copy of the app. Please download it again."
            case .noStart(let detail): detail.isEmpty ? "The engine didn't start. Open Shifu Dojo again, or restart the Mac." : detail
            }
        }
    }

    /// What the running engine reports about itself.
    struct Status: Decodable {
        struct Chat: Decodable { let name: String; let detail: String }
        let build: String
        let pid: Int
        let service: Bool
        let working: [Chat]
        let jobs: Int
    }

    static let label = "com.socialshifu.dojo.engine"
    private static let port = 51791
    private let resources: URL
    private let onReady: @Sendable (URL) -> Void
    private let onFailure: @Sendable (String) -> Void
    /// Asked when the running engine is an older build and editors are working. True restarts it now.
    private let confirmRestart: @Sendable ([Status.Chat]) -> Bool

    init(resources: URL, onReady: @escaping @Sendable (URL) -> Void, onFailure: @escaping @Sendable (String) -> Void, confirmRestart: @escaping @Sendable ([Status.Chat]) -> Bool) {
        self.resources = resources
        self.onReady = onReady
        self.onFailure = onFailure
        self.confirmRestart = confirmRestart
    }

    private var node: URL { resources.deletingLastPathComponent().appendingPathComponent("MacOS/node") }
    private var main: URL { resources.appendingPathComponent("engine/src/main.ts") }
    private var build: String { (try? String(contentsOf: resources.appendingPathComponent("BUILD"), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "dev" }
    private static var support: URL { FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Shifu Dojo") }
    private static var plist: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/\(label).plist") }
    private static var logs: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Shifu Dojo") }
    private static var domain: String { "gui/\(getuid())" }

    func start() throws {
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: main.path) else { throw Failure.missing }
        DispatchQueue.global().async { [self] in
            do {
                onReady(try connect())
            } catch {
                onFailure(error.localizedDescription)
            }
        }
    }

    /// Installs or updates the service, makes sure the right build is running, and waits for it.
    private func connect() throws -> URL {
        let changed = try writeService()
        if let status = Self.status() {
            if status.build == build && !changed { return try Self.address() }
            // An older engine keeps running until it's safe: restarting cuts turns short, though they resume.
            if !status.working.isEmpty && !confirmRestart(status.working) { return try Self.address() }
            Self.launchctl(["bootout", "\(Self.domain)/\(Self.label)"])
            Self.waitUntilStopped()
        } else if changed {
            Self.launchctl(["bootout", "\(Self.domain)/\(Self.label)"])
        }
        // Loads the service, or starts it again if it was loaded and stopped.
        if Self.launchctl(["bootstrap", Self.domain, Self.plist.path]) != 0 {
            Self.launchctl(["kickstart", "\(Self.domain)/\(Self.label)"])
        }
        for _ in 0..<120 {
            if Self.status() != nil { return try Self.address() }
            Thread.sleep(forTimeInterval: 0.5)
        }
        throw Failure.noStart(Self.lastLog())
    }

    /// The launchd agent. Returns true when it changed, so the running service is reloaded.
    private func writeService() throws -> Bool {
        try FileManager.default.createDirectory(at: Self.logs, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: Self.plist.deletingLastPathComponent(), withIntermediateDirectories: true)
        let log = Self.logs.appendingPathComponent("engine.log").path
        let service: [String: Any] = [
            "Label": Self.label,
            "ProgramArguments": [node.path, "--disable-warning=ExperimentalWarning", main.path],
            "RunAtLoad": true,
            // A crash starts it again; a deliberate stop doesn't.
            "KeepAlive": ["SuccessfulExit": false],
            "ThrottleInterval": 5,
            "ProcessType": "Interactive",
            "LimitLoadToSessionType": "Aqua",
            "StandardOutPath": log,
            "StandardErrorPath": log,
            "EnvironmentVariables": ["PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"],
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: service, format: .xml, options: 0)
        if let existing = try? Data(contentsOf: Self.plist), existing == data { return false }
        try data.write(to: Self.plist, options: .atomic)
        return true
    }

    /// The running engine's build and work, or nil if nothing answers.
    static func status() -> Status? {
        guard let token = token(), let url = URL(string: "http://127.0.0.1:\(port)/api/engine") else { return nil }
        var request = URLRequest(url: url, timeoutInterval: 2)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let done = DispatchSemaphore(value: 0)
        nonisolated(unsafe) var result: Status?
        URLSession.shared.dataTask(with: request) { data, response, _ in
            if (response as? HTTPURLResponse)?.statusCode == 200, let data { result = try? JSONDecoder().decode(Status.self, from: data) }
            done.signal()
        }.resume()
        _ = done.wait(timeout: .now() + 3)
        return result
    }

    private static func token() -> String? {
        (try? String(contentsOf: support.appendingPathComponent("token"), encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func address() throws -> URL {
        guard let token = token(), let url = URL(string: "http://127.0.0.1:\(port)/?k=\(token)") else { throw Failure.noStart("The engine started without its sign-in token.") }
        return url
    }

    private static func waitUntilStopped() {
        for _ in 0..<40 where status() != nil { Thread.sleep(forTimeInterval: 0.25) }
    }

    private static func lastLog() -> String {
        guard let text = try? String(contentsOf: logs.appendingPathComponent("engine.log"), encoding: .utf8) else { return "" }
        return text.split(separator: "\n").suffix(6).joined(separator: "\n")
    }

    @discardableResult
    private static func launchctl(_ arguments: [String]) -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus
        } catch {
            return -1
        }
    }

    /// Stops the background engine until the app opens again. Editors stop with it.
    static func stopService() {
        launchctl(["bootout", "\(domain)/\(label)"])
    }
}
