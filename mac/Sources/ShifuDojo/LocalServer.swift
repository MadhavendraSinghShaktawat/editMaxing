import Foundation
import Network

/// A tiny read-only web server for the bundled studio.
/// It listens on 127.0.0.1 only, so nothing on the network can reach it.
final class LocalServer {
    private let root: URL
    private let queue = DispatchQueue(label: "shifu.dojo.server")
    private var listener: NWListener?
    private var started = false

    private static let preferredPort: UInt16 = 51790
    private static let types = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
        "json": "application/json", "png": "image/png", "svg": "image/svg+xml", "woff2": "font/woff2", "woff": "font/woff",
    ]

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    func start(completion: @escaping @Sendable (Result<UInt16, Error>) -> Void) {
        listen(on: NWEndpoint.Port(rawValue: Self.preferredPort)!, retryAnyPort: true, completion: completion)
    }

    private func listen(on port: NWEndpoint.Port, retryAnyPort: Bool, completion: @escaping @Sendable (Result<UInt16, Error>) -> Void) {
        do {
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: port)
            parameters.allowLocalEndpointReuse = true
            let listener = try NWListener(using: parameters)
            listener.newConnectionHandler = { [weak self] connection in self?.serve(connection) }
            listener.stateUpdateHandler = { [weak self, weak listener] state in
                guard let self else { return }
                switch state {
                case .ready:
                    self.started = true
                    completion(.success(listener?.port?.rawValue ?? port.rawValue))
                case .failed(let error):
                    listener?.cancel()
                    if retryAnyPort && !self.started {
                        self.listen(on: .any, retryAnyPort: false, completion: completion)
                    } else {
                        completion(.failure(error))
                    }
                default:
                    break
                }
            }
            self.listener = listener
            listener.start(queue: queue)
        } catch {
            completion(.failure(error))
        }
    }

    private func serve(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, _, _ in
            guard let self, let data, let request = String(data: data, encoding: .utf8) else {
                connection.cancel()
                return
            }
            self.respond(to: request, on: connection)
        }
    }

    private func respond(to request: String, on connection: NWConnection) {
        let parts = request.split(separator: "\r\n", maxSplits: 1).first?.split(separator: " ") ?? []
        guard parts.count >= 2, parts[0] == "GET" || parts[0] == "HEAD" else {
            return send(status: "405 Method Not Allowed", type: "text/plain", body: Data("Method not allowed".utf8), on: connection)
        }
        let target = parts[1].split(separator: "?", maxSplits: 1).first.map(String.init) ?? "/"
        let path = target.removingPercentEncoding ?? target
        let relative = path == "/" ? "index.html" : String(path.drop(while: { $0 == "/" }))
        let file = root.appendingPathComponent(relative).standardizedFileURL

        // Only files inside the bundled studio folder are ever served.
        guard file.path.hasPrefix(root.path + "/"), let body = try? Data(contentsOf: file) else {
            return send(status: "404 Not Found", type: "text/plain", body: Data("Not found".utf8), on: connection)
        }
        let type = Self.types[file.pathExtension.lowercased()] ?? "application/octet-stream"
        send(status: "200 OK", type: type, body: parts[0] == "HEAD" ? Data() : body, length: body.count, on: connection)
    }

    private func send(status: String, type: String, body: Data, length: Int? = nil, on connection: NWConnection) {
        let head = "HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(length ?? body.count)\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n"
        var response = Data(head.utf8)
        response.append(body)
        connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
    }
}
