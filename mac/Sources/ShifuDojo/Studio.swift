import AppKit
import Combine
import Foundation
import WebKit

/// Owns the local engine and the window's web view, so menus can act on them.
@MainActor
final class Studio: ObservableObject {
    @Published private(set) var address: URL?
    @Published private(set) var failure: String?
    weak var webView: WKWebView?
    private var engine: Engine?

    init() {
        guard let resources = Bundle.main.resourceURL else {
            failure = "The studio files are missing from this copy of the app. Please download it again."
            return
        }
        let engine = Engine(
            resources: resources,
            onReady: { [weak self] url in Task { @MainActor in self?.address = url } },
            onFailure: { [weak self] message in Task { @MainActor in self?.failure = message } }
        )
        self.engine = engine
        do {
            try engine.start()
        } catch {
            failure = error.localizedDescription
        }
    }

    func stop() {
        engine?.stop()
    }

    func reload() {
        webView?.reload()
    }

    /// The address carries this Mac's sign-in link, so the browser opens signed in.
    func openInBrowser() {
        if let address { NSWorkspace.shared.open(address) }
    }

    func copyAddress() {
        guard let address else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(address.absoluteString, forType: .string)
    }
}
