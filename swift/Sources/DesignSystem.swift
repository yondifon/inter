import AppKit
import SwiftUI

/// Shared visual tokens. Two radii, one hairline, one hit-target floor.
enum Radius {
    static let small: CGFloat = 6
    static let medium: CGFloat = 10
}

/// Depth comes from fill, not outlines. A panel lifts off the window because it is
/// lighter; code and raw data sink into the panel because they are darker. Strokes
/// would say the same thing twice and clutter the window doing it.
///
/// Flat neutral greys, not the system window/control pair: those two put the
/// sidebar *above* the content and carry a cool cast. Reading happens in the
/// content column, so it stays near the top of the scale and the sidebar drops one
/// step below it — the columns part without a rule between them.
enum Surface {
    static let sidebar = Color(nsColor: sidebarColor)
    static let content = Color(nsColor: contentColor)
    static let panel = Color(nsColor: panelColor)
    static let sunken = Color.primary.opacity(0.05)

    static let sidebarColor = neutral(light: 0.957, dark: 0.118)
    static let contentColor = neutral(light: 0.980, dark: 0.150)
    static let panelColor = neutral(light: 1.000, dark: 0.180)

    private static func neutral(light: CGFloat, dark: CGFloat) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return NSColor(white: isDark ? dark : light, alpha: 1)
        }
    }
}

/// `NavigationSplitView` draws its pane-dividing hairline through the AppKit
/// `NSSplitView` it builds internally; SwiftUI exposes no modifier to hide it.
/// The two panes' background shades already carry the separation, so this
/// suppresses the divider's drawn color without touching its draggable hit
/// area — dragging keeps resizing the sidebar exactly as before.
/// `dividerColor` alone leaves the line visible: the split view paints the
/// divider in `drawDivider(in:)` rather than filling the rect with that color,
/// so both have to go. The draggable hit area is separate from either, and
/// keeps working.
private final class HairlineHiddenSplitView: NSSplitView {
    override var dividerColor: NSColor { .clear }
    override func drawDivider(in rect: NSRect) {}
}

/// Invisible helper view. Add it anywhere inside a `NavigationSplitView` pane
/// via `.background(SplitViewDividerHider())`; it walks up to the outermost
/// enclosing `NSSplitView` and hides every divider on the way, since the pane
/// a caller anchors to may sit inside a nested split view of its own.
struct SplitViewDividerHider: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        NSView(frame: .zero)
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async {
            var view: NSView? = nsView
            while let current = view {
                if let splitView = current as? NSSplitView,
                   object_getClass(splitView) !== HairlineHiddenSplitView.self {
                    object_setClass(splitView, HairlineHiddenSplitView.self)
                    splitView.needsDisplay = true
                }
                view = current.superview
            }
        }
    }
}

/// The trace's one stroke: a 2pt rule that stands in for a container. Signals,
/// quotes, and handoffs draw one of these on the page's edge instead of a
/// filled surface — the color is all that varies.
struct AccentRule: View {
    var color: Color = Color(nsColor: .separatorColor)

    var body: some View {
        RoundedRectangle(cornerRadius: 1)
            .fill(color)
            .frame(width: 2)
    }
}

// The app's voice: every machine-produced string — ids, paths, commands, models,
// env values, tool names — asks for the monospaced face at its call site, and
// prose stays in the system face, which is 20% narrower and easier to read
// across a wide panel.

// MARK: - UI scale

/// Multiplier for content typography and the metrics tuned against it.
/// macOS has no Dynamic Type, so `@ScaledMetric` and `.dynamicTypeSize` do
/// nothing here — View ▸ Zoom drives this value instead.
private struct UIScaleKey: EnvironmentKey {
    static let defaultValue: CGFloat = 1
}

extension EnvironmentValues {
    var uiScale: CGFloat {
        get { self[UIScaleKey.self] }
        set { self[UIScaleKey.self] = newValue }
    }
}

/// macOS point sizes for the text styles this app uses, hand-tuned as one
/// ladder: the reading sizes (body 13, callout 12, caption 10) hold their
/// system positions — this is a native tool, and the platform's optical
/// sizing and tracking are tuned for those — while the identity tier steps
/// one notch above system (title3 16, title2 18, title 24, largeTitle 28) so
/// a task title or a markdown heading separates from prose, headline clears
/// body by a full point instead of sharing it, and the tertiary tier drops a
/// point (caption2 9, footnote 11 vs. subheadline 11.5) so timestamps and
/// meta stay behind content in size as well as color. Weights are part of
/// the ladder too, so hierarchy never leans on size alone: bold for the
/// display sizes, semibold for identity, medium for the one subheading.
private enum TextStyleSize {
    static func base(_ style: Font.TextStyle) -> CGFloat {
        switch style {
        case .largeTitle: 28
        case .title: 24
        case .title2: 18
        case .title3: 16
        case .headline: 14
        case .body: 13
        case .callout: 12
        case .subheadline: 11.5
        case .footnote: 11
        case .caption: 10
        case .caption2: 9
        @unknown default: 13
        }
    }

    static func weight(_ style: Font.TextStyle) -> Font.Weight {
        switch style {
        case .largeTitle, .title, .title2: .bold
        case .title3, .headline: .semibold
        case .subheadline: .medium
        default: .regular
        }
    }
}

extension Font {
    /// The same size ladder `scaledFont` uses, for the places a font has to be set
    /// on an attributed run instead of on a view — inline code inside prose.
    static func scaled(
        _ style: Font.TextStyle,
        scale: CGFloat,
        weight: Font.Weight? = nil,
        design: Font.Design = .default
    ) -> Font {
        .system(
            size: TextStyleSize.base(style) * scale,
            weight: weight ?? TextStyleSize.weight(style),
            design: design
        )
    }
}

private struct ScaledFont: ViewModifier {
    @Environment(\.uiScale) private var uiScale

    let style: Font.TextStyle
    let weight: Font.Weight?
    let design: Font.Design
    let monospacedDigit: Bool

    func body(content: Content) -> some View {
        var font = Font.scaled(style, scale: uiScale, weight: weight, design: design)
        if monospacedDigit { font = font.monospacedDigit() }
        return content.font(font)
    }
}

extension View {
    /// Text style that follows View ▸ Zoom. Use for content; native controls keep
    /// their system size so they never clip.
    func scaledFont(
        _ style: Font.TextStyle,
        weight: Font.Weight? = nil,
        design: Font.Design = .default,
        monospacedDigit: Bool = false
    ) -> some View {
        modifier(ScaledFont(style: style, weight: weight, design: design, monospacedDigit: monospacedDigit))
    }
}

/// Section header for machine-facing groups. Mono and uppercase so a header never
/// competes with the prose under it.
struct SectionLabel: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .scaledFont(.caption2, weight: .semibold, design: .monospaced)
            .tracking(0.6)
            .foregroundStyle(.tertiary)
    }
}

/// Sidebar group heading. The sidebar is a place you scan, not read, so its
/// headings drop the machine-facing mono voice `SectionLabel` uses and sit
/// quietly in the system face.
struct SidebarSectionLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .scaledFont(.caption, weight: .medium)
            .foregroundStyle(.secondary)
    }
}

// MARK: - Task state

/// Task lifecycle presentation. One source of truth so a state reads the same
/// way in the sidebar, the detail header, and the timeline.
enum TaskState: String {
    case queued, running, needsInput = "needs_input", answered, blocked, completed, failed, cancelled, unknown

    init(_ raw: String) { self = TaskState(rawValue: raw) ?? .unknown }

    var label: String {
        switch self {
        case .queued: "Queued"
        case .running: "Running"
        case .needsInput: "Needs input"
        case .answered: "Answered"
        case .blocked: "Blocked"
        case .completed: "Completed"
        case .failed: "Failed"
        case .cancelled: "Cancelled"
        case .unknown: "Unknown"
        }
    }

    /// Muted by default. A list of completed tasks should read as a quiet ledger,
    /// so only states that want a human get saturated color.
    var tint: Color {
        switch self {
        case .completed: Color(nsColor: .systemGreen).opacity(0.7)
        case .failed: Color(nsColor: .systemRed).opacity(0.9)
        case .blocked: Color(nsColor: .systemOrange)
        case .cancelled: .secondary
        case .needsInput: Color(nsColor: .systemOrange)
        case .running, .answered: .secondary
        case .queued, .unknown: Color(nsColor: .tertiaryLabelColor)
        }
    }

    /// Fill backs up the color so state survives color-blind vision: a run that
    /// landed is a solid dot, one that has not is a ring, and live work pulses.
    var dot: StateDot {
        switch self {
        case .running: .pulse
        case .completed, .blocked, .needsInput: .filled
        case .failed, .queued, .answered, .cancelled, .unknown: .ring
        }
    }

    /// The dot already says completed and failed on its own. Every other state
    /// still spends a word next to the task name.
    var wantsLabelBesideName: Bool { self != .completed && self != .failed }

    /// Glyph form, for the few places a dot is too quiet — currently the Error tab.
    var symbol: String {
        switch self {
        case .completed: "checkmark"
        case .failed: "exclamationmark.triangle"
        case .blocked: "hand.raised"
        case .cancelled: "xmark"
        case .needsInput: "questionmark.circle"
        case .answered: "arrow.turn.down.right"
        case .running: "circle.dotted"
        case .queued: "circle"
        case .unknown: "minus"
        }
    }

    /// Only these states earn their state name in a dense list; a check already
    /// says "completed", and the pulse already says "running".
    var wantsLabelInList: Bool { self != .completed && self != .running }

    var isTerminal: Bool {
        [.needsInput, .answered, .blocked, .completed, .failed, .cancelled].contains(self)
    }
}

enum StateDot {
    case filled, ring, pulse
}

/// One dot for state, sized off zoom. It sits before the task name everywhere a
/// task appears, so a row and its detail header read the same way.
struct StateMarker: View {
    let state: TaskState
    /// Set where nothing else names the state — a lone dot has to speak for itself.
    var speaks = false

    @Environment(\.uiScale) private var uiScale

    var body: some View {
        marker
            .accessibilityHidden(!speaks)
            .accessibilityLabel("State: \(state.label)")
    }

    private var size: CGFloat { 8 * uiScale }

    @ViewBuilder private var marker: some View {
        switch state.dot {
        case .filled:
            Circle().fill(state.tint).frame(width: size, height: size)
        case .ring:
            Circle().strokeBorder(state.tint, lineWidth: 1.5 * uiScale).frame(width: size, height: size)
        case .pulse:
            PulsingDot(color: state.tint, diameter: size)
        }
    }
}

/// A dot with a slow heartbeat. Motion is what pulls the eye to something still
/// moving, so the same beat runs everywhere in the app that is live — a running
/// task, a broker that is up.
struct PulsingDot: View {
    let color: Color
    let diameter: CGFloat
    /// A light that stopped should look stopped.
    var beats = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var beating = false

    var body: some View {
        Circle()
            .fill(color)
            .opacity(beating ? 0.3 : 1)
            .scaleEffect(beating ? 0.72 : 1)
            .frame(width: diameter, height: diameter)
            .onAppear { sync() }
            .onChange(of: beats) { _, _ in sync() }
    }

    private func sync() {
        guard beats, !reduceMotion else {
            // A repeating animation only ends when the value is set through a
            // finite one.
            withAnimation(.easeOut(duration: 0.2)) { beating = false }
            return
        }
        withAnimation(.easeInOut(duration: 0.85).repeatForever(autoreverses: true)) {
            beating = true
        }
    }
}

// MARK: - Controls

/// Env keys that name credentials (TOKEN, KEY, SECRET, …) render masked
/// wherever they are edited or displayed. The name decides, not the value.
func isSecretEnvKey(_ key: String) -> Bool {
    ["TOKEN", "KEY", "SECRET", "PASSWORD", "CREDENTIAL"].contains { key.uppercased().contains($0) }
}

/// Icon-only control with a real hit target and a real accessibility name.
/// `.help` is a tooltip, not a label, so both are set here.
struct IconButton: View {
    let symbol: String
    let label: String
    var tint: AnyShapeStyle = AnyShapeStyle(.secondary)
    /// macOS 14 ships no vertical ellipsis, so a kebab is `ellipsis` turned 90°.
    var rotation: Angle = .zero
    let action: () -> Void

    @Environment(\.uiScale) private var uiScale

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .rotationEffect(rotation)
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 24 * uiScale, height: 24 * uiScale)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .foregroundStyle(tint)
        .help(label)
        .accessibilityLabel(label)
    }
}

// MARK: - Collapsible sections

/// Collapsible section header. The whole title line is the toggle — not a tiny
/// chevron. The chevron sits a few points right of the label text, never before
/// it and never pushed to the far edge by a spacer; it points right when
/// collapsed and down when expanded, rotating in place so the motion reads as
/// one thing folding. Content is rendered by the call site as its own
/// `if isExpanded { … }`: a List only turns native `DisclosureGroup` children
/// into real rows, so nesting tagged rows inside this view would break
/// selection. Bindings keep the state wherever the site already owns it
/// (settings, AppStorage-backed groups, or local state).
struct CollapsibleSection<Label: View, Trailing: View>: View {
    @Binding var isExpanded: Bool
    let label: Label
    let trailing: Trailing
    /// Card-style sections fill the header row with the panel surface, like the
    /// other cards in the activity timeline.
    var panel = false

    init(
        isExpanded: Binding<Bool>,
        @ViewBuilder label: () -> Label,
        @ViewBuilder trailing: () -> Trailing = { EmptyView() },
        panel: Bool = false
    ) {
        _isExpanded = isExpanded
        self.label = label()
        self.trailing = trailing()
        self.panel = panel
    }

    var body: some View {
        Button {
            withAnimation(.easeOut(duration: 0.15)) { isExpanded.toggle() }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                label
                chevron
                Spacer(minLength: 0)
                trailing
            }
            .padding(panel ? EdgeInsets(top: 10, leading: 14, bottom: 10, trailing: 14) : EdgeInsets())
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                if panel {
                    RoundedRectangle(cornerRadius: Radius.medium).fill(Surface.panel)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
    }

    /// Quiet and small — the title does the talking.
    private var chevron: some View {
        Image(systemName: "chevron.down")
            .scaledFont(.caption2, weight: .semibold)
            .foregroundStyle(.tertiary)
            .rotationEffect(.degrees(isExpanded ? 0 : -90))
            .animation(.easeOut(duration: 0.15), value: isExpanded)
            .accessibilityHidden(true)
    }
}

/// Copies text and confirms in place. Used for endpoints, paths, and env values.
struct CopyIconButton: View {
    let text: String
    var label: String = "Copy"
    var symbol: String = "doc.on.doc"

    @State private var copied = false
    @State private var resetTask: Task<Void, Never>?

    var body: some View {
        IconButton(
            symbol: copied ? "checkmark" : symbol,
            label: copied ? "Copied" : label,
            tint: copied ? AnyShapeStyle(Color.green) : AnyShapeStyle(.secondary)
        ) {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            withAnimation(.easeOut(duration: 0.15)) { copied = true }
            // Each click replaces the pending reset, so a rapid second copy
            // keeps “Copied” up for its own full beat.
            resetTask?.cancel()
            resetTask = Task {
                try? await Task.sleep(for: .seconds(1.2))
                guard !Task.isCancelled else { return }
                withAnimation(.easeOut(duration: 0.15)) { copied = false }
            }
        }
    }
}
