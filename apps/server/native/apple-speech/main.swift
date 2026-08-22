//
//  jumpcut-stt — on-device speech recognition for Jumpcut, via Apple's Speech
//  framework (macOS 26+).
//
//  Reads one audio file, writes ONE json object to stdout:
//
//      { "words": [ { "text": "...", "start": 0.0, "end": 0.42 } ], ... }
//
//  Progress goes to stderr as "#progress <0..1>" lines; every other stderr line
//  is diagnostic text meant for a human reading a server log.
//
//  ── why this exists ─────────────────────────────────────────────────────────
//
//  Every other provider here is a network call with a key. This one is neither:
//  the model ships with the OS, runs on the machine, and costs nothing. It earns
//  its place for one measured reason — it is VERBATIM. Feeding it
//  "So um, today I want to, uh, talk about…" returns "um" and "ah" as their own
//  timed words rather than tidying them away, which is the property the filler
//  remover is built on and the property Whisper-family models lack.
//
//  It has no diarization. `Word.speaker` comes back empty and the editor's
//  speaker colours go quiet. That is the trade: verbatim + free + private,
//  against knowing who is talking.
//
//  ── on timestamps ───────────────────────────────────────────────────────────
//
//  `attributeOptions: [.audioTimeRange]` is the whole reason this is usable.
//  Without it the result is a bare string, and a string cannot be cut against
//  media. With it, every run of the returned AttributedString carries a
//  CMTimeRange, and a run is a word.
//
//  Measured caveat, so nobody has to rediscover it: word boundaries ABSORB
//  adjacent silence. A 2.5s gap between two sentences came back as a 1.38s hole
//  between words, the rest swallowed by the words either side. Cuts derived from
//  these gaps are therefore conservative, which is the safe direction to be
//  wrong in — a pause is under-trimmed rather than a syllable clipped.
//

import Foundation
import Speech
import AVFoundation
import CoreMedia

struct WordOut: Codable {
    let text: String
    let start: Double
    let end: Double
}

struct Payload: Codable {
    let words: [WordOut]
    let locale: String
    let provider: String
    let duration: Double
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data("error: \(message)\n".utf8))
    exit(code)
}

func note(_ message: String) {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
}

func emitProgress(_ fraction: Double) {
    let clamped = min(max(fraction, 0), 1)
    FileHandle.standardError.write(Data("#progress \(String(format: "%.4f", clamped))\n".utf8))
}

// ── arguments ───────────────────────────────────────────────────────────────

var path: String?
var localeId = "en-US"

var i = 1
let argv = CommandLine.arguments
while i < argv.count {
    switch argv[i] {
    case "--locale":
        i += 1
        if i < argv.count { localeId = argv[i] }
    default:
        path = argv[i]
    }
    i += 1
}

guard let audioPath = path else {
    fail("usage: jumpcut-stt [--locale en-US] <audio-file>", code: 2)
}

guard SpeechTranscriber.isAvailable else {
    fail("SpeechTranscriber is not available on this machine", code: 3)
}

let url = URL(fileURLWithPath: audioPath)
guard FileManager.default.fileExists(atPath: audioPath) else {
    fail("no such audio file: \(audioPath)", code: 2)
}

// ── locale ──────────────────────────────────────────────────────────────────
//
// Fall back to en-US rather than failing: an unsupported locale is a worse
// reason to lose a transcript than a slightly wrong language guess, and the
// server only ever asks for languages the panel offered.

let supported = await SpeechTranscriber.supportedLocales
let wanted = Locale(identifier: localeId)
let matched = supported.first { $0.identifier(.bcp47) == wanted.identifier(.bcp47) }
    ?? supported.first { $0.language.languageCode == wanted.language.languageCode }

guard let locale = matched else {
    let names = supported.prefix(12).map { $0.identifier(.bcp47) }.joined(separator: ", ")
    fail("locale \(localeId) is not supported on device. Available: \(names)…", code: 4)
}

if locale.identifier(.bcp47) != wanted.identifier(.bcp47) {
    note("locale \(localeId) unavailable; using \(locale.identifier(.bcp47))")
}

// ── transcribe ──────────────────────────────────────────────────────────────

let transcriber = SpeechTranscriber(
    locale: locale,
    transcriptionOptions: [],
    reportingOptions: [],
    attributeOptions: [.audioTimeRange]
)

do {
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        note("installing on-device speech model…")
        try await request.downloadAndInstall()
        note("model installed")
    }
} catch {
    fail("could not install the on-device speech model: \(error.localizedDescription)", code: 5)
}

let file: AVAudioFile
do {
    file = try AVAudioFile(forReading: url)
} catch {
    fail("could not read audio: \(error.localizedDescription)", code: 2)
}

let duration = Double(file.length) / file.processingFormat.sampleRate
guard duration > 0 else { fail("audio file has no samples", code: 2) }

let analyzer = SpeechAnalyzer(modules: [transcriber])

// Results arrive while the file is still being analyzed, so collection has to
// run alongside analyzeSequence rather than after it.
let collector = Task { () -> [WordOut] in
    var out: [WordOut] = []
    for try await result in transcriber.results {
        let attributed = result.text
        for run in attributed.runs {
            guard let range = run.audioTimeRange else { continue }
            let text = String(attributed[run.range].characters)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty { continue }

            let start = range.start.seconds
            let end = range.end.seconds
            guard start.isFinite, end.isFinite, end > start else { continue }

            out.append(WordOut(text: text, start: start, end: end))
            emitProgress(end / duration)
        }
    }
    return out
}

do {
    _ = try await analyzer.analyzeSequence(from: file)
    try await analyzer.finalizeAndFinishThroughEndOfInput()
} catch {
    collector.cancel()
    fail("transcription failed: \(error.localizedDescription)", code: 6)
}

let words: [WordOut]
do {
    words = try await collector.value
} catch {
    fail("transcription failed while collecting results: \(error.localizedDescription)", code: 6)
}

emitProgress(1)

let payload = Payload(
    words: words,
    locale: locale.identifier(.bcp47),
    provider: "apple_speech",
    duration: duration
)

do {
    let encoder = JSONEncoder()
    let data = try encoder.encode(payload)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    fail("could not encode result: \(error.localizedDescription)", code: 1)
}
