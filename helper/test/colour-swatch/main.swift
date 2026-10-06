// STC-510: a full-screen window with two swatches that differ ONLY on a wide-gamut
// display — `color(display-p3 0 1 0)` on the left half, sRGB #00ff00 on the right.
// On an sRGB display they are the same green. Exits after <seconds> (default 10).
// Needs no grant: it only draws.
import AppKit

let seconds = CommandLine.arguments.count > 1 ? Double(CommandLine.arguments[1]) ?? 10 : 10
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
guard let screen = NSScreen.main else { exit(1) }

let win = NSWindow(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
win.level = .screenSaver
win.isOpaque = true
win.backgroundColor = .black
let w = screen.frame.width, h = screen.frame.height
for (i, colour) in [NSColor(displayP3Red: 0, green: 1, blue: 0, alpha: 1),
                    NSColor(srgbRed: 0, green: 1, blue: 0, alpha: 1)].enumerated() {
    let v = NSView(frame: NSRect(x: w * 0.5 * CGFloat(i), y: 0, width: w * 0.5, height: h))
    v.wantsLayer = true
    v.layer?.backgroundColor = colour.cgColor
    win.contentView?.addSubview(v)
}
// A moving bar across the top 5%, clear of the sampled rects. A perfectly still
// screen is a VFR take of one or two frames, which is not the question here;
// frames have to keep arriving for the take to look like a real one.
let bar = NSView(frame: NSRect(x: 0, y: h * 0.95, width: w * 0.05, height: h * 0.05))
bar.wantsLayer = true
bar.layer?.backgroundColor = NSColor.black.cgColor
win.contentView?.addSubview(bar)
var phase = 0.0
Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { _ in
    phase += 0.02
    let x = (sin(phase) * 0.5 + 0.5) * Double(w) * 0.95
    bar.setFrameOrigin(NSPoint(x: x, y: h * 0.95))
}
win.makeKeyAndOrderFront(nil)
print("SWATCH_READY")
fflush(stdout)
DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { exit(0) }
app.run()
