import AVFoundation
import CoreImage
import Foundation
import Vision

/// A small grey copy of a frame, used to score how well a registration really fits.
private struct Small {
    let image: CGImage
    let gray: [UInt8]
    let width: Int
    let height: Int
}

private let context = CIContext(options: [.useSoftwareRenderer: false, .cacheIntermediates: false])

private func shrink(_ buffer: CVPixelBuffer, transform: CGAffineTransform, width target: Int) -> Small? {
    var image = CIImage(cvPixelBuffer: buffer).transformed(by: transform)
    image = image.transformed(by: CGAffineTransform(translationX: -image.extent.minX, y: -image.extent.minY))
    let scale = CGFloat(target) / image.extent.width
    image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let height = Int(image.extent.height) & ~1
    let bounds = CGRect(x: 0, y: 0, width: target, height: height)
    guard height > 8, let cg = context.createCGImage(image, from: bounds) else { return nil }
    var gray = [UInt8](repeating: 0, count: target * height)
    let drawn: Bool = gray.withUnsafeMutableBytes { bytes in
        guard let ctx = CGContext(data: bytes.baseAddress, width: target, height: height, bitsPerComponent: 8, bytesPerRow: target, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
        ctx.draw(cg, in: bounds)
        return true
    }
    return drawn ? Small(image: cg, gray: gray, width: target, height: height) : nil
}

private func apply(_ m: simd_float3x3, _ x: Float, _ y: Float) -> SIMD2<Float> {
    let v = m * SIMD3<Float>(x, y, 1)
    return SIMD2(v.x / v.z, v.y / v.z)
}

/// How a frame moved to become the next one. Fit compares the frames with and without the warp,
/// because Vision returns a transform even for two unrelated pictures.
private func register(_ from: Small, _ to: Small) -> [String: Double]? {
    let request = VNHomographicImageRegistrationRequest(targetedCGImage: from.image, options: [:])
    let handler = VNImageRequestHandler(cgImage: to.image, options: [:])
    guard (try? handler.perform([request])) != nil, let warp = (request.results?.first as? VNImageHomographicAlignmentObservation)?.warpTransform else { return nil }

    let w = Float(to.width)
    let h = Float(to.height)
    let center = SIMD2<Float>(w / 2, h / 2)
    let probes: [SIMD2<Float>] = [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]].map { SIMD2($0[0] * w, $0[1] * h) }
    var shift = SIMD2<Float>(0, 0)
    var scale: Float = 0
    var turn: Float = 0
    let mapped = apply(warp, center.x, center.y)
    for p in probes {
        let q = apply(warp, center.x + p.x, center.y + p.y)
        shift += q - center
        let r = q - mapped
        scale += simd_length(r) / simd_length(p)
        turn += atan2(p.x * r.y - p.y * r.x, simd_dot(p, r))
    }
    shift /= 4
    scale /= 4
    turn /= 4

    // Vision's origin is bottom-left and the transform carries the target onto the reference.
    var before = 0
    var after = 0
    var count = 0
    let stride = max(2, to.width / 80)
    for y in Swift.stride(from: stride, to: to.height - stride, by: stride) {
        for x in Swift.stride(from: stride, to: to.width - stride, by: stride) {
            let q = apply(warp, Float(x), Float(to.height - 1 - y))
            let qx = Int(q.x.rounded())
            let qy = from.height - 1 - Int(q.y.rounded())
            guard qx >= 0, qy >= 0, qx < from.width, qy < from.height else { continue }
            let target = Int(to.gray[y * to.width + x])
            after += abs(Int(from.gray[qy * from.width + qx]) - target)
            before += abs(Int(from.gray[y * from.width + x]) - target)
            count += 1
        }
    }
    guard count > 20 else { return nil }
    return [
        "scale": Double(1 / max(scale, 0.01)),
        "dx": Double(-shift.x / w),
        "dy": Double(shift.y / h),
        "turn": Double(-turn),
        "before": Double(before) / Double(count) / 255,
        "after": Double(after) / Double(count) / 255,
    ]
}

/// Measures the camera: push, pull, pan and shake between samples, and the zoom across each cut.
/// `scale` above 1 means the picture grew, so the camera pushed in.
func measureMotion(_ args: Args) async throws {
    guard let path = args.positional.first else { Out.fail("Give a video path.") }
    let rate = args.double("rate", 6)
    let width = Int(args.double("width", 480))
    let cuts = (args.string("cuts") ?? "").split(separator: ",").compactMap { Double($0) }.sorted()
    let reader = try await FrameReader(url: fileURL(path))
    let frame = 1 / max(1, reader.frameRate)

    var samples: [[String: Double]] = []
    var cutResults: [[String: Double]] = []
    var last: (Small, Double)?
    var beforeCut: (Small, Double)?
    var nextSample = 0.0
    var cutIndex = 0
    var awaiting: Double?
    var count = 0

    while let (buffer, time) = reader.next() {
        let t = time.seconds
        count += 1
        if count % 30 == 0, reader.duration > 0 { Out.progress(t / reader.duration) }
        while cutIndex < cuts.count, cuts[cutIndex] < t - frame * 1.5 { cutIndex += 1 }
        let cut = cutIndex < cuts.count ? cuts[cutIndex] : nil
        let closing = cut.map { t < $0 && t + frame * 1.5 >= $0 } ?? false
        let opening = awaiting != nil
        let sampling = t >= nextSample
        guard sampling || closing || opening || (cut.map { t >= $0 } ?? false) else { continue }
        guard let small = shrink(buffer, transform: reader.transform, width: width) else { continue }

        if closing { beforeCut = (small, t) }
        if let target = awaiting, let held = beforeCut, t >= target {
            if var r = autoreleasepool(invoking: { register(held.0, small) }) {
                r["t"] = target
                cutResults.append(r)
            }
            awaiting = nil
            beforeCut = nil
        }
        if let c = cut, t >= c, awaiting == nil, beforeCut != nil {
            if var r = autoreleasepool(invoking: { register(beforeCut!.0, small) }) {
                r["t"] = c
                cutResults.append(r)
            }
            beforeCut = nil
            cutIndex += 1
        }
        if sampling {
            // A registration across a cut would be meaningless, so a cut restarts the chain.
            let crossed = last.map { previous in cuts.contains { $0 > previous.1 && $0 <= t } } ?? true
            if let previous = last, !crossed, var r = autoreleasepool(invoking: { register(previous.0, small) }) {
                r["t"] = t
                r["dt"] = t - previous.1
                samples.append(r)
            }
            last = (small, t)
            nextSample = t + 1 / rate
        }
    }
    Out.done(["samples": samples, "cuts": cutResults, "fps": reader.frameRate, "duration": reader.duration])
}
