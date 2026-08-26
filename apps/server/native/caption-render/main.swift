//
//  jumpcut-captions — rasterise a caption track to PNG tiles, using CoreText.
//
//  Reads ONE json manifest on stdin, writes N PNGs into `dir`, and prints the
//  concat list ffmpeg needs on stdout.
//
//  ── why this exists ─────────────────────────────────────────────────────────
//
//  Burning captions normally means libass, reached through ffmpeg's `subtitles`
//  filter. That filter is a BUILD OPTION, and Homebrew's ffmpeg formula does not
//  carry it — its declared dependencies are dav1d, lame, libvmaf, libvpx,
//  openssl, opus, sdl2-compat, svt-av1, x264, x265 and xz, with no libass,
//  freetype or fontconfig anywhere. So `subtitles`, `ass` AND `drawtext` are all
//  missing, and every export with captions enabled died on
//  "No such filter: 'subtitles'". Reinstalling does not help; the filter is not
//  in the bottle to begin with.
//
//  What IS on every Mac is CoreText, which is a better text engine than libass
//  anyway. So the glyphs are drawn here, once per caption state, and ffmpeg is
//  left doing the one thing it still can: compositing images.
//
//  ── why tiles and not frames ────────────────────────────────────────────────
//
//  A caption only changes when the words change — at a cue boundary, or on the
//  next word when karaoke is on. Rendering one tile per STATE rather than one
//  per frame turns a 96-second programme at 30fps from 2880 images into a few
//  hundred, and the concat demuxer turns those back into a continuous stream
//  with a `duration` against each. ffmpeg then needs exactly ONE overlay filter
//  no matter how many captions there are, which matters because the filtergraph
//  already grows with the cut count.
//
//  Every tile is the same size — the caption BOX, not the whole frame — so the
//  concat stream has one geometry and the overlay has one position.
//

import Foundation
import CoreText
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import AppKit

// ── manifest ────────────────────────────────────────────────────────────────

struct Segment: Codable {
    /// Seconds this tile is on screen. Gaps carry no words.
    let duration: Double
    /// Lines of text. Empty means a transparent gap tile.
    let lines: [String]
    /// Index of the word to draw in the "spoken" colour, counting across lines.
    /// -1 disables karaoke for this tile (every word gets `color`).
    let highlight: Int
}

struct Manifest: Codable {
    let dir: String
    let boxWidth: Int
    let boxHeight: Int
    let fontName: String
    let fontSize: Double
    let color: String
    let highlightColor: String
    let strokeColor: String
    let strokeWidth: Double
    /// "none" | "shadow" | "box"
    let backdrop: String
    let lineGap: Double
    let segments: [Segment]
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("error: \(message)\n".utf8))
    exit(code)
}

func colorOf(_ hex: String, alpha: CGFloat = 1) -> CGColor {
    var s = hex.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6, let v = UInt32(s, radix: 16) else {
        return CGColor(red: 1, green: 1, blue: 1, alpha: alpha)
    }
    return CGColor(
        red: CGFloat((v >> 16) & 0xff) / 255,
        green: CGFloat((v >> 8) & 0xff) / 255,
        blue: CGFloat(v & 0xff) / 255,
        alpha: alpha
    )
}

// ── read the manifest ───────────────────────────────────────────────────────

let stdinData = FileHandle.standardInput.readDataToEndOfFile()
guard let manifest = try? JSONDecoder().decode(Manifest.self, from: stdinData) else {
    fail("could not read the caption manifest on stdin", code: 2)
}

let W = manifest.boxWidth
let H = manifest.boxHeight
guard W > 0, H > 0 else { fail("caption box has no size", code: 2) }

try? FileManager.default.createDirectory(
    atPath: manifest.dir, withIntermediateDirectories: true
)

/// Resolve the family, falling back rather than failing: a caption in the wrong
/// face is recoverable, a render that refuses is not.
func makeFont(_ name: String, _ size: Double) -> CTFont {
    let f = CTFontCreateWithName(name as CFString, size, nil)
    let resolved = CTFontCopyFamilyName(f) as String
    if resolved.lowercased().contains("helvetica") && !name.lowercased().contains("helvetica") {
        FileHandle.standardError.write(Data("note: \(name) unavailable, using \(resolved)\n".utf8))
    }
    return f
}

let font = makeFont(manifest.fontName, manifest.fontSize)
let fg = colorOf(manifest.color)
let hl = colorOf(manifest.highlightColor)
let stroke = colorOf(manifest.strokeColor)

/// One line's words, already measured, so a karaoke tile can colour exactly one.
func runsFor(_ line: String) -> [String] {
    line.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
}

func attributed(_ line: String, wordOffset: Int, highlight: Int) -> NSAttributedString {
    let out = NSMutableAttributedString()
    let words = runsFor(line)
    for (i, word) in words.enumerated() {
        let spoken = highlight >= 0 && (wordOffset + i) <= highlight
        var attrs: [NSAttributedString.Key: Any] = [
            .font: font,
            // Karaoke's direction is the ASS one the app documents: a word WAITS
            // in highlightColor and lands on `color` once spoken.
            .foregroundColor: NSColor(cgColor: spoken ? fg : hl) as Any,
        ]
        if manifest.strokeWidth > 0 && manifest.backdrop != "box" {
            attrs[.strokeColor] = NSColor(cgColor: stroke) as Any
            // Negative width means stroke AND fill; positive is outline only.
            attrs[.strokeWidth] = -manifest.strokeWidth
        }
        out.append(NSAttributedString(string: word, attributes: attrs))
        if i < words.count - 1 {
            out.append(NSAttributedString(string: " ", attributes: attrs))
        }
    }
    return out
}

func renderTile(_ seg: Segment, index: Int) -> String {
    let path = "\(manifest.dir)/cap-\(String(format: "%05d", index)).png"

    let cs = CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(
        data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0,
        space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { fail("could not create a \(W)x\(H) bitmap") }

    // Transparent ground: the tile is composited over the picture.
    ctx.clear(CGRect(x: 0, y: 0, width: W, height: H))

    if !seg.lines.isEmpty {
        // Measure every line first so the block can be centred vertically and
        // the box (if any) drawn to fit.
        var offset = 0
        var built: [(NSAttributedString, CGSize)] = []
        for line in seg.lines {
            let a = attributed(line, wordOffset: offset, highlight: seg.highlight)
            let setter = CTFramesetterCreateWithAttributedString(a)
            let size = CTFramesetterSuggestFrameSizeWithConstraints(
                setter, CFRange(location: 0, length: 0), nil,
                CGSize(width: CGFloat(W), height: CGFloat.greatestFiniteMagnitude), nil
            )
            built.append((a, size))
            offset += runsFor(line).count
        }

        let lineH = CGFloat(manifest.fontSize) * CGFloat(manifest.lineGap)
        let blockH = lineH * CGFloat(built.count)
        var y = (CGFloat(H) - blockH) / 2 + (blockH - lineH)

        if manifest.backdrop == "box" {
            let pad = CGFloat(manifest.strokeWidth)
            let widest = built.map(\.1.width).max() ?? 0
            let rect = CGRect(
                x: (CGFloat(W) - widest) / 2 - pad,
                y: (CGFloat(H) - blockH) / 2 - pad,
                width: widest + pad * 2,
                height: blockH + pad * 2
            )
            ctx.setFillColor(colorOf(manifest.strokeColor, alpha: 0.85))
            ctx.fill(rect)
        }

        for (a, size) in built {
            if manifest.backdrop == "shadow" {
                ctx.setShadow(offset: CGSize(width: 0, height: -2), blur: 6,
                              color: CGColor(red: 0, green: 0, blue: 0, alpha: 0.85))
            }
            let x = (CGFloat(W) - size.width) / 2
            let line = CTLineCreateWithAttributedString(a)
            ctx.textPosition = CGPoint(x: x, y: y + CGFloat(manifest.fontSize) * 0.22)
            CTLineDraw(line, ctx)
            y -= lineH
        }
    }

    guard let image = ctx.makeImage() else { fail("could not snapshot the tile") }
    guard let dest = CGImageDestinationCreateWithURL(
        URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil
    ) else { fail("could not open \(path) for writing") }
    CGImageDestinationAddImage(dest, image, nil)
    guard CGImageDestinationFinalize(dest) else { fail("could not write \(path)") }
    return path
}

// ── render every tile, then print the concat list ───────────────────────────

func quoted(_ path: String) -> String {
    "file '" + path.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

var lines: [String] = ["ffconcat version 1.0"]
for (i, seg) in manifest.segments.enumerated() {
    lines.append(quoted(renderTile(seg, index: i)))
    lines.append("duration " + String(format: "%.4f", max(0.001, seg.duration)))
}

/**
 * A transparent tile to finish on.
 *
 * The concat demuxer holds its LAST entry for whatever time remains after the
 * durations run out, so a track ending on a caption leaves that caption burnt
 * over the tail of the programme. Ending on an empty tile makes the overlay
 * a no-op from there on, whatever the last spoken line was.
 */
let tail = renderTile(Segment(duration: 0.04, lines: [], highlight: -1), index: manifest.segments.count)
lines.append(quoted(tail))

print(lines.joined(separator: "\n"))
