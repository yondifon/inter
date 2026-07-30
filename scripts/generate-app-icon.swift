import AppKit
import Foundation

guard CommandLine.arguments.count == 2 else {
    fputs("usage: generate-app-icon.swift <output.iconset>\n", stderr)
    exit(2)
}

let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try? FileManager.default.removeItem(at: output)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

// Inter's mark: a lowercase "i" flanked by two peer nodes. Fractions come from
// logos/export/logo.svg (512pt viewBox, SVG top-left origin). This script runs
// standalone, so it duplicates swift/Sources/InterMark.swift; keep both in sync.
func box(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat, side: CGFloat) -> NSRect {
    NSRect(x: side * x, y: side * (1 - y - height), width: side * width, height: side * height)
}

func node(cx: CGFloat, cy: CGFloat, r: CGFloat, side: CGFloat) -> NSRect {
    box(x: cx - r, y: cy - r, width: r * 2, height: r * 2, side: side)
}

func glyphPath(side: CGFloat) -> NSBezierPath {
    let path = NSBezierPath()
    path.appendOval(in: node(cx: 0.5, cy: 0.2871, r: 0.0625, side: side))
    path.append(NSBezierPath(
        roundedRect: box(x: 0.4375, y: 0.4043, width: 0.125, height: 0.3711, side: side),
        xRadius: side * 0.0625,
        yRadius: side * 0.0625
    ))
    path.appendOval(in: node(cx: 0.2773, cy: 0.6074, r: 0.0664, side: side))
    path.appendOval(in: node(cx: 0.7227, cy: 0.6074, r: 0.0664, side: side))
    return path
}

let variants: [(name: String, pixels: Int)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

for variant in variants {
    guard let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: variant.pixels,
        pixelsHigh: variant.pixels,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        throw NSError(domain: "InterIcon", code: 1)
    }

    bitmap.size = NSSize(width: variant.pixels, height: variant.pixels)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)

    let side = CGFloat(variant.pixels)
    let bounds = NSRect(x: 0, y: 0, width: side, height: side)
    NSColor.clear.setFill()
    bounds.fill()
    NSColor(calibratedWhite: 0.11, alpha: 1).setFill()
    NSBezierPath(
        roundedRect: bounds.insetBy(dx: side * 0.047, dy: side * 0.047),
        xRadius: side * 0.209,
        yRadius: side * 0.209
    ).fill()

    NSColor.white.setFill()
    glyphPath(side: side).fill()

    NSGraphicsContext.restoreGraphicsState()
    guard let data = bitmap.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "InterIcon", code: 2)
    }
    try data.write(to: output.appendingPathComponent(variant.name))
}
