import SwiftUI

struct YouTubeSuggestion: Codable, Hashable, Identifiable {
    let title: String
    let start: Double
    let end: Double
    let reason: String

    var id: Double { start }
}

struct YouTubeAnalysis: Codable, Hashable {
    let id: String
    let title: String
    let channel: String
    let duration: Double
    let suggestions: [YouTubeSuggestion]

    var thumbnail: URL? { URL(string: "https://i.ytimg.com/vi/\(id)/hqdefault.jpg") }
    var original: URL? { URL(string: "https://www.youtube.com/watch?v=\(id)") }
}

enum YouTubeImportError: LocalizedError {
    case invalidLink, missingService, unreachable, rejected(String), invalidResponse

    var errorDescription: String? {
        switch self {
        case .invalidLink: "Paste a YouTube video, Shorts, or youtu.be link."
        case .missingService: "Set the Clip Maker service URL in the Xcode build settings to import from YouTube."
        case .unreachable: "Couldn’t reach the Clip Maker service. Check the connection and try again."
        case .rejected(let message): message
        case .invalidResponse: "Clip Maker received an unreadable response. Try again."
        }
    }
}

enum YouTubeImport {
    private struct IDBody: Encodable { let id: String }
    private struct RangeBody: Encodable {
        let id: String
        let start: Double
        let end: Double
    }
    private struct Caption: Decodable {
        let text: String
        let start: Double
        let end: Double
    }
    private struct ErrorBody: Decodable { let error: String }

    static func videoID(from address: String) -> String? {
        let input = address.trimmingCharacters(in: .whitespacesAndNewlines)
        if isID(input) { return input }
        let full = input.contains("://") ? input : "https://" + input
        guard let parts = URLComponents(string: full),
              let host = parts.host?.lowercased(),
              ["https", "http"].contains(parts.scheme?.lowercased() ?? ""),
              parts.user == nil, parts.password == nil, parts.port == nil else { return nil }
        let path = parts.path.split(separator: "/").map(String.init)
        let id: String?
        switch host {
        case "youtu.be":
            id = path.count == 1 ? path[0] : nil
        case "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com":
            if path == ["watch"] {
                id = parts.queryItems?.first { $0.name == "v" }?.value
            } else if path.count == 2 && ["shorts", "embed", "live"].contains(path[0]) {
                id = path[1]
            } else {
                id = nil
            }
        default:
            id = nil
        }
        return id.flatMap { isID($0) ? $0 : nil }
    }

    private static func isID(_ value: String) -> Bool {
        value.utf8.count == 11 && value.utf8.allSatisfy { byte in
            (48...57).contains(byte) || (65...90).contains(byte) || (97...122).contains(byte) || byte == 45 || byte == 95
        }
    }

    static func analyze(id: String) async throws -> YouTubeAnalysis {
        let request = try request(for: "analyze", body: IDBody(id: id), timeout: 50)
        let (data, response) = try await data(for: request)
        try check(response, body: data)
        let analysis = try? JSONDecoder().decode(YouTubeAnalysis.self, from: data)
        guard let analysis, analysis.id == id, analysis.duration.isFinite, analysis.duration >= 0.5,
              !analysis.suggestions.isEmpty else { throw YouTubeImportError.invalidResponse }
        return analysis
    }

    static func download(id: String, start: Double, end: Double) async throws -> URL {
        let request = try request(for: "clip", body: RangeBody(id: id, start: start, end: end), timeout: 210)
        let result: (URL, URLResponse)
        do {
            result = try await URLSession.shared.download(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw YouTubeImportError.unreachable
        }

        let (temporary, response) = result
        defer { try? FileManager.default.removeItem(at: temporary) }
        let errorBody = (response as? HTTPURLResponse).map { !(200..<300).contains($0.statusCode) } == true
        try check(response, body: errorBody ? (try? Data(contentsOf: temporary)) : nil)
        let file = URL.temporaryDirectory.appending(path: UUID().uuidString + ".mp4")
        try FileManager.default.moveItem(at: temporary, to: file)
        return file
    }

    static func captions(id: String, start: Double, end: Double) async -> [CaptionCue] {
        guard let request = try? request(for: "captions", body: RangeBody(id: id, start: start, end: end), timeout: 12),
              let (data, response) = try? await data(for: request),
              (try? check(response, body: data)) != nil,
              let items = try? JSONDecoder().decode([Caption].self, from: data) else { return [] }
        return items.compactMap { item in
            guard item.start.isFinite, item.end.isFinite, item.start >= 0, item.end > item.start else { return nil }
            return CaptionCue(text: item.text, start: item.start, end: item.end)
        }
    }

    private static func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await URLSession.shared.data(for: request)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw YouTubeImportError.unreachable
        }
    }

    private static func request(for action: String, body: some Encodable, timeout: TimeInterval) throws -> URLRequest {
        guard let setting = Bundle.main.object(forInfoDictionaryKey: "ClipMakerServiceURL") as? String,
              let base = URL(string: setting), let host = base.host,
              base.user == nil, base.password == nil else { throw YouTubeImportError.missingService }
        #if DEBUG && targetEnvironment(simulator)
        let valid = base.scheme == "https" || (base.scheme == "http" && host == "127.0.0.1")
        #else
        let valid = base.scheme == "https"
        #endif
        guard valid else { throw YouTubeImportError.missingService }
        var request = URLRequest(url: base.appending(path: "api/native/youtube").appending(path: action), timeoutInterval: timeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        return request
    }

    private static func check(_ response: URLResponse, body: Data?) throws {
        guard let http = response as? HTTPURLResponse else { throw YouTubeImportError.invalidResponse }
        if (200..<300).contains(http.statusCode) { return }
        if let body, let failure = try? JSONDecoder().decode(ErrorBody.self, from: body) {
            throw YouTubeImportError.rejected(failure.error)
        }
        throw YouTubeImportError.invalidResponse
    }
}

struct YouTubeClipPicker: View {
    let analysis: YouTubeAnalysis
    let library: StudioLibrary
    let onImport: (ClipProject) -> Void
    @State private var selected: YouTubeSuggestion?
    @State private var custom = false
    @State private var start = 0.0
    @State private var end: Double
    @State private var busy = false
    @State private var error: String?

    init(analysis: YouTubeAnalysis, library: StudioLibrary, onImport: @escaping (ClipProject) -> Void) {
        self.analysis = analysis
        self.library = library
        self.onImport = onImport
        let first = analysis.suggestions.first
        _selected = State(initialValue: first)
        _start = State(initialValue: first?.start ?? 0)
        _end = State(initialValue: first?.end ?? min(30, analysis.duration))
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    videoCard
                    HStack {
                        Text("Choose a clip").font(.title2.bold()).accessibilityAddTraits(.isHeader)
                        Spacer()
                        Button(custom ? "Suggestions" : "Custom range") {
                            custom.toggle()
                            if !custom, let selected {
                                start = selected.start
                                end = selected.end
                            }
                        }
                            .font(.subheadline.weight(.semibold))
                    }
                    if custom {
                        rangeControls
                    } else {
                        ForEach(analysis.suggestions) { option in
                            Button {
                                selected = option
                                start = option.start
                                end = option.end
                            } label: {
                                HStack(spacing: 13) {
                                    Image(systemName: selected == option ? "largecircle.fill.circle" : "circle")
                                        .foregroundStyle(selected == option ? StudioStyle.accent : Color.secondary)
                                        .font(.title3)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(option.title).font(.subheadline.bold())
                                        Text(option.reason).font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text("\(studioTime(option.start))–\(studioTime(option.end))")
                                        .font(.caption.monospacedDigit().weight(.semibold))
                                        .foregroundStyle(StudioStyle.accent)
                                }
                                .foregroundStyle(.primary)
                                .studioCard(padding: 14)
                            }
                            .buttonStyle(.plain)
                            .accessibilityAddTraits(selected == option ? [.isSelected] : [])
                        }
                    }
                }
                .disabled(busy)
                .frame(maxWidth: 620)
                .padding(22)
                .frame(maxWidth: .infinity)
            }
            Button(action: importClip) {
                if busy {
                    ProgressView("Importing from YouTube…").tint(StudioStyle.background)
                } else {
                    Label("Edit this clip", systemImage: "scissors")
                }
            }
            .buttonStyle(StudioPrimaryButton())
            .accessibilityIdentifier("youtube-edit-clip")
            .disabled(busy || !validRange)
            .frame(maxWidth: 620)
            .padding(.horizontal, 22)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity)
            .background(.ultraThinMaterial)
        }
        .background(StudioStyle.background.ignoresSafeArea())
        .navigationTitle("YouTube video")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(busy)
        .alert("Couldn’t import clip", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) { error = nil }
        } message: { Text(error ?? "") }
    }

    private var videoCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            AsyncImage(url: analysis.thumbnail) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                ZStack {
                    StudioStyle.surface
                    Image(systemName: "play.rectangle.fill").font(.largeTitle).foregroundStyle(StudioStyle.accent)
                }
            }
            .frame(height: 144)
            .frame(maxWidth: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            Text(analysis.title).font(.headline).lineLimit(3).accessibilityIdentifier("youtube-video-title")
            Text([analysis.channel, studioTime(analysis.duration)].filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.caption).foregroundStyle(.secondary)
        }
        .studioCard()
    }

    private var rangeControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Select up to 90 seconds.").font(.caption).foregroundStyle(.secondary)
            HStack {
                Text("Start")
                Spacer()
                Text(clipTime(start)).monospacedDigit().foregroundStyle(StudioStyle.accent)
            }
            Slider(value: Binding(get: { start }, set: { value in
                start = value
                end = max(start + 0.5, min(end, start + 90))
            }), in: 0...max(0, analysis.duration - 0.5))
            .accessibilityLabel("YouTube clip start")
            HStack {
                Text("End")
                Spacer()
                Text(clipTime(end)).monospacedDigit().foregroundStyle(StudioStyle.accent)
            }
            Slider(value: $end, in: (start + 0.5)...max(start + 0.5, min(analysis.duration, start + 90)))
                .accessibilityLabel("YouTube clip end")
        }
        .font(.subheadline)
        .studioCard()
    }

    private var validRange: Bool {
        end <= analysis.duration + 0.001 && end - start >= 0.5 - 0.0001 && end - start <= 90 + 0.0001
    }

    private func importClip() {
        guard validRange, !busy else { return }
        let rangeStart = start
        let rangeEnd = end
        busy = true
        Task {
            defer { busy = false }
            do {
                async let captions = YouTubeImport.captions(id: analysis.id, start: rangeStart, end: rangeEnd)
                let file = try await YouTubeImport.download(id: analysis.id, start: rangeStart, end: rangeEnd)
                defer { try? FileManager.default.removeItem(at: file) }
                let title = selected == nil || custom ? analysis.title : "\(analysis.title) · \(studioTime(rangeStart))"
                let project = try await library.importVideo(
                    file, title: title, captions: await captions, initialDuration: rangeEnd - rangeStart,
                    originalURL: analysis.original
                )
                onImport(project)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
