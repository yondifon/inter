import AppKit
import CoreText
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
    /// The current row. One step further off the surface than `sunken`, which
    /// marks a well rather than a choice, and neutral so the row's own type
    /// stays the loudest thing inside it.
    static let selection = Color(nsColor: selectionColor)
    /// `selection` as an NSColor, for the AppKit layers that paint fills
    /// themselves — `Color` cannot draw onto an `NSBezierPath`. `labelColor` at
    /// 0.09 darkens the light sidebar enough to read as selected; the same
    /// alpha over the dark sidebar barely lightens it, so dark mode gets a
    /// stronger alpha to land at a comparable, clearly-selected contrast.
    static let selectionColor = NSColor(name: nil) { appearance in
        let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        return NSColor.labelColor.withAlphaComponent(isDark ? 0.16 : 0.09)
    }

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
        DividerHidingProbe(frame: .zero)
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        nsView.hideEnclosingSplitViewDividers()
    }
}

/// The walk runs on every layout pass, not only on update: at first layout the
/// probe is not yet parented under the split view, so an update-only pass finds
/// nothing and the divider stays visible until a drag triggers another update.
/// Re-walking is cheap — once a split view carries the hiding class the loop
/// only re-reads it — and it is what makes the divider stay hidden across the
/// view rebuilds SwiftUI does on its own.
private final class DividerHidingProbe: NSView {
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        hideEnclosingSplitViewDividers()
    }

    override func layout() {
        super.layout()
        hideEnclosingSplitViewDividers()
    }
}

private extension NSView {
    /// Hides every `NSSplitView` in the window, reached two ways because neither
    /// alone is enough: walking up covers a probe already parented under the
    /// split view, and sweeping down from the window's root covers first layout,
    /// where the probe is not yet in that hierarchy and an upward walk finds
    /// nothing at all. The swap is deferred to the next turn of the run loop:
    /// swapping the class inline during SwiftUI's own layout pass discards the
    /// split view subclass SwiftUI installed, and that hangs layout before the
    /// window ever finishes building.
    func hideEnclosingSplitViewDividers() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            var view: NSView? = self
            while let current = view {
                Self.hideDividers(in: current)
                view = current.superview
            }
            if let root = self.window?.contentView {
                Self.hideDividers(in: root)
            }
        }
    }

    /// Swaps the runtime class of `view` and every split view beneath it. Once a
    /// split view carries the hiding class the swap is skipped, so re-running
    /// this on every layout pass costs a walk and nothing more.
    static func hideDividers(in view: NSView) {
        if let splitView = view as? NSSplitView,
           object_getClass(splitView) !== HairlineHiddenSplitView.self {
            object_setClass(splitView, HairlineHiddenSplitView.self)
            splitView.needsDisplay = true
        }
        for subview in view.subviews {
            hideDividers(in: subview)
        }
    }
}

/// AppKit owns sidebar row selection, not SwiftUI. `List(selection:)` under
/// `.listStyle(.sidebar)` is backed by an `NSTableView`, and the row view fills a
/// selected row with the system accent from `selectedContentBackgroundColor`
/// before SwiftUI's content draws. That fill sits below SwiftUI's environment, so
/// a `.tint` on the List never reaches it; the same selection also puts the row
/// into the emphasized background style, which is what inverts its text to white.
/// `selectionHighlightStyle = .none` removes both at the source: the table stops
/// painting the row and stops reporting an emphasized background, so the row
/// keeps its own colors and its `.listRowBackground` is the only thing marking
/// the current row. Only drawing is affected — the selection itself still moves
/// by click and arrow key and is still reported to VoiceOver.
///
/// Add it inside a list row via `.background(SystemSelectionHider())`; it walks
/// up to the enclosing table, or to the scroll view that holds it.
struct SystemSelectionHider: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        NSView(frame: .zero)
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async {
            var view: NSView? = nsView
            while let current = view {
                if let table = current as? NSTableView {
                    table.selectionHighlightStyle = .none
                    return
                }
                if let scrollView = current as? NSScrollView,
                   let table = scrollView.documentView as? NSTableView {
                    table.selectionHighlightStyle = .none
                    return
                }
                view = current.superview
            }
        }
    }
}

/// The diff's own colors — added lines and their counts read green, removed
/// lines and their counts read red, everywhere a diff appears. One pair so a
/// count next to a file never lands on a different green than the lines it
/// is counting.
enum DiffTint {
    static let added = Color.green
    static let removed = Color.red
}

/// Syntax colour: five tints, none of them the diff's red or green — a string
/// tinted red inside a removed line would read as part of the removal rather
/// than as a string. Kept to a small palette on purpose; a colour per token
/// class competes with the diff's own signal instead of sitting under it.
enum SyntaxTint {
    static let keyword = tone(light: 0x8A3F_FCFF, dark: 0xC9A0_FFFF)
    static let type = tone(light: 0x1D5F_D6FF, dark: 0x7FB1_FFFF)
    static let string = tone(light: 0xA162_0AFF, dark: 0xE0A4_58FF)
    static let number = tone(light: 0x0F76_6EFF, dark: 0x5FCF_C6FF)
    static let comment = tone(light: 0x6B72_80FF, dark: 0x8B94_9EFF)

    private static func tone(light: UInt32, dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return NSColor(rgba: isDark ? dark : light)
        })
    }
}

private extension NSColor {
    convenience init(rgba: UInt32) {
        self.init(
            srgbRed: CGFloat((rgba >> 24) & 0xFF) / 255,
            green: CGFloat((rgba >> 16) & 0xFF) / 255,
            blue: CGFloat((rgba >> 8) & 0xFF) / 255,
            alpha: CGFloat(rgba & 0xFF) / 255
        )
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

/// Point sizes for the text styles this app uses, hand-tuned as one ladder
/// for IBM Plex Sans: its x-height reads smaller than the Inter x-height
/// this ladder was tuned against before, so every tier sits one point above
/// where that ladder placed it. The reading sizes (body 13, callout 12,
/// caption 10) stay small and close together — this is a dense, scanned
/// tool, not a document — while the identity tier still steps above body
/// (title3 15, title2 17, title 21, largeTitle 25) so a task title or a
/// markdown heading separates from prose, headline clears body by a full
/// point instead of sharing it, and the tertiary tier drops further
/// (caption2 9, footnote 11 vs. subheadline 11.5) so timestamps and meta
/// stay behind content in size as well as color. The caption2 floor moved
/// up to 9pt from the previous 8pt: Plex Sans small-size hinting has not
/// been checked against a scanned list the way the previous face was, so
/// this stays conservative until verified against a build. Weights are
/// part of the ladder too, so hierarchy never leans on size alone: bold
/// for the display sizes, semibold for identity, medium for the one
/// subheading.
private enum TextStyleSize {
    static func base(_ style: Font.TextStyle) -> CGFloat {
        switch style {
        case .largeTitle: 25
        case .title: 21
        case .title2: 17
        case .title3: 15
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

/// Prose face: IBM Plex Sans, bundled as a package resource and registered
/// with CoreText the first time it is needed. Machine strings route through
/// `MonoFace` below instead — only `.default` reads through Plex Sans here.
/// A build with the resource files missing (the font is not checked into
/// this repo yet) registers nothing, `available` comes back false, and
/// every call below falls back to the system face exactly as it rendered
/// before this typeface existed — never blank, never an unstyled substitute.
private enum ProseFace {
    static let familyName = "IBM Plex Sans"

    static let available: Bool = {
        registerBundledFonts()
        return NSFontManager.shared.availableFontFamilies.contains(familyName)
    }()

    /// Static weight files, not the variable font: SwiftUI's `Font.custom`
    /// has no weight axis to drive, so each weight in the ladder needs its
    /// own named instance to render as anything but regular.
    static func postScriptName(for weight: Font.Weight) -> String {
        switch weight {
        case .bold: "IBMPlexSans-Bold"
        case .semibold: "IBMPlexSans-SemiBold"
        case .medium: "IBMPlexSans-Medium"
        default: "IBMPlexSans-Regular"
        }
    }

    private static func registerBundledFonts() {
        guard let urls = Bundle.module.urls(forResourcesWithExtension: "ttf", subdirectory: "Fonts") else { return }
        for url in urls {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }
}

/// Machine-string face: IBM Plex Mono, registered by the same call above
/// that registers `ProseFace` — the `.ttf` files for both families sit
/// side by side in the same bundled `Fonts` directory, so one CoreText
/// registration pass covers both. A build with the resource files missing
/// falls back to the system monospaced design exactly as every machine
/// string rendered before this typeface existed.
private enum MonoFace {
    static let familyName = "IBM Plex Mono"

    static let available: Bool = {
        NSFontManager.shared.availableFontFamilies.contains(familyName)
    }()

    static func postScriptName(for weight: Font.Weight) -> String {
        switch weight {
        case .bold: "IBMPlexMono-Bold"
        case .semibold: "IBMPlexMono-SemiBold"
        case .medium: "IBMPlexMono-Medium"
        default: "IBMPlexMono-Regular"
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
        let resolvedWeight = weight ?? TextStyleSize.weight(style)
        let size = TextStyleSize.base(style) * scale
        if design == .monospaced, MonoFace.available {
            return .custom(MonoFace.postScriptName(for: resolvedWeight), size: size)
        }
        if design == .default, ProseFace.available {
            return .custom(ProseFace.postScriptName(for: resolvedWeight), size: size)
        }
        return .system(size: size, weight: resolvedWeight, design: design)
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
/// quietly in the system face. `dense` is the task sidebar's own tier: a step
/// smaller than a settings pane's headings, with the weight raised so a heading
/// that small still separates from the rows beneath it.
struct SidebarSectionLabel: View {
    let text: String
    var dense = false

    var body: some View {
        Text(text)
            .scaledFont(dense ? .caption2 : .caption, weight: dense ? .semibold : .medium)
            .foregroundStyle(.secondary)
    }
}

// MARK: - Task state

/// Task lifecycle presentation. One source of truth so a state reads the same
/// way in the sidebar, the detail header, and the timeline.
enum TaskState: String {
    case queued, pending, running, needsInput = "needs_input", answered, blocked, completed, failed, cancelled, unknown

    init(_ raw: String) { self = TaskState(rawValue: raw) ?? .unknown }

    var label: String {
        switch self {
        case .queued: "Queued"
        case .pending: "Waiting"
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
    /// so only states that want a human get saturated color. `answered` keeps
    /// `needsInput`'s blue — it's the same question, just no longer waiting on
    /// anyone — and drops to a ring since it stopped asking.
    var tint: Color {
        switch self {
        case .completed: Color(nsColor: .systemGreen).opacity(0.7)
        case .failed: Color(nsColor: .systemRed).opacity(0.9)
        case .blocked: Color(nsColor: .systemRed)
        case .needsInput, .answered: .blue
        // Real work with a real future, not a hole in the list — so not the
        // tertiary grey queued uses.
        case .running, .pending, .cancelled: .secondary
        case .queued, .unknown: Color(nsColor: .tertiaryLabelColor)
        }
    }

    /// Fill backs up the color so state survives color-blind vision: `failed`
    /// (solid) and `completed` (ring) must read apart by shape alone, since
    /// their colors differ only in hue. Live work pulses; everything else is
    /// either solid or outlined, and no two states share both a color and a
    /// fill — that pairing, not the fill alone, is what keeps every dot unique.
    var dot: StateDot {
        switch self {
        case .running: .pulse
        case .failed, .needsInput, .cancelled, .unknown: .filled
        case .blocked, .completed, .queued, .pending, .answered: .ring
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
        case .needsInput: "questionmark"
        case .answered: "arrow.turn.down.right"
        case .running: "circle.dotted"
        case .pending: "clock"
        case .queued: "circle"
        case .unknown: "minus"
        }
    }

    /// Only these states earn their state name in a dense list; a check already
    /// says "completed", and the pulse already says "running". Blocked, failed,
    /// and cancelled also have their meaning in the dot, so they don't show text.
    var wantsLabelInList: Bool {
        switch self {
        case .completed, .running:
            return false
        case .blocked, .failed, .cancelled:
            return false
        case .needsInput, .answered, .queued, .pending, .unknown:
            return true
        }
    }

    var isTerminal: Bool {
        [.needsInput, .answered, .blocked, .completed, .failed, .cancelled].contains(self)
    }
}

enum StateDot: Equatable {
    case filled, ring, pulse
}

/// One dot for state, sized off zoom. It sits before the task name everywhere a
/// task appears, so a row and its detail header read the same way.
struct StateMarker: View {
    let state: TaskState
    /// Set where nothing else names the state — a lone dot has to speak for itself.
    var speaks = false
    /// Override for a dense list, where the dot is one of many; the detail
    /// header keeps the default since it is the sole carrier of the state.
    var diameter: CGFloat = 8

    @Environment(\.uiScale) private var uiScale

    var body: some View {
        marker
            .accessibilityHidden(!speaks)
            .accessibilityLabel("State: \(state.label)")
    }

    private var size: CGFloat { diameter * uiScale }

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

/// Icon for a "more" `Menu`: the horizontal `ellipsis` symbol, the mac native
/// form of this control. A vertical kebab is not composable here — this
/// borderless `Menu` label drops `rotationEffect`, small stacked `Image`s, and
/// `Shape` fills — while the plain `ellipsis` renders reliably, as the sibling
/// settings "more" menu already proves. `.foregroundStyle` from the host menu
/// tints it to match the row's other secondary icons.
struct MenuKebabLabel: View {
    @Environment(\.uiScale) private var uiScale

    var body: some View {
        Image(systemName: "ellipsis")
            .font(.system(size: 12 * uiScale))
            .frame(width: 24 * uiScale, height: 24 * uiScale)
            .contentShape(.rect)
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
