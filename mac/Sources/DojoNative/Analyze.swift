import Foundation
import Vision

/// Local frame analysis. Claude reads these results as evidence, and nothing leaves the Mac.
@available(macOS 15.0, *)
func analyze(_ args: Args) async throws {
    let wanted = Set((args.string("features") ?? "text,faces,saliency,labels,print").split(separator: ",").map(String.init))
    let paths = args.positional
    var results: [[String: Any]] = []
    for (index, path) in paths.enumerated() {
        let url = fileURL(path)
        var item: [String: Any] = ["path": path]
        if wanted.contains("text") {
            let observations = try await RecognizeTextRequest().perform(on: url)
            item["text"] = observations.compactMap { o -> [String: Any]? in
                guard let top = o.topCandidates(1).first else { return nil }
                let box = o.boundingBox
                return ["text": top.string, "confidence": top.confidence, "box": [box.origin.x, box.origin.y, box.width, box.height]]
            }
        }
        if wanted.contains("faces") {
            let observations = try await DetectFaceRectanglesRequest().perform(on: url)
            item["faces"] = observations.map { o -> [String: Any] in
                let box = o.boundingBox
                return ["confidence": o.confidence, "box": [box.origin.x, box.origin.y, box.width, box.height]]
            }
        }
        if wanted.contains("saliency") {
            let observation = try await GenerateAttentionBasedSaliencyImageRequest().perform(on: url)
            item["saliency"] = observation.salientObjects.map { o -> [String: Any] in
                let box = o.boundingBox
                return ["confidence": o.confidence, "box": [box.origin.x, box.origin.y, box.width, box.height]]
            }
        }
        if wanted.contains("labels") {
            let observations = try await ClassifyImageRequest().perform(on: url)
            item["labels"] = observations.filter { $0.confidence > 0.25 }.prefix(10).map { ["label": $0.identifier, "confidence": $0.confidence] as [String: Any] }
        }
        if wanted.contains("print") {
            let observation = try await GenerateImageFeaturePrintRequest().perform(on: url)
            item["print"] = observation.data.base64EncodedString()
            item["printCount"] = observation.elementCount
            item["printType"] = "\(observation.elementType)"
        }
        results.append(item)
        Out.progress(Double(index + 1) / Double(max(1, paths.count)))
    }
    Out.done(["items": results])
}
