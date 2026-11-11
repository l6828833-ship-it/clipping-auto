import AVFoundation
import CoreTransferable
import Observation
import UniformTypeIdentifiers

enum ClipFormat: String, CaseIterable, Codable, Identifiable {
    case vertical = "9:16"
    case square = "1:1"
    case wide = "16:9"

    var id: Self { self }
    var size: CGSize {
        switch self {
        case .vertical: CGSize(width: 1080, height: 1920)
        case .square: CGSize(width: 1080, height: 1080)
        case .wide: CGSize(width: 1920, height: 1080)
        }
    }
    var aspect: CGFloat { size.width / size.height }
}

struct CaptionCue: Codable, Identifiable, Equatable, Sendable {
    var id = UUID()
    var text: String
    var start: Double
    var end: Double
}

struct ClipProject: Codable, Identifiable, Equatable {
    let id: UUID
    let sourceName: String
    let sourceDuration: Double
    let width: Double
    let height: Double
    var title: String
    var modified = Date()
    var start = 0.0
    var end: Double
    var format = ClipFormat.vertical
    var zoom = 1.0
    var panX = 0.0
    var panY = 0.0
    var muted = false
    var caption = ""
    var cues: [CaptionCue] = []
    var originalURL: URL?

    var sourceSize: CGSize { CGSize(width: width, height: height) }
    var length: Double { end - start }
}

struct StudioExport: Codable, Identifiable {
    var id = UUID()
    var title: String
    var created = Date()
    var duration: Double
    var format: ClipFormat
}

enum StudioError: LocalizedError {
    case invalidVideo, emptyRange, noExport, invalidLink, unavailableLink, missingSample

    var errorDescription: String? {
        switch self {
        case .invalidVideo: "Choose a playable video file, such as an MP4 or MOV."
        case .emptyRange: "Choose a clip with a start time before its end time."
        case .noExport: "The video couldn’t be exported. Try a shorter clip or a different source."
        case .invalidLink: "Enter a direct HTTPS link to an MP4 or MOV video."
        case .unavailableLink: "The video couldn’t be downloaded from this link."
        case .missingSample: "The sample video is unavailable."
        }
    }
}

@MainActor
@Observable
final class StudioLibrary {
    private struct Index: Codable {
        var projects: [ClipProject] = []
        var exports: [StudioExport] = []
    }

    private static let directory = URL.applicationSupportDirectory.appending(path: "ShortsPro", directoryHint: .isDirectory)
    private static let indexURL = directory.appending(path: "Library.json")
    private var index = Index()
    private var loadError: Error?

    var projects: [ClipProject] { index.projects.sorted { $0.modified > $1.modified } }
    var exports: [StudioExport] { index.exports.sorted { $0.created > $1.created } }
    var libraryIssue: String? { loadError?.localizedDescription }

    init() {
        do {
            try FileManager.default.createDirectory(at: Self.directory, withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: Self.indexURL.path) {
                index = try JSONDecoder().decode(Index.self, from: Data(contentsOf: Self.indexURL))
            }
        } catch {
            loadError = error
        }
    }

    func sourceURL(_ project: ClipProject) -> URL {
        Self.directory.appending(path: project.sourceName)
    }

    func posterURL(_ project: ClipProject) -> URL {
        Self.directory.appending(path: project.id.uuidString + ".jpg")
    }

    func exportURL(_ item: StudioExport) -> URL {
        Self.directory.appending(path: item.id.uuidString + ".mp4")
    }

    func importVideo(
        _ source: URL, title: String? = nil, captions: [CaptionCue] = [],
        initialDuration: Double = 30, originalURL: URL? = nil
    ) async throws -> ClipProject {
        if let loadError { throw loadError }
        let id = UUID()
        let ext = source.pathExtension.lowercased()
        let name = id.uuidString + "." + (["mp4", "mov", "m4v"].contains(ext) ? ext : "mov")
        let destination = Self.directory.appending(path: name)
        let thumbnail = Self.directory.appending(path: id.uuidString + ".jpg")

        try await Task.detached(priority: .userInitiated) {
            let scoped = source.startAccessingSecurityScopedResource()
            defer { if scoped { source.stopAccessingSecurityScopedResource() } }
            try FileManager.default.copyItem(at: source, to: destination)
        }.value

        do {
            let asset = AVURLAsset(url: destination)
            guard let track = try await asset.loadTracks(withMediaType: .video).first else {
                throw StudioError.invalidVideo
            }
            let duration = try await asset.load(.duration).seconds
            let size = try await track.load(.naturalSize, .preferredTransform)
            let oriented = CGRect(origin: .zero, size: size.0).applying(size.1).standardized.size
            guard duration.isFinite, duration > 0, oriented.width > 0, oriented.height > 0 else {
                throw StudioError.invalidVideo
            }

            let generator = AVAssetImageGenerator(asset: asset)
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 450, height: 450)
            if let image = try? await generator.image(at: .zero).image {
                try? StudioMedia.savePoster(image, to: thumbnail)
            }

            let project = ClipProject(
                id: id, sourceName: name, sourceDuration: duration,
                width: oriented.width, height: oriented.height,
                title: title ?? source.deletingPathExtension().lastPathComponent,
                end: min(initialDuration, duration), cues: captions, originalURL: originalURL
            )
            var updated = index
            updated.projects.append(project)
            try commit(updated)
            return project
        } catch {
            try? FileManager.default.removeItem(at: destination)
            try? FileManager.default.removeItem(at: thumbnail)
            throw error
        }
    }

    func importLink(_ address: String) async throws -> ClipProject {
        guard let url = URL(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme?.lowercased() == "https", url.host != nil,
              url.user == nil, url.password == nil else { throw StudioError.invalidLink }
        let (download, response) = try await URLSession.shared.download(from: url)
        defer { try? FileManager.default.removeItem(at: download) }
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode), http.url?.scheme == "https" else {
            throw StudioError.unavailableLink
        }
        let title = url.deletingPathExtension().lastPathComponent
        return try await importVideo(download, title: title.isEmpty ? "Imported video" : title)
    }

    func save(_ project: ClipProject) throws {
        guard let position = index.projects.firstIndex(where: { $0.id == project.id }) else { return }
        var updated = index
        updated.projects[position] = project
        updated.projects[position].modified = .now
        try commit(updated)
    }

    func render(_ project: ClipProject) async throws -> StudioExport {
        let item = StudioExport(title: project.title, duration: project.length, format: project.format)
        let output = exportURL(item)
        do {
            try await StudioMedia.render([.init(url: sourceURL(project), project: project)], format: project.format, to: output)
            try addExport(item)
            return item
        } catch {
            try? FileManager.default.removeItem(at: output)
            throw error
        }
    }

    func renderReel(_ clips: [StudioExport]) async throws -> StudioExport {
        let item = StudioExport(title: "Reel", duration: clips.reduce(0) { $0 + $1.duration }, format: .vertical)
        let output = exportURL(item)
        do {
            try await StudioMedia.render(clips.map { .init(url: exportURL($0), project: nil) }, format: .vertical, to: output)
            try addExport(item)
            return item
        } catch {
            try? FileManager.default.removeItem(at: output)
            throw error
        }
    }

    func remove(_ project: ClipProject) throws {
        var updated = index
        updated.projects.removeAll { $0.id == project.id }
        try commit(updated)
        try? FileManager.default.removeItem(at: sourceURL(project))
        try? FileManager.default.removeItem(at: posterURL(project))
    }

    func remove(_ item: StudioExport) throws {
        var updated = index
        updated.exports.removeAll { $0.id == item.id }
        try commit(updated)
        try? FileManager.default.removeItem(at: exportURL(item))
    }

    private func addExport(_ item: StudioExport) throws {
        var updated = index
        updated.exports.append(item)
        try commit(updated)
    }

    private func commit(_ updated: Index) throws {
        if let loadError { throw loadError }
        try JSONEncoder().encode(updated).write(to: Self.indexURL, options: .atomic)
        index = updated
    }
}

struct PickedMovie: Transferable {
    let url: URL
    let title: String

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let name = received.file.deletingPathExtension().lastPathComponent
            let destination = URL.temporaryDirectory.appending(path: UUID().uuidString)
                .appendingPathExtension(received.file.pathExtension)
            try FileManager.default.copyItem(at: received.file, to: destination)
            return Self(url: destination, title: name.isEmpty ? "Photos video" : name)
        }
    }
}

func studioTime(_ time: Double) -> String {
    let seconds = max(0, Int(time.rounded(.down)))
    return String(format: "%d:%02d", seconds / 60, seconds % 60)
}

func clipTime(_ time: Double) -> String {
    String(format: "%@.%01d", studioTime(time), Int((time * 10).rounded(.down)) % 10)
}
