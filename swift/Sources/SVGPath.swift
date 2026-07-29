import SwiftUI

/// Minimal SVG path-data shape for the 24×24 provider marks in `ProviderMark`.
/// Supports M L H V C S Q T A Z (absolute and relative).
struct SVGPath: Shape {
    let data: String
    var viewBox: CGFloat = 24

    func path(in rect: CGRect) -> Path {
        let side = min(rect.width, rect.height)
        let scale = side / viewBox
        return SVGPath.parse(data).applying(
            CGAffineTransform(translationX: rect.midX - side / 2, y: rect.midY - side / 2)
                .scaledBy(x: scale, y: scale))
    }

    static func parse(_ data: String) -> Path {
        var path = Path()
        var scanner = Tokenizer(data)
        var current = CGPoint.zero
        var start = CGPoint.zero
        var lastControl: CGPoint?
        var command: Character = "M"

        while true {
            if let next = scanner.nextCommand() { command = next }
            guard scanner.hasNumber || command == "Z" || command == "z" else { break }

            let relative = command.isLowercase
            func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                relative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
            }

            switch Character(command.uppercased()) {
            case "M":
                guard let x = scanner.number(), let y = scanner.number() else { return path }
                current = point(x, y)
                start = current
                path.move(to: current)
                lastControl = nil
                command = relative ? "l" : "L"
            case "L":
                guard let x = scanner.number(), let y = scanner.number() else { return path }
                current = point(x, y)
                path.addLine(to: current)
                lastControl = nil
            case "H":
                guard let x = scanner.number() else { return path }
                current = CGPoint(x: relative ? current.x + x : x, y: current.y)
                path.addLine(to: current)
                lastControl = nil
            case "V":
                guard let y = scanner.number() else { return path }
                current = CGPoint(x: current.x, y: relative ? current.y + y : y)
                path.addLine(to: current)
                lastControl = nil
            case "C":
                guard let x1 = scanner.number(), let y1 = scanner.number(),
                      let x2 = scanner.number(), let y2 = scanner.number(),
                      let x = scanner.number(), let y = scanner.number() else { return path }
                let c1 = point(x1, y1), c2 = point(x2, y2)
                current = point(x, y)
                path.addCurve(to: current, control1: c1, control2: c2)
                lastControl = c2
            case "S":
                guard let x2 = scanner.number(), let y2 = scanner.number(),
                      let x = scanner.number(), let y = scanner.number() else { return path }
                let c1 = reflect(lastControl, around: current)
                let c2 = point(x2, y2)
                current = point(x, y)
                path.addCurve(to: current, control1: c1, control2: c2)
                lastControl = c2
            case "Q":
                guard let x1 = scanner.number(), let y1 = scanner.number(),
                      let x = scanner.number(), let y = scanner.number() else { return path }
                let control = point(x1, y1)
                current = point(x, y)
                path.addQuadCurve(to: current, control: control)
                lastControl = control
            case "T":
                guard let x = scanner.number(), let y = scanner.number() else { return path }
                let control = reflect(lastControl, around: current)
                current = point(x, y)
                path.addQuadCurve(to: current, control: control)
                lastControl = control
            case "A":
                guard let rx = scanner.number(), let ry = scanner.number(),
                      let rotation = scanner.number(), let largeArc = scanner.number(),
                      let sweep = scanner.number(), let x = scanner.number(),
                      let y = scanner.number() else { return path }
                let end = point(x, y)
                addArc(to: &path, from: current, to: end, rx: rx, ry: ry,
                       rotation: rotation, largeArc: largeArc != 0, sweep: sweep != 0)
                current = end
                lastControl = nil
            case "Z":
                path.closeSubpath()
                current = start
                lastControl = nil
                command = "?" // a close consumes itself; the next token must be an explicit command
            default:
                return path
            }
        }
        return path
    }

    private static func reflect(_ control: CGPoint?, around point: CGPoint) -> CGPoint {
        guard let control else { return point }
        return CGPoint(x: 2 * point.x - control.x, y: 2 * point.y - control.y)
    }

    /// Endpoint-parameterised arc → centre parameterisation → cubic segments (SVG spec F.6.5).
    private static func addArc(to path: inout Path, from: CGPoint, to end: CGPoint,
                               rx: CGFloat, ry: CGFloat, rotation: CGFloat,
                               largeArc: Bool, sweep: Bool) {
        guard rx != 0, ry != 0 else {
            path.addLine(to: end)
            return
        }
        var rx = abs(rx), ry = abs(ry)
        let phi = rotation * .pi / 180
        let dx2 = (from.x - end.x) / 2, dy2 = (from.y - end.y) / 2
        let x1 = cos(phi) * dx2 + sin(phi) * dy2
        let y1 = -sin(phi) * dx2 + cos(phi) * dy2

        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 {
            rx *= sqrt(lambda)
            ry *= sqrt(lambda)
        }

        let sign: CGFloat = largeArc == sweep ? -1 : 1
        let numerator = max(0, rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1)
        let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
        let coefficient = denominator == 0 ? 0 : sign * sqrt(numerator / denominator)
        let cx1 = coefficient * rx * y1 / ry
        let cy1 = -coefficient * ry * x1 / rx
        let center = CGPoint(x: cos(phi) * cx1 - sin(phi) * cy1 + (from.x + end.x) / 2,
                             y: sin(phi) * cx1 + cos(phi) * cy1 + (from.y + end.y) / 2)

        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let dot = ux * vx + uy * vy
            let length = sqrt(ux * ux + uy * uy) * sqrt(vx * vx + vy * vy)
            let value = acos(min(1, max(-1, length == 0 ? 1 : dot / length)))
            return ux * vy - uy * vx < 0 ? -value : value
        }

        let startAngle = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
        var delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
        if !sweep, delta > 0 { delta -= 2 * .pi }
        if sweep, delta < 0 { delta += 2 * .pi }

        let segments = max(1, Int(ceil(abs(delta) / (.pi / 2))))
        let step = delta / CGFloat(segments)
        let alpha = 4.0 / 3.0 * tan(step / 4)
        var theta = startAngle
        var point = from

        for _ in 0..<segments {
            let next = theta + step
            func onArc(_ t: CGFloat) -> CGPoint {
                let x = rx * cos(t), y = ry * sin(t)
                return CGPoint(x: cos(phi) * x - sin(phi) * y + center.x,
                               y: sin(phi) * x + cos(phi) * y + center.y)
            }
            func derivative(_ t: CGFloat) -> CGPoint {
                let x = -rx * sin(t), y = ry * cos(t)
                return CGPoint(x: cos(phi) * x - sin(phi) * y, y: sin(phi) * x + cos(phi) * y)
            }
            let endPoint = onArc(next)
            let d1 = derivative(theta), d2 = derivative(next)
            path.addCurve(to: endPoint,
                          control1: CGPoint(x: point.x + alpha * d1.x, y: point.y + alpha * d1.y),
                          control2: CGPoint(x: endPoint.x - alpha * d2.x, y: endPoint.y - alpha * d2.y))
            point = endPoint
            theta = next
        }
    }
}

private struct Tokenizer {
    private let characters: [Character]
    private var index = 0

    init(_ data: String) { characters = Array(data) }

    private mutating func skipSeparators() {
        while index < characters.count, characters[index] == " " || characters[index] == ","
                || characters[index] == "\n" || characters[index] == "\t" || characters[index] == "\r" {
            index += 1
        }
    }

    mutating func nextCommand() -> Character? {
        skipSeparators()
        guard index < characters.count, characters[index].isLetter else { return nil }
        defer { index += 1 }
        return characters[index]
    }

    var hasNumber: Bool {
        var probe = index
        while probe < characters.count, characters[probe] == " " || characters[probe] == ","
                || characters[probe] == "\n" || characters[probe] == "\t" || characters[probe] == "\r" {
            probe += 1
        }
        guard probe < characters.count else { return false }
        let character = characters[probe]
        return character.isNumber || character == "-" || character == "+" || character == "."
    }

    mutating func number() -> CGFloat? {
        skipSeparators()
        var text = ""
        if index < characters.count, characters[index] == "-" || characters[index] == "+" {
            text.append(characters[index])
            index += 1
        }
        while index < characters.count {
            let character = characters[index]
            if character.isNumber {
                text.append(character)
            } else if character == "." {
                if text.contains(".") { break }
                text.append(character)
            } else {
                break
            }
            index += 1
        }
        guard let value = Double(text) else { return nil }
        return CGFloat(value)
    }
}
