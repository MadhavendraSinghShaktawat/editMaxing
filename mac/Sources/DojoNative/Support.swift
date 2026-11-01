import Foundation

/// Every tool speaks newline-delimited JSON on stdout so the engine can stream progress.
enum Out {
    static func emit(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let line = String(data: data, encoding: .utf8) else { return }
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }

    static func progress(_ value: Double, _ message: String? = nil) {
        var o: [String: Any] = ["event": "progress", "value": min(1, max(0, value))]
        if let message { o["message"] = message }
        emit(o)
    }

    static func done(_ result: [String: Any]) {
        emit(["event": "done", "result": result])
    }

    static func fail(_ message: String) -> Never {
        emit(["event": "error", "message": message])
        exit(1)
    }
}

struct Args {
    private var values: [String: String] = [:]
    private(set) var flags = Set<String>()
    private(set) var positional: [String] = []

    init(_ raw: [String]) {
        var i = 0
        while i < raw.count {
            let token = raw[i]
            if token.hasPrefix("--") {
                let key = String(token.dropFirst(2))
                if i + 1 < raw.count, !raw[i + 1].hasPrefix("--") {
                    values[key] = raw[i + 1]
                    i += 2
                } else {
                    flags.insert(key)
                    i += 1
                }
            } else {
                positional.append(token)
                i += 1
            }
        }
    }

    func string(_ key: String) -> String? { values[key] }
    func require(_ key: String) -> String {
        guard let v = values[key] else { Out.fail("Missing --\(key)") }
        return v
    }
    func double(_ key: String, _ fallback: Double) -> Double { values[key].flatMap(Double.init) ?? fallback }
    func has(_ key: String) -> Bool { flags.contains(key) }
}

func fileURL(_ path: String) -> URL { URL(fileURLWithPath: path) }
