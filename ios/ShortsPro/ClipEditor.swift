import AVFoundation
import SwiftUI
import UIKit

struct ClipEditor: View {
    let library: StudioLibrary
    let onExport: (StudioExport) -> Void
    @State private var project: ClipProject
    @State private var player = AVPlayer()
    @State private var timeObserver: Any?
    @State private var playhead = 0.0
    @State private var playing = false
    @State private var tab = Tool.trim
    @State private var work: Work?
    @State private var error: String?
    @State private var editCues = false
    @State private var editText = false

    private enum Tool: String, CaseIterable, Identifiable {
        case trim = "Trim", frame = "Frame", captions = "Captions"
        var id: Self { self }
        var icon: String {
            switch self {
            case .trim: "scissors"
            case .frame: "crop"
            case .captions: "captions.bubble"
            }
        }
    }

    private enum Work {
        case export, captions
    }

    init(library: StudioLibrary, project: ClipProject, onExport: @escaping (StudioExport) -> Void) {
        self.library = library
        self.onExport = onExport
        _project = State(initialValue: project)
        _playhead = State(initialValue: project.start)
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(spacing: 16) {
                    preview
                    transport
                    tools
                    switch tab {
                    case .trim: trimPanel
                    case .frame: framePanel
                    case .captions: captionsPanel
                    }
                }
                .frame(maxWidth: 620)
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            exportBar
        }
        .background(StudioStyle.background.ignoresSafeArea())
        .navigationTitle("Edit clip")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(work != nil)
        .onAppear(perform: attachPlayer)
        .onDisappear(perform: detachPlayer)
        .task(id: project) {
            do {
                try await Task.sleep(for: .milliseconds(450))
                try library.save(project)
            } catch is CancellationError {
                return
            } catch {
                self.error = error.localizedDescription
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime)) { notification in
            guard notification.object as? AVPlayerItem === player.currentItem else { return }
            playing = false
            seek(project.start)
        }
        .sheet(isPresented: $editCues) { cueEditor }
        .sheet(isPresented: $editText) { textEditor }
        .alert("Clip Maker", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) { error = nil }
        } message: { Text(error ?? "") }
    }

    private var preview: some View {
        GeometryReader { layout in
            let canvas = layout.size
            let crop = ClipFraming(
                source: project.sourceSize, canvas: canvas, zoom: project.zoom, x: project.panX, y: project.panY
            )
            ZStack(alignment: .topLeading) {
                Color.black
                PlayerSurface(player: player)
                    .frame(width: project.sourceSize.width * crop.scale, height: project.sourceSize.height * crop.scale)
                    .offset(x: crop.origin.x, y: crop.origin.y)
                if let text = visibleCaption {
                    Text(text)
                        .font(.system(size: 60 * canvas.width / project.format.size.width, weight: .heavy))
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                        .shadow(color: .black, radius: 2)
                        .shadow(color: .black, radius: 2)
                        .frame(width: canvas.width * 0.85, height: 240 * canvas.height / project.format.size.height, alignment: .top)
                        .position(x: canvas.width / 2, y: canvas.height * 0.915 - (120 * canvas.height / project.format.size.height))
                }
            }
            .frame(width: canvas.width, height: canvas.height, alignment: .topLeading)
            .clipped()
        }
        .aspectRatio(project.format.aspect, contentMode: .fit)
        .frame(maxWidth: project.format == .vertical ? 182 : project.format == .square ? 285 : 460)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14).strokeBorder(StudioStyle.border).allowsHitTesting(false)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(StudioStyle.surface, in: RoundedRectangle(cornerRadius: 20))
        .accessibilityLabel("Video preview")
    }

    private var transport: some View {
        HStack(spacing: 12) {
            Button(action: togglePlayback) {
                Image(systemName: playing ? "pause.fill" : "play.fill")
                    .font(.system(size: 14, weight: .bold))
                    .frame(width: 42, height: 42)
                    .foregroundStyle(StudioStyle.accent)
                    .background(StudioStyle.accent.opacity(0.13), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(playing ? "Pause" : "Play clip")
            Slider(value: Binding(
                get: { min(max(project.start, playhead), project.end) },
                set: { player.pause(); playing = false; seek($0) }
            ), in: project.start...project.end)
            .accessibilityLabel("Playhead")

            Text(clipTime(playhead - project.start))
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(minWidth: 45, alignment: .trailing)
        }
    }

    private var tools: some View {
        HStack(spacing: 5) {
            ForEach(Tool.allCases) { item in
                Button {
                    tab = item
                } label: {
                    Label(item.rawValue, systemImage: item.icon)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(tab == item ? StudioStyle.accent : Color.secondary)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(tab == item ? StudioStyle.accent.opacity(0.12) : .clear,
                                    in: RoundedRectangle(cornerRadius: 11))
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(tab == item ? [.isSelected] : [])
            }
        }
        .padding(4)
        .background(StudioStyle.surface, in: RoundedRectangle(cornerRadius: 15))
    }

    private var trimPanel: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack {
                Text("Clip range").font(.headline)
                Spacer()
                Text("\(clipTime(project.length)) selected")
                    .font(.caption.monospacedDigit().weight(.semibold)).foregroundStyle(StudioStyle.accent)
            }
            trimControl("Start", value: Binding(
                get: { project.start },
                set: { updateRange(start: $0, end: project.end, previewAt: $0) }
            ), limits: 0...max(0, project.end - minimumLength))
            trimControl("End", value: Binding(
                get: { project.end },
                set: { updateRange(start: project.start, end: $0, previewAt: $0) }
            ), limits: min(project.sourceDuration, project.start + minimumLength)...project.sourceDuration)
            Divider()
            TextField("Clip name", text: $project.title)
                .font(.subheadline)
                .accessibilityLabel("Clip name")
                .submitLabel(.done)
            if let url = project.originalURL {
                Link(destination: url) {
                    Label("Open original on YouTube", systemImage: "arrow.up.right")
                        .font(.footnote)
                }
            }
        }
        .studioCard()
        .disabled(work != nil)
    }

    private var framePanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Aspect ratio").font(.headline)
            Picker("Aspect ratio", selection: $project.format) {
                ForEach(ClipFormat.allCases) { format in
                    Text(format.rawValue).tag(format)
                }
            }
            .pickerStyle(.segmented)
            framingSlider("Zoom", value: $project.zoom, limits: 1...3, display: String(format: "%.1f×", project.zoom))
            framingSlider("Horizontal", value: $project.panX, limits: -1...1, display: position(project.panX))
            framingSlider("Vertical", value: $project.panY, limits: -1...1, display: position(project.panY))
            Toggle("Mute original audio", isOn: $project.muted)
                .font(.subheadline)
                .onChange(of: project.muted) { _, value in player.isMuted = value }
        }
        .studioCard()
        .disabled(work != nil)
    }

    private var captionsPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Caption").font(.headline)
            Button {
                editText = true
            } label: {
                HStack {
                    Text(project.caption.isEmpty ? "Add text" : project.caption)
                        .lineLimit(2)
                    Spacer()
                    Image(systemName: "pencil")
                }
                .padding(11)
                .contentShape(Rectangle())
                .background(StudioStyle.background, in: RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(.plain)
            .font(.subheadline)
            .accessibilityIdentifier("edit-caption")
            Button(action: generateCaptions) {
                if work == .captions {
                    ProgressView("Generating captions…")
                } else {
                    Label("Generate from speech", systemImage: "waveform")
                }
            }
            .font(.subheadline.weight(.semibold))
            .disabled(!project.caption.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || work != nil)
            if !project.cues.isEmpty {
                Button("Edit timed captions (\(project.cues.count))") { editCues = true }
                    .font(.subheadline)
            }
        }
        .studioCard()
        .disabled(work == .export)
    }

    private var textEditor: some View {
        NavigationStack {
            Form {
                TextField("Text for the whole clip", text: Binding(
                    get: { project.caption },
                    set: { project.caption = String($0.prefix(140)) }
                ), axis: .vertical)
                .lineLimit(3...6)
                .accessibilityIdentifier("caption-input")
            }
            .navigationTitle("Caption text")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { editText = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var cueEditor: some View {
        NavigationStack {
            List {
                ForEach($project.cues) { $cue in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(clipTime(max(0, cue.start - project.start)))
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                        TextField("Caption", text: $cue.text, axis: .vertical)
                    }
                }
                .onDelete { project.cues.remove(atOffsets: $0) }
            }
            .navigationTitle("Timed captions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { editCues = false }
                }
            }
        }
    }

    private var exportBar: some View {
        Button(action: export) {
            if work == .export {
                ProgressView("Exporting MP4…")
                    .tint(StudioStyle.background)
            } else {
                Label("Export MP4", systemImage: "square.and.arrow.up")
            }
        }
        .buttonStyle(StudioPrimaryButton())
        .accessibilityIdentifier("export-mp4")
        .disabled(work != nil)
        .opacity(work == .captions ? 0.5 : 1)
        .frame(maxWidth: 620)
        .padding(.horizontal, 20)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity)
        .background(.ultraThinMaterial)
    }

    private var visibleCaption: String? {
        let manual = project.caption.trimmingCharacters(in: .whitespacesAndNewlines)
        if !manual.isEmpty { return manual }
        return project.cues.first { $0.start <= playhead && playhead < $0.end }?.text
    }

    private var minimumLength: Double { min(0.15, project.sourceDuration) }

    private func trimControl(_ label: String, value: Binding<Double>, limits: ClosedRange<Double>) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(label).font(.subheadline)
                Spacer()
                Text(clipTime(value.wrappedValue)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            Slider(value: value, in: limits)
                .accessibilityLabel("\(label) time")
                .disabled(limits.lowerBound == limits.upperBound)
        }
    }

    private func framingSlider(_ label: String, value: Binding<Double>, limits: ClosedRange<Double>, display: String) -> some View {
        HStack {
            Text(label).font(.caption).frame(width: 67, alignment: .leading)
            Slider(value: value, in: limits)
                .accessibilityLabel(label)
            Text(display).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                .frame(width: 45, alignment: .trailing)
        }
    }

    private func position(_ value: Double) -> String {
        "\(Int((value * 100).rounded()))%"
    }

    private func attachPlayer() {
        guard timeObserver == nil else { return }
        player.replaceCurrentItem(with: AVPlayerItem(url: library.sourceURL(project)))
        player.isMuted = project.muted
        player.currentItem?.forwardPlaybackEndTime = CMTime(seconds: project.end, preferredTimescale: 600)
        seek(project.start)
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(value: 1, timescale: 15), queue: .main
        ) { time in
            MainActor.assumeIsolated {
                if time.seconds.isFinite { playhead = time.seconds }
            }
        }
    }

    private func detachPlayer() {
        player.pause()
        playing = false
        if let timeObserver {
            player.removeTimeObserver(timeObserver)
            self.timeObserver = nil
        }
        try? library.save(project)
    }

    private func updateRange(start: Double, end: Double, previewAt: Double) {
        player.pause()
        playing = false
        project.start = start
        project.end = end
        player.currentItem?.forwardPlaybackEndTime = CMTime(seconds: end, preferredTimescale: 600)
        seek(min(previewAt, max(start, end - 0.02)))
    }

    private func togglePlayback() {
        if playing {
            player.pause()
            playing = false
        } else {
            if playhead >= project.end - 0.03 || playhead < project.start { seek(project.start) }
            player.play()
            playing = true
        }
    }

    private func seek(_ time: Double) {
        playhead = time
        player.seek(to: CMTime(seconds: time, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    private func export() {
        guard work == nil else { return }
        player.pause()
        playing = false
        work = .export
        let snapshot = project
        Task {
            defer { work = nil }
            do {
                try library.save(snapshot)
                onExport(try await library.render(snapshot))
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func generateCaptions() {
        guard work == nil else { return }
        work = .captions
        let snapshot = project
        Task {
            defer { work = nil }
            do {
                project.cues = try await LocalCaptions.generate(
                    url: library.sourceURL(snapshot), start: snapshot.start, end: snapshot.end
                )
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

private struct PlayerSurface: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> PlayerView {
        let view = PlayerView()
        view.playerLayer.videoGravity = .resizeAspect
        return view
    }

    func updateUIView(_ view: PlayerView, context: Context) {
        view.playerLayer.player = player
    }
}

private final class PlayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}
