import Foundation

/// Runs the bundled engine for as long as the app is open.
/// The engine binds to 127.0.0.1 only and prints its signed-in address once it is ready.
final class Engine: @unchecked Sendable {
    enum Failure: LocalizedError {
        case missing
        var errorDescription: String? { "The engine is missing from this copy of the app. Please download it again." }
    }

    private static let port = 51791
    private static let maxRestarts = 3
    private var process: Process?
    private var stopping = false
    private var restarts = 0
    private var announced = false
    private let resources: URL
    private let onReady: @Sendable (URL) -> Void
    private let onFailure: @Sendable (String) -> Void

    init(resources: URL, onReady: @escaping @Sendable (URL) -> Void, onFailure: @escaping @Sendable (String) -> Void) {
        self.resources = resources
        self.onReady = onReady
        self.onFailure = onFailure
    }

    func start() throws {
        let node = resources.deletingLastPathComponent().appendingPathComponent("MacOS/node")
        let main = resources.appendingPathComponent("engine/src/main.ts")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: main.path) else { throw Failure.missing }

        let process = Process()
        process.executableURL = node
        process.arguments = ["--disable-warning=ExperimentalWarning", main.path]
        var environment = ProcessInfo.processInfo.environment
        environment["DOJO_WATCH_PARENT"] = "1"
        process.environment = environment

        let output = Pipe()
        let errors = Pipe()
        process.standardOutput = output
        process.standardError = errors
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let text = String(data: handle.availableData, encoding: .utf8), !text.isEmpty else { return }
            self?.read(text)
        }
        let log = ErrorLog()
        errors.fileHandleForReading.readabilityHandler = { handle in log.add(handle.availableData) }
        process.terminationHandler = { [weak self] finished in
            output.fileHandleForReading.readabilityHandler = nil
            errors.fileHandleForReading.readabilityHandler = nil
            self?.finished(finished.terminationStatus, message: log.text)
        }
        try process.run()
        self.process = process
    }

    private func read(_ text: String) {
        guard !announced, let range = text.range(of: #"http://127\.0\.0\.1:\d+/\?k=\S+"#, options: .regularExpression), let url = URL(string: String(text[range])) else { return }
        announced = true
        onReady(url)
    }

    private func finished(_ status: Int32, message: String) {
        if stopping { return }
        // Another copy of the engine owns the port. The app can use it, because both share one token.
        if message.contains("already in use"), let url = Self.runningAddress() {
            announced = true
            return onReady(url)
        }
        guard restarts < Self.maxRestarts else {
            return onFailure(message.isEmpty ? "The engine stopped unexpectedly (\(status))." : message)
        }
        restarts += 1
        DispatchQueue.global().asyncAfter(deadline: .now() + 1) { [weak self] in
            do {
                try self?.start()
            } catch {
                self?.onFailure(error.localizedDescription)
            }
        }
    }

    private static func runningAddress() -> URL? {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let file = support.appendingPathComponent("Shifu Dojo/token")
        guard let token = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        return URL(string: "http://127.0.0.1:\(port)/?k=\(token.trimmingCharacters(in: .whitespacesAndNewlines))")
    }

    func stop() {
        stopping = true
        process?.terminate()
    }
}

private final class ErrorLog: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()

    func add(_ chunk: Data) {
        lock.lock()
        data.append(chunk.suffix(4000))
        lock.unlock()
    }

    var text: String {
        lock.lock()
        defer { lock.unlock() }
        return String(decoding: data.suffix(4000), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
