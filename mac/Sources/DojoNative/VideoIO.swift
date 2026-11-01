import AVFoundation
import VideoToolbox

/// Decodes a video to BGRA frames. Timestamps are preserved so output stays in sync.
final class FrameReader {
    let reader: AVAssetReader
    let output: AVAssetReaderTrackOutput
    let size: CGSize
    let frameRate: Double
    let duration: Double
    let transform: CGAffineTransform

    init(url: URL) async throws {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            throw NSError(domain: "dojo", code: 1, userInfo: [NSLocalizedDescriptionKey: "This file has no video track."])
        }
        size = try await track.load(.naturalSize)
        transform = try await track.load(.preferredTransform)
        let nominal = try await track.load(.nominalFrameRate)
        frameRate = nominal > 0 ? Double(nominal) : 30
        duration = try await asset.load(.duration).seconds
        reader = try AVAssetReader(asset: asset)
        output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        output.alwaysCopiesSampleData = false
        reader.add(output)
        guard reader.startReading() else {
            throw reader.error ?? NSError(domain: "dojo", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not read this video."])
        }
    }

    func next() -> (CVPixelBuffer, CMTime)? {
        guard let sample = output.copyNextSampleBuffer(), let buffer = CMSampleBufferGetImageBuffer(sample) else { return nil }
        return (buffer, CMSampleBufferGetPresentationTimeStamp(sample))
    }
}

enum AlphaCodec: String {
    case prores
    case hevc
}

/// Writes straight-alpha BGRA frames as ProRes 4444 or HEVC with alpha.
final class AlphaWriter {
    let writer: AVAssetWriter
    let input: AVAssetWriterInput
    let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private var started = false

    init(url: URL, width: Int, height: Int, codec: AlphaCodec, transform: CGAffineTransform = .identity) throws {
        try? FileManager.default.removeItem(at: url)
        writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        var settings: [String: Any] = [AVVideoWidthKey: width, AVVideoHeightKey: height]
        switch codec {
        case .prores:
            settings[AVVideoCodecKey] = AVVideoCodecType.proRes4444
        case .hevc:
            settings[AVVideoCodecKey] = AVVideoCodecType.hevcWithAlpha
            settings[AVVideoCompressionPropertiesKey] = [
                kVTCompressionPropertyKey_Quality as String: 0.82,
                kVTCompressionPropertyKey_TargetQualityForAlpha as String: 0.95,
            ]
        }
        input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = false
        input.transform = transform
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
        ])
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? NSError(domain: "dojo", code: 3) }
    }

    func makeBuffer() -> CVPixelBuffer? {
        guard let pool = adaptor.pixelBufferPool else { return nil }
        var out: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out)
        return out
    }

    func append(_ buffer: CVPixelBuffer, at time: CMTime) throws {
        if !started {
            writer.startSession(atSourceTime: time)
            started = true
        }
        while !input.isReadyForMoreMediaData {
            if writer.status == .failed { throw writer.error ?? NSError(domain: "dojo", code: 4) }
            usleep(500)
        }
        guard adaptor.append(buffer, withPresentationTime: time) else {
            throw writer.error ?? NSError(domain: "dojo", code: 5)
        }
    }

    func finish() async throws {
        input.markAsFinished()
        await writer.finishWriting()
        if writer.status != .completed { throw writer.error ?? NSError(domain: "dojo", code: 6) }
    }
}
