import Accelerate
import AVFoundation
import Vision

/// Saves a cutout once, so editors and Claude can reuse it without running it live.
func removeBackground(_ args: Args) async throws {
    let input = fileURL(args.require("input"))
    let output = fileURL(args.require("output"))
    let codec = AlphaCodec(rawValue: args.string("codec") ?? "prores") ?? .prores
    let subject = args.string("subject") ?? "person"
    let qualityName = args.string("quality") ?? "accurate"
    let maskOut = args.string("mask").map(fileURL)

    let reader = try await FrameReader(url: input)
    let width = Int(reader.size.width)
    let height = Int(reader.size.height)
    let writer = try AlphaWriter(url: output, width: width, height: height, codec: codec, transform: reader.transform)
    let maskWriter = try maskOut.map { try AlphaWriter(url: $0, width: width, height: height, codec: .hevc, transform: reader.transform) }

    let personRequest = VNGeneratePersonSegmentationRequest()
    personRequest.qualityLevel = qualityName == "fast" ? .fast : qualityName == "balanced" ? .balanced : .accurate
    personRequest.outputPixelFormat = kCVPixelFormatType_OneComponent8
    let sequence = VNSequenceRequestHandler()
    let foregroundRequest = VNGenerateForegroundInstanceMaskRequest()

    var previous = [UInt8](repeating: 0, count: width * height)
    var current = [UInt8](repeating: 0, count: width * height)
    var hasPrevious = false
    var frames = 0
    var coverage = 0.0
    let total = max(1, reader.duration * reader.frameRate)
    let blend = UInt32(min(1, max(0, args.double("smooth", 0.6))) * 256)

    while let (frame, time) = reader.next() {
        try autoreleasepool {
            var mask: CVPixelBuffer?
            if subject == "foreground" {
                let handler = VNImageRequestHandler(cvPixelBuffer: frame, options: [:])
                try handler.perform([foregroundRequest])
                if let result = foregroundRequest.results?.first {
                    mask = try result.generateScaledMaskForImage(forInstances: result.allInstances, from: handler)
                }
            } else {
                try sequence.perform([personRequest], on: frame)
                mask = personRequest.results?.first?.pixelBuffer
            }
            if let mask { scaleMask(mask, into: &current, width: width, height: height) }
            else { current.withUnsafeMutableBufferPointer { $0.update(repeating: 0) } }

            // Edge-aware temporal filter: settle small flicker, follow real motion instantly.
            if hasPrevious {
                current.withUnsafeMutableBufferPointer { cur in
                    previous.withUnsafeBufferPointer { prev in
                        for i in 0..<cur.count {
                            let c = Int32(cur[i])
                            let p = Int32(prev[i])
                            if abs(c - p) < 56 { cur[i] = UInt8((UInt32(c) * (256 - blend) + UInt32(p) * blend) >> 8) }
                        }
                    }
                }
            }
            swap(&previous, &current)
            hasPrevious = true

            guard let out = writer.makeBuffer() else { throw NSError(domain: "dojo", code: 7) }
            coverage += compose(frame: frame, mask: previous, into: out, width: width, height: height)
            try writer.append(out, at: time)
            if let maskWriter, let m = maskWriter.makeBuffer() {
                writeMask(previous, into: m, width: width, height: height)
                try maskWriter.append(m, at: time)
            }
        }
        frames += 1
        if frames % 12 == 0 { Out.progress(Double(frames) / total) }
    }
    try await writer.finish()
    try await maskWriter?.finish()
    if reader.reader.status == .failed { throw reader.reader.error ?? NSError(domain: "dojo", code: 8) }
    Out.done(["output": output.path, "mask": maskOut?.path ?? NSNull(), "frames": frames, "width": width, "height": height, "codec": codec.rawValue, "subject": subject, "coverage": frames > 0 ? coverage / Double(frames) : 0])
}

/// Scales Vision's mask to frame size. Handles the 8-bit and float formats Vision returns.
private func scaleMask(_ mask: CVPixelBuffer, into target: inout [UInt8], width: Int, height: Int) {
    CVPixelBufferLockBaseAddress(mask, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(mask, .readOnly) }
    let mw = CVPixelBufferGetWidth(mask)
    let mh = CVPixelBufferGetHeight(mask)
    let stride = CVPixelBufferGetBytesPerRow(mask)
    guard let base = CVPixelBufferGetBaseAddress(mask) else { return }
    var planar: [UInt8]
    var srcBytes = stride
    if CVPixelBufferGetPixelFormatType(mask) == kCVPixelFormatType_OneComponent32Float {
        planar = [UInt8](repeating: 0, count: mw * mh)
        for y in 0..<mh {
            let row = base.advanced(by: y * stride).assumingMemoryBound(to: Float.self)
            for x in 0..<mw { planar[y * mw + x] = UInt8(max(0, min(255, row[x] * 255))) }
        }
        srcBytes = mw
    } else {
        planar = [UInt8](UnsafeBufferPointer(start: base.assumingMemoryBound(to: UInt8.self), count: stride * mh))
    }
    planar.withUnsafeMutableBytes { src in
        target.withUnsafeMutableBytes { dst in
            var s = vImage_Buffer(data: src.baseAddress, height: vImagePixelCount(mh), width: vImagePixelCount(mw), rowBytes: srcBytes)
            var d = vImage_Buffer(data: dst.baseAddress, height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: width)
            vImageScale_Planar8(&s, &d, nil, vImage_Flags(kvImageHighQualityResampling))
        }
    }
}

private func compose(frame: CVPixelBuffer, mask: [UInt8], into out: CVPixelBuffer, width: Int, height: Int) -> Double {
    CVPixelBufferLockBaseAddress(frame, .readOnly)
    CVPixelBufferLockBaseAddress(out, [])
    defer {
        CVPixelBufferUnlockBaseAddress(frame, .readOnly)
        CVPixelBufferUnlockBaseAddress(out, [])
    }
    let srcStride = CVPixelBufferGetBytesPerRow(frame)
    let dstStride = CVPixelBufferGetBytesPerRow(out)
    let src = CVPixelBufferGetBaseAddress(frame)!.assumingMemoryBound(to: UInt8.self)
    let dst = CVPixelBufferGetBaseAddress(out)!.assumingMemoryBound(to: UInt8.self)
    var sum = 0
    mask.withUnsafeBufferPointer { m in
        for y in 0..<height {
            let s = src + y * srcStride
            let d = dst + y * dstStride
            let row = y * width
            for x in 0..<width {
                let a = m[row + x]
                sum += Int(a)
                // Straight alpha keeps hair edges clean when composited over a new background.
                d[x * 4] = s[x * 4]
                d[x * 4 + 1] = s[x * 4 + 1]
                d[x * 4 + 2] = s[x * 4 + 2]
                d[x * 4 + 3] = a
            }
        }
    }
    return Double(sum) / Double(width * height) / 255
}

private func writeMask(_ mask: [UInt8], into out: CVPixelBuffer, width: Int, height: Int) {
    CVPixelBufferLockBaseAddress(out, [])
    defer { CVPixelBufferUnlockBaseAddress(out, []) }
    let stride = CVPixelBufferGetBytesPerRow(out)
    let dst = CVPixelBufferGetBaseAddress(out)!.assumingMemoryBound(to: UInt8.self)
    mask.withUnsafeBufferPointer { m in
        for y in 0..<height {
            let d = dst + y * stride
            for x in 0..<width {
                let a = m[y * width + x]
                d[x * 4] = a
                d[x * 4 + 1] = a
                d[x * 4 + 2] = a
                d[x * 4 + 3] = 255
            }
        }
    }
}
