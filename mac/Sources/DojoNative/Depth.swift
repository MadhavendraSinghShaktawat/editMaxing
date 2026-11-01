import Accelerate
import AVFoundation
import CoreImage
import CoreML
import Foundation
import Vision

private let ciContext = CIContext(options: [.workingColorSpace: NSNull()])

/// Runs a Core ML depth model. Output is 8-bit grayscale where brighter is closer.
private func depthMap(_ request: VNCoreMLRequest, image: CGImage, width: Int, height: Int) throws -> [UInt8] {
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])
    guard let result = request.results?.first as? VNPixelBufferObservation else {
        throw NSError(domain: "dojo", code: 10, userInfo: [NSLocalizedDescriptionKey: "The depth model returned no image."])
    }
    let scaled = CIImage(cvPixelBuffer: result.pixelBuffer).transformed(by: CGAffineTransform(
        scaleX: CGFloat(width) / CGFloat(CVPixelBufferGetWidth(result.pixelBuffer)),
        y: CGFloat(height) / CGFloat(CVPixelBufferGetHeight(result.pixelBuffer))
    )).clampedToExtent().applyingGaussianBlur(sigma: 1.6).cropped(to: CGRect(x: 0, y: 0, width: width, height: height))
    var rgba = [UInt8](repeating: 0, count: width * height * 4)
    ciContext.render(scaled, toBitmap: &rgba, rowBytes: width * 4, bounds: CGRect(x: 0, y: 0, width: width, height: height), format: .RGBA8, colorSpace: nil)
    var out = [UInt8](repeating: 0, count: width * height)
    var lo: UInt8 = 255
    var hi: UInt8 = 0
    for i in 0..<out.count {
        let v = rgba[i * 4]
        out[i] = v
        lo = min(lo, v)
        hi = max(hi, v)
    }
    let span = max(1, Int(hi) - Int(lo))
    for i in 0..<out.count { out[i] = UInt8((Int(out[i]) - Int(lo)) * 255 / span) }
    return out
}

private func loadRequest(_ path: String) throws -> VNCoreMLRequest {
    var url = fileURL(path)
    if url.pathExtension != "mlmodelc" { url = try MLModel.compileModel(at: url) }
    let config = MLModelConfiguration()
    config.computeUnits = .all
    let request = VNCoreMLRequest(model: try VNCoreMLModel(for: MLModel(contentsOf: url, configuration: config)))
    request.imageCropAndScaleOption = .scaleFill
    return request
}

private func loadImage(_ url: URL) throws -> CGImage {
    guard let image = CIImage(contentsOf: url, options: [.applyOrientationProperty: true]),
          let cg = ciContext.createCGImage(image, from: image.extent, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)) else {
        throw NSError(domain: "dojo", code: 11, userInfo: [NSLocalizedDescriptionKey: "Could not read this image."])
    }
    return cg
}

func estimateDepth(_ args: Args) async throws {
    let request = try loadRequest(args.require("model"))
    let image = try loadImage(fileURL(args.require("input")))
    let output = fileURL(args.require("output"))
    let map = try depthMap(request, image: image, width: image.width, height: image.height)
    let provider = CGDataProvider(data: Data(map) as CFData)!
    let cg = CGImage(width: image.width, height: image.height, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: image.width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: 0), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
    try ciContext.writePNGRepresentation(of: CIImage(cgImage: cg), to: output, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
    Out.done(["output": output.path, "width": image.width, "height": image.height])
}

/// Renders a 2.5D camera move from one image: nearer pixels shift more than far ones.
func renderParallax(_ args: Args) async throws {
    let request = try loadRequest(args.require("model"))
    let image = try loadImage(fileURL(args.require("input")))
    let output = fileURL(args.require("output"))
    let duration = args.double("duration", 4)
    let fps = args.double("fps", 30)
    let amount = args.double("amount", 0.028)
    let move = args.string("move") ?? "orbit"
    let width = image.width & ~1
    let height = image.height & ~1

    let depth = try depthMap(request, image: image, width: width, height: height)
    var source = [UInt8](repeating: 0, count: width * height * 4)
    let ctx = CGContext(data: &source, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

    try? FileManager.default.removeItem(at: output)
    let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height, AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 16_000_000]])
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height])
    writer.add(input)
    writer.startWriting()
    writer.startSession(atSourceTime: .zero)

    let frames = Int(duration * fps)
    let overscan = 1 + Float(amount) * 2.4
    let cx = Float(width) / 2
    let cy = Float(height) / 2
    for f in 0..<frames {
        let u = Float(f) / Float(max(1, frames - 1))
        let eased = u * u * (3 - 2 * u)
        var dx: Float
        var dy: Float = 0
        var dolly: Float = 0
        switch move {
        case "dolly":
            dx = 0
            dolly = eased * Float(amount) * 2.2
        case "rise":
            dx = 0
            dy = (eased - 0.5) * Float(amount) * Float(height)
        default:
            dx = (eased - 0.5) * Float(amount) * Float(width) * 2
        }
        var pool: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pool)
        guard let buffer = pool else { continue }
        CVPixelBufferLockBaseAddress(buffer, [])
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        let dst = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
        source.withUnsafeBufferPointer { src in
            depth.withUnsafeBufferPointer { d in
                nonisolated(unsafe) let s = src.baseAddress!
                nonisolated(unsafe) let dp = d.baseAddress!
                nonisolated(unsafe) let out = dst
                DispatchQueue.concurrentPerform(iterations: height) { y in
                    let row = out + y * stride
                    for x in 0..<width {
                        var px = (Float(x) - cx) / overscan + cx
                        var py = (Float(y) - cy) / overscan + cy
                        // Two fixed-point steps approximate the inverse warp, reducing tearing at edges.
                        for _ in 0..<2 {
                            let ix = max(0, min(width - 1, Int(px)))
                            let iy = max(0, min(height - 1, Int(py)))
                            let z = Float(dp[iy * width + ix]) / 255 - 0.35
                            let sx = (Float(x) - cx) / overscan + cx
                            let sy = (Float(y) - cy) / overscan + cy
                            let zoom = 1 + dolly * z
                            px = (sx - cx) / zoom + cx - dx * z
                            py = (sy - cy) / zoom + cy - dy * z
                        }
                        let ix = max(0, min(width - 1, Int(px)))
                        let iy = max(0, min(height - 1, Int(py)))
                        let k = (iy * width + ix) * 4
                        row[x * 4] = s[k]
                        row[x * 4 + 1] = s[k + 1]
                        row[x * 4 + 2] = s[k + 2]
                        row[x * 4 + 3] = 255
                    }
                }
            }
        }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        while !input.isReadyForMoreMediaData { usleep(500) }
        adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(f), timescale: CMTimeScale(fps)))
        if f % 12 == 0 { Out.progress(Double(f) / Double(frames)) }
    }
    input.markAsFinished()
    await writer.finishWriting()
    if writer.status != .completed { throw writer.error ?? NSError(domain: "dojo", code: 12) }
    Out.done(["output": output.path, "frames": frames, "move": move])
}
