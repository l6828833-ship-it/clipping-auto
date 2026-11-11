import AVKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

@main
struct ShortsProApp: App {
    @State private var library = StudioLibrary()

    var body: some Scene {
        WindowGroup {
            StudioHome(library: library)
                .preferredColorScheme(.dark)
                .tint(StudioStyle.accent)
        }
    }
}

enum StudioStyle {
    static let background = Color(red: 0.06, green: 0.06, blue: 0.08)
    static let surface = Color(red: 0.105, green: 0.105, blue: 0.135)
    static let border = Color.white.opacity(0.10)
    static let accent = Color(red: 0.74, green: 0.71, blue: 1.00)
}

struct StudioPrimaryButton: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 54)
            .foregroundStyle(Color(red: 0.10, green: 0.08, blue: 0.18))
            .background(StudioStyle.accent, in: RoundedRectangle(cornerRadius: 16))
            .opacity(configuration.isPressed ? 0.76 : 1)
    }
}

extension View {
    func studioCard(padding: CGFloat = 16) -> some View {
        self.padding(padding)
            .background(StudioStyle.surface, in: RoundedRectangle(cornerRadius: 18))
            .overlay {
                RoundedRectangle(cornerRadius: 18)
                    .strokeBorder(StudioStyle.border)
                    .allowsHitTesting(false)
            }
    }
}

private enum StudioRoute: Hashable {
    case youtube(YouTubeAnalysis)
    case project(UUID)
    case export(UUID)
    case reel
}

private enum LibraryRemoval {
    case project(ClipProject)
    case export(StudioExport)
}

private struct StudioHome: View {
    let library: StudioLibrary
    @State private var path: [StudioRoute] = []
    @State private var picked: PhotosPickerItem?
    @State private var choosePhotos = false
    @State private var chooseFile = false
    @State private var showLink = false
    @State private var link = ""
    @State private var busy = false
    @State private var youtubeLink = ""
    @State private var analyzing = false
    @State private var youtubeError: String?
    @FocusState private var editingYouTubeLink: Bool
    @State private var error: String?
    @State private var removal: LibraryRemoval?

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 27) {
                    header
                    if library.projects.isEmpty {
                        sampleCard
                    } else {
                        projectsSection
                    }
                    if !library.exports.isEmpty {
                        exportsSection
                    }
                    if let issue = library.libraryIssue {
                        Label(issue, systemImage: "exclamationmark.circle")
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: 620)
                .padding(.horizontal, 22)
                .padding(.top, 18)
                .padding(.bottom, 30)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(StudioStyle.background.ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .principal) {
                    HStack(spacing: 7) {
                        Image(systemName: "bolt.fill")
                            .font(.system(size: 13, weight: .black))
                            .foregroundStyle(StudioStyle.accent)
                        Text("Clip Maker").font(.headline.weight(.heavy))
                    }
                    .fixedSize()
                    .accessibilityLabel("Clip Maker")
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: StudioRoute.self) { route in
                switch route {
                case .youtube(let analysis):
                    YouTubeClipPicker(analysis: analysis, library: library) { project in
                        path.append(.project(project.id))
                    }
                case .project(let id):
                    if let project = library.projects.first(where: { $0.id == id }) {
                        ClipEditor(library: library, project: project) { item in
                            path.append(.export(item.id))
                        }
                    }
                case .export(let id):
                    if let item = library.exports.first(where: { $0.id == id }) {
                        ExportPreview(item: item, url: library.exportURL(item))
                    }
                case .reel:
                    ReelBuilder(library: library) { item in
                        path.append(.export(item.id))
                    }
                }
            }
            .photosPicker(isPresented: $choosePhotos, selection: $picked, matching: .videos, preferredItemEncoding: .current)
            .onChange(of: picked) { _, item in
                guard let item else { return }
                performImport {
                    guard let movie = try await item.loadTransferable(type: PickedMovie.self) else {
                        throw StudioError.invalidVideo
                    }
                    defer { try? FileManager.default.removeItem(at: movie.url) }
                    return try await library.importVideo(movie.url, title: movie.title)
                }
                picked = nil
            }
            .fileImporter(isPresented: $chooseFile, allowedContentTypes: [.movie]) { result in
                switch result {
                case .success(let url): performImport { try await library.importVideo(url) }
                case .failure(let error): self.error = error.localizedDescription
                }
            }
            .sheet(isPresented: $showLink) { linkSheet }
            .alert("Clip Maker", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) { error = nil }
            } message: {
                Text(error ?? "")
            }
            .confirmationDialog("Remove from Clip Maker?", isPresented: Binding(
                get: { removal != nil }, set: { if !$0 { removal = nil } }
            ), titleVisibility: .visible) {
                Button("Remove", role: .destructive, action: removeSelection)
                Button("Cancel", role: .cancel) { removal = nil }
            }
            .overlay(alignment: .bottom) {
                if busy {
                    ProgressView("Importing video…")
                        .font(.subheadline)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 13)
                        .background(.regularMaterial, in: Capsule())
                        .padding(.bottom, 18)
                        .accessibilityIdentifier("import-progress")
                }
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 13) {
            Text("Make clips from YouTube")
                .font(.system(.largeTitle, design: .default).weight(.black))
                .accessibilityAddTraits(.isHeader)
            Text("Choose a moment, add captions, and export a short.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            youtubeCard
            Menu {
                Button("Photo Library", systemImage: "photo.on.rectangle") { choosePhotos = true }
                Button("Browse Files", systemImage: "folder") { chooseFile = true }
                Button("Direct Video Link", systemImage: "link") { link = ""; showLink = true }
            } label: {
                Label("Import a file instead", systemImage: "plus")
                    .font(.subheadline.weight(.semibold))
                    .frame(minHeight: 44)
            }
            .accessibilityIdentifier("import-video")
            .disabled(busy || analyzing)
        }
    }

    private var youtubeCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("YouTube link", systemImage: "play.rectangle.fill")
                .font(.subheadline.weight(.bold))
                .foregroundStyle(.primary)
            HStack(spacing: 9) {
                TextField("Paste a YouTube video URL", text: $youtubeLink)
                    .focused($editingYouTubeLink)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .accessibilityLabel("YouTube link")
                    .accessibilityIdentifier("youtube-url")
                    .onSubmit(analyzeYouTube)
                    .onChange(of: youtubeLink) { _, _ in youtubeError = nil }
                PasteButton(payloadType: String.self) { values in
                    if let first = values.first {
                        youtubeLink = first.trimmingCharacters(in: .whitespacesAndNewlines)
                    }
                }
                .labelStyle(.titleOnly)
                .controlSize(.small)
            }
            .padding(.horizontal, 11)
            .frame(minHeight: 48)
            .background(StudioStyle.background, in: RoundedRectangle(cornerRadius: 11))
            .disabled(analyzing)
            if let youtubeError {
                Label(youtubeError, systemImage: "exclamationmark.circle")
                    .font(.footnote)
                    .foregroundStyle(Color(red: 1, green: 0.61, blue: 0.64))
                    .accessibilityIdentifier("youtube-error")
            }
            Button(action: analyzeYouTube) {
                if analyzing {
                    ProgressView("Analyzing video…").tint(StudioStyle.background)
                } else {
                    Label("Analyze video", systemImage: "sparkles")
                }
            }
            .buttonStyle(StudioPrimaryButton())
            .accessibilityIdentifier("analyze-youtube")
            .disabled(busy || analyzing || youtubeLink.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .studioCard()
    }

    private func analyzeYouTube() {
        guard !busy, !analyzing else { return }
        guard let id = YouTubeImport.videoID(from: youtubeLink) else {
            youtubeError = YouTubeImportError.invalidLink.localizedDescription
            return
        }
        editingYouTubeLink = false
        youtubeError = nil
        analyzing = true
        Task {
            defer { analyzing = false }
            do { path.append(.youtube(try await YouTubeImport.analyze(id: id))) }
            catch { youtubeError = error.localizedDescription }
        }
    }

    private var sampleCard: some View {
        Button {
            performImport {
                guard let url = Bundle.main.url(forResource: "StudioSample", withExtension: "mp4") else {
                    throw StudioError.missingSample
                }
                return try await library.importVideo(url, title: "Flower study")
            }
        } label: {
            ZStack(alignment: .bottomLeading) {
                GeometryReader { layout in
                    if let image = UIImage(named: "SamplePoster") {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFill()
                            .frame(width: layout.size.width, height: layout.size.height)
                            .clipped()
                    }
                }
                LinearGradient(stops: [
                    .init(color: .black.opacity(0.15), location: 0),
                    .init(color: .black.opacity(0.02), location: 0.35),
                    .init(color: .black.opacity(0.88), location: 1)
                ], startPoint: .top, endPoint: .bottom)
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Try a sample").font(.title3.weight(.heavy))
                        Text("Flower study").font(.subheadline).foregroundStyle(.white.opacity(0.76))
                    }
                    Spacer()
                    Image(systemName: "arrow.up.right")
                        .font(.headline)
                        .frame(width: 42, height: 42)
                        .background(.ultraThinMaterial, in: Circle())
                }
                .padding(17)
            }
            .frame(height: 213)
            .background(StudioStyle.surface)
            .clipShape(RoundedRectangle(cornerRadius: 20))
            .foregroundStyle(.white)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Try a sample")
        .accessibilityIdentifier("try-sample")
        .disabled(busy || analyzing)
    }

    private var projectsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Projects").font(.title3.weight(.bold)).accessibilityAddTraits(.isHeader)
            ForEach(library.projects) { project in
                HStack(spacing: 10) {
                    NavigationLink(value: StudioRoute.project(project.id)) {
                        HStack(spacing: 13) {
                            thumbnail(project)
                            VStack(alignment: .leading, spacing: 5) {
                                Text(project.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                                Text("\(studioTime(project.length)) · \(project.format.rawValue)")
                                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            }
                            Spacer()
                        }
                        .foregroundStyle(.primary)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Menu {
                        Button("Remove project", systemImage: "trash", role: .destructive) { removal = .project(project) }
                    } label: {
                        Image(systemName: "ellipsis").frame(width: 34, height: 36)
                    }
                    .accessibilityLabel("Project options")
                }
                .studioCard(padding: 11)
            }
        }
    }

    private var exportsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Exports").font(.title3.weight(.bold)).accessibilityAddTraits(.isHeader)
                Spacer()
                if library.exports.count >= 2 {
                    NavigationLink(value: StudioRoute.reel) {
                        Label("Make reel", systemImage: "film.stack").font(.subheadline.weight(.semibold))
                    }
                }
            }
            ForEach(library.exports) { item in
                HStack {
                    NavigationLink(value: StudioRoute.export(item.id)) {
                        HStack(spacing: 13) {
                            Image(systemName: "film")
                                .font(.title3)
                                .foregroundStyle(StudioStyle.accent)
                                .frame(width: 46, height: 46)
                                .background(StudioStyle.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 11))
                            VStack(alignment: .leading, spacing: 5) {
                                Text(item.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                                Text("MP4 · \(studioTime(item.duration)) · \(item.format.rawValue)")
                                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            }
                            Spacer()
                        }
                        .foregroundStyle(.primary)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Menu {
                        ShareLink(item: library.exportURL(item), preview: SharePreview(item.title))
                        Button("Remove export", systemImage: "trash", role: .destructive) { removal = .export(item) }
                    } label: {
                        Image(systemName: "ellipsis").frame(width: 34, height: 36)
                    }
                    .accessibilityLabel("Export options")
                }
                .studioCard(padding: 11)
            }
        }
    }

    private func thumbnail(_ project: ClipProject) -> some View {
        ZStack {
            StudioStyle.background
            if let image = UIImage(contentsOfFile: library.posterURL(project).path) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Image(systemName: "film").foregroundStyle(.secondary)
            }
        }
        .frame(width: 64, height: 52)
        .clipShape(RoundedRectangle(cornerRadius: 9))
        .accessibilityHidden(true)
    }

    private var linkSheet: some View {
        NavigationStack {
            Form {
                TextField("https://example.com/video.mp4", text: $link)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Text("Use a direct link to an MP4 or MOV file.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .navigationTitle("Video Link")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showLink = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Import") {
                        let address = link
                        showLink = false
                        performImport { try await library.importLink(address) }
                    }
                    .disabled(link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func performImport(_ operation: @escaping @MainActor () async throws -> ClipProject) {
        guard !busy, !analyzing else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let project = try await operation()
                path.append(.project(project.id))
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func removeSelection() {
        guard let removal else { return }
        defer { self.removal = nil }
        do {
            switch removal {
            case .project(let project): try library.remove(project)
            case .export(let item): try library.remove(item)
            }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct ExportPreview: View {
    let item: StudioExport
    let url: URL
    @State private var player = AVPlayer()

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                VideoPlayer(player: player)
                    .aspectRatio(item.format.aspect, contentMode: .fit)
                    .frame(maxWidth: item.format == .vertical ? 300 : 590)
                    .clipShape(RoundedRectangle(cornerRadius: 18))
                    .accessibilityLabel("Exported video preview")

                VStack(spacing: 4) {
                    Text(item.title).font(.title3.weight(.bold))
                    Text("MP4 · \(item.format.rawValue) · \(clipTime(item.duration))")
                        .font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                }
                ShareLink(item: url, preview: SharePreview(item.title)) {
                    Label("Share MP4", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(StudioPrimaryButton())
                .accessibilityIdentifier("share-mp4")
            }
            .frame(maxWidth: 620)
            .padding(22)
            .frame(maxWidth: .infinity)
        }
        .background(StudioStyle.background.ignoresSafeArea())
        .navigationTitle("Export ready")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { player.replaceCurrentItem(with: AVPlayerItem(url: url)) }
        .onDisappear { player.pause() }
    }
}

private struct ReelBuilder: View {
    let library: StudioLibrary
    let onExport: (StudioExport) -> Void
    @State private var selection: [UUID] = []
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Tap 2–5 exports in playback order.")
                    .font(.subheadline).foregroundStyle(.secondary)
                ForEach(library.exports) { item in
                    Button {
                        if let index = selection.firstIndex(of: item.id) {
                            selection.remove(at: index)
                        } else if selection.count < 5 {
                            selection.append(item.id)
                        }
                    } label: {
                        HStack {
                            if let position = selection.firstIndex(of: item.id) {
                                Text("\(position + 1)")
                                    .font(.caption.weight(.bold))
                                    .foregroundStyle(StudioStyle.background)
                                    .frame(width: 27, height: 27)
                                    .background(StudioStyle.accent, in: Circle())
                            } else {
                                Image(systemName: "circle").frame(width: 27, height: 27)
                            }
                            Text(item.title).lineLimit(1)
                            Spacer()
                            Text(studioTime(item.duration)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        }
                        .foregroundStyle(.primary)
                        .studioCard(padding: 13)
                    }
                    .buttonStyle(.plain)
                    .disabled(busy)
                }
            }
            .frame(maxWidth: 620)
            .padding(22)
            .frame(maxWidth: .infinity)
        }
        .background(StudioStyle.background.ignoresSafeArea())
        .navigationTitle("Make reel")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(busy)
        .safeAreaInset(edge: .bottom) {
            Button(action: render) {
                if busy {
                    ProgressView().tint(StudioStyle.background).accessibilityLabel("Exporting reel")
                } else {
                    Label("Export reel", systemImage: "square.and.arrow.up")
                }
            }
            .buttonStyle(StudioPrimaryButton())
            .disabled(busy || selection.count < 2)
            .opacity(!busy && selection.count < 2 ? 0.45 : 1)
            .padding(.horizontal, 22)
            .padding(.vertical, 10)
            .background(.ultraThinMaterial)
        }
        .alert("Couldn’t export reel", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) { error = nil }
        } message: { Text(error ?? "") }
    }

    private func render() {
        let clips = selection.compactMap { id in library.exports.first { $0.id == id } }
        guard clips.count >= 2 else { return }
        busy = true
        Task {
            defer { busy = false }
            do { onExport(try await library.renderReel(clips)) }
            catch { self.error = error.localizedDescription }
        }
    }
}
