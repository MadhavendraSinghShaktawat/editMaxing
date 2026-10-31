import AppKit
import SwiftUI
import WebKit

struct StudioWebView: NSViewRepresentable {
    let address: URL
    let studio: Studio

    func makeCoordinator() -> Coordinator { Coordinator(address: address) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.preferences.isElementFullscreenEnabled = true
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.uiDelegate = context.coordinator
        view.underPageBackgroundColor = NSColor(red: 0.05, green: 0.31, blue: 0.35, alpha: 1)
        #if DEBUG
        view.isInspectable = true
        #endif
        view.load(URLRequest(url: address))
        studio.webView = view
        context.coordinator.scheduleTestSnapshot(of: view)
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        private let address: URL

        init(address: URL) {
            self.address = address
        }

        /// The native file picker that backs every "choose a file" button in the studio.
        func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.canChooseDirectories = false
            panel.begin { response in completionHandler(response == .OK ? panel.urls : nil) }
        }

        /// Anything that isn't the studio opens in the user's own browser.
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url, url.host != address.host, url.scheme != "blob", url.scheme != "data" else {
                return decisionHandler(.allow)
            }
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        }

        /// Set DOJO_SNAPSHOT to a path to save a screenshot and quit. Used to test release builds.
        func scheduleTestSnapshot(of view: WKWebView) {
            guard let path = ProcessInfo.processInfo.environment["DOJO_SNAPSHOT"] else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 12) {
                view.takeSnapshot(with: nil) { image, _ in
                    if let tiff = image?.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                        try? png.write(to: URL(fileURLWithPath: path))
                    }
                    NSApp.terminate(nil)
                }
            }
        }
    }
}
