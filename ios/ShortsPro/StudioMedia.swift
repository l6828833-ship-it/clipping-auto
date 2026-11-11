import AVFoundation
import ImageIO
import CoreImage
import UniformTypeIdentifiers
import UIKit

struct ClipFraming {
    let scale: CGFloat
    let origin: CGPoint

    init(source: CGSize, canvas: CGSize, zoom: Double, x: Double, y: Double) {
        scale = max(canvas.width / source.width, canvas.height / source.height) * zoom
        origin = CGPoint(
            x: (canvas.width - source.width * scale) * (1 - x) / 2,
            y: (canvas.height - source.height * scale) * (1 - y) / 2
        )
    }
}

@MainActor
enum StudioMedia {
    struct Input {
        let url: URL
        let project: ClipProject?
    }

    static func savePoster(_ image: CGImage, to url: URL) throws {
        guard let writer = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw StudioError.invalidVideo
        }
        CGImageDestinationAddImage(writer, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(writer) else { throw StudioError.invalidVideo }
    }

    static func render(_ inputs: [Input], format: ClipFormat, to output: URL) async throws {
        let composition = AVMutableComposition()
        guard let video = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw StudioError.noExport
        }
        let audio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
        let canvas = format.size
        var cursor = CMTime.zero
        var segments: [VideoSegment] = []
        var captions: [CaptionCue] = []

        for input in inputs {
            try Task.checkCancellation()
            let asset = AVURLAsset(url: input.url)
            guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw StudioError.invalidVideo }
            let (naturalSize, orientation, available) = try await track.load(.naturalSize, .preferredTransform, .timeRange)
            let project = input.project
            let requested = CMTimeRange(
                start: project.map { time($0.start) } ?? available.start,
                end: project.map { time($0.end) } ?? available.end
            )
            let range = available.intersection(requested)
            guard range.isValid, range.duration.seconds > 0 else { throw StudioError.emptyRange }
            try video.insertTimeRange(range, of: track, at: cursor)

            if project?.muted != true,
               let audioTrack = try await asset.loadTracks(withMediaType: .audio).first {
                let audioRange = try await audioTrack.load(.timeRange).intersection(range)
                if audioRange.isValid && audioRange.duration.seconds > 0 {
                    try audio?.insertTimeRange(audioRange, of: audioTrack, at: cursor + (audioRange.start - range.start))
                }
            }

            let bounds = CGRect(origin: .zero, size: naturalSize).applying(orientation).standardized
            guard bounds.width > 0, bounds.height > 0 else { throw StudioError.invalidVideo }
            let frame = ClipFraming(
                source: bounds.size, canvas: canvas,
                zoom: project?.zoom ?? 1, x: project?.panX ?? 0, y: project?.panY ?? 0
            )
            let transform = orientation
                .concatenating(CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY))
                .concatenating(CGAffineTransform(scaleX: frame.scale, y: frame.scale))
                .concatenating(CGAffineTransform(translationX: frame.origin.x, y: frame.origin.y))
            segments.append(VideoSegment(
                range: CMTimeRange(start: cursor, duration: range.duration),
                transform: transform
            ))

            if let project {
                let manual = project.caption.trimmingCharacters(in: .whitespacesAndNewlines)
                if !manual.isEmpty {
                    captions.append(.init(text: manual, start: cursor.seconds, end: (cursor + range.duration).seconds))
                } else {
                    for cue in project.cues {
                        let start = max(cue.start, range.start.seconds)
                        let end = min(cue.end, range.end.seconds)
                        if end > start {
                            captions.append(.init(
                                text: cue.text,
                                start: cursor.seconds + start - range.start.seconds,
                                end: cursor.seconds + end - range.start.seconds
                            ))
                        }
                    }
                }
            }
            cursor = cursor + range.duration
        }

        guard cursor.seconds > 0 else { throw StudioError.emptyRange }
        let videoComposition = AVMutableVideoComposition()
        videoComposition.renderSize = canvas
        videoComposition.frameDuration = CMTime(value: 1, timescale: 30)
        if captions.isEmpty {
            videoComposition.instructions = segments.map { segment in
                let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: video)
                layer.setTransform(segment.transform, at: segment.range.start)
                let instruction = AVMutableVideoCompositionInstruction()
                instruction.timeRange = segment.range
                instruction.layerInstructions = [layer]
                return instruction
            }
        } else {
            let overlays = captions.compactMap { captionImage($0, canvas: canvas) }
            videoComposition.customVideoCompositorClass = CaptionCompositor.self
            videoComposition.instructions = segments.map {
                CaptionInstruction(segment: $0, trackID: video.trackID, overlays: overlays)
            }
        }

        guard let session = AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality),
              session.supportedFileTypes.contains(.mp4) else { throw StudioError.noExport }
        session.videoComposition = videoComposition
        session.shouldOptimizeForNetworkUse = true
        try await export(session, to: output, type: .mp4)
    }

    static func prepareSpeechAudio(_ source: URL, start: Double, end: Double, output: URL) async throws {
        let asset = AVURLAsset(url: source)
        guard try await !asset.loadTracks(withMediaType: .audio).isEmpty,
              let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
            throw CaptionError.noAudio
        }
        session.timeRange = CMTimeRange(start: time(start), end: time(end))
        try await export(session, to: output, type: .m4a)
    }

    private static func export(_ session: AVAssetExportSession, to url: URL, type: AVFileType) async throws {
        if #available(iOS 18, *) {
            try await session.export(to: url, as: type)
        } else {
            session.outputURL = url
            session.outputFileType = type
            await session.export()
            guard session.status == .completed else { throw session.error ?? StudioError.noExport }
        }
    }

    private static func time(_ seconds: Double) -> CMTime {
        CMTime(seconds: seconds, preferredTimescale: 60000)
    }

    private static func captionImage(_ cue: CaptionCue, canvas: CGSize) -> CaptionImage? {
        let size = CGSize(width: (canvas.width * 0.85).rounded(.down), height: 240)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        let text = NSAttributedString(string: cue.text, attributes: [
            .font: UIFont.systemFont(ofSize: 60, weight: .heavy),
            .foregroundColor: UIColor.white,
            .strokeColor: UIColor.black,
            .strokeWidth: -4,
            .paragraphStyle: paragraph,
        ])
        let rendered = renderer.image { _ in
            text.draw(with: CGRect(x: 4, y: 4, width: size.width - 8, height: size.height - 8),
                      options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], context: nil)
        }
        guard let image = rendered.cgImage else { return nil }
        let position = CGAffineTransform(translationX: (canvas.width - size.width) / 2, y: canvas.height * 0.085)
        return CaptionImage(image: CIImage(cgImage: image).transformed(by: position), start: cue.start, end: cue.end)
    }
}

private struct VideoSegment {
    let range: CMTimeRange
    let transform: CGAffineTransform
}

private struct CaptionImage {
    let image: CIImage
    let start: Double
    let end: Double
}

private final class CaptionInstruction: NSObject, AVVideoCompositionInstructionProtocol {
    let timeRange: CMTimeRange
    let transform: CGAffineTransform
    let trackID: CMPersistentTrackID
    let overlays: [CaptionImage]
    let enablePostProcessing = true
    let containsTweening = true
    let passthroughTrackID = kCMPersistentTrackID_Invalid
    var requiredSourceTrackIDs: [NSValue]? { [NSNumber(value: trackID)] }
    var requiredSourceSampleDataTrackIDs: [NSNumber] { [] }

    init(segment: VideoSegment, trackID: CMPersistentTrackID, overlays: [CaptionImage]) {
        timeRange = segment.range
        transform = segment.transform
        self.trackID = trackID
        self.overlays = overlays
    }
}

private final class CaptionCompositor: NSObject, AVVideoCompositing {
    private let context = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    var sourcePixelBufferAttributes: [String: any Sendable]? { requiredPixelBufferAttributesForRenderContext }
    var requiredPixelBufferAttributesForRenderContext: [String: any Sendable] {
        [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    }

    func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {}

    func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
        guard let instruction = request.videoCompositionInstruction as? CaptionInstruction,
              let source = request.sourceFrame(byTrackID: instruction.trackID),
              let output = request.renderContext.newPixelBuffer() else {
            request.finish(with: StudioError.noExport)
            return
        }
        let canvas = CGRect(origin: .zero, size: request.renderContext.size)
        let sourceHeight = CGFloat(CVPixelBufferGetHeight(source))
        // AVFoundation's crop transform uses top-left coordinates. Core Image uses bottom-left.
        let sourceFlip = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: sourceHeight)
        let canvasFlip = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: canvas.height)
        let transform = sourceFlip.concatenating(instruction.transform).concatenating(canvasFlip)
        let original = CIImage(cvPixelBuffer: source).transformed(by: transform).cropped(to: canvas)
        let time = request.compositionTime.seconds
        let image = instruction.overlays.first { $0.start <= time && time < $0.end }?
            .image.composited(over: original).cropped(to: canvas) ?? original
        context.render(image, to: output, bounds: canvas, colorSpace: colorSpace)
        request.finish(withComposedVideoFrame: output)
    }
}
