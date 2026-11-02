import AVFoundation
import CoreText
import Foundation

private struct Spec: Decodable {
    struct Word: Decodable {
        let text: String
        let start: Double
        let end: Double
        var scale: Double?
        var font: String?
        var color: String?
        var breakBefore: Bool?
    }
    struct Chunk: Decodable {
        let start: Double
        let end: Double
        let words: [Word]
        var y: Double?
        var x: Double?
    }
    struct Style: Decodable {
        var font: String?
        var size: Double?
        var color: String?
        var highlight: String?
        var strokeColor: String?
        var strokeWidth: Double?
        var glowColor: String?
        var glowRadius: Double?
        var boxColor: String?
        var boxOpacity: Double?
        var position: Double?
        var x: Double?
        var uppercase: Bool?
        var maxWidth: Double?
        var animation: String?
        var animationSeconds: Double?
        var reveal: String?
        var lineHeight: Double?
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

private let easeOut = { (p: Double) in 1 - pow(1 - p, 3) }

/// A spring that overshoots and settles, which is what makes a pop feel physical.
private let spring = { (p: Double) in 1 - exp(-6 * p) * cos(p * 9) }

/// How far a word is through its entrance, from 0 to 1.
private func entrance(_ start: Double, _ t: Double, _ seconds: Double) -> Double {
    seconds <= 0 ? 1 : min(1, max(0, (t - start) / seconds))
}

private final class Painter {
    let spec: Spec
    let style: Spec.Style
    let baseSize: CGFloat
    let baseFont: String
    let base: CGColor
    let highlight: CGColor
    let stroke: CGColor
    let strokeWidth: CGFloat
    let glow: CGColor?
    let glowRadius: CGFloat
    let uppercase: Bool
    let limit: CGFloat
    let animation: String
    let seconds: Double
    let wordReveal: Bool
    let leading: CGFloat
    private var fonts: [String: CTFont] = [:]

    init(_ spec: Spec) {
        self.spec = spec
        style = spec.style
        baseSize = CGFloat(style.size ?? Double(spec.height) * 0.062)
        baseFont = style.font ?? "Avenir Next Heavy"
        base = cgColor(style.color ?? "#FFFFFF")
        highlight = cgColor(style.highlight ?? style.color ?? "#FFD34E")
        stroke = cgColor(style.strokeColor ?? "#000000")
        strokeWidth = CGFloat(style.strokeWidth ?? 0)
        glow = style.glowColor.map(cgColor)
        glowRadius = CGFloat(style.glowRadius ?? 0)
        uppercase = style.uppercase ?? false
        limit = CGFloat(style.maxWidth ?? 0.86) * CGFloat(spec.width)
        animation = style.animation ?? "pop"
        seconds = style.animationSeconds ?? 0.22
        wordReveal = style.reveal == "word"
        leading = CGFloat(style.lineHeight ?? 1.1)
    }

    func font(_ name: String, _ size: CGFloat) -> CTFont {
        let key = "\(name)@\(size)"
        if let f = fonts[key] { return f }
        let f = CTFontCreateWithName(name as CFString, size, nil)
        fonts[key] = f
        return f
    }

    func line(_ text: String, font: CTFont, color: CGColor, strokeWidth: CGFloat? = nil) -> CTLine {
        var attributes: [CFString: Any] = [kCTFontAttributeName: font, kCTForegroundColorAttributeName: color]
        if let strokeWidth {
            attributes[kCTStrokeColorAttributeName] = color
            attributes[kCTStrokeWidthAttributeName] = strokeWidth
        }
        return CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes as [NSAttributedString.Key: Any]))
    }

    /// True while anything is still animating, so held frames stay cheap to write.
    func moving(_ chunk: Spec.Chunk, _ t: Double) -> Bool {
        guard animation != "none" else { return false }
        if wordReveal { return chunk.words.contains { t >= $0.start && t < $0.start + seconds } }
        return t < chunk.start + seconds
    }

    struct Placed {
        let index: Int
        let text: String
        let font: CTFont
        let width: CGFloat
        let size: CGFloat
    }

    func draw(_ chunk: Spec.Chunk, _ t: Double, in ctx: CGContext) {
        let width = CGFloat(spec.width)
        let height = CGFloat(spec.height)
        var rows: [[Placed]] = [[]]
        var rowWidth: CGFloat = 0
        for (i, word) in chunk.words.enumerated() {
            let text = uppercase ? word.text.uppercased() : word.text
            let size = baseSize * CGFloat(word.scale ?? 1)
            let f = font(word.font ?? baseFont, size)
            let gap = CGFloat(CTLineGetTypographicBounds(line(" ", font: f, color: base), nil, nil, nil))
            let w = CGFloat(CTLineGetTypographicBounds(line(text, font: f, color: base), nil, nil, nil))
            if ((word.breakBefore ?? false) || rowWidth + w > limit), !rows[rows.count - 1].isEmpty {
                rows.append([])
                rowWidth = 0
            }
            rows[rows.count - 1].append(Placed(index: i, text: text, font: f, width: w, size: size))
            rowWidth += w + gap
        }

        let heights = rows.map { row in (row.map(\.size).max() ?? baseSize) * leading }
        let total = heights.reduce(0, +)
        let anchorX = CGFloat(chunk.x ?? style.x ?? 0.5) * width
        let anchorY = CGFloat(chunk.y ?? style.position ?? 0.16) * height
        let active = chunk.words.lastIndex { $0.start <= t } ?? -1

        if let box = style.boxColor, let widest = rows.map({ row in row.reduce(CGFloat(0)) { $0 + $1.width } + baseSize * 0.3 * CGFloat(max(0, row.count - 1)) }).max() {
            let pad = baseSize * 0.4
            ctx.setFillColor(cgColor(box).copy(alpha: CGFloat(style.boxOpacity ?? 0.7)) ?? cgColor(box))
            let rect = CGRect(x: anchorX - widest / 2 - pad, y: anchorY - pad * 0.7, width: widest + pad * 2, height: total + pad)
            ctx.addPath(CGPath(roundedRect: rect, cornerWidth: pad * 0.7, cornerHeight: pad * 0.7, transform: nil))
            ctx.fillPath()
        }

        var top = anchorY + total
        ctx.setLineJoin(.round)
        for (r, row) in rows.enumerated() {
            top -= heights[r]
            let gaps = row.map { CGFloat(CTLineGetTypographicBounds(line(" ", font: $0.font, color: base), nil, nil, nil)) }
            let rowTotal = row.reduce(CGFloat(0)) { $0 + $1.width } + gaps.dropLast().reduce(0, +)
            var x = anchorX - rowTotal / 2
            for (k, placed) in row.enumerated() {
                let word = chunk.words[placed.index]
                defer { x += placed.width + gaps[k] }
                let start = wordReveal ? word.start : chunk.start
                guard !wordReveal || t >= start else { continue }
                paint(placed, word: word, at: CGPoint(x: x, y: top), progress: entrance(start, t, seconds), isActive: placed.index == active, in: ctx)
            }
        }
    }

    private func paint(_ placed: Placed, word: Spec.Word, at origin: CGPoint, progress p: Double, isActive: Bool, in ctx: CGContext) {
        let mid = CGPoint(x: origin.x + placed.width / 2, y: origin.y + placed.size * 0.35)
        var scale = 1.0
        var alpha = 1.0
        var lift = 0.0
        switch animation {
        case "pop":
            scale = 0.72 + 0.28 * spring(p)
            alpha = min(1, p * 3)
        case "rise":
            lift = -(1 - easeOut(p)) * Double(placed.size) * 0.45
            alpha = easeOut(p)
        case "fade":
            alpha = easeOut(p)
        case "drop":
            lift = (1 - spring(p)) * Double(placed.size) * 0.5
            alpha = min(1, p * 3)
        case "stretch":
            scale = 1.35 - 0.35 * easeOut(p)
            alpha = easeOut(p)
        default:
            break
        }

        ctx.saveGState()
        ctx.setAlpha(CGFloat(alpha))
        ctx.translateBy(x: mid.x, y: mid.y + CGFloat(lift))
        ctx.scaleBy(x: CGFloat(scale), y: CGFloat(scale))
        ctx.translateBy(x: -mid.x, y: -mid.y)
        if let glow, glowRadius > 0 { ctx.setShadow(offset: .zero, blur: glowRadius, color: glow) }
        if strokeWidth > 0 {
            ctx.textPosition = origin
            CTLineDraw(line(placed.text, font: placed.font, color: stroke, strokeWidth: strokeWidth / placed.size * 100), ctx)
        }
        let color = word.color.map(cgColor) ?? (isActive && !wordReveal ? highlight : base)
        ctx.textPosition = origin
        CTLineDraw(line(placed.text, font: placed.font, color: color), ctx)
        ctx.restoreGState()
    }
}

/// The exact names captions accept. CoreText quietly swaps in Helvetica for a name it doesn't know.
func listFonts() {
    let names = (CTFontManagerCopyAvailablePostScriptNames() as? [String]) ?? []
    Out.done(["fonts": names.filter { !$0.hasPrefix(".") }.sorted()])
}

/// Renders animated captions to a transparent video layer. Frames are only redrawn
/// while something on screen changes, which keeps long videos fast.
func renderCaptions(_ args: Args) async throws {
    let spec = try JSONDecoder().decode(Spec.self, from: Data(contentsOf: fileURL(args.require("spec"))))
    let output = fileURL(args.require("output"))
    let writer = try AlphaWriter(url: output, width: spec.width, height: spec.height, codec: .prores)
    let painter = Painter(spec)
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
        let animating = chunk.map { painter.moving($0, t) } ?? false
        let key = animating ? "f\(f)" : "\(chunk == nil ? -1 : cursor):\(active)"

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
                painter.draw(chunk, t, in: ctx)
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
