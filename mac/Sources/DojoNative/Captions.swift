import AVFoundation
import CoreText
import Foundation

private struct Spec: Decodable {
    struct Word: Decodable {
        let text: String
        let start: Double
        let end: Double
    }
    struct Chunk: Decodable {
        let start: Double
        let end: Double
        let words: [Word]
    }
    struct Style: Decodable {
        var font: String?
        var size: Double?
        var color: String?
        var highlight: String?
        var strokeColor: String?
        var strokeWidth: Double?
        var position: Double?
        var uppercase: Bool?
        var maxWidth: Double?
    }
    let width: Int
    let height: Int
    let fps: Double
    let duration: Double
    let chunks: [Chunk]
    let style: Style
}

private func cgColor(_ hex: String) -> CGColor {
    let v = UInt32(hex.replacingOccurrences(of: "#", with: ""), radix: 16) ?? 0xFFFFFF
    return CGColor(srgbRed: CGFloat((v >> 16) & 255) / 255, green: CGFloat((v >> 8) & 255) / 255, blue: CGFloat(v & 255) / 255, alpha: 1)
}

/// Renders word-highlighted captions to a transparent video layer.
/// Frames are only redrawn when the highlighted word changes, which keeps this fast.
func renderCaptions(_ args: Args) async throws {
    let spec = try JSONDecoder().decode(Spec.self, from: Data(contentsOf: fileURL(args.require("spec"))))
    let output = fileURL(args.require("output"))
    let writer = try AlphaWriter(url: output, width: spec.width, height: spec.height, codec: .prores)
    let fontName = spec.style.font ?? "Avenir Next Heavy"
    let size = CGFloat(spec.style.size ?? Double(spec.height) * 0.062)
    let font = CTFontCreateWithName(fontName as CFString, size, nil)
    let base = cgColor(spec.style.color ?? "#FFFFFF")
    let highlight = cgColor(spec.style.highlight ?? "#FFD34E")
    let stroke = cgColor(spec.style.strokeColor ?? "#000000")
    let strokeWidth = CGFloat(spec.style.strokeWidth ?? 8)
    let uppercase = spec.style.uppercase ?? false
    let y = CGFloat(spec.style.position ?? 0.16) * CGFloat(spec.height)
    let limit = CGFloat(spec.style.maxWidth ?? 0.86) * CGFloat(spec.width)

    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    let frames = Int(spec.duration * spec.fps)
    var lastKey = "__"
    var held: CVPixelBuffer?
    var cursor = 0

    for f in 0..<frames {
        let t = Double(f) / spec.fps
        while cursor < spec.chunks.count, spec.chunks[cursor].end <= t { cursor += 1 }
        let chunk = cursor < spec.chunks.count && spec.chunks[cursor].start <= t ? spec.chunks[cursor] : nil
        let active = chunk?.words.lastIndex { $0.start <= t } ?? -1
        let key = "\(chunk == nil ? -1 : cursor):\(active)"

        if key != lastKey || held == nil {
            lastKey = key
            guard let buffer = writer.makeBuffer() else { throw NSError(domain: "dojo", code: 9) }
            CVPixelBufferLockBaseAddress(buffer, [])
            memset(CVPixelBufferGetBaseAddress(buffer), 0, CVPixelBufferGetDataSize(buffer))
            if let chunk, let ctx = CGContext(
                data: CVPixelBufferGetBaseAddress(buffer), width: spec.width, height: spec.height, bitsPerComponent: 8,
                bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
            ) {
                draw(chunk, active: active, in: ctx, font: font, base: base, highlight: highlight, stroke: stroke, strokeWidth: strokeWidth, uppercase: uppercase, y: y, width: CGFloat(spec.width), limit: limit)
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            held = buffer
        }
        try writer.append(held!, at: CMTime(value: CMTimeValue(f * 1000), timescale: CMTimeScale(spec.fps * 1000)))
        if f % 60 == 0 { Out.progress(Double(f) / Double(max(1, frames))) }
    }
    try await writer.finish()
    Out.done(["output": output.path, "frames": frames])
}

private func line(_ text: String, font: CTFont, color: CGColor, strokeWidth: CGFloat? = nil) -> CTLine {
    var attributes: [CFString: Any] = [kCTFontAttributeName: font, kCTForegroundColorAttributeName: color]
    if let strokeWidth {
        attributes[kCTStrokeColorAttributeName] = color
        attributes[kCTStrokeWidthAttributeName] = strokeWidth
    }
    return CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes as [NSAttributedString.Key: Any]))
}

private func draw(_ chunk: Spec.Chunk, active: Int, in ctx: CGContext, font: CTFont, base: CGColor, highlight: CGColor, stroke: CGColor, strokeWidth: CGFloat, uppercase: Bool, y: CGFloat, width: CGFloat, limit: CGFloat) {
    let space = CTLineGetTypographicBounds(line(" ", font: font, color: base), nil, nil, nil)
    var rows: [[(Int, String, CGFloat)]] = [[]]
    var rowWidth: CGFloat = 0
    for (i, word) in chunk.words.enumerated() {
        let text = uppercase ? word.text.uppercased() : word.text
        let w = CGFloat(CTLineGetTypographicBounds(line(text, font: font, color: base), nil, nil, nil))
        if rowWidth + w > limit, !rows[rows.count - 1].isEmpty {
            rows.append([])
            rowWidth = 0
        }
        rows[rows.count - 1].append((i, text, w))
        rowWidth += w + CGFloat(space)
    }
    let leading = CTFontGetSize(font) * 1.18
    ctx.setLineJoin(.round)
    for (r, row) in rows.enumerated() {
        let total = row.reduce(CGFloat(0)) { $0 + $1.2 } + CGFloat(space) * CGFloat(row.count - 1)
        var x = (width - total) / 2
        let baseline = y + CGFloat(rows.count - 1 - r) * leading
        for (i, text, w) in row {
            ctx.textPosition = CGPoint(x: x, y: baseline)
            if strokeWidth > 0 {
                CTLineDraw(line(text, font: font, color: stroke, strokeWidth: strokeWidth / CTFontGetSize(font) * 100), ctx)
            }
            ctx.textPosition = CGPoint(x: x, y: baseline)
            CTLineDraw(line(text, font: font, color: i == active ? highlight : base), ctx)
            x += w + CGFloat(space)
        }
    }
}
