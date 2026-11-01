import AVFoundation
import Foundation
import Speech

/// On-device, word-timed transcription with Apple's SpeechAnalyzer (macOS 26+).
@available(macOS 26.0, *)
func transcribe(_ args: Args) async throws {
    let input = fileURL(args.require("input"))
    let locale = Locale(identifier: args.string("locale") ?? "en-US")
    let supported = await SpeechTranscriber.supportedLocales
    guard supported.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) else {
        Out.fail("Speech recognition does not support \(locale.identifier).")
    }
    let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange, .transcriptionConfidence])
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        Out.progress(0.02, "Downloading speech model")
        try await request.downloadAndInstall()
    }
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let file = try AVAudioFile(forReading: input)
    let duration = Double(file.length) / file.processingFormat.sampleRate

    let collector = Task { () throws -> [[String: Any]] in
        var words: [[String: Any]] = []
        for try await result in transcriber.results where result.isFinal {
            for run in result.text.runs {
                let text = String(result.text[run.range].characters).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty, let range = run.audioTimeRange else { continue }
                var word: [String: Any] = ["text": text, "start": range.start.seconds, "end": range.end.seconds]
                if let confidence = run.transcriptionConfidence { word["confidence"] = confidence }
                words.append(word)
            }
            if let last = words.last?["end"] as? Double, duration > 0 { Out.progress(last / duration) }
        }
        return words
    }
    try await analyzer.start(inputAudioFile: file, finishAfterFile: true)
    let words = try await collector.value
    Out.done(["locale": locale.identifier(.bcp47), "duration": duration, "words": words])
}

@available(macOS 26.0, *)
func speechLocales() async {
    let supported = await SpeechTranscriber.supportedLocales.map { $0.identifier(.bcp47) }.sorted()
    let installed = await SpeechTranscriber.installedLocales.map { $0.identifier(.bcp47) }.sorted()
    Out.done(["supported": supported, "installed": installed])
}
