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
        }
        .defaultSize(width: 1440, height: 900)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(after: .toolbar) {
                Button("Reload Studio") { studio.reload() }
                    .keyboardShortcut("r")
            }
            CommandMenu("Studio") {
                Button("Stop Background Engine…") { studio.stopEngine() }
                    .disabled(!studio.running)
                Divider()
                Button("Open in Browser") { studio.openInBrowser() }
                    .keyboardShortcut("b", modifiers: [.command, .shift])
                    .disabled(studio.address == nil)
                Button("Copy Studio Address") { studio.copyAddress() }
                    .disabled(studio.address == nil)
            }
        }

        // A small status item: who's working, and a way back into the studio.
        MenuBarExtra {
            MenuBarContent(studio: studio)
        } label: {
            Image(systemName: studio.working.isEmpty ? "film.stack" : "film.stack.fill")
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    /// WebKit pauses drawing for hidden windows, so the studio opens in front.
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate()
    }

    /// Closing the window keeps the app in the menu bar. Editors run in the background engine either way.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Clicking the Dock icon with no window open brings the studio back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { true }
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

/// The menu-bar menu. Editors keep working here after the window is closed.
struct MenuBarContent: View {
    @ObservedObject var studio: Studio

    var body: some View {
        if studio.working.isEmpty {
            Text(studio.running ? "No editors working" : "Engine stopped")
        } else {
            ForEach(Array(studio.working.enumerated()), id: \.offset) { _, chat in
                Text(chat.detail.isEmpty ? "\(chat.name) is working" : "\(chat.name): \(chat.detail)")
            }
        }
        Divider()
        Button("Open Studio") { studio.openStudio() }
        Button("Open in Browser") { studio.openInBrowser() }
            .disabled(studio.address == nil)
        Divider()
        if studio.running {
            Button("Stop Background Engine…") { studio.stopEngine() }
        } else {
            Button("Start Engine") { studio.startEngine() }
        }
        Button("Quit Shifu Dojo") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}
