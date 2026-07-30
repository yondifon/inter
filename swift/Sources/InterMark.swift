import AppKit

/// Inter's mark: a lowercase "i" flanked by two peer nodes.
///
/// Geometry is expressed as fractions of a square canvas, taken from
/// `logos/export/logo.svg` (512pt viewBox, SVG top-left origin).
/// `scripts/generate-app-icon.swift` runs standalone and redraws the same figure
/// for the bundled `.icns`, so it carries its own copy of these fractions.
enum InterMark {
    /// Neutral near-black, the same value the app's darkest surface uses. A blue
    /// cast in the tile fought the grey planes it sits next to in the Dock.
    static let ink = NSColor(calibratedWhite: 0.11, alpha: 1)

    static func tilePath(in canvas: NSRect) -> NSBezierPath {
        NSBezierPath(
            roundedRect: canvas.insetBy(dx: canvas.width * 0.047, dy: canvas.height * 0.047),
            xRadius: canvas.width * 0.209,
            yRadius: canvas.height * 0.209
        )
    }

    static func glyphPath(in canvas: NSRect) -> NSBezierPath {
        let path = NSBezierPath()
        path.appendOval(in: node(cx: 0.5, cy: 0.2871, r: 0.0625, in: canvas))
        path.append(NSBezierPath(
            roundedRect: box(x: 0.4375, y: 0.4043, width: 0.125, height: 0.3711, in: canvas),
            xRadius: canvas.width * 0.0625,
            yRadius: canvas.height * 0.0625
        ))
        path.appendOval(in: node(cx: 0.2773, cy: 0.6074, r: 0.0664, in: canvas))
        path.appendOval(in: node(cx: 0.7227, cy: 0.6074, r: 0.0664, in: canvas))
        return path
    }

    static func appIcon(side: CGFloat = 512) -> NSImage {
        let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { canvas in
            ink.setFill()
            tilePath(in: canvas).fill()
            NSColor.white.setFill()
            glyphPath(in: canvas).fill()
            return true
        }
        image.isTemplate = false
        return image
    }

    /// Menu-bar variant: glyph only, scaled to fill the bar. AppKit tints templates.
    static func statusItemImage(side: CGFloat = 18) -> NSImage {
        let image = NSImage(size: NSSize(width: side, height: side), flipped: false) { canvas in
            let path = glyphPath(in: NSRect(x: 0, y: 0, width: 512, height: 512))
            let glyph = path.bounds
            // Leave the breathing room other menu-bar glyphs have.
            let target = canvas.insetBy(dx: canvas.width * 0.06, dy: canvas.height * 0.06)
            let scale = min(target.width / glyph.width, target.height / glyph.height)
            let fit = NSAffineTransform()
            fit.translateX(by: target.midX - glyph.midX * scale, yBy: target.midY - glyph.midY * scale)
            fit.scale(by: scale)
            path.transform(using: fit as AffineTransform)
            NSColor.black.setFill()
            path.fill()
            return true
        }
        image.isTemplate = true
        return image
    }

    /// SVG coordinates run top-down; AppKit's origin is bottom-left.
    private static func box(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat, in canvas: NSRect) -> NSRect {
        NSRect(
            x: canvas.minX + canvas.width * x,
            y: canvas.maxY - canvas.height * (y + height),
            width: canvas.width * width,
            height: canvas.height * height
        )
    }

    private static func node(cx: CGFloat, cy: CGFloat, r: CGFloat, in canvas: NSRect) -> NSRect {
        box(x: cx - r, y: cy - r, width: r * 2, height: r * 2, in: canvas)
    }
}
