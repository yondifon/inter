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

    static let sidebarColor = neutral(light: 0.925, dark: 0.105)
    static let contentColor = neutral(light: 0.965, dark: 0.140)
    static let panelColor = neutral(light: 1.000, dark: 0.180)

    private static func neutral(light: CGFloat, dark: CGFloat) -> NSColor {
        NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return NSColor(white: isDark ? dark : light, alpha: 1)
        }
    }
}

/// One switch for the app's voice. `.data` puts every machine-produced string —
/// ids, paths, commands, models, env values, tool names — in the monospaced face
/// and leaves prose in the system face, which stays 20% narrower and easier to
/// read across a wide panel. `.mono` sends the whole app mono, prose included.
enum Typeface {
    case data
    case mono

    static let current: Typeface = .data

    /// Resolves a call site's request against the app-wide choice.
    static func design(_ requested: Font.Design) -> Font.Design {
        current == .mono ? .monospaced : requested
    }
}

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

/// macOS point sizes for the text styles this app uses.
private enum TextStyleSize {
    static func base(_ style: Font.TextStyle) -> CGFloat {
        switch style {
        case .largeTitle: 26
        case .title: 22
        case .title2: 17
        case .title3: 15
        case .headline: 13
        case .body: 13
        case .callout: 12
        case .subheadline: 11
        case .footnote: 10
        case .caption: 10
        case .caption2: 10
        @unknown default: 13
        }
    }

    static func weight(_ style: Font.TextStyle) -> Font.Weight {
        style == .headline ? .semibold : .regular
    }
}

private struct ScaledFont: ViewModifier {
    @Environment(\.uiScale) private var uiScale

    let style: Font.TextStyle
    let weight: Font.Weight?
    let design: Font.Design
    let monospacedDigit: Bool

    func body(content: Content) -> some View {
        var font = Font.system(
            size: TextStyleSize.base(style) * uiScale,
            weight: weight ?? TextStyleSize.weight(style),
            design: Typeface.design(design)
        )
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
    /// says "completed".
    var wantsLabelInList: Bool { self != .completed }

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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulsing = false

    var body: some View {
        marker
            .frame(width: 8 * uiScale, height: 8 * uiScale)
            .accessibilityHidden(!speaks)
            .accessibilityLabel("State: \(state.label)")
    }

    @ViewBuilder private var marker: some View {
        switch state.dot {
        case .filled:
            Circle().fill(state.tint)
        case .ring:
            Circle().strokeBorder(state.tint, lineWidth: 1.5 * uiScale)
        case .pulse:
            Circle()
                .fill(state.tint)
                .opacity(pulsing ? 0.3 : 1)
                .scaleEffect(pulsing ? 0.72 : 1)
                .onAppear {
                    guard !reduceMotion else { return }
                    withAnimation(.easeInOut(duration: 0.85).repeatForever(autoreverses: true)) {
                        pulsing = true
                    }
                }
        }
    }
}

// MARK: - Controls

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
                .frame(width: 24 * uiScale, height: 24 * uiScale)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .foregroundStyle(tint)
        .help(label)
        .accessibilityLabel(label)
    }
}

/// Copies text and confirms in place. Used for endpoints, paths, and env values.
struct CopyIconButton: View {
    let text: String
    var label: String = "Copy"

    @State private var copied = false

    var body: some View {
        IconButton(
            symbol: copied ? "checkmark" : "doc.on.doc",
            label: copied ? "Copied" : label,
            tint: copied ? AnyShapeStyle(Color.green) : AnyShapeStyle(.secondary)
        ) {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.2))
                copied = false
            }
        }
    }
}
