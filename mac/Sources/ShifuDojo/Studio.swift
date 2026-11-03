import AppKit
import Combine
import Foundation
import WebKit

/// Connects to the background engine and owns the window's web view, so menus can act on them.
/// Closing the window or quitting the app leaves the engine and its editors running.
@MainActor
final class Studio: ObservableObject {
    @Published private(set) var address: URL?
    @Published private(set) var failure: String?
    /// Editors working right now, for the menu bar.
    @Published private(set) var working: [Engine.Status.Chat] = []
    @Published private(set) var running = false
    weak var webView: WKWebView?
    private var engine: Engine?
    private var poll: Timer?

    init() {
        guard let resources = Bundle.main.resourceURL else {
            failure = "The studio files are missing from this copy of the app. Please download it again."
            return
        }
        let engine = Engine(
            resources: resources,
            onReady: { [weak self] url in Task { @MainActor in self?.address = url; self?.failure = nil } },
            onFailure: { [weak self] message in Task { @MainActor in self?.failure = message } },
            confirmRestart: { chats in
                // Asked on the main thread, while the engine waits on its own queue.
                DispatchQueue.main.sync {
                    let alert = NSAlert()
                    let names = chats.map(\.name).joined(separator: ", ")
                    alert.messageText = "Restart the engine to finish updating?"
                    alert.informativeText = "\(names) \(chats.count == 1 ? "is" : "are") working. Restarting pauses them for a moment, then they continue where they left off."
                    alert.addButton(withTitle: "Restart now")
                    alert.addButton(withTitle: "Later")
                    return alert.runModal() == .alertFirstButtonReturn
                }
            }
        )
        self.engine = engine
        do {
            try engine.start()
        } catch {
            failure = error.localizedDescription
        }
        poll = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.refresh() }
        refresh()
    }

    private func refresh() {
        DispatchQueue.global().async {
            let status = Engine.status()
            Task { @MainActor [weak self] in
                self?.running = status != nil
                self?.working = status?.working ?? []
            }
        }
    }

    /// Starts the engine again after it was stopped from the menu bar.
    func startEngine() {
        failure = nil
        address = nil
        try? engine?.start()
    }

    /// Stops the background engine and every editor with it, after asking when someone is working.
    func stopEngine() {
        if !working.isEmpty {
            let alert = NSAlert()
            alert.messageText = "Stop the engine?"
            alert.informativeText = "\(working.map(\.name).joined(separator: ", ")) \(working.count == 1 ? "is" : "are") working. They'll continue the next time the engine starts."
            alert.addButton(withTitle: "Stop")
            alert.addButton(withTitle: "Cancel")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        DispatchQueue.global().async {
            Engine.stopService()
            Task { @MainActor [weak self] in
                self?.address = nil
                self?.running = false
                self?.working = []
                self?.failure = "The engine is stopped. Choose Start Engine in the menu bar to start it again."
            }
        }
    }

    /// Brings the studio window back after it was closed.
    func openStudio() {
        NSApp.activate()
        if let window = NSApp.windows.first(where: { $0.canBecomeMain }) {
            window.makeKeyAndOrderFront(nil)
        }
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
