import AppKit
import Combine
import Foundation
import WebKit

/// Owns the local web server and the window's web view, so menus can act on them.
@MainActor
final class Studio: ObservableObject {
    @Published private(set) var address: URL?
    @Published private(set) var failure: String?
    weak var webView: WKWebView?
    private var server: LocalServer?

    init() {
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("web"),
              FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path)
        else {
            failure = "The studio files are missing from this copy of the app. Please download it again."
            return
        }
        let server = LocalServer(root: root)
        self.server = server
        server.start { [weak self] result in
            Task { @MainActor in
                switch result {
                case .success(let port): self?.address = URL(string: "http://127.0.0.1:\(port)/")
                case .failure(let error): self?.failure = error.localizedDescription
                }
            }
        }
    }

    func reload() {
        webView?.reload()
    }

    func openInBrowser() {
        if let address { NSWorkspace.shared.open(address) }
    }

    func copyAddress() {
        guard let address else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(address.absoluteString, forType: .string)
    }
}
