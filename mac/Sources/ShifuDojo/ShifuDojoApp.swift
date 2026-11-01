import AppKit
import SwiftUI

@main
struct ShifuDojoApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var studio = Studio()

    var body: some Scene {
        WindowGroup("Shifu Dojo") {
            ContentView(studio: studio)
                .frame(minWidth: 1100, minHeight: 720)
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                    studio.stop()
                }
        }
        .defaultSize(width: 1440, height: 900)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(after: .toolbar) {
                Button("Reload Studio") { studio.reload() }
                    .keyboardShortcut("r")
            }
            CommandMenu("Studio") {
                Button("Open in Browser") { studio.openInBrowser() }
                    .keyboardShortcut("b", modifiers: [.command, .shift])
                    .disabled(studio.address == nil)
                Button("Copy Studio Address") { studio.copyAddress() }
                    .disabled(studio.address == nil)
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// WebKit pauses drawing for hidden windows, so the studio opens in front.
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

struct ContentView: View {
    @ObservedObject var studio: Studio

    var body: some View {
        Group {
            if let address = studio.address {
                StudioWebView(address: address, studio: studio)
            } else if let failure = studio.failure {
                ContentUnavailableView("Shifu Dojo can't start", systemImage: "exclamationmark.triangle", description: Text(failure))
            } else {
                ProgressView("Opening the studio…")
            }
        }
        .background(Color(red: 0.05, green: 0.31, blue: 0.35))
    }
}
