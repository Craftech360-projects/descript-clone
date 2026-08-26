import { spawn, type ChildProcess } from 'node:child_process';
import type { SpeedMap } from '../../../packages/core/src/edl.ts';
import { writeFile, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONFIG } from './config.ts';
import type { Edl } from '../../../packages/core/src/types.ts';
import {
  buildRenderPlan,
  buildSequenceRenderPlan,
  type BgMusicRender,
  type ImagesRender,
  type SequenceRenderClip,
} from '../../../packages/core/src/render.ts';
import type { Grade } from '../../../packages/core/src/color.ts';
import type { FrameRender } from '../../../packages/core/src/frame.ts';
import type { OutputMove } from '../../../packages/core/src/frame-track.ts';
import { outputDuration } from '../../../packages/core/src/edl.ts';

export interface MediaInfo {
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  /** Frames per second, e.g. 59.94. Absent for audio, or if ffprobe won't say. */
  fps?: number;
}

/**
 * Report whether ffmpeg and ffprobe can actually be spawned.
 *
 * Their absence is not a startup error — the process boots fine and then fails
 * on the first import with a spawn ENOENT, which reads as an app bug rather
 * than a missing dependency. A health check says so before any traffic arrives.
 */
export async function checkTools(): Promise<{ ffmpeg: string | null; ffprobe: string | null }> {
  const version = async (bin: string): Promise<string | null> => {
    try {
      const out = await run(bin, ['-version']);
      return out.split('\n')[0]?.trim() ?? null;
    } catch {
      return null;
    }
  };
  const [ffmpeg, ffprobe] = await Promise.all([
    version(CONFIG.ffmpegPath),
    version(CONFIG.ffprobePath),
  ]);
  return { ffmpeg, ffprobe };
}

/**
 * Can this ffmpeg BURN captions into the picture?
 *
 * Burning goes through libass, reached by the `subtitles` filter. That filter is
 * a BUILD OPTION, not a given: a Homebrew ffmpeg configured without
 * `--enable-libass` runs everything else in this app perfectly and then dies on
 * the one filter the caption burn needs, with
 *
 *     No such filter: 'subtitles'
 *
 * after the render has already been queued. Measured on this machine: ffmpeg
 * 8.1.2, built with x264/x265/opus/vpx and no libass at all — so every export of
 * a project with captions enabled failed, and the only clue was a line of ffmpeg
 * stderr in a job record.
 *
 * Asking once, at startup, turns that into something the UI can say up front and
 * the render route can refuse cleanly. Cached because it cannot change while the
 * process lives.
 */
let subtitlesFilter: boolean | null = null;

/**
 * The encoder flags for a render, honouring CONFIG.videoEncoder.
 *
 * Probed rather than assumed. A build of ffmpeg without VideoToolbox — every
 * Linux one, and some Homebrew formulae — fails with "Unknown encoder" partway
 * into a render that has already spent a minute on the earlier passes, which is
 * the worst moment to find out. Falling back to software costs speed and finishes.
 *
 * Cached: this shells out to ffmpeg, and a render should not pay for the probe
 * every time.
 */
let encoderArgs: string[] | null = null;

export async function renderEncoderArgs(): Promise<string[]> {
  if (encoderArgs) return encoderArgs;

  const SOFTWARE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'];

  if (CONFIG.videoEncoder !== 'videotoolbox') {
    encoderArgs = SOFTWARE;
    return encoderArgs;
  }

  const available = await hasEncoder('h264_videotoolbox');
  if (!available) {
    console.warn('VIDEO_ENCODER=videotoolbox, but this ffmpeg has no h264_videotoolbox — using libx264.');
    encoderArgs = SOFTWARE;
    return encoderArgs;
  }

  /**
   * -q:v rather than -crf: VideoToolbox has no CRF, and passing one is silently
   * ignored, so a render that looked configured would come out at whatever
   * default bitrate the encoder chose. 55 is roughly comparable to crf 18 for
   * this kind of footage — high quality, not visually lossless.
   */
  encoderArgs = ['-c:v', 'h264_videotoolbox', '-q:v', '55'];
  return encoderArgs;
}

/** Does this ffmpeg have the named encoder compiled in? */
async function hasEncoder(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(CONFIG.ffmpegPath, ['-hide_banner', '-encoders'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (c) => { out += String(c); });
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(new RegExp(`\\b${name}\\b`).test(out)));
  });
}

export async function canBurnCaptions(): Promise<boolean> {
  if (subtitlesFilter !== null) return subtitlesFilter;
  try {
    const out = await run(CONFIG.ffmpegPath, ['-hide_banner', '-filters']);
    // The filter table lists one filter per line; the name is the second column.
    subtitlesFilter = /^\s*\S+\s+subtitles\s/m.test(out);
  } catch {
    // If ffmpeg cannot even be asked, the honest answer is "no" — the render
    // would fail anyway, and claiming the capability would only move the error.
    subtitlesFilter = false;
  }
  return subtitlesFilter;
}

/** Synchronous read of the cached answer, for request handlers that cannot await. */
export function burnCaptionsReady(): boolean {
  return subtitlesFilter === true;
}

/**
 * The rotation a container asks a player to apply, as 0 / 90 / 180 / 270.
 *
 * Vertical phone video is almost never STORED vertical. It is stored in the
 * sensor's own landscape orientation with a Display Matrix that says "turn this
 * 90 degrees on the way out" — so ffprobe reports 3840x2160 for a clip that every
 * player, including this app's own `<video>`, shows as 2160x3840.
 *
 * Reading the stored numbers and ignoring the matrix is why an imported reel came
 * out STRETCHED: the editor sized a landscape box around a portrait picture, and
 * `frameSize` then aimed the render at the wrong target shape entirely.
 *
 * Both spellings are handled. `side_data_list` carries the Display Matrix on
 * modern files; `tags.rotate` is the older QuickTime spelling that some phones
 * and most transcoders still emit.
 */
export function rotationOf(video: any): 0 | 90 | 180 | 270 {
  const raw =
    video?.side_data_list?.find((d: any) => d?.rotation !== undefined)?.rotation ??
    video?.tags?.rotate;

  const deg = Number(raw);
  if (!Number.isFinite(deg)) return 0;

  // -90 and 270 are the same instruction. Normalize into [0, 360) and snap to
  // the quarter turns a display matrix can actually express.
  const normalized = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return normalized === 90 || normalized === 180 || normalized === 270 ? normalized : 0;
}

/**
 * The size the picture is SEEN at, which is the only size the rest of this app
 * should ever know about.
 *
 * Verified against ffmpeg 8.1 rather than assumed: decoding this project's own
 * phone clip with default flags yields 2160x3840, and only `-noautorotate` yields
 * the stored 3840x2160. Autorotation is on by default, so every filter graph, every
 * thumbnail and every render downstream already works in DISPLAY space. Reporting
 * display dimensions here is what makes the probe agree with them.
 */
export function displaySize(video: any): { width?: number; height?: number } {
  const width = video?.width;
  const height = video?.height;
  const turned = rotationOf(video) % 180 !== 0;
  return turned ? { width: height, height: width } : { width, height };
}

export async function probe(path: string): Promise<MediaInfo> {
  const out = await run(CONFIG.ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    path,
  ]);

  const data = JSON.parse(out);
  const video = data.streams?.find((s: any) => s.codec_type === 'video');
  const audio = data.streams?.find((s: any) => s.codec_type === 'audio');

  if (!audio) {
    throw new Error('This file has no audio track, so there is nothing to transcribe.');
  }

  // Display size, not stored size — see displaySize(). A vertical phone clip is
  // stored landscape with a 90-degree Display Matrix, and every consumer of these
  // numbers (the monitor's geometry, frameSize, the render target) means the
  // shape the viewer sees.
  const { width, height } = displaySize(video);

  return {
    duration: Number(data.format?.duration ?? 0),
    hasVideo: Boolean(video),
    hasAudio: true,
    width,
    height,
    // avg_frame_rate FIRST, and the order is the whole ballgame. The render's
    // video cut renumbers kept frames to a constant rate with setpts=N/fps, so
    // fps must be frames÷duration — the AVERAGE rate — to reproduce real time.
    // r_frame_rate is the timebase base rate: equal to the average on constant-
    // frame-rate media, but far higher on a variable-frame-rate source (screen
    // grabs, phone video, browser/OBS captures — exactly what gets imported).
    // Feed r_frame_rate into setpts=N/fps there and the frames pack too tightly,
    // so the export runs FASTER than real time and ahead of the audio. Fall back
    // to r_frame_rate only when avg is unusable ("0/0").
    fps: parseFps(video?.avg_frame_rate) ?? parseFps(video?.r_frame_rate),
  };
}

/**
 * A still image's pixel size, and the gate that decides whether it may become an
 * ImageAsset at all.
 *
 * It cannot be `probe`: that one THROWS when a file carries no audio track,
 * which is the one thing every picture is guaranteed to be — so the media probe
 * rejects every valid image before it can report a width.
 *
 * The test is the DEMUXER, not "does it have a video stream", and the difference
 * is the whole reason this is strict. An overlay input is spelt
 * `-loop 1 -framerate F -t D -i file` (see overlayFilterLines), and `loop` is an
 * option of the image2 demuxer family — nothing else has it. Measured against
 * ffmpeg 8.0: an .mp4 and an animated .gif each carry a video stream and each
 * report a width and a height, and each makes the whole command die with
 * "Option loop not found." (exit 8). Accepting one would not produce a bad
 * overlay, it would make EVERY export of the project that holds it fail, long
 * after the import that let it in. Stills open as `<codec>_pipe` — jpeg_pipe,
 * png_pipe, webp_pipe, bmp_pipe, tiff_pipe — or as `image2`; that is the list.
 */
export async function probeImage(path: string): Promise<{ width: number; height: number }> {
  let out: string;
  try {
    out = await run(CONFIG.ffprobePath, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      // A JPEG's EXIF Orientation does NOT appear on the stream — verified:
      // ffprobe reports neither side_data_list nor tags.rotate for a rotated
      // photo, so the stream alone says 400x300 for an image every viewer shows
      // as 300x400. It is only visible as a display matrix on a FRAME, so ask
      // for exactly one.
      '-show_frames',
      '-read_intervals', '%+#1',
      path,
    ]);
  } catch (e) {
    // ffprobe exits non-zero on anything it cannot demux at all. That is the
    // "user attached a PDF" case, and it is a 400 rather than a 500.
    //
    // But it ALSO rejects here when it never ran, and that is a different
    // sentence entirely: a packaged build whose ffprobe is missing, unsigned or
    // built for the wrong architecture fails on the first import of anything,
    // and telling the user their PNG "could not be read as an image" points them
    // at the one thing that is not wrong. See ToolError. The health check at
    // /api/health answers this in one request.
    if (e instanceof ToolError && e.kind === 'spawn') {
      throw new Error(
        `ffprobe could not be started, so no file can be imported — this is the app's install, not this picture. ${e.message}`,
      );
    }
    // ffprobe's own last line names what it objected to ("Invalid data found
    // when processing input", "No such file or directory"). Quote it: the
    // sentence without it is true of every failure and useful for none.
    const said = e instanceof ToolError ? lastLine(e.stderr) : '';
    throw new Error(`That file could not be read as an image${said ? `: ${said}` : '.'}`);
  }

  const data = JSON.parse(out);
  const video = data.streams?.find((s: any) => s.codec_type === 'video');
  if (!video?.width || !video?.height) {
    throw new Error('That file has no picture in it to use as an overlay.');
  }

  // format_name is a comma-joined list of every format the probe matched
  // ("mov,mp4,m4a,3gp,3g2,mj2"), so this asks whether ANY of them is a still
  // demuxer rather than comparing the whole string.
  const formats = String(data.format?.format_name ?? '').split(',');
  if (!formats.some((f) => f === 'image2' || f.endsWith('_pipe'))) {
    throw new Error(
      `That is a ${formats[0] || 'media'} file, and an overlay needs a still image: it holds one frame for the whole time it is on screen, which ffmpeg can only do for a still. Use a JPEG, PNG, WebP, BMP or TIFF.`,
    );
  }

  /**
   * Same rule as video, different place to read it.
   *
   * ffmpeg's decoder applies EXIF Orientation (measured: a 400x300 JPEG with
   * Orientation=6 decodes to 300x400), and so does every browser. Reporting the
   * stored numbers described a portrait photo as landscape — to the panel that
   * warns "this is a 400px image on a 1080p frame", and to the assistant.
   */
  const frame = data.frames?.[0];
  const { width, height } = displaySize({
    width: video.width,
    height: video.height,
    side_data_list: frame?.side_data_list ?? video.side_data_list,
    tags: video.tags,
  });

  return { width: width ?? video.width, height: height ?? video.height };
}

/**
 * ffprobe reports frame rate as a STRING RATIONAL — "60000/1001", not 59.94.
 *
 * It was already in the -show_streams response we parse; nothing read it. Two
 * traps: audio streams report "0/0", which divides to NaN, and a variable-rate
 * stream can report "0/0" on avg_frame_rate too — which is why the caller keeps
 * r_frame_rate as a fallback.
 */
function parseFps(rational: unknown): number | undefined {
  if (typeof rational !== 'string') return undefined;
  const [num, den] = rational.split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num === 0) return undefined;
  return num / den;
}

/**
 * Extract a mono 16 kHz WAV for ASR. Every speech model wants this, and sending
 * a 200 MB video to a transcription API instead of a 5 MB wav is slow and, on a
 * paid API, wasteful.
 */
export async function extractAudioForAsr(input: string, output: string): Promise<string> {
  await run(CONFIG.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    output,
  ]);
  return output;
}

/**
 * Composite a pre-rendered caption strip onto a finished render.
 *
 * A SECOND pass, deliberately. The main graph is intricate — cuts, speed, frame,
 * grade, images, music, all interdependent — and threading another input through
 * both of its builders to work around a missing filter is a poor trade for the
 * risk. This is one input and one overlay against a file that is already
 * correct, so it cannot break the edit; the cost is a re-encode of the video
 * track, which for a reel is seconds.
 *
 * `eof_action=pass` matters: the caption stream is shorter than the programme
 * whenever the last words are not at the very end, and without it ffmpeg holds
 * the final tile — or stops — instead of letting the clean picture through.
 */
export async function burnCaptionStrip(
  input: string,
  output: string,
  strip: { listPath: string; x: number; y: number },
  hooks: RenderHooks = {},
): Promise<void> {
  const args = [
    '-hide_banner', '-v', 'error', '-y',
    '-i', input,
    '-f', 'concat', '-safe', '0', '-i', strip.listPath,
    '-filter_complex',
    `[1:v]format=rgba,setpts=PTS-STARTPTS[cap];` +
      `[0:v][cap]overlay=x=${Math.round(strip.x)}:y=${Math.round(strip.y)}:eof_action=pass:format=auto[v]`,
    '-map', '[v]',
    '-map', '0:a?',
    // Audio is already mixed, cut and normalised by the first pass. Copying it
    // keeps this pass from touching the one thing it has no business changing.
    '-c:a', 'copy',
    ...(await renderEncoderArgs()),
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    output,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(CONFIG.ffmpegPath, args, { windowsHide: true });
    hooks.onSpawn?.(child);
    let stderr = '';
    child.stderr.on('data', (c) => { stderr = (stderr + String(c)).slice(-2000); });
    child.on('error', (e) => reject(new Error(`ffmpeg could not be started: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`burning captions failed (${code}): ${stderr.trim().slice(0, 400)}`));
    });
  });
}

/**
 * Render an EDL to a finished file. This is the only place media is written.
 *
 * Pass `subtitles` (ASS markup) to burn captions into the picture. Burned
 * captions are pixels: they cannot be turned off downstream, which is the point
 * for social video, and the reason it stays opt-in.
 */
export interface RenderHooks {
  /** Called with 0..1 as encoding proceeds. Determinate: we know the target. */
  onProgress?: (fraction: number) => void;
  /** Hand the child process to the caller so a cancel can kill it. */
  onSpawn?: (child: ChildProcess) => void;
}

/** What to render, as one object: this was six positional arguments. */
export interface RenderJob {
  input: string;
  output: string;
  /** Audio-only sources skip the video chain entirely. */
  hasVideo: boolean;
  /** ASS markup to burn into the picture. Omit to render clean. */
  subtitles?: string;
  /**
   * Directory of imported font files to hand libass, so a burned caption can use
   * an imported family. Inert without `subtitles`. See fonts.ts / render.ts.
   */
  fontsDir?: string;
  /** Output speed multiplier. Must already be clamped — see clampSpeed. */
  speed?: number;
  /**
   * Source frame rate. The video cut re-numbers kept frames against it, so a
   * wrong or missing value is a broken output rather than a slow one — when the
   * project record has none, renderEdl probes for it rather than guessing.
   */
  fps?: number;
  /**
   * The source files for a multi-clip stitch, in the SAME order as edl.clips.
   * Present (and matching edl.clips length) makes renderEdl concatenate these
   * into one output instead of cutting the single `input`. Any clip missing its
   * fps is probed. `input` is still required and names the first clip.
   */
  clips?: SequenceRenderClip[];
  /** Canonical output frame size for a multi-clip stitch — the first video clip's. */
  width?: number;
  height?: number;
  /**
   * A background-music bed mixed under the finished program. Omit for none. Works
   * on both the single-input and the multi-clip path, and on audio-only projects.
   * Its `durationSec` is already resolved to the output clock by the caller.
   */
  bgMusic?: BgMusicRender;
  /**
   * Run the program audio through the Studio Sound voice chain before the music
   * bed is mixed in — so the enhancer works on the voice alone and never touches
   * the bed. See studioSoundStages in render.ts.
   */
  studioSound?: boolean;
  /** The trained denoiser already ran on `input` — gentles the voice chain. */
  denoised?: boolean;
  /** Per-clip playback rates. Sequence renders only; see render.ts. */
  clipSpeeds?: SpeedMap;
  /**
   * The crop into a target resolution, already resolved to concrete pixels by the
   * caller — resolveFrame returns null when the setting would change nothing, and
   * that null is why an unreframed project emits no scale/crop at all.
   *
   * This field was missing while index.ts was already passing it, so the value
   * was dropped on the floor here and every export came out at the source's
   * shape however the Frame panel was set. Nothing caught it: the plan builders
   * treat an absent frame as "no reframe", which is a legitimate render.
   */
  frame?: FrameRender;
  /**
   * The colour grade, already resolved to a matrix and an affine by the caller —
   * resolveColor returns null when the grade is neutral. Omit to leave the
   * picture's values untouched. See colorFilterStages in render.ts.
   */
  color?: Grade;
  /**
   * Animated push-ins over the finished frame, already mapped onto the OUTPUT
   * clock by the caller (movesToOutput) and carrying the delivered frame's size.
   *
   * The frame RATE is deliberately not here. zoompan generates its own
   * timestamps from it, so a stale one is a video of the wrong length — and the
   * correct value is the one this function probes for the frame renumber, or the
   * canonical rate it picks for a stitch. Both are resolved below, so the punch
   * takes whichever applies rather than making the caller guess which path it is
   * on. This is the same class of bug the `frame` field's comment records.
   */
  punch?: { moves: OutputMove[]; width: number; height: number };
  /**
   * The B-roll track — overlays already mapped onto the OUTPUT clock by the
   * caller (overlaysToOutput), paired with a path per asset id.
   *
   * `fps` is spelt out of the type for exactly the reason `punch` omits it: the
   * still is generated at that rate, and the correct value is the one resolved
   * below — the fresh probe on the single-input path, the canonical rate on a
   * stitch — not whatever the project record happens to remember.
   *
   * Unlike `punch`, though, a rate that could not be resolved does NOT withdraw
   * the track. zoompan generates its own timestamps, so a wrong rate there is a
   * video of the wrong length; the image branch is bounded by `-t` instead, so a
   * wrong rate costs a dissolve that steps rather than ramps. overlayFilterLines
   * already falls back to 30 for a non-positive rate, and losing a picture the
   * user placed is the worse of the two failures.
   */
  images?: Omit<ImagesRender, 'fps'>;
}

export async function renderEdl(
  edl: Edl,
  job: RenderJob,
  hooks: RenderHooks = {},
): Promise<{ output: string; segments: number; burnedIn: boolean }> {
  const { input, output, hasVideo, subtitles, speed = 1, fontsDir, bgMusic, studioSound, denoised, clipSpeeds, frame, color } =
    job;
  // A multi-clip stitch when the caller handed us one file per EDL clip. A single
  // clip falls through to the original single-input path, byte-identical.
  const sequence = Boolean(edl.clips && edl.clips.length > 1 && job.clips && job.clips.length === edl.clips.length);
  // fps drives the video cut's frame renumbering (setpts=N/fps), so a wrong value
  // is a wrong-speed picture, not a slow render. Probe fresh rather than trust the
  // stored project.fps: a project imported before the avg_frame_rate fix holds
  // r_frame_rate, which is wrong for variable-frame-rate media and would keep
  // exporting too fast. One probe costs milliseconds; getting this wrong costs the
  // whole encode. An explicit job.fps still wins, for a caller that already probed.
  const fps = hasVideo && !sequence ? (job.fps ?? (await probe(input)).fps) : undefined;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const scriptPath = join(tmpdir(), `edl-${stamp}.txt`);
  // libass picks the parser from the extension, so this must stay .ass.
  const subtitlePath = subtitles ? join(tmpdir(), `cap-${stamp}.ass`) : undefined;

  if (subtitlePath) {
    // No BOM: ffmpeg reads a leading U+FEFF as part of the first token and the
    // filtergraph fails to parse with "trailing garbage".
    await writeFile(subtitlePath, subtitles!, 'utf8');
  }

  // Encode to a partial file and rename only on success. Two things this fixes:
  // a canceled or crashed render used to leave a truncated file sitting in
  // media/renders/ looking exactly like a finished one, and on Windows a killed
  // ffmpeg cannot finalise its container at all.
  //
  // The marker goes BEFORE the extension, never after: ffmpeg picks the output
  // muxer from the extension, so "video.mp4.part" fails outright with "Unable to
  // choose an output format". "video.part.mp4" still reads as mp4.
  const partial = output.replace(/(\.[^.]+)$/, '.part$1');
  // fontsDir only matters when there is a subtitle to burn; both plan builders
  // ignore it otherwise, so passing it unconditionally is harmless.
  let plan;
  if (sequence) {
    // Resolve every clip's own fps (the frame renumber needs it), then pick the
    // canonical output rate as the fastest clip so no clip has frames dropped to
    // hit it. Size is the first video clip's, letterboxing the rest.
    const clips = await Promise.all(
      job.clips!.map(async (c) => ({
        input: c.input,
        fps: hasVideo ? (c.fps ?? (await probe(c.input)).fps) : undefined,
        sourceStart: c.sourceStart,
      })),
    );
    const canonFps = Math.max(0, ...clips.map((c) => c.fps ?? 0)) || 30;
    plan = buildSequenceRenderPlan(edl, {
      clips,
      output: partial,
      hasVideo,
      width: job.width ?? 1920,
      height: job.height ?? 1080,
      fps: canonFps,
      subtitlePath,
      speed,
      fontsDir: subtitlePath ? fontsDir : undefined,
      bgMusic,
      studioSound,
      denoised,
      clipSpeeds,
      frame,
      color,
      // The canonical rate every clip was resampled to — not any one clip's, or
      // zoompan would re-time the join to a rate the join does not have.
      punch: job.punch ? { ...job.punch, fps: canonFps } : undefined,
      // Same rate, for the same reason: the stills are generated into the joined
      // stream, so they have to step at the rate that stream actually runs at.
      images: job.images ? { ...job.images, fps: canonFps } : undefined,
    });
  } else {
    plan = buildRenderPlan(edl, {
      input,
      output: partial,
      hasVideo,
      subtitlePath,
      speed,
      fps,
      fontsDir: subtitlePath ? fontsDir : undefined,
      bgMusic,
      studioSound,
      denoised,
      frame,
      color,
      // The same freshly-probed rate the frame renumber uses. Undefined when the
      // probe could not say, and punchFilterStage then emits nothing rather than
      // guessing — losing the move is recoverable, a mistimed export is not.
      punch: job.punch && fps ? { ...job.punch, fps } : undefined,
      // The same rate, but NOT the same guard — see RenderJob.images. 0 is passed
      // through deliberately when the probe could not say, because
      // overlayFilterLines reads a non-positive rate as "fall back to 30" rather
      // than emitting `-framerate 0`.
      images: job.images ? { ...job.images, fps: fps ?? 0 } : undefined,
    });
  }
  await writeFile(scriptPath, plan.filterScript, 'utf8');

  // The output length is known exactly, so this progress is real, not a guess.
  //
  // Speed divides it, and must: ffmpeg reports out_time against the OUTPUT, which
  // at 1.2x reaches the end after 1/1.2 of the un-sped length. Measuring against
  // the wrong target does not just skew the bar — it pins at 83% and never
  // finishes, which reads as a hung render.
  const target = outputDuration(edl, speed);

  try {
    const args = plan.args.map((a) => (a === '{SCRIPT}' ? scriptPath : a));
    await runWithProgress(CONFIG.ffmpegPath, args, target, hooks);
    await rename(partial, output);
    return { output, segments: plan.segments, burnedIn: Boolean(subtitlePath && hasVideo) };
  } catch (e) {
    await unlink(partial).catch(() => {});
    throw e;
  } finally {
    await unlink(scriptPath).catch(() => {});
    if (subtitlePath) await unlink(subtitlePath).catch(() => {});
  }
}

/**
 * Run ffmpeg with `-progress pipe:1`, reporting a real fraction.
 *
 * ffmpeg emits `key=value` lines to stdout. The trap: `out_time_ms` is
 * MICROseconds despite its name — a long-standing misnomer. Divide it by 1000
 * and progress reads 1000x too high and pins at 100% immediately. We read
 * `out_time_us` when present and fall back to `out_time_ms`, treating both as
 * microseconds.
 */
function runWithProgress(
  bin: string,
  args: string[],
  targetSeconds: number,
  hooks: RenderHooks,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['-progress', 'pipe:1', '-nostats', ...args], { windowsHide: true });
    hooks.onSpawn?.(proc);

    let stderr = '';
    let carry = '';

    proc.stdout.on('data', (d: Buffer) => {
      carry += d.toString();
      const lines = carry.split('\n');
      carry = lines.pop() ?? ''; // keep the partial line for the next chunk

      for (const line of lines) {
        const [key, value] = line.split('=');
        if (key !== 'out_time_us' && key !== 'out_time_ms') continue;
        const micros = Number(value);
        if (!Number.isFinite(micros) || targetSeconds <= 0) continue;
        const fraction = Math.min(1, micros / 1e6 / targetSeconds);
        hooks.onProgress?.(fraction);
      }
    });

    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', (err) =>
      reject(new Error(`Could not run ${bin}. Is it on PATH? (${err.message})`)),
    );
    proc.on('close', (code, signal) => {
      if (code === 0) return resolve();
      if (signal || code === null) return reject(new Error('Render canceled.'));
      reject(new Error(`${bin} exited ${code}: ${stderr.trim() || '(no stderr)'}`));
    });
  });
}

/**
 * Waveform peaks for the timeline. Decodes to raw mono PCM and reduces it to
 * `buckets` amplitude values in [0,1].
 *
 * The timeline is worth having real data behind: a fake waveform is worse than
 * none, because you cannot use it to find the edit point you are looking for.
 */
export async function computePeaks(input: string, buckets = 1600): Promise<number[]> {
  const pcm = await runBinary(CONFIG.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-i', input,
    '-vn',
    '-ac', '1',
    '-ar', '8000',        // plenty for a visual envelope; keeps the buffer small
    '-f', 's16le',
    '-',
  ]);

  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  if (samples.length === 0) return [];

  const size = Math.max(1, Math.floor(samples.length / buckets));
  const peaks: number[] = [];

  for (let i = 0; i < samples.length; i += size) {
    let max = 0;
    const end = Math.min(i + size, samples.length);
    for (let j = i; j < end; j++) {
      const v = Math.abs(samples[j]);
      if (v > max) max = v;
    }
    peaks.push(max / 32768);
  }

  return peaks;
}

function runBinary(bin: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', (err) => reject(new Error(`Could not run ${bin}: ${err.message}`)));
    proc.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(`${bin} exited ${code}: ${stderr.trim()}`)),
    );
  });
}

/**
 * A spawned tool that failed, carrying WHICH WAY it failed.
 *
 * The two kinds are opposite problems and a caller that cannot tell them apart
 * will describe one as the other. `spawn` means the binary never ran — missing,
 * wrong architecture, not executable, killed by Gatekeeper — which is a fault in
 * this app's INSTALL and identical for every input. `exit` means it ran, read
 * the file and refused it, which is a fault in the FILE and specific to that
 * one. Reported as the same sentence, a broken package reads to the user as a
 * broken picture, and they go off and re-export the picture.
 *
 * `stderr` is kept because it is where the tool says what it actually objected
 * to; a caller writing a user-facing message should quote it rather than
 * inventing its own guess. See probeImage.
 */
export class ToolError extends Error {
  // Written out longhand rather than as constructor parameter properties: the
  // server runs its TypeScript through Node's strip-only loader, which erases
  // types and refuses anything that would EMIT code. See package.json's scripts.
  kind: 'spawn' | 'exit';
  stderr: string;

  constructor(kind: 'spawn' | 'exit', message: string, stderr = '') {
    super(message);
    this.name = 'ToolError';
    this.kind = kind;
    this.stderr = stderr;
  }
}

/** The last thing a tool said before giving up — its complaint, without the banner. */
function lastLine(text: string): string {
  const lines = text.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));

    proc.on('error', (err) =>
      reject(new ToolError('spawn', `Could not run ${bin}. Is it on PATH? (${err.message})`)),
    );

    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new ToolError('exit', `${bin} exited ${code}: ${stderr.trim() || '(no stderr)'}`, stderr));
    });
  });
}
