// Renders the workflow icons with AppKit (no third-party assets).
// Usage: swift tools/make_icons.swift <output-dir>
import AppKit

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "workflow"
try? FileManager.default.createDirectory(atPath: "\(outDir)/icons", withIntermediateDirectories: true)

func color(_ hex: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
}

func render(_ path: String, size: CGFloat, draw: (CGRect) -> Void) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    draw(CGRect(x: 0, y: 0, width: size, height: size))
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

// Rounded-square background with a vertical gradient
func tile(_ r: CGRect, _ top: UInt32, _ bottom: UInt32, inset: CGFloat = 0.06) {
    let box = r.insetBy(dx: r.width * inset, dy: r.width * inset)
    let shape = NSBezierPath(roundedRect: box, xRadius: box.width * 0.225, yRadius: box.width * 0.225)
    NSGradient(starting: color(top), ending: color(bottom))!.draw(in: shape, angle: -90)
}

// Envelope outline centred in r
func envelope(_ r: CGRect, scale: CGFloat = 0.52, stroke: NSColor = .white, fill: NSColor? = nil, lineWidth: CGFloat = 0.05, dy: CGFloat = 0) {
    let w = r.width * scale, h = w * 0.68
    let box = CGRect(x: r.midX - w / 2, y: r.midY - h / 2 + r.height * dy, width: w, height: h)
    let body = NSBezierPath(roundedRect: box, xRadius: w * 0.09, yRadius: w * 0.09)
    if let fill = fill { fill.setFill(); body.fill() }
    stroke.setStroke()
    body.lineWidth = r.width * lineWidth
    body.stroke()
    let flap = NSBezierPath()
    flap.move(to: CGPoint(x: box.minX + w * 0.08, y: box.maxY - h * 0.12))
    flap.line(to: CGPoint(x: box.midX, y: box.midY - h * 0.02))
    flap.line(to: CGPoint(x: box.maxX - w * 0.08, y: box.maxY - h * 0.12))
    flap.lineWidth = r.width * lineWidth
    flap.lineCapStyle = .round
    flap.lineJoinStyle = .round
    flap.stroke()
}

func glyph(_ text: String, _ r: CGRect, size: CGFloat = 0.5, weight: NSFont.Weight = .bold, dy: CGFloat = 0) {
    let font = NSFont.systemFont(ofSize: r.width * size, weight: weight)
    let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.white]
    let str = NSAttributedString(string: text, attributes: attrs)
    let s = str.size()
    str.draw(at: CGPoint(x: r.midX - s.width / 2, y: r.midY - s.height / 2 + r.height * dy))
}

func badge(_ r: CGRect, _ fillHex: UInt32, _ text: String) {
    let d = r.width * 0.36
    let circle = CGRect(x: r.maxX - d - r.width * 0.07, y: r.minY + r.width * 0.07, width: d, height: d)
    color(fillHex).setFill()
    NSBezierPath(ovalIn: circle).fill()
    NSColor.white.setStroke()
    let ring = NSBezierPath(ovalIn: circle)
    ring.lineWidth = r.width * 0.035
    ring.stroke()
    glyph(text, circle, size: 0.62, weight: .heavy)
}

// Main icon: envelope with a forwarding arrow badge
render("\(outDir)/icon.png", size: 512) { r in
    tile(r, 0x5B6CFF, 0x2E3BB8)
    envelope(r, scale: 0.56, dy: 0.04)
    badge(r, 0x1FB985, "→")
}

let icons: [(String, UInt32, UInt32, (CGRect) -> Void)] = [
    ("alias", 0x5B6CFF, 0x2E3BB8, { r in envelope(r) }),
    ("alias-off", 0x9AA0AE, 0x656B78, { r in envelope(r); badge(r, 0x565B66, "‖") }),
    ("burner", 0xFF9A3C, 0xE0561B, { r in envelope(r); badge(r, 0xB8420F, "∅") }),
    ("inbox", 0x3AA0FF, 0x1766C9, { r in
        let w = r.width * 0.56, h = w * 0.62
        let box = CGRect(x: r.midX - w / 2, y: r.midY - h / 2, width: w, height: h)
        let tray = NSBezierPath()
        tray.move(to: CGPoint(x: box.minX, y: box.midY))
        tray.line(to: CGPoint(x: box.minX + w * 0.28, y: box.midY))
        tray.line(to: CGPoint(x: box.minX + w * 0.36, y: box.minY + h * 0.3))
        tray.line(to: CGPoint(x: box.maxX - w * 0.36, y: box.minY + h * 0.3))
        tray.line(to: CGPoint(x: box.maxX - w * 0.28, y: box.midY))
        tray.line(to: CGPoint(x: box.maxX, y: box.midY))
        let outline = NSBezierPath(roundedRect: box, xRadius: w * 0.1, yRadius: w * 0.1)
        NSColor.white.setStroke()
        for p in [tray, outline] { p.lineWidth = r.width * 0.05; p.lineJoinStyle = .round; p.lineCapStyle = .round; p.stroke() }
    }),
    ("mail", 0x2FC4C4, 0x14878F, { r in envelope(r, fill: color(0x14878F).withAlphaComponent(0.3)) }),
    ("new", 0x34D07A, 0x15964D, { r in glyph("+", r, size: 0.72, weight: .semibold, dy: 0.02) }),
    ("code", 0xA66BFF, 0x6A2FD0, { r in glyph("123", r, size: 0.34, weight: .heavy) }),
    ("link", 0x5F87B5, 0x35567D, { r in glyph("↗", r, size: 0.56, weight: .bold) }),
    ("edit", 0xFFC23D, 0xD9860B, { r in glyph("Aa", r, size: 0.4, weight: .heavy) }),
    ("web", 0x3FB6F2, 0x167DB3, { r in
        let d = r.width * 0.52
        let c = CGRect(x: r.midX - d / 2, y: r.midY - d / 2, width: d, height: d)
        NSColor.white.setStroke()
        let lw = r.width * 0.045
        let globe = NSBezierPath(ovalIn: c); globe.lineWidth = lw; globe.stroke()
        let meridian = NSBezierPath(ovalIn: c.insetBy(dx: d * 0.27, dy: 0)); meridian.lineWidth = lw; meridian.stroke()
        for y in [c.midY, c.minY + d * 0.28, c.maxY - d * 0.28] {
            let inset = y == c.midY ? 0 : d * 0.07
            let line = NSBezierPath(); line.move(to: CGPoint(x: c.minX + inset, y: y)); line.line(to: CGPoint(x: c.maxX - inset, y: y))
            line.lineWidth = lw; line.stroke()
        }
    }),
    ("trash", 0xFF5A5F, 0xC62830, { r in glyph("×", r, size: 0.7, weight: .semibold, dy: 0.03) }),
    ("warn", 0xFFB020, 0xE06C00, { r in glyph("!", r, size: 0.62, weight: .black, dy: 0.02) }),
    ("refresh", 0x8E97A8, 0x5B6373, { r in glyph("↻", r, size: 0.56, weight: .bold, dy: 0.02) }),
    ("back", 0x8E97A8, 0x5B6373, { r in glyph("←", r, size: 0.52, weight: .bold, dy: 0.02) }),
    ("info", 0x8E97A8, 0x5B6373, { r in glyph("i", r, size: 0.56, weight: .heavy, dy: 0.02) }),
]

for (name, top, bottom, draw) in icons {
    render("\(outDir)/icons/\(name).png", size: 256) { r in
        tile(r, top, bottom)
        draw(r)
    }
}
print("Rendered \(icons.count + 1) icons into \(outDir)")
