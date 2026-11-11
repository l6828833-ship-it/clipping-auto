import AVFoundation
import Speech

enum CaptionError: LocalizedError {
    case unavailable, permission, noAudio, noSpeech, length

    var errorDescription: String? {
        switch self {
        case .unavailable: "On-device captions are unavailable for this device or language. You can add text manually."
        case .permission: "Allow Speech Recognition in Settings to generate captions."
        case .noAudio: "This video has no audio track. You can add text manually."
        case .noSpeech: "No speech was detected in this selection."
        case .length: "Select up to 60 seconds to generate captions."
        }
    }
}

@MainActor
enum LocalCaptions {
    static func generate(url: URL, start: Double, end: Double) async throws -> [CaptionCue] {
        guard end - start <= 60 else { throw CaptionError.length }
        let asset = AVURLAsset(url: url)
        guard try await !asset.loadTracks(withMediaType: .audio).isEmpty else { throw CaptionError.noAudio }
        guard let recognizer = SFSpeechRecognizer(), recognizer.supportsOnDeviceRecognition else {
            throw CaptionError.unavailable
        }

        let authorization = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard authorization == .authorized else { throw CaptionError.permission }
        guard recognizer.isAvailable else { throw CaptionError.unavailable }

        let audio = URL.temporaryDirectory.appending(path: UUID().uuidString + ".m4a")
        defer { try? FileManager.default.removeItem(at: audio) }
        try await StudioMedia.prepareSpeechAudio(url, start: start, end: end, output: audio)

        let request = SFSpeechURLRecognitionRequest(url: audio)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        request.taskHint = .dictation
        let state = CaptionRecognition()
        let cues = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                state.start(continuation, recognizer: recognizer, request: request, offset: start, end: end)
            }
        } onCancel: {
            state.cancel()
        }
        guard !cues.isEmpty else { throw CaptionError.noSpeech }
        return cues
    }
}

private final class CaptionRecognition: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<[CaptionCue], any Error>?
    private var task: SFSpeechRecognitionTask?
    private var finished = false

    func start(_ continuation: CheckedContinuation<[CaptionCue], any Error>,
               recognizer: SFSpeechRecognizer, request: SFSpeechRecognitionRequest, offset: Double, end: Double) {
        lock.lock()
        if finished {
            lock.unlock()
            continuation.resume(throwing: CancellationError())
            return
        }
        self.continuation = continuation
        lock.unlock()

        let recognition = recognizer.recognitionTask(with: request) { [self] result, error in
            if let result, result.isFinal {
                let segments = result.bestTranscription.segments
                let cues = stride(from: 0, to: segments.count, by: 4).compactMap { index -> CaptionCue? in
                    let group = segments[index..<min(index + 4, segments.count)]
                    guard let first = group.first, let last = group.last else { return nil }
                    let start = offset + first.timestamp
                    let stop = min(end, offset + last.timestamp + max(0.25, last.duration))
                    guard stop > start else { return nil }
                    return .init(text: group.map(\.substring).joined(separator: " "), start: start, end: stop)
                }
                finish(.success(cues), cancel: false)
            } else if let error {
                finish(.failure(error), cancel: false)
            }
        }
        lock.lock()
        if finished {
            lock.unlock()
            recognition.cancel()
        } else {
            task = recognition
            lock.unlock()
        }
    }

    func cancel() {
        finish(.failure(CancellationError()), cancel: true)
    }

    private func finish(_ result: Result<[CaptionCue], any Error>, cancel: Bool) {
        lock.lock()
        finished = true
        let active = task
        task = nil
        let pending = continuation
        continuation = nil
        lock.unlock()
        if cancel { active?.cancel() }
        pending?.resume(with: result)
    }
}
