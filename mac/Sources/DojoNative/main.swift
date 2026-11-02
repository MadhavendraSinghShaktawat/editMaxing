import Foundation

let raw = Array(CommandLine.arguments.dropFirst())
guard let command = raw.first else { Out.fail("Usage: dojo-native <remove-bg|transcribe|speech-locales|analyze|motion|captions|fonts|depth|parallax> [options]") }
let args = Args(Array(raw.dropFirst()))

let task = Task {
    do {
        switch command {
        case "remove-bg": try await removeBackground(args)
        case "transcribe":
            guard #available(macOS 26.0, *) else { Out.fail("Transcription needs macOS 26 or later.") }
            try await transcribe(args)
        case "speech-locales":
            guard #available(macOS 26.0, *) else { Out.fail("Speech recognition needs macOS 26 or later.") }
            await speechLocales()
        case "analyze":
            guard #available(macOS 15.0, *) else { Out.fail("Frame analysis needs macOS 15 or later.") }
            try await analyze(args)
        case "motion": try await measureMotion(args)
        case "captions": try await renderCaptions(args)
        case "fonts": listFonts()
        case "depth": try await estimateDepth(args)
        case "parallax": try await renderParallax(args)
        default: Out.fail("Unknown command \(command).")
        }
        exit(0)
    } catch {
        Out.fail(error.localizedDescription)
    }
}
_ = task
dispatchMain()
