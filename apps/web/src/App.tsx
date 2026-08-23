import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  clipsOf,
  clipGlobalTime,
  clipLocalTime,
  projectDuration,
  waitForJob,
  type Capabilities,
  type Clip,
  type CustomFont,
  type Folder,
  type ImageAsset,
  type JobKind,
  type MediaItem,
  type MusicResult,
  type Project,
  type RenderResult,
  type AsrOptions,
  type SummonedFile,
  type Thumbs,
} from './api.ts';
import { renderFilename, saveAs, saveTextAs } from './download.ts';
import Script from './Script.tsx';
import Timeline from './Timeline.tsx';
import TitleBar from './shell/TitleBar.tsx';
import Dashboard from './shell/Dashboard.tsx';
import Library from './shell/Library.tsx';
import Monitor from './shell/Monitor.tsx';
import Transport from './shell/Transport.tsx';
import Splitter from './shell/Splitter.tsx';
import Rail from './shell/Rail.tsx';
import Icon, { type IconName } from './ui/Icon.tsx';
import { SectionOpen, sectionKey } from './ui/Field.tsx';
import { SwipeAway } from './ui/SwipeAway.tsx';
import TranscribeDialog from './dialogs/TranscribeDialog.tsx';
import ExportDialog from './dialogs/ExportDialog.tsx';
import SettingsDialog from './dialogs/SettingsDialog.tsx';
import type { FillerMode } from './rail/ProjectPanel.tsx';

import {
  beginCutDrag,
  clearDoc,
  correctText,
  countFillers,
  countRetakes,
  endCutDrag,
  historyState,
  loadDoc,
  redoEdit,
  removeFillers,
  removeRetakes,
  restoreAll,
  retrySave,
  runImportChain,
  selectedIds,
  setSaver,
  setSelection,
  setSelectionDeleted,
  undoEdit,
  updateCut,
  updateCaptions,
  updateSpeed,
  updateStudioSound,
  updateFrame,
  beginFrameDrag,
  endFrameDrag,
  addPunchIn,
  setMove,
  setMovePath,
  deletePunchIn,
  updateColor,
  beginColorDrag,
  endColorDrag,
  beginCaptionDrag,
  endCaptionDrag,
  addImageOverlay,
  setOverlay,
  deleteImageOverlay,
  dropOverlaysForAsset,
  beginOverlayDrag,
  endOverlayDrag,
  useEditor,
  flushSave,
} from './store/editor.ts';
import { CAPTION_FONTS, DEFAULT_CAPTIONS, normalizeCaptions } from '../../../packages/core/src/caption-style.ts';
import CaptionOverlay from './shell/CaptionOverlay.tsx';
import { lastStartingAtOrBefore } from '../../../packages/core/src/paragraphs.ts';
import { speakers, colorMap } from './speakers.ts';
import { usePlayback } from './store/playback.ts';
import { useMusicPreview } from './store/musicPreview.ts';
import { useStudioSoundPreview } from './store/studioSound.ts';
import {
  autoImportCount,
  loadAutoImport,
  saveAutoImport,
  type AutoImport,
} from './store/autoImport.ts';
import { cutFromWire, cutToWire, DEFAULT_SPEED, type CutSettings } from '../../../packages/core/src/doc.ts';
import { DEFAULT_FRAME, frameLayout, frameSize } from '../../../packages/core/src/frame.ts';
import SafeAreaOverlay from './shell/SafeAreaOverlay.tsx';
import FloatingAssistant from './agent/FloatingAssistant.tsx';
import { agentModel } from './store/agent.ts';
import {
  MIN_MOVE_SEC,
  boxToPunch,
  punchToBox,
  type FrameBox,
} from '../../../packages/core/src/frame-track.ts';
import { FollowAborted, followObject } from './track/follow.ts';
import { DEFAULT_COLOR } from '../../../packages/core/src/color.ts';
import ImageOverlayLayer from './shell/ImageOverlayLayer.tsx';
import { MAX_OVERLAYS, suggestWindow, type ImageOverlay } from '../../../packages/core/src/overlay.ts';
import { placeByPrompt } from '../../../packages/core/src/image-prompt.ts';
import { bedFadeOut, bedLength, bedLoops } from '../../../packages/core/src/music.ts';
import { clipAt, compileEdl, compileSequenceEdl, outputDuration, outputToSource } from '../../../packages/core/src/edl.ts';
import type { Edl, Transcript, Word } from '../../../packages/core/src/types.ts';
import { wordAt } from '../../../packages/core/src/paragraphs.ts';
import { setAgentBridge, type AgentBridge } from './agent/tools.ts';
import { setChatProject } from './store/agent.ts';
import { connectEditorBridge, reportProject } from './store/bridge.ts';

/**
 * The phone tool bar, ordered the way a cut actually happens: tidy the words,
 * then shape the picture, then dress it, then the odds and ends.
 *
 * Labels and icons match the rail's own sections, and the keys come from the same
 * `sectionKey` the sections use — so renaming a section cannot silently strand it
 * behind a button that no longer opens anything.
 */
const MOBILE_TOOLS: Array<{ key: string; label: string; icon: IconName }> = (
  [
    { label: 'Clean up', icon: 'scissors' },
    { label: 'Pauses', icon: 'clock' },
    { label: 'Captions', icon: 'captions' },
    { label: 'Frame', icon: 'crop' },
    { label: 'Colour', icon: 'contrast' },
    { label: 'Background music', icon: 'music' },
    { label: 'Studio Sound', icon: 'sparkle' },
    { label: 'Push-ins', icon: 'target' },
    { label: 'Images', icon: 'image' },
    { label: 'Advanced', icon: 'sliders' },
  ] as Array<{ label: string; icon: IconName }>
).map((t) => ({ ...t, key: sectionKey(t.label) }));

const CUSTOM_FILLERS_KEY = 'jumpcut.customFillers';

/**
 * One frozen empty array for every project with no image inserts.
 *
 * A fresh `[]` in the render body would be a new reference each pass, which is
 * enough to tear down and rebuild ImageOverlayLayer's rAF loop on every one of
 * App's ~4Hz playback re-renders — the same trap Monitor documents around its
 * `geometry` ref.
 */
const EMPTY_OVERLAYS: ImageOverlay[] = [];

/**
 * The output(1x) time at a source moment: the kept duration lying before it.
 *
 * Unlike edl.ts's sourceToOutput, this never returns null inside a cut gap — it
 * clamps to the gap's near boundary — so the music trim handle can be dragged to
 * land anywhere on the timeline, cut material included, and still resolve to a
 * sensible length.
 */
function keptBefore(edl: Edl, sourceSec: number): number {
  let acc = 0;
  for (const r of edl.keep) {
    if (sourceSec <= r.start) break;
    acc += Math.min(sourceSec, r.end) - r.start;
    if (sourceSec < r.end) break;
  }
  return acc;
}

/**
 * Shift a project's LOCAL per-clip word times onto the one global timeline.
 *
 * The server stores each word's start/end in its own clip's file timeline (plus
 * a clipId). The editor runs on a single global clock, so each word is moved by
 * its clip's offset once, at load. A single-source project has one clip at offset
 * 0, so this returns the transcript untouched.
 */
function globalizeTranscript(p: Project): Transcript {
  const t = p.transcript!;
  const clips = clipsOf(p);
  if (clips.length <= 1) return t;
  const offsetOf = new Map(clips.map((c) => [c.id, c.offset]));
  const firstId = clips[0].id;
  return {
    ...t,
    duration: clips.reduce((sum, c) => sum + c.duration, 0),
    words: t.words.map((w) => {
      const off = offsetOf.get(w.clipId ?? firstId) ?? 0;
      return { ...w, start: w.start + off, end: w.end + off };
    }),
  };
}

/** The user's saved custom filler words, or [] if none / unreadable. */
function loadCustomFillers(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_FILLERS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === 'string') : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [library, setLibrary] = useState<MediaItem[]>([]);
  const [project, setProject] = useState<Project | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Which platform's furniture to outline over the picture.
   *
   * A VIEW preference, not part of the document: it changes nothing about the
   * output, so persisting it into the project would put a render-irrelevant
   * field in every saved file and mark the doc dirty for looking at something.
   * localStorage, the same as the pane widths.
   */
  const [safeArea, setSafeArea] = useState<'off' | 'reels' | 'tiktok' | 'shorts' | 'all'>(() => {
    try {
      const v = localStorage.getItem('ui.safeArea');
      return v === 'reels' || v === 'tiktok' || v === 'shorts' || v === 'all' ? v : 'off';
    } catch {
      return 'off';
    }
  });
  const chooseSafeArea = useCallback((v: 'off' | 'reels' | 'tiktok' | 'shorts' | 'all') => {
    setSafeArea(v);
    try { localStorage.setItem('ui.safeArea', v); } catch { /* private mode */ }
  }, []);
  /** Why the workspace could not boot. Read by the gate, not by the banner. */
  const [bootError, setBootError] = useState<string | null>(null);

  /**
   * Folders, and which one is open.
   *
   * `null` is the top level (a list of folders); a folder id is inside that one;
   * `''` is the Unfiled bucket. Navigation state, deliberately not persisted —
   * coming back to the app should show you the whole shelf, not wherever you
   * happened to stop.
   */
  const [folders, setFolders] = useState<Folder[]>([]);
  /**
   * The last music search, so attach_music can resolve an id the model was
   * shown. Kept in a ref rather than state: nothing renders from it, and a
   * re-render per search would be churn for a lookup table.
   */
  const musicHits = useRef<MusicResult[]>([]);
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);

  const loadFolders = useCallback(
    () => api.folders.list().then(setFolders).catch((e) => setError(`Could not load folders: ${e.message}`)),
    [],
  );

  const createFolder = async (name: string) => {
    try {
      const made = await api.folders.create(name);
      await loadFolders();
      // Straight into it: you made a folder in order to put something in it.
      setOpenFolderId(made.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const patchFolder = async (id: string, patch: { name?: string; brief?: string }) => {
    try {
      await api.folders.update(id, patch);
      await loadFolders();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /** Put a project in a folder, or take it out. '' is Unfiled. */
  const moveProject = async (id: string, folderId: string) => {
    try {
      await api.setProjectFolder(id, folderId || null);
      setLibrary(await api.list());
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeFolder = async (id: string) => {
    try {
      await api.folders.remove(id);
      await loadFolders();
      // The videos survive; only the label is gone. Show them rather than
      // leaving the user staring at a folder that no longer exists.
      await api.list().then(setLibrary).catch(() => {});
      setOpenFolderId(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const [notice, setNotice] = useState<string | null>(null);

  /** The long-running job in flight, if any: what it is and how far along. */
  const [job, setJob] = useState<
    { id: string; progress: number; stage: string; kind: JobKind } | null
  >(null);

  const [dialog, setDialog] = useState<'transcribe' | 'export' | null>(null);
  /** The API-keys dialog — reachable from the dashboard and the assistant panel. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Re-read capabilities after keys change so the assistant/transcription light up
  // (or dim) without a reload. setAsr keeps the transcribe defaults in step too.
  // Errors here are reported, not swallowed: after saving an API key a failed
  // refresh used to leave the assistant reading "off" forever with no reason given.
  const refreshCaps = useCallback(() => {
    api.capabilities()
      .then((c) => { setCaps(c); setAsr(c.asrDefaults); })
      .catch((e) => setError(`Could not refresh what this workspace can do: ${e.message}`));
  }, []);
  /** The media/speakers drawer behind the title-bar ☰. */
  const [libOpen, setLibOpen] = useState(false);
  // Which surface a phone shows: the transcript or the tools rail. On a phone
  // the two cannot share the width, so a switcher under the monitor picks one.
  // Desktop never sees this — the .m-* elements are display:none outside the
  // mobile media query, and the m-view-* class matches no desktop rule.
  const [mobileTab, setMobileTab] = useState<'script' | 'tools'>('script');
  /**
   * Which rail section the phone has open — one at a time, see SectionOpen.
   * null means the sheet is closed and the script has the screen to itself.
   */
  const [openSection, setOpenSection] = useState<string | null>(null);

  /**
   * The phone shows ONE of two things properly rather than three badly.
   *
   * 'watch' gives the picture the screen; 'script' gives it to the transcript.
   * Trying to fit both at once is what the first attempt did, and the result was
   * a medium picture above a three-line transcript above a squeezed timeline —
   * every surface compromised and none of them good.
   *
   * The timeline is hidden in both until asked for. On a 390px screen it is a
   * ruler with colliding labels and clip stubs you cannot aim at; it is worth
   * having when you go looking for it and worth nothing the rest of the time.
   */
  const [phoneMode, setPhoneMode] = useState<'watch' | 'script'>('watch');
  const [showTimeline, setShowTimeline] = useState(false);

  /**
   * Bring the section the tool bar just opened into view.
   *
   * Without this the bar is only half a feature: tapping "Captions" switched to
   * the tools surface and showed it from the top — the Inspector tabs, the
   * project header, "Tighten for reels", then Clean up — with Captions open
   * somewhere below the fold. You still had to hunt for it, which is the cost the
   * bar exists to remove.
   *
   * rAF because the section only stops being `hidden` after the render that
   * opened it, and scrolling to an element with no height puts you in the wrong
   * place. `block: 'start'` so the header you tapped for is the first thing
   * under your thumb.
   */
  useEffect(() => {
    if (!openSection) return;
    /**
     * Scroll the panel itself rather than calling scrollIntoView.
     *
     * scrollIntoView walks up for a scrollable ancestor, and here that walk
     * happens while the sheet is still being laid out — it picked the document,
     * moved nothing, and the section stayed a thousand pixels down. Measuring the
     * two rects and moving the panel by the difference needs no guess about which
     * ancestor scrolls, and works whether the sheet has settled or not.
     *
     * Two frames, not one: the first is the render that opens the section, the
     * second is after the sheet has taken its height. Measuring in between gives
     * an offset that is correct for a layout no longer on screen.
     */
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`[data-sect="${openSection}"]`);
        const panel = el?.closest<HTMLElement>('.panel');
        if (!el || !panel) return;
        const delta = el.getBoundingClientRect().top - panel.getBoundingClientRect().top;
        panel.scrollTo({ top: panel.scrollTop + delta, behavior: 'smooth' });
      });
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [openSection]);
  const [asr, setAsr] = useState<AsrOptions | null>(null);
  const [fillerMode, setFillerMode] = useState<FillerMode>('hesitations');
  const [customFillers, setCustomFillers] = useState<string[]>(loadCustomFillers);
  const [retakeMin, setRetakeMin] = useState(2);

  // Which steps run by themselves on import. A personal preference, so it is
  // read from and written to localStorage, exactly like the custom filler words.
  const [autoImport, setAutoImport] = useState<AutoImport>(loadAutoImport);
  useEffect(() => saveAutoImport(autoImport), [autoImport]);

  // Persist the user's custom filler words across reloads. They are a personal
  // preference, not project data, so localStorage — not the server — is home.
  useEffect(() => {
    try {
      localStorage.setItem(CUSTOM_FILLERS_KEY, JSON.stringify(customFillers));
    } catch { /* private mode: keep them for this session only */ }
  }, [customFillers]);

  const [showDeleted, setShowDeleted] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [followEdit, setFollowEdit] = useState(true);
  const [result, setResult] = useState<RenderResult | null>(null);

  // Imported caption fonts are global — one library backs every project — so they
  // live at the top of the app, not on a project. See importFont / the @font-face
  // effect below.
  const [customFonts, setCustomFonts] = useState<CustomFont[]>([]);
  const [fontBusy, setFontBusy] = useState(false);

  // Background music is per project, so it rides on `project.music`; this only
  // tracks the in-flight import so the button can say so. See importMusic below.
  const [musicBusy, setMusicBusy] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  // The <audio> that plays the music bed in the monitor, on the output clock.
  const musicRef = useRef<HTMLAudioElement>(null);
  // The output frame element in the monitor. Shared with the caption overlay,
  // which measures the same rectangle so a caption is placed against the frame
  // that ships rather than against the source picture behind it.
  const frameRef = useRef<HTMLDivElement>(null);

  const { doc, selection, flash, reveal, saveStatus } = useEditor();

  const words = doc?.words ?? [];
  const cut = doc?.cut ?? null;
  const captions = doc?.captions ?? DEFAULT_CAPTIONS;
  const frame = doc?.frame ?? DEFAULT_FRAME;

  /**
   * The output's SHAPE, published to CSS.
   *
   * The stylesheet had no way to know whether it was laying out a landscape or a
   * vertical programme, so every rule assumed landscape — which is why a 9:16
   * frame sat in a wide centre column surrounded by mat. `frameSize` is the same
   * function the render uses, so the layout reacts to the shape that will
   * actually ship rather than to the shape of the source.
   */
  const frameOut = frameSize(frame, {
    width: project?.width ?? 1920,
    height: project?.height ?? 1080,
  });
  const frameOrientation =
    frameOut.width === frameOut.height
      ? 'square'
      : frameOut.width < frameOut.height
        ? 'portrait'
        : 'landscape';
  const color = doc?.color ?? DEFAULT_COLOR;
  const overlays = doc?.overlays ?? EMPTY_OVERLAYS;
  /**
   * assetId → URL, for the preview layer and the panel.
   *
   * Rebuilt from the project rather than stored on the overlay, so deleting an
   * image and re-adding it under a new id cannot leave a stale URL welded to a
   * placement — and so the document stays free of anything server-shaped.
   */
  const imageUrls = useMemo(
    () => Object.fromEntries((project?.images ?? []).map((img) => [img.id, img.sourceUrl])),
    [project?.images],
  );
  const imageNames = useMemo(
    () => Object.fromEntries((project?.images ?? []).map((img) => [img.id, img.name])),
    [project?.images],
  );
  const speed = doc?.speed ?? DEFAULT_SPEED;
  const history = historyState();

  // The project's clips, in play order with timeline offsets. One entry for a
  // single-source project — so everything below is one code path.
  const clips = useMemo(() => (project ? clipsOf(project) : []), [project]);

  // The seams the "+" markers sit on in the timeline: the start of every clip
  // (index 0 is the very start), plus one past the end for "append". Each carries
  // the play-order slot a new source dropped there would take — offset in global
  // source seconds so the timeline can place it under the current zoom/scroll.
  const clipInsertPoints = useMemo(() => {
    if (!project || clips.length === 0) return [];
    const points = clips.map((c, i) => ({ index: i, time: c.offset }));
    points.push({ index: clips.length, time: project.duration });
    return points;
  }, [clips, project?.duration]);

  // Which clip the one <video> element is currently showing. Playback and seeks
  // swap this as the global playhead crosses a clip seam; a single-clip project
  // never moves off its one clip.
  const [activeClipId, setActiveClipId] = useState<string | null>(null);
  const activeClip = useMemo(
    () => clips.find((c) => c.id === activeClipId) ?? clips[0] ?? null,
    [clips, activeClipId],
  );
  // The rAF playback loop and imperative seeks read the live clip without
  // re-subscribing every render.
  const activeClipRef = useRef<Clip | null>(null);
  activeClipRef.current = activeClip;

  // Reset to the first clip whenever the project changes (not on every clips
  // identity change — e.g. a filmstrip arriving must not yank playback to clip 0).
  useEffect(() => {
    setActiveClipId(clips[0]?.id ?? null);
  }, [project?.id]);

  /**
   * The boot fetch, and the reason it has its OWN error state.
   *
   * The workspace does not render until `caps` and `asr` arrive, so a failure
   * here is not one more banner among many — it is the whole screen. Routing it
   * through `setError` looked like it reported the problem, but the banner is
   * rendered further down than the "Loading workspace…" early return, so nobody
   * ever saw it: with the API server down the app sat on the loading line
   * forever, with no message and no way to retry. `bootError` is what the gate
   * itself reads.
   */
  const loadWorkspace = useCallback(() => {
    setBootError(null);
    api.capabilities()
      .then((c) => { setCaps(c); setAsr(c.asrDefaults); })
      .catch((e) => setBootError(e.message || 'The server did not respond.'));
    // Say so when the listing fails. Swallowing this rendered the Dashboard's
    // "Nothing yet" empty state over a server that was simply unreachable — the
    // user is told their entire library is gone.
    api.list().then(setLibrary).catch((e) => setError(`Could not load your projects: ${e.message}`));
    api.fonts.list().then(setCustomFonts).catch((e) => setError(`Could not load your fonts: ${e.message}`));
    void loadFolders();
  }, []);

  useEffect(() => { loadWorkspace(); }, [loadWorkspace]);

  // Make every imported font available to the preview by declaring an @font-face
  // for it — the same family libass gets from fontsdir at render, so the monitor
  // and the burn show the identical typeface. One managed <style> holds them all;
  // it is rebuilt whenever the library changes and its rules never accumulate.
  useEffect(() => {
    const el = document.createElement('style');
    el.textContent = customFonts
      .map(
        (f) =>
          `@font-face{font-family:"${f.family.replace(/"/g, '')}";` +
          `src:url("${f.url}") format("${f.format}");font-display:swap;}`,
      )
      .join('\n');
    document.head.appendChild(el);
    return () => el.remove();
  }, [customFonts]);

  // Persist the deleted set, debounced and single-flighted by the store. It used
  // to fire on every word toggle with no debounce and no ordering guarantee —
  // and since the PATCH replaces the whole set, a late response could resurrect
  // words you had already cut.
  useEffect(() => {
    if (!project) return setSaver(null);
    const id = project.id;
    setSaver(async (d) => {
      try {
        await api.saveDoc(id, {
          deletedIds: d.words.filter((w) => w.deleted).map((w) => w.id),
          captions: d.captions,
          speed: d.speed,
          studioSound: d.studioSound,
          frame: d.frame,
          color: d.color,
          overlays: d.overlays,
          // Infinity ("keep every pause") does not survive JSON — cutToWire maps
          // it to the 0 the server and disk speak.
          cut: cutToWire(d.cut),
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
    return () => setSaver(null);
  }, [project?.id]);

  // Hydrate the assistant panel from the opened project's saved conversation, and
  // clear it when the editor closes. Keyed on the id, like the saver above, so an
  // in-place refresh of the same project (an edit action returning a fresh record)
  // never clobbers the live chat — only an actual project switch does. This one hook
  // covers every path that changes the open project (import, open, home).
  useEffect(() => {
    setChatProject(project?.id ?? null, project?.chat ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  useEffect(() => {
    const flush = () => flushSave();
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  const edl = useMemo(() => {
    if (!doc) return null;
    // One clip: the original single-source compile, byte-identical.
    if (clips.length <= 1) {
      return compileEdl({ mediaId: '', duration: project?.duration ?? 0, words: doc.words }, doc.cut);
    }
    // Several clips: hand each its own words back on its LOCAL timeline (undo the
    // globalize) so compileSequenceEdl cuts at seams and never merges across a
    // file boundary. The result's ranges come back global, with clip metadata.
    const firstId = clips[0].id;
    const seq = clips.map((c) => ({
      clipId: c.id,
      duration: c.duration,
      words: doc.words
        .filter((w) => (w.clipId ?? firstId) === c.id)
        .map((w) => ({ ...w, start: w.start - c.offset, end: w.end - c.offset })),
    }));
    return compileSequenceEdl(seq, doc.cut);
  }, [doc?.words, doc?.cut, project?.duration, clips]);

  // Who is in this piece, and in what colour. Keyed on the words array, whose
  // identity structural sharing preserves — so this is a full scan per edit, not
  // per render, and it never runs during playback.
  const cast = useMemo(() => speakers(words), [words]);
  const castColors = useMemo(() => colorMap(cast), [cast]);

  const playingIndex = useMemo(
    () => (playing ? wordAt(words, currentTime) : -1),
    [playing, words, currentTime],
  );

  const selectedSet = useMemo(() => selectedIds(words, selection), [words, selection]);
  const flashSet = useMemo(() => new Set(flash), [flash]);

  // The timeline reads the clock imperatively at 60Hz. Passing currentTime as a
  // prop would re-render the whole app on every animation frame. The element's
  // currentTime is LOCAL to the loaded clip; add its offset to report the global
  // timeline position everything else speaks. Offset 0 for a single-clip project.
  const getCurrentTime = useCallback(() => {
    const clip = activeClipRef.current;
    const local = videoRef.current?.currentTime ?? 0;
    return clip ? clipGlobalTime(clip, local) : local;
  }, []);

  const selectedWords = useMemo(
    () => words.filter((w) => selectedSet.has(w.id)),
    [words, selectedSet],
  );

  /**
   * A selection that is already cut offers Restore rather than a second Cut —
   * the phone bar below has room for one verb, so it must be the true one.
   */
  const selectionIsCut = useMemo(
    () => selectedWords.length > 0 && selectedWords.every((w) => w.deleted),
    [selectedWords],
  );

  /** The source range the script selection covers, so both surfaces agree. */
  const selectionRange = useMemo(() => {
    if (selectedWords.length === 0) return null;
    return {
      start: selectedWords[0].start,
      end: selectedWords[selectedWords.length - 1].end,
    };
  }, [selectedWords]);

  // Word edges and cut boundaries — the only places a selection can honestly
  // land, since the EDL is word-bounded.
  const snapTargets = useMemo(() => {
    const targets: number[] = [];
    for (const w of words) { targets.push(w.start); targets.push(w.end); }
    return targets;
  }, [words]);

  /** Dragging in the timeline selects the words that range covers. */
  const selectRange = useCallback(
    (range: { start: number; end: number } | null) => {
      if (!range) return setSelection(null);
      const covered = words.filter((w) => w.end > range.start && w.start < range.end);
      if (covered.length === 0) return setSelection(null);
      setSelection({ anchorId: covered[0].id, focusId: covered[covered.length - 1].id });
    },
    [words],
  );

  const stats = {
    words: words.length,
    kept: words.filter((w) => !w.deleted).length,
    cuts: edl?.keep.length ?? 0,
    outputSec: edl ? outputDuration(edl, speed) : 0,
    sourceSec: project?.duration ?? 0,
    speed,
  };

  const run = async <T,>(label: string, fn: () => Promise<T>) => {
    setBusy(label);
    setError(null);
    try { return await fn(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); return null; }
    finally { setBusy(null); }
  };

  const cancelJob = useCallback(() => {
    // A failed cancel used to look exactly like a successful one — the job kept
    // running and the UI implied it had stopped.
    if (job) void api.cancelJob(job.id).catch((e) => setError(`Could not cancel the job: ${e.message}`));
  }, [job]);

  const openTranscript = (p: Project, defaults: CutSettings) => {
    // Cut settings, caption style and speed are all persisted per project, so
    // they come off the record. Anything a project saved before these existed is
    // missing, and each fills in: cutFromWire to the engine defaults,
    // normalizeCaptions per FIELD, speed (via clampSpeed downstream) to 1.
    //
    // Per field, not per object. This was `p.captions ?? DEFAULT_CAPTIONS`, which
    // only covers a project that never had captions at all — one that had them
    // before a setting was added kept the gap. See normalizeCaptions.
    if (p.transcript) {
      // The stored words hold LOCAL per-clip timestamps; the editor works on one
      // global timeline (playhead, EDL, selection, timeline). Shift each word by
      // its clip's offset once here, so every consumer downstream stays a single-
      // timeline code path and only the EDL compile splits back per clip. A
      // single-source project has offset 0, so this is a no-op for it.
      loadDoc(
        globalizeTranscript(p),
        cutFromWire(p.cut, defaults),
        normalizeCaptions(p.captions),
        p.speed,
        p.studioSound,
        p.frame,
        p.color,
        p.overlays,
      );
    } else clearDoc();
  };

  // --- the on-import chain ------------------------------------------------------
  /**
   * Take a file that just landed all the way to something you could export.
   *
   * Transcribe, cut the hesitations, cap the pauses, set the speed, enhance the
   * voice, turn on the captions — the six things you would otherwise do by hand,
   * in the only order they work in. Which of them run is the user's, in the
   * Library drawer under "On import"; see store/autoImport.ts.
   *
   * The split here is deliberate. Transcription is a SERVER JOB: it has to be
   * awaited, it can fail, and it replaces the document wholesale, so it lives up
   * here where the project state and the progress bar are. The steps after it are
   * pure edits to the document, so they go down into the store as one batch —
   * one undo step, one save, and no chance of racing the debounced write.
   *
   * Failures propagate to `run`, which shows the banner and clears busy. A chain
   * that dies at transcription leaves an imported, untranscribed project — which
   * is exactly the state importing has always left you in, so nothing is lost.
   */
  const runAutoImport = async (imported: Project): Promise<Project> => {
    const steps = autoImport;
    let p = imported;
    if (autoImportCount(steps) === 0) return p;

    let transcribed = false;
    if (steps.transcribe && !p.transcript) {
      if (!caps?.hasAsr || !asr) {
        setNotice(
          'Imported. The on-import chain starts with transcription, and no ASR provider is ' +
            'configured — set ELEVENLABS_API_KEY on the server, or run Transcribe by hand.',
        );
        return p;
      }
      // The auto-import preference only breaks a tie. If exactly one real key is
      // configured, it wins regardless of an older saved preference.
      const preferred = caps.asrModels.find(
        (model) => model.provider === steps.asrProvider && model.available,
      );
      const onlyReal = caps.asrModels.filter((model) => model.available && model.provider !== 'mock');
      const autoModel = preferred ?? (onlyReal.length === 1 ? onlyReal[0] : undefined);
      const { jobId } = await api.transcribe(p.id, { ...asr, ...(autoModel ? { model: autoModel.id } : {}) });
      setJob({ id: jobId, progress: -1, stage: 'Transcribing', kind: 'transcribe' });
      await waitForJob(jobId, (j) =>
        setJob({ id: jobId, progress: j.progress, stage: j.stage, kind: 'transcribe' }),
      );
      setJob(null);
      // The job returns an id, not the project — a 485KB payload has no business
      // in a record polled twice a second. Same reason as doTranscribe.
      p = await api.get(p.id);
      setProject(p);
      openTranscript(p, editDefaults(caps));
      setLibrary(await api.list());
      transcribed = true;
    }

    // Hesitations only, never the wider "All" sweep: "sort of" and "I mean" are
    // load-bearing often enough that nothing should cut them unasked. The custom
    // words ride along, since those the user chose by name.
    const done = runImportChain({
      fillers: steps.fillers
        ? { includeDiscourseMarkers: false, customWords: customFillers }
        : null,
      maxGapMs: steps.pauses ? steps.pauseCapMs : null,
      speed: steps.speed ? steps.speedValue : null,
      studioSound: steps.studioSound ? true : null,
      captions: steps.captions ? true : null,
    });

    // Land it now rather than 800ms from now: the chain is the last thing that
    // happens to an import, so there is nothing coming to coalesce with.
    flushSave();

    const applied = [...(transcribed ? ['transcribed'] : []), ...done.applied];
    setNotice(
      applied.length > 0
        ? `Ready — ${applied.join(', ')}. Undo takes the clean-up back in one step.`
        : 'Imported. Nothing in the on-import chain had anything to do.',
    );
    return p;
  };

  // --- library -----------------------------------------------------------------
  /**
   * Give the project the name the user typed before picking files.
   *
   * A rename, not an import parameter: the import endpoint takes the filename
   * from a header and naming it there would mean a second way to set the same
   * field. This is one PATCH that moves no bytes.
   *
   * A failed rename keeps the import. The project exists and is openable; it just
   * carries the filename until it is renamed by hand, which is strictly better
   * than discarding an upload that already landed.
   */
  const applyName = async (p: Project, name?: string): Promise<Project> => {
    const wanted = name?.trim();
    if (!wanted || wanted === p.name) return p;
    try {
      const { project } = await api.rename(p.id, wanted);
      return project;
    } catch {
      return p;
    }
  };

  const importFile = (file: File, name?: string) =>
    run('import', async () => {
      let p = await api.import(file);
      p = await applyName(p, name);
      // Land it where the user is standing. An import made inside a folder
      // belongs to that folder — otherwise the folder is a label you have to
      // remember to apply, which is the thing folders are supposed to replace.
      if (openFolderId) {
        try {
          await api.setProjectFolder(p.id, openFolderId);
          p.folderId = openFolderId;
        } catch {
          // A failed filing must not lose the import — the project exists and is
          // openable; it just sits in Unfiled until it is moved.
        }
      }
      setProject(p);
      openTranscript(p, editDefaults(caps));
      setResult(null);
      setLibrary(await api.list());
      // Import still does not transcribe on its own — but if you have asked for
      // the on-import chain, this is where it runs. With every step off this
      // returns immediately and importing means exactly what it always did.
      //
      // After the api.list() await, deliberately: React has flushed the render
      // that setProject queued, so the effect keyed on project.id has installed
      // the saver and the chain's edits actually persist.
      return await runAutoImport(p);
    }).finally(() => setJob(null));

  /**
   * Append another source file to the OPEN project, extending its timeline.
   *
   * This is "add a video into this project": import lands a new project, this
   * lands a new clip on the current one. A transcribed project transcribes the
   * newcomer (a job); either way we re-fetch to pick up the stitched transcript
   * and the recomputed clip list. flushSave first so any pending word deletions
   * are on the server before it rewrites the transcript.
   */
  const addClip = (file: File, atIndex?: number) =>
    run('addClip', async () => {
      await flushSave();
      // The clips present before the append — used both to spot which id is the
      // newcomer and to rebuild the order when inserting somewhere other than end.
      const before = clips.map((c) => c.id);
      const { jobId } = await api.addClip(project!.id, file);
      if (jobId) {
        setJob({ id: jobId, progress: -1, stage: 'Transcribing new clip', kind: 'transcribe' });
        await waitForJob(jobId, (j) =>
          setJob({ id: jobId, progress: j.progress, stage: j.stage, kind: 'transcribe' }),
        );
      }
      let fresh = await api.get(project!.id);
      // A positional insert is an append followed by a reorder: the server only
      // knows how to add at the end, so slot the new id into place ourselves.
      const newId = clipsOf(fresh)
        .map((c) => c.id)
        .find((id) => !before.includes(id));
      if (newId && atIndex != null && atIndex < before.length) {
        const order = before.slice();
        order.splice(atIndex, 0, newId);
        await api.reorderClips(project!.id, order);
        fresh = await api.get(project!.id);
      }
      setProject(fresh);
      openTranscript(fresh, editDefaults(caps));
      setResult(null);
      setLibrary(await api.list());

      // The on-import chain applies here too, but only its filler step, and only
      // over the clip that just arrived. The rest are DOCUMENT settings — pauses,
      // speed, the enhancer, captions — which this project already decided when it
      // was imported; re-asserting them would quietly overrule any change made
      // since. Adding footage is not permission to reset the edit.
      if (autoImport.fillers && newId && jobId) {
        const done = runImportChain({
          fillers: { includeDiscourseMarkers: false, customWords: customFillers },
          fillersInClipId: newId,
          maxGapMs: null,
          speed: null,
          studioSound: null,
          captions: null,
        });
        if (done.fillers > 0) setNotice(`Clip added — ${done.applied.join(', ')} from it.`);
      }
      return fresh;
    }).finally(() => setJob(null));

  /** Remove a clip from the open project. Refused server-side if it is the last. */
  const removeClip = (clipId: string) =>
    run('removeClip', async () => {
      await flushSave();
      await api.removeClip(project!.id, clipId);
      const fresh = await api.get(project!.id);
      setProject(fresh);
      openTranscript(fresh, editDefaults(caps));
      setResult(null);
      return fresh;
    });

  /**
   * Several files as ONE project, clips in the order they were picked.
   *
   * The first file makes the project — that is the only call that can create one —
   * and the rest are appended as clips. Sequential rather than parallel on
   * purpose: each upload streams to disk and then gets probed, and firing five at
   * once at a laptop or a Mac mini turns a predictable wait into contention with
   * no progress anyone can read.
   *
   * A failure partway through keeps what landed. Four of five clips imported is a
   * project you can work with and add the fifth to; throwing all four away
   * because the fifth was a HEIC would be worse, and the error names which one.
   */
  const importMany = (files: File[], name?: string) =>
    run('import', async () => {
      let p = await api.import(files[0]);
      p = await applyName(p, name);
      if (openFolderId) {
        try {
          await api.setProjectFolder(p.id, openFolderId);
          p.folderId = openFolderId;
        } catch {
          // Same reasoning as importFile: a failed filing must not lose the import.
        }
      }

      const failed: string[] = [];
      for (let i = 1; i < files.length; i++) {
        setBusy(`import ${i + 1}/${files.length}`);
        try {
          const r = await api.addClip(p.id, files[i]);
          p = r.project;
        } catch (e) {
          failed.push(files[i].name);
        }
      }

      setProject(p);
      openTranscript(p, editDefaults(caps));
      setResult(null);
      setLibrary(await api.list());
      if (failed.length) {
        setError(
          `Imported ${files.length - failed.length} of ${files.length}. ` +
            `Could not add: ${failed.join(', ')}.`,
        );
      }
      return p;
    });

  /**
   * Commit a whole new play order at once — what dragging a clip along the
   * timeline's clip lane produces.
   *
   * Reordering, not repositioning: clips are a gapless sequence whose offsets
   * are the sum of the durations before them, so the only thing a drag can
   * change is which slot a clip occupies.
   */
  const reorderClips = (ids: string[]) =>
    run('reorderClip', async () => {
      await flushSave();
      await api.reorderClips(project!.id, ids);
      const fresh = await api.get(project!.id);
      setProject(fresh);
      openTranscript(fresh, editDefaults(caps));
      setResult(null);
      return fresh;
    });

  /** Move a clip one place earlier (-1) or later (+1) in play order. */
  const moveClip = (clipId: string, delta: -1 | 1) =>
    run('reorderClip', async () => {
      await flushSave();
      const ids = clips.map((c) => c.id);
      const from = ids.indexOf(clipId);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= ids.length) return project!;
      [ids[from], ids[to]] = [ids[to], ids[from]];
      await api.reorderClips(project!.id, ids);
      const fresh = await api.get(project!.id);
      setProject(fresh);
      openTranscript(fresh, editDefaults(caps));
      setResult(null);
      return fresh;
    });

  /**
   * Cut the clip under the playhead in two, at the playhead — the razor. The two
   * pieces become independent clips (reorder, remove, add between). Instant and
   * non-destructive: the halves share the one source file. Refused at the very
   * edge of a clip, where there is nothing to cut off.
   */
  const splitAt = async (t: number): Promise<string> => {
    const clip = clips.find((c) => t >= c.offset && t < c.offset + c.duration) ?? activeClip;
    if (!clip) return 'No clip is under that time.';
    const at = t - clip.offset;
    if (at <= 0.2 || at >= clip.duration - 0.2) {
      setNotice('Move the playhead into a clip, away from its edges, to split it.');
      return 'That time is at a clip edge — there is nothing to cut off there.';
    }
    const fresh = await run('splitClip', async () => {
      await flushSave();
      await api.splitClip(project!.id, clip.id, at);
      const fresh = await api.get(project!.id);
      setProject(fresh);
      openTranscript(fresh, editDefaults(caps));
      setResult(null);
      setNotice('Clip split. The two pieces are now separate clips.');
      return fresh;
    });
    return fresh ? 'Clip split. The two pieces are now separate clips.' : 'The split did not complete.';
  };

  /** The razor, on the keyboard and in the transport: split wherever we are now. */
  const splitAtPlayhead = (): Promise<string> => splitAt(getCurrentTime());
  // The global keydown effect below subscribes on a small dep set, so it would
  // otherwise close over a stale splitAtPlayhead (which reads clips/project). A
  // ref keeps the shortcut calling the current one without re-subscribing.
  const splitRef = useRef(splitAtPlayhead);
  splitRef.current = splitAtPlayhead;

  // --- fonts (global, shared across projects) ---------------------------------
  //
  // Its own busy flag, not `run`'s: importing a font must not read as the app
  // being busy, and it leaves the current selection and document untouched. The
  // returned entry replaces any font of the same family in place, so re-importing
  // an updated cut of a face just refreshes it.
  const importFont = async (file: File) => {
    setFontBusy(true);
    setError(null);
    try {
      const font = await api.fonts.upload(file);
      setCustomFonts((prev) => {
        const rest = prev.filter((f) => f.id !== font.id);
        return [...rest, font].sort((a, b) => a.label.localeCompare(b.label));
      });
      setNotice(`Imported “${font.label}”. It is available on every project.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFontBusy(false);
    }
  };

  const removeFont = async (id: string) => {
    setFontBusy(true);
    setError(null);
    try {
      await api.fonts.remove(id);
      setCustomFonts((prev) => prev.filter((f) => f.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFontBusy(false);
    }
  };

  // --- background music (per project) -----------------------------------------
  //
  // Its own busy flag rather than `run`'s, exactly like fonts: importing a bed is
  // not the app being "busy", and it must not touch the selection or the doc.
  // volume/length changes are optimistic on the project, then persisted debounced
  // — a slider drag would otherwise fire a PATCH per pixel.
  const importMusic = async (file: File) => {
    if (!project) return;
    setMusicBusy(true);
    setError(null);
    try {
      const p = await api.music.upload(project.id, file);
      setProject((cur) => (cur?.id === p.id ? p : cur));
      setNotice(`Added “${file.name}” as background music.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMusicBusy(false);
    }
  };

  /**
   * Attach a bed found through the picker.
   *
   * Same shape as importMusic, and deliberately so — the difference is only
   * where the bytes come from, and the server does that fetching, so the browser
   * never holds them. Everything after this point cannot tell the two apart.
   */
  const pickMusic = async (track: MusicResult) => {
    if (!project) return;
    setMusicBusy(true);
    setError(null);
    try {
      const p = await api.music.fromUrl(project.id, track);
      setProject((cur) => (cur?.id === p.id ? p : cur));
      setNotice(
        track.attribution
          ? `Added “${track.title}”. Remember to credit ${track.artist} — the line is in the Music panel.`
          : `Added “${track.title}” as background music.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMusicBusy(false);
    }
  };

  const removeMusic = async () => {
    if (!project) return;
    setMusicBusy(true);
    setError(null);
    try {
      const p = await api.music.remove(project.id);
      setProject((cur) => (cur?.id === p.id ? p : cur));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMusicBusy(false);
    }
  };

  // Coalesce rapid patches (a slider emits many) into one server write. The
  // pending patch accumulates FIELDS so a volume drag followed by a length change
  // both land, rather than the later timer clobbering the earlier field.
  type MusicPatch = { volume?: number; durationSec?: number | null; loop?: boolean };
  const pendingMusic = useRef<MusicPatch>({});
  const musicSaveTimer = useRef<number | null>(null);
  const updateMusic = (patch: MusicPatch) => {
    if (!project?.music) return;
    const id = project.id;
    // Optimistic: the panel and the preview read project.music, so reflect the
    // change at once and let the debounced PATCH catch up.
    setProject((cur) => {
      if (!cur?.music) return cur;
      const music = { ...cur.music };
      if (patch.volume !== undefined) music.volume = patch.volume;
      if (patch.loop !== undefined) music.loop = patch.loop;
      if (patch.durationSec !== undefined) {
        if (patch.durationSec === null) delete music.durationSec;
        else music.durationSec = patch.durationSec;
      }
      return { ...cur, music };
    });

    pendingMusic.current = { ...pendingMusic.current, ...patch };
    if (musicSaveTimer.current) window.clearTimeout(musicSaveTimer.current);
    musicSaveTimer.current = window.setTimeout(() => {
      const body = pendingMusic.current;
      pendingMusic.current = {};
      api.music
        .update(id, body)
        .then((p) => setProject((cur) => (cur?.id === p.id ? p : cur)))
        .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    }, 350);
  };

  // The finished program's length on the output clock. One value, used by the
  // bed's resolve, its lane on the timeline, and the preview — the bed is capped
  // by it in three places and they must be the same number in all three.
  const programSec = useMemo(() => (edl ? outputDuration(edl, speed) : 0), [edl, speed]);

  // Trim/extend the bed by dragging its right edge on the timeline. The handle
  // reports a SOURCE time; convert it to a length on the output clock. keptBefore
  // is the output(1x) time at that source point (gap-safe, unlike sourceToOutput
  // which is null inside a cut); ÷ speed gives the post-speed length the bed and
  // the render both speak. Not looping caps it at the file's own length; looping
  // lets it run to the whole program.
  const resizeMusic = (endSourceSec: number) => {
    if (!project?.music || !edl) return;
    const out1x = keptBefore(edl, endSourceSec);
    const cap = bedLoops(project.music)
      ? programSec
      : Math.min(project.music.sourceDuration, programSec);
    const durationSec = Math.min(Math.max(0.1, out1x / speed), cap);
    updateMusic({ durationSec });
  };

  // "Duplicate to fill": loop the track across the whole video. One gesture that
  // turns looping on and clears the length cap so the bed runs the full program.
  const fillMusic = () => updateMusic({ loop: true, durationSec: null });

  const openProject = (id: string) =>
    run('open', async () => {
      const p = await api.get(id);
      setProject(p);
      openTranscript(p, editDefaults(caps));
      setResult(null);
      return p;
    });

  /**
   * Close the project and go back to the grid.
   *
   * flushSave first, and awaited: edits are written on a debounce, so leaving the
   * editor is the one moment where a pending write has nowhere left to land —
   * clearDoc would drop it. Everything after is the reverse of openProject.
   */
  const goHome = async () => {
    await flushSave();
    videoRef.current?.pause();
    clearDoc();
    setProject(null);
    setResult(null);
    setLibOpen(false);
    setDialog(null);
    setError(null);
    setNotice(null);
    api.list().then(setLibrary).catch((e) => setError(`Could not load your projects: ${e.message}`));
  };

  /**
   * Delete a project outright — the record and the media file behind it.
   *
   * The one action here with no undo, which is why both callers ask first. If it
   * is the open project, leave the editor BEFORE the request: goHome flushes the
   * debounced save, and a pending write landing on a record the server has just
   * deleted would either 404 into the error strip or, worse, recreate it.
   */
  /**
   * Rename a project, optimistically.
   *
   * The grid updates before the request lands. A rename is one string on a
   * record nothing else is keyed by, so the only failure mode is that it does
   * not stick — and the refresh in the catch puts the old name straight back.
   * Waiting a round trip to redraw a label you just typed is the worse trade.
   */
  const renameProject = async (id: string, name: string) => {
    const clean = name.replace(/\s+/g, ' ').trim();
    const before = library.find((m) => m.id === id);
    if (!clean || !before || clean === before.name) return;

    setLibrary((prev) => prev.map((m) => (m.id === id ? { ...m, name: clean } : m)));
    if (project?.id === id) setProject((p) => (p ? { ...p, name: clean } : p));
    try {
      await api.rename(id, clean);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setLibrary(await api.list().catch(() => library));
    }
  };

  const deleteProject = async (id: string) => {
    if (project?.id === id) await goHome();
    await run('delete', async () => {
      await api.remove(id);
      setLibrary(await api.list());
    });
  };

  /**
   * Build the filmstrip on first open of a video project.
   *
   * Lazy rather than at import because it costs ~8s of ffmpeg (measured on the
   * 885s file), and import should not sit on that. Fire-and-forget and silent on
   * failure: no strip degrades the timeline to a waveform, which is exactly what
   * it was before — it must never block the editor or raise an error banner.
   */
  useEffect(() => {
    const id = project?.id;
    if (!id || !project?.hasVideo || project.thumbs) return;

    let live = true;
    // Guard the write on the id: an 8s job easily outlives the user clicking
    // another project, and the strip belongs to the one that asked for it.
    const apply = (thumbs: Thumbs) =>
      live && setProject((p) => (p && p.id === id ? { ...p, thumbs } : p));

    void (async () => {
      try {
        const res = await api.thumbs(id);
        if (res.thumbs) return apply(res.thumbs);
        if (res.jobId) apply(await waitForJob<Thumbs>(res.jobId, () => {}));
      } catch {
        // No filmstrip. The waveform is still a timeline.
      }
    })();

    return () => { live = false; };
  }, [project?.id, project?.hasVideo, project?.thumbs]);

  // --- stages ------------------------------------------------------------------
  //
  // `override` is for the assistant: the dialog's options live in React state, so
  // a tool that sets them and transcribes in one turn would otherwise send the
  // state as it was when this closure was built. Merging here makes "transcribe
  // it verbatim" one call instead of two and a re-render.
  const doTranscribe = (override?: Partial<AsrOptions>) =>
    run('transcribe', async () => {
      const { jobId } = await api.transcribe(project!.id, { ...asr!, ...(override ?? {}) });
      setJob({ id: jobId, progress: -1, stage: 'Starting', kind: 'transcribe' });

      await waitForJob(jobId, (j) =>
        setJob({ id: jobId, progress: j.progress, stage: j.stage, kind: 'transcribe' }),
      );

      // The job returns an id, not the project: a 485KB payload has no business
      // in a record polled twice a second.
      const p = await api.get(project!.id);
      setProject(p);
      openTranscript(p, editDefaults(caps));
      setResult(null);
      setDialog(null);
      setLibrary(await api.list());
      // The verbatim warning is not a toast — it lives in the rail next to the
      // filler tool it is about, where you can act on it.
      return p;
    }).finally(() => setJob(null));

  const doCaptions = (format: string) =>
    run('captions', async () => {
      // Same reason the render flushes: the server builds cues from ITS stored
      // transcript, so an unsaved cut would be absent from the picture and
      // present in the subtitles. This path had no flush at all — cut a
      // sentence, export an .srt, and the sentence was still in the file.
      await flushSave();
      // speed rides along: a sidecar file is read against the RENDERED clock, so
      // its cues have to be divided the way the render's are.
      const r = await api.captions(project!.id, { format, ...cut, speed });
      // saveTextAs, not an inline anchor: on Android the shell's bridge does
      // the save, and everywhere else this is the same blob+anchor as before.
      saveTextAs(r.content, `${project!.name.replace(/\.[^.]+$/, '')}.${format}`);
      setNotice(`${r.cues} caption cues, timed to the edit.`);
      return r;
    });

  const doRender = (preset = 'source') =>
    run('render', async () => {
      // The server renders from ITS copy of the deleted set, so the edit has to
      // have LANDED before we ask for pixels — awaited, not fired off. Without
      // the await, a render started inside the 800ms save debounce exported the
      // previous document: the words you just cut were still in the file.
      await flushSave();
      const { jobId } = await api.render(project!.id, {
        // Where the file is going: fixes the output shape and the loudness target.
        preset,
        ...cut!,
        burnCaptions: captions.enabled,
        captions,
        speed,
        // The bed's live settings ride along too, so an Export fired mid-debounce
        // still uses the volume/length on screen rather than the last saved ones.
        music: {
          enabled: project?.music ? true : false,
          volume: pendingMusic.current?.volume ?? project?.music?.volume ?? 1,
          durationSec: pendingMusic.current?.durationSec ?? project?.music?.durationSec ?? null,
          // bedLoops, not `?? false`: an absent flag means "fill the video", and
          // sending a literal false here would tell the server the user had
          // turned looping OFF — overriding the very default it falls back to.
          loop: pendingMusic.current?.loop ?? (project?.music ? bedLoops(project.music) : false),
        },
        studioSound: doc?.studioSound ?? project?.studioSound ?? false,
        // Same reason as captions and speed above: an Export fired mid-debounce
        // must reframe to the crop on screen, not to the last one that saved.
        frame: doc?.frame ?? project?.frame,
        // …and grade to the look on screen, for the same reason.
        color: doc?.color ?? project?.color,
      });
      setJob({ id: jobId, progress: -1, stage: 'Starting', kind: 'render' });

      const r = await waitForJob<RenderResult>(jobId, (j) =>
        setJob({ id: jobId, progress: j.progress, stage: j.stage, kind: 'render' }),
      );

      setResult(r);
      setDialog(null);
      // Offer the save without being asked. A render is a terminal act — the
      // user came here to get a file out, and making them find a link
      // afterwards is a step that exists only because we did not take it.
      // The link in the monitor stays, for saving a second copy.
      saveAs(r.url, renderFilename(project!, r));
      setNotice(
        r.captionsSkipped
          ? 'Rendered without captions — this project is audio only, so there is no picture to burn them onto.'
          : `Rendered ${fmtShort(r.outputDuration)} in ${r.renderMs}ms — choose where to save it.`,
      );
      return r;
    }).finally(() => setJob(null));

  // --- playback ----------------------------------------------------------------

  // Live clips for the imperative seek/swap paths, without re-subscribing.
  const clipsRef = useRef<Clip[]>([]);
  clipsRef.current = clips;

  // A seek waiting on a clip's media to load. The swap sets the element's src via
  // activeClipId (React), then this lands the local time once the file is ready.
  const pendingSeekRef = useRef<{ clipId: string; local: number; resume: boolean } | null>(null);

  /**
   * Move the playhead to GLOBAL time `t`, swapping the loaded clip if `t` lives
   * in another one. Same-clip is an immediate local seek; cross-clip defers the
   * seek until the new src reports ready (see the effect below). A single-clip
   * project only ever takes the same-clip branch.
   */
  const requestClipSeek = useCallback((t: number, resume: boolean) => {
    const video = videoRef.current;
    if (!video) return;
    const list = clipsRef.current;
    const clip =
      list.find((c) => t >= c.offset && t < c.offset + c.duration) ?? list[list.length - 1] ?? null;
    if (!clip) {
      video.currentTime = t;
      if (resume) void video.play();
      return;
    }
    const local = clipLocalTime(clip, t);
    if (clip.id === activeClipRef.current?.id) {
      video.currentTime = local;
      if (resume) void video.play();
      return;
    }
    pendingSeekRef.current = { clipId: clip.id, local, resume };
    setActiveClipId(clip.id);
  }, []);

  // Land a pending cross-clip seek once its media is loaded. activeClipId changing
  // has already swapped the element's src (via Monitor); here we wait for the new
  // file to know its timeline, then seek into it and resume if we were playing.
  useEffect(() => {
    const video = videoRef.current;
    const pending = pendingSeekRef.current;
    if (!video || !pending || pending.clipId !== activeClipId) return;

    const apply = () => {
      if (pendingSeekRef.current !== pending) return;
      video.currentTime = pending.local;
      if (pending.resume) void video.play();
      pendingSeekRef.current = null;
    };
    if (video.readyState >= 1) apply();
    else video.addEventListener('loadedmetadata', apply, { once: true });
    return () => video.removeEventListener('loadedmetadata', apply);
  }, [activeClipId]);

  const seek = useCallback(
    (t: number) => {
      requestClipSeek(t, false);
      setCurrentTime(t);
    },
    [requestClipSeek],
  );

  /**
   * Play just the selected words, then stop at the end of them. Defined here,
   * after the seek coordinator, because it references requestClipSeek — its
   * dependency array would otherwise touch that const in its temporal dead zone.
   */
  const playSelection = useCallback(() => {
    if (!selectionRange) return;
    // Global start; requestClipSeek loads the right clip and plays. The stop test
    // reads the global clock too, so it holds whichever clip is showing.
    requestClipSeek(selectionRange.start, true);

    const stopAt = selectionRange.end;
    const tick = () => {
      const video = videoRef.current;
      if (!video || video.paused) return;
      if (getCurrentTime() >= stopAt) return video.pause();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [selectionRange, requestClipSeek, getCurrentTime]);

  // timeupdate now only feeds the karaoke highlight (~4Hz is plenty — words
  // average ~400ms). Skipping cut material is usePlayback's job, on rAF.
  const onTimeUpdate = () => {
    if (videoRef.current) setCurrentTime(getCurrentTime());
  };

  // ── push-ins ───────────────────────────────────────────────────────────────
  //
  // Two pieces of view state, and neither belongs in the document: which move is
  // being marked (a modal gesture, not an edit) and which is being followed (a
  // job in flight). Everything a move IS lives on doc.frame.moves and undoes with
  // the rest of the edit.

  const [markingMoveId, setMarkingMoveId] = useState<string | null>(null);
  const [following, setFollowing] = useState<{ id: string; progress: number } | null>(null);
  const followAbort = useRef<AbortController | null>(null);

  /**
   * Why the selection cannot take a push-in, or null when it can.
   *
   * Computed rather than left to the button being dead, because "nothing
   * happens" is the least useful thing an interface can say. Overlap is the only
   * real refusal — normalizeMoves drops overlapping moves rather than blending
   * them, so offering one here would silently discard it on the next save.
   */
  const punchBlocked = useMemo(() => {
    if (!selectionRange) return 'Select the words this push-in should cover.';
    if (selectionRange.end - selectionRange.start < MIN_MOVE_SEC) {
      return 'Too short to push in on — select a little more.';
    }
    const clash = frame.moves.some(
      (m) => selectionRange.start < m.end && m.start < selectionRange.end,
    );
    return clash ? 'A push-in already covers part of this selection.' : null;
  }, [selectionRange, frame.moves]);

  /**
   * Mark a stretch, then hand straight over to the marquee.
   *
   * The playhead moves to the move's start first, and that is not a nicety: the
   * template the tracker hunts for is taken from the frame that is on screen
   * when the box is drawn, so marking against some unrelated moment produces a
   * follow that looks for something which is not there.
   */
  const punchInOnSelection = useCallback(() => {
    if (!selectionRange || punchBlocked) return;
    const id = addPunchIn(selectionRange.start, selectionRange.end);
    if (!id) return;
    seek(selectionRange.start);
    setMarkingMoveId(id);
  }, [selectionRange, punchBlocked, seek]);

  // ── image inserts ──────────────────────────────────────────────────────────
  //
  // The sibling of the push-in above, and deliberately shaped the same way: the
  // decision the selection makes is WHEN, and when is a range of words. What
  // picture, and where it sits on the frame, are decided afterwards in the panel
  // — so this is one click that lands an image on the words you have, not a
  // dialog that asks four questions first.

  const [editingOverlayId, setEditingOverlayId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  /**
   * Place an asset over a range of words, and reveal it.
   *
   * The window comes from `suggestWindow` rather than from the words directly,
   * and that is the whole "for how long" question answered in ONE place: a
   * single word is ~0.3s, and an image on screen for 0.3s is a flash rather than
   * a cutaway. Generation, the retarget button and the assistant all come
   * through here, so none of them can disagree about how long an insert lasts.
   */
  const placeAsset = useCallback(
    (assetId: string, words: Word[], existingOverlayId?: string) => {
      const limit = project ? projectDuration(project) : Infinity;
      const window = suggestWindow(words, limit);
      const first = words[0];
      const patch = {
        start: window.start,
        end: window.end,
        wordId: first?.id,
        wordText: first?.text,
      };

      if (existingOverlayId) {
        setOverlay(existingOverlayId, patch, 'Move image');
        seek(window.start);
        return existingOverlayId;
      }

      const id = addImageOverlay(assetId, window.start, window.end, {
        wordId: patch.wordId,
        wordText: patch.wordText,
      });
      if (!id) {
        setError(`This project is already at the limit of ${MAX_OVERLAYS} images.`);
        return null;
      }
      // Seek, but do NOT enter framing mode. Holding a new insert on screen
      // regardless of the playhead made every image anyone added look like it
      // was stuck there permanently — the hold is a placement aid, and it has to
      // be asked for. The seek is enough to show the user what they just made.
      seek(window.start);
      return id;
    },
    [project, seek],
  );

  /**
   * Describe a picture, get one, and have it land where it belongs.
   *
   * The placement is DERIVED rather than asked for — `placeByPrompt` looks for
   * the prompt's subject in the script and puts the image on the first time it
   * is said. That is the whole flow: no selecting a word first, because the
   * prompt already names the thing.
   *
   * When nothing in the prompt is anywhere in the script it falls back to the
   * selection, then to the playhead. Refusing to place it at all would leave the
   * user with a picture and no way to see it; putting it somewhere concrete and
   * saying where is recoverable in one click ("Place on selection").
   */
  const generateImageForPrompt = useCallback(
    async (prompt: string) => {
      if (!project) return;
      setGenerating(true);
      setError(null);
      try {
        const fresh = await api.images.generate(project.id, prompt);
        setProject(fresh);
        const asset = (fresh.images ?? []).at(-1);
        if (!asset) throw new Error('The image was generated but not saved.');

        const words = doc?.words ?? [];
        const at = placeByPrompt(words, prompt);
        let target: Word[];
        if (at) {
          target = words.filter((w) => w.id === at.wordId);
        } else if (selectedWords.length > 0) {
          target = selectedWords;
        } else {
          // The playhead: somewhere the user is already looking.
          const t = getCurrentTime();
          const near = words.find((w) => !w.deleted && w.end >= t) ?? words.find((w) => !w.deleted);
          target = near ? [near] : [];
        }
        if (target.length === 0) {
          setError('There is no transcript to place the image on yet.');
          return;
        }
        placeAsset(asset.id, target);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setGenerating(false);
      }
    },
    [project, doc?.words, selectedWords, getCurrentTime, placeAsset],
  );

  /** Import a picture from disk, placed the same way a generated one is. */
  const importImageFile = useCallback(
    async (file: File) => {
      if (!project) return;
      setGenerating(true);
      setError(null);
      try {
        const fresh = await api.images.upload(project.id, file);
        setProject(fresh);
        const asset = (fresh.images ?? []).at(-1);
        if (!asset) throw new Error('That file could not be imported.');
        // No prompt to match on, so an imported file goes where the user is
        // pointing: the selection, else the playhead.
        const words = doc?.words ?? [];
        const t = getCurrentTime();
        const near = words.find((w) => !w.deleted && w.end >= t) ?? words.find((w) => !w.deleted);
        const target = selectedWords.length > 0 ? selectedWords : near ? [near] : [];
        if (target.length === 0) {
          setError('There is no transcript to place the image on yet.');
          return;
        }
        placeAsset(asset.id, target);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setGenerating(false);
      }
    },
    [project, doc?.words, selectedWords, getCurrentTime, placeAsset],
  );

  /**
   * Which insert "Move the image here" would move.
   *
   * The one being framed, else the most recent — and the most recent is the
   * right fallback because the whole flow is generate-then-correct: the image
   * you have just been given is the one whose placement you are judging.
   */
  const movableOverlay = useMemo(() => {
    if (overlays.length === 0) return null;
    return overlays.find((o) => o.id === editingOverlayId) ?? overlays[overlays.length - 1];
  }, [overlays, editingOverlayId]);

  /** Move that insert onto the words currently selected in the script. */
  const moveImageHere = useCallback(() => {
    if (!movableOverlay || selectedWords.length === 0) return;
    placeAsset(movableOverlay.assetId, selectedWords, movableOverlay.id);
  }, [movableOverlay, selectedWords, placeAsset]);

  /**
   * Retarget an insert by TYPING the word it should play on.
   *
   * The other half of correcting an automatic placement, and the one that costs
   * nothing: selecting the words means finding them in the script first, which
   * is a scroll and a drag to fix something the user can already name. Typing
   * "robot" is the same sentence they used to ask for the picture.
   *
   * It goes through the SAME `placeByPrompt` that chose the spot in the first
   * place, so "where it landed" and "where I sent it" obey one rule — including
   * the plural fold and skipping words the edit has already cut.
   */
  const retargetOverlayToWord = useCallback(
    (overlayId: string, phrase: string) => {
      const words = doc?.words ?? [];
      const overlay = overlays.find((o) => o.id === overlayId);
      if (!overlay) return;

      const at = placeByPrompt(words, phrase);
      if (!at) {
        setError(
          `Nothing in the edit says “${phrase.trim()}”. Check the spelling, or select the words and use “Move … here”.`,
        );
        return;
      }
      const word = words.find((w) => w.id === at.wordId);
      if (!word) return;
      placeAsset(overlay.assetId, [word], overlayId);
    },
    [doc?.words, overlays, placeAsset],
  );

  const markMove = useCallback(
    (id: string) => {
      const move = frame.moves.find((m) => m.id === id);
      if (move) seek(move.start);
      setMarkingMoveId(id);
    },
    [frame.moves, seek],
  );

  /**
   * A box was dragged over the picture: that is the shot.
   *
   * boxToPunch turns it into the zoom and pan the frame will hold, and a mark
   * always CLEARS any existing follow — the path was tracked from a template
   * taken at the old box, so keeping it would leave the move following something
   * the user just told it not to look at.
   */
  const applyMark = useCallback((id: string, box: FrameBox) => {
    setMarkingMoveId(null);
    const punch = boxToPunch(box);
    // The mark is kept alongside the shot it resolved to: the tracker wants the
    // rectangle that was actually drawn, not the wider window the frame's aspect
    // turned it into. See FrameMove.mark.
    setMove(id, { ...punch, mark: box, path: [] }, 'Mark push-in');
  }, []);

  const followMove = useCallback(
    async (id: string) => {
      const video = videoRef.current;
      const move = frame.moves.find((m) => m.id === id);
      const clip = activeClipRef.current;
      // The string returns are for the assistant, which calls this as a tool and
      // has to report what happened; the panel's own button ignores them.
      if (!video || !move || !project) return 'That push-in could not be tracked.';

      // The follow reads one file. A move that spans a seam would need the app's
      // clip-swap coordinator inside the sample loop, which is a real feature and
      // not this one — say so rather than tracking the wrong footage.
      if (clip && (move.start < clip.offset || move.end > clip.offset + clip.duration)) {
        setNotice('That push-in crosses a clip boundary, which tracking cannot follow yet.');
        return 'That push-in crosses a clip boundary, which tracking cannot follow yet.';
      }

      const source = {
        width: clip?.width ?? project.width ?? 0,
        height: clip?.height ?? project.height ?? 0,
      };
      // Against a UNIT box, so the follow depends on the crop and not on how big
      // the monitor happened to be when it ran.
      const layout = frameLayout(frame, source, { width: 1, height: 1 });

      const abort = new AbortController();
      followAbort.current = abort;
      setFollowing({ id, progress: 0 });
      try {
        const result = await followObject({
          video,
          start: move.start,
          end: move.end,
          toLocal: (t) => (clip ? clipLocalTime(clip, t) : t),
          // The rectangle that was drawn, when there is one. Falling back to the
          // delivered window is the best available answer for a move framed with
          // the sliders instead — see FrameMove.mark.
          box: move.mark ?? punchToBox(move),
          layout,
          zoom: move.zoom,
          signal: abort.signal,
          onProgress: (progress) => setFollowing((f) => (f?.id === id ? { id, progress } : f)),
        });
        setMovePath(id, result.path);
        // The quality of a follow is how often it had nothing to go on, and that
        // is worth saying: a follow that held half its samples is pointing at
        // whatever was last recognised, which the user can see but not diagnose.
        const said =
          result.lost === 0
            ? `Following — ${result.samples} points.`
            : `Following, but lost the subject on ${result.lost} of ${result.samples} points. Mark it again on a clearer frame if it drifts.`;
        setNotice(said);
        return said;
      } catch (err) {
        if (err instanceof FollowAborted) return 'Tracking was cancelled.';
        const said = err instanceof Error ? err.message : String(err);
        setNotice(said);
        return said;
      } finally {
        followAbort.current = null;
        setFollowing(null);
      }
    },
    [frame, project],
  );

  // A follow in flight owns the <video>'s playhead, so it must not outlive the
  // project it was started on.
  useEffect(() => () => followAbort.current?.abort(), [project?.id]);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.paused ? video.play() : video.pause();
  }, []);

  /**
   * Rewind when the piece finishes. To the top of the EDIT, not to raw zero —
   * with the head of the source cut, second 0 is material that was deliberately
   * removed, and parking the playhead there means the next Play starts on
   * something the viewer already decided to throw away.
   */
  const onPlaybackEnded = useCallback(() => {
    setPlaying(false);
    requestClipSeek(edl.keep[0]?.start ?? 0, false);
  }, [edl, requestClipSeek]);

  /**
   * The skip loop that calls the above only mounts while FOLLOWING the edit, so
   * with Preview edit off nothing noticed the source running out: the transport
   * stayed lit as though still playing and the playhead sat on the last frame.
   * The element's own event covers that case. Both may fire for one stop, which
   * is harmless — pausing and rewinding twice lands in the same place.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.addEventListener('ended', onPlaybackEnded);
    return () => video.removeEventListener('ended', onPlaybackEnded);
  }, [onPlaybackEnded]);

  // Declared after onPlaybackEnded on purpose: a const is in its temporal dead
  // zone until its initialiser runs, so calling this above would throw.
  usePlayback({
    videoRef,
    edl,
    followEdit,
    playing,
    speed,
    onEnded: onPlaybackEnded,
    activeClipRef,
    activeClipId,
    seekAcrossClip: requestClipSeek,
  });

  // The music bed's length on the OUTPUT clock. bedLength is the SAME function
  // the server calls to resolve the render, rather than a mirror of it — the
  // preview ending where the export does is the one thing the monitor is for.
  const musicEndSec = useMemo(() => {
    const m = project?.music;
    if (!m || !edl) return 0;
    return bedLength(m, programSec);
  }, [project?.music, edl, programSec]);

  useMusicPreview({
    musicRef,
    edl,
    playing,
    speed,
    getCurrentTime,
    volume: project?.music?.volume ?? 0,
    endSec: musicEndSec,
    loop: project?.music ? bedLoops(project.music) : false,
    sourceDuration: project?.music?.sourceDuration ?? 0,
    // Match the render's ramp: a bed cut short fades, one that plays to the last
    // frame does not. Both sides ask bedFadeOut, so neither can drift.
    fadeOutSec: bedFadeOut(musicEndSec, programSec),
  });

  // The voice enhancer on the monitor. Deliberately on the <video> only: the bed
  // has its own element and the render mixes it in AFTER the chain, so leaving it
  // out here is what makes the preview match.
  useStudioSoundPreview({ videoRef, enabled: doc?.studioSound ?? false });

  // The bed drawn as a lane on the timeline. The timeline is SOURCE time and the
  // bed lives on the OUTPUT clock, so map its end back: musicEndSec is post-speed,
  // so × speed gives the un-sped output position, which outputToSource turns into
  // the source time where the bed stops. It spans from the first kept moment
  // (output 0) to there — covering the cut gaps in between, which is honest: the
  // music plays straight through them in the finished cut.
  const musicLane = useMemo(() => {
    const m = project?.music;
    if (!m || !edl || edl.keep.length === 0 || musicEndSec <= 0) return null;
    const sum = outputDuration(edl, 1); // un-sped output length
    const endOut = Math.min(musicEndSec * speed, sum);
    const startSec = edl.keep[0].start;
    const endSec =
      endOut >= sum - 1e-6
        ? edl.keep[edl.keep.length - 1].end
        : outputToSource(edl, endOut) ?? edl.keep[edl.keep.length - 1].end;
    return { name: m.name, startSec, endSec, loop: bedLoops(m) };
  }, [project?.music, edl, musicEndSec, speed]);

  /**
   * Step to the previous/next word boundary.
   *
   * NOT "one frame". The document has no frames — the EDL is word-bounded and
   * carries float seconds, so a frame step would be a fiction that lands
   * somewhere the editor cannot act on. The word is this app's atomic unit, and
   * it is the more useful step anyway.
   */
  const stepWord = useCallback(
    (direction: -1 | 1) => {
      const video = videoRef.current;
      if (!video || words.length === 0) return;
      const now = getCurrentTime();
      const i = lastStartingAtOrBefore(words, now);

      if (direction === 1) {
        const next = words.find((w) => w.start > now + 1e-3);
        if (next) seek(next.start);
        return;
      }
      // Going back from mid-word lands on this word's start; pressing again on
      // the previous one — the behaviour every editor has.
      const current = words[i];
      if (current && now - current.start > 0.15) return seek(current.start);
      if (i > 0) seek(words[i - 1].start);
    },
    [words, seek, getCurrentTime],
  );

  // Undo/redo reveal: scroll the change into view and, when paused, seek to it.
  // Without this a sweep's undo restores words somewhere off-screen and the app
  // looks like it did nothing.
  useEffect(() => {
    if (!reveal) return;
    const el = document.querySelector<HTMLElement>(`[data-wid="${cssEscape(reveal.id)}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const word = words.find((w) => w.id === reveal.id);
    if (reveal.seek && word && videoRef.current?.paused) seek(word.start);
  }, [reveal?.nonce]);

  // --- editing -----------------------------------------------------------------
  /**
   * Put the cursor on a word. THE rule for both surfaces that have one.
   *
   * Landing on a word means "put the playhead here and select it"; landing on it
   * with shift held means "stretch the live selection's focus end onto it, and
   * leave the playhead alone" — reviewing a range you are still choosing must
   * not keep jumping the video to its far end.
   *
   * Both the click path below and the keyboard cursor in Script go through this,
   * so the two cannot drift into disagreeing about what a selection is.
   */
  const moveCursor = (id: string, extend: boolean) => {
    const word = words.find((w) => w.id === id);
    if (!word) return;
    if (extend && selection) {
      setSelection({ anchorId: selection.anchorId, focusId: id });
      return;
    }
    setSelection({ anchorId: id, focusId: id });
    seek(word.start);
  };

  /**
   * Clicking a word is moveCursor, plus one thing a keypress cannot do: clicking
   * the word that IS the whole selection clears it.
   *
   * That is the toggle. Without it a selection could only be cleared with Escape
   * or by hitting a paragraph gap, so one you made by accident just sat there.
   * The seek stays either way, which keeps the rule above true: the highlight
   * goes away, the playhead still lands where you pointed.
   *
   * `clicks === 1` keeps the second half of a double-click out of it. That
   * gesture means "play from here", and it would otherwise select on click one
   * and unselect on click two, flickering on its way to playing.
   */
  const clickWord = (index: number, shift: boolean, clicks: number) => {
    const word = words[index];
    if (!word) return;

    // Only when this word IS the selection, not merely inside it — clicking one
    // word of a run collapses onto it, the way any text editor does, and a
    // second click then clears.
    const isWholeSelection =
      selection?.anchorId === word.id && selection?.focusId === word.id;

    if (!shift && isWholeSelection && clicks === 1) {
      setSelection(null);
      seek(word.start);
      return;
    }
    moveCursor(word.id, shift);
  };

  const doFillers = () => {
    const n = removeFillers(fillerMode === 'all', customFillers);
    setResult(null);
    setNotice(n === 0 ? 'No filler words found to cut.' : `${n} filler words cut.`);
  };

  // Normalize on the way in so the chip matches what the detector matches:
  // trimmed, lowercased, no duplicates, no blanks. A pasted "Um, " becomes "um".
  const addCustomFiller = (raw: string) => {
    const word = raw.trim().toLowerCase();
    if (!word) return;
    setCustomFillers((prev) => (prev.includes(word) ? prev : [...prev, word]));
  };

  const removeCustomFiller = (word: string) => {
    setCustomFillers((prev) => prev.filter((w) => w !== word));
  };

  const doRetakes = () => {
    const n = removeRetakes(retakeMin);
    setResult(null);
    setNotice(n === 0 ? 'No retakes found.' : `${n} words cut.`);
  };

  const doRestoreAll = () => {
    const n = restoreAll();
    setResult(null);
    setNotice(n === 0 ? 'Nothing was cut.' : `${n} words restored.`);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // activeElement, not e.target: a key pressed while focus sits in a field
      // can retarget, and the old check missed textarea and contentEditable
      // entirely.
      if (document.activeElement?.closest('input,textarea,select,[contenteditable]')) return;

      /**
       * A modal owns the keyboard while it is open.
       *
       * `showModal()` makes the background INERT to pointers and to focus, but a
       * listener bound on `window` still hears every key. So bare S was splitting
       * the clip under the playhead behind an open Export dialog, and Space was
       * scrubbing a video the user could not see.
       */
      if (document.querySelector('dialog[open]')) return;

      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        const label = e.shiftKey ? redoEdit() : undoEdit();
        if (label) setNotice(`${e.shiftKey ? 'Redid' : 'Undid'}: ${label}`);
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') { // Windows redo
        e.preventDefault();
        const label = redoEdit();
        if (label) setNotice(`Redid: ${label}`);
        return;
      }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); flushSave(); return; }

      if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); setSelectionDeleted(true); }
      else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); setSelectionDeleted(false); }
      // Escape closes the drawer first if it's open, otherwise clears selection.
      else if (e.key === 'Escape') { if (libOpen) setLibOpen(false); else setSelection(null); }
      /**
       * Space plays — UNLESS a button has focus, where Space is that button's
       * own activation key.
       *
       * Chrome fires a focused button's click on keyUP, and only if the keydown
       * was not cancelled. Calling preventDefault() here unconditionally meant a
       * keyboard user tabbed onto "Render video" pressed Space and got playback
       * toggling instead of a render — the button simply never fired.
       */
      else if (e.key === ' ') {
        if (document.activeElement?.closest('button,[role="button"],a[href],summary')) return;
        e.preventDefault();
        togglePlay();
      }
      // Home and the arrows are advertised in the transport's own tooltips, so
      // they have to exist. They did not.
      //
      // These are the TRANSPORT's copies. With a word focused in the script the
      // same keys drive the word cursor instead, and Script stops them before
      // they reach this window listener — so the tooltips stay true either way
      // (both land the playhead on an adjacent word), and only one of the two
      // ever fires.
      else if (e.key === 'Home') { e.preventDefault(); seek(0); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stepWord(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stepWord(1); }
      // The razor: cut the clip under the playhead in two. Bare S, like an NLE.
      else if (!mod && e.key.toLowerCase() === 's') { e.preventDefault(); void splitRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, libOpen, seek, stepWord]);

  /**
   * What becomes of a file the assistant summoned — fetched from the web, or made
   * by a media operation the app has no feature for.
   *
   * Deliberately the ORDINARY import paths. The server could attach these itself
   * and save a round trip, but then a summoned clip would arrive by a route no
   * imported clip ever takes: no transcription of the newcomer, no stitching, no
   * filmstrip, and a second copy of all three to maintain. Fetching the bytes
   * back as a File and posting them where the drop target posts costs one hop and
   * buys "indistinguishable from an import" for free.
   */
  const attachSummoned = async (
    file: SummonedFile,
    attachAs: 'clip' | 'music' | 'image' | 'download' | 'keep',
    name?: string,
  ): Promise<string> => {
    if (!project) return 'No project is open.';
    if (attachAs === 'keep') return `Kept as ${file.url}.`;
    if (attachAs === 'download') {
      saveAs(file.url, name ?? file.name);
      return `Saved ${name ?? file.name} (${fmtBytes(file.bytes)}) — choose where to put it.`;
    }

    // Every remaining path needs the bytes as a File, because that is what the
    // import routes take. The upload route specifically: a summoned file is
    // already on our own disk, so it needs importing rather than generating.
    const blob = await fetch(file.url).then((r) => r.blob());
    const asFile = new File([blob], name ?? file.name, { type: blob.type });

    if (attachAs === 'image') {
      if (file.kind !== 'image') return `That file is ${file.kind}, not a picture, so it cannot go in the image library.`;
      const fresh = await api.images.upload(project.id, asFile);
      setProject(fresh);
      const added = (fresh.images ?? []).at(-1);
      return added
        ? `Added "${added.name}" to the project's pictures — place it with add_image_at_words.`
        : 'The picture could not be imported.';
    }

    if (attachAs === 'music') {
      if (file.kind === 'image') return 'A picture cannot be background music.';
      const fresh = await api.music.upload(project.id, asFile);
      setProject(fresh);
      return `"${fresh.music?.name ?? asFile.name}" is now the background music.`;
    }

    if (file.kind === 'image') {
      return 'A still picture cannot be a clip on its own — run it through run_media_op with a still_duration_sec first, then attach that.';
    }
    const fresh = await addClip(asFile);
    return fresh
      ? `Added "${asFile.name}" to the timeline as a new clip${doc ? ', transcribed and stitched into the script' : ''}.`
      : 'The clip could not be added.';
  };

  // ── the AI assistant's bridge ────────────────────────────────────────────
  //
  // The chat runtime executes most tools by calling store/editor.ts directly, but
  // the async, App-level actions (switching projects, transcription, rendering,
  // music) live here as closures over live state — so App hands the agent a bridge
  // to them, exactly as it hands the store a saver. Re-registered every render with
  // no dep array: the closures must be fresh, and building the object inside the
  // effect keeps it clear of the const temporal-dead-zone at render time.
  useEffect(() => {
    const bridge: AgentBridge = {
      snapshot: () => ({
        screen: {
          view: project ? ('editor' as const) : openFolderId === null ? ('folders' as const) : ('folder' as const),
          folderName: (() => {
            const id = project ? project.folderId ?? '' : openFolderId ?? '';
            if (!id) return openFolderId === '' || project ? 'Unfiled' : null;
            return folders.find((f) => f.id === id)?.name ?? null;
          })(),
          folderBrief: (() => {
            const id = project ? project.folderId ?? '' : openFolderId ?? '';
            return id ? folders.find((f) => f.id === id)?.brief ?? null : null;
          })(),
          folderCount: folders.length,
          projectsHere:
            openFolderId === null
              ? library.length
              : library.filter((p) => (p.folderId ?? '') === openFolderId).length,
        },
        project: project
          ? { id: project.id, name: project.name, durationSec: project.duration, hasVideo: project.hasVideo }
          : null,
        transcribed: Boolean(doc),
        asrAvailable: Boolean(caps?.hasAsr),
        imageGenAvailable: Boolean(caps?.images?.generate),
        doc,
        selectedWordIds: [...selectedSet],
        selectionText: selectedWords.map((w) => w.text).join(' '),
        stats: { words: stats.words, kept: stats.kept, cuts: stats.cuts, outputSec: stats.outputSec },
        music: project?.music ? { name: project.music.name, volume: project.music.volume } : null,
        images: (project?.images ?? []).map((i) => ({
          id: i.id,
          name: i.name,
          width: i.width,
          height: i.height,
        })),
        clips: clips.map((c, i) => ({
          id: c.id,
          name: clips.length === 1 ? (project?.name ?? 'clip') : `Clip ${i + 1}`,
          startSec: c.offset,
          durationSec: c.duration,
          hasVideo: c.hasVideo,
        })),
        customFillers,
        fonts: [...CAPTION_FONTS.map((f) => f.id), ...customFonts.map((f) => f.family)],
        job: job ? { kind: job.kind, stage: job.stage, progress: job.progress } : null,
        playheadSec: getCurrentTime(),
        playing,
      }),
      listProjects: async () => {
        const items = await api.list();
        return items.map((m) => ({ id: m.id, name: m.name, transcribed: m.status === 'transcribed' }));
      },
      openProject: async (id) => {
        await openProject(id);
      },
      renameProject: async (id, name) => {
        await renameProject(id, name);
      },
      deleteProject: async (id) => {
        await deleteProject(id);
      },
      transcribe: async (options) => {
        // The dialog's options are React state, and doTranscribe reads them from
        // the closure it was built in — so a change made here would not be seen
        // by the call we are about to make. Passing them through explicitly is
        // what lets "transcribe this verbatim" work in one turn.
        if (options) setAsr((prev) => (prev ? { ...prev, ...options } : prev));
        await doTranscribe(options);
      },
      asrModels: () => caps?.asrModels?.map((m) => ({ id: m.id, label: m.label, hint: m.hint })) ?? [],
      exportVideo: async () => {
        const r = await doRender();
        return r ? `Exported ${fmtShort(r.outputDuration)} of finished video.` : 'The export did not complete.';
      },
      exportCaptions: async (format) => {
        const r = await doCaptions(format);
        return r ? `Saved ${r.cues} caption cues as .${format}, timed to the edit.` : 'The caption export did not complete.';
      },
      cancelJob: async () => {
        if (!job) return 'Nothing is running.';
        const was = job.kind;
        cancelJob();
        return `Asked the server to stop the ${was} job.`;
      },
      addMusic: async (query, instrumental) => {
        if (!project) return 'No project is open.';
        const { results } = await api.music.search(query, {
          instrumental,
          provider: caps?.musicProviders?.[0],
        });
        if (results.length === 0) return `No tracks found for "${query}".`;
        await pickMusic(results[0]);
        return `Added "${results[0].title}" by ${results[0].artist} as background music.`;
      },
      /**
       * Search and hand back the OPTIONS rather than silently taking the first.
       *
       * addMusic picks the top hit, which is right when someone says "put some
       * music on" and wrong when they say "give me more options" — and a bed is
       * a taste decision, so a shortlist is the honest default.
       */
      readWebpage: async (url) => api.readPage(url),

      listFolders: async () => {
        const list = await api.folders.list();
        setFolders(list);
        return list.map((f) => ({
          id: f.id,
          name: f.name,
          hasMemory: Boolean(f.brief.trim()),
          memory: f.brief,
          projects: library.filter((p) => p.folderId === f.id).length,
        }));
      },

      setFolderMemory: async (folderId, memory) => {
        // Default to the folder in front of the user: "write the memory for this
        // folder" is the common phrasing, and making them name an id they cannot
        // see would be a worse tool.
        const id = folderId || (project ? project.folderId : openFolderId) || '';
        if (!id) {
          return 'No folder is in view. Open a folder first, or pass folder_id from list_folders.';
        }
        const updated = await api.folders.update(id, { brief: memory });
        await loadFolders();
        return `Memory saved on "${updated.name}" (${memory.length} characters). Every title and description for that folder is written against it from now on.`;
      },

      searchMusic: async (query, instrumental, limit) => {
        const provider = caps?.musicProviders?.[0];
        const run = (q: string) => api.music.search(q, { instrumental, provider });

        /**
         * Fall back to fewer words when a phrase finds nothing.
         *
         * Jumpy is told to search for the FEELING of a piece, which produces
         * queries like "gentle playful ukulele" — and measured against
         * Openverse, that returns zero results while "ukulele" returns three.
         * The catalogue matches titles and tags, not descriptions, so every
         * extra word narrows it towards nothing.
         *
         * Dropping the leading adjectives keeps the noun that actually names an
         * instrument or a genre, which is the word the catalogue knows. Better
         * than telling the model to write worse queries, and far better than
         * reporting "no music found" for a library that has plenty.
         */
        let { results } = await run(query);
        const words = query.trim().split(/\s+/);
        for (let drop = 1; results.length === 0 && drop < words.length; drop++) {
          const shorter = words.slice(drop).join(' ');
          results = (await run(shorter)).results;
        }

        musicHits.current = results;
        return results.slice(0, limit).map((r) => ({
          id: r.id,
          title: r.title,
          artist: r.artist,
          durationSec: r.durationSec,
          license: r.license,
          needsCredit: Boolean(r.attribution?.trim()),
        }));
      },

      attachMusic: async (id, volume) => {
        if (!project) return 'No project is open.';
        const hit = musicHits.current.find((r) => r.id === id);
        if (!hit) return 'That id is not from the last search. Run search_music again.';
        await pickMusic(hit);
        if (typeof volume === 'number') await setMusicVolume(Math.max(0, Math.min(1, volume)));
        return `Attached "${hit.title}" by ${hit.artist}.`;
      },

      writePost: async (target) => {
        if (!project) throw new Error('No project is open.');
        const r = await api.social(project.id, { model: agentModel(), target });
        return { ...r.draft, usedMemory: r.usedBrief, folder: r.folder };
      },

      lookAtFrame: async (atSeconds) => {
        if (!project) throw new Error('No project is open.');
        return api.projectFrame(project.id, { atSeconds, captions });
      },

      generateImage: async (prompt) => {
        if (!project) throw new Error('No project is open.');
        const fresh = await api.images.generate(project.id, prompt);
        setProject(fresh);
        const added = (fresh.images ?? []).at(-1);
        if (!added) throw new Error('the picture was generated but not saved.');
        return {
          id: added.id,
          name: added.name,
          url: added.sourceUrl,
          width: added.width,
          height: added.height,
        };
      },
      downloadFile: async (url, name) => {
        // The same saveAs the summon path uses, so on the desktop build this
        // goes through the real Save dialog rather than vanishing into Downloads.
        saveAs(url, name);
        return `Saved ${name} — choose where to put it.`;
      },
      setMusicVolume: async (volume) => {
        updateMusic({ volume });
      },
      setMusicOptions: async ({ loop, durationSec, fit }) => {
        if (fit) {
          // The same gesture the panel's "duplicate to fill" makes: loop it and
          // clear the length cap, so the bed runs the whole program however the
          // edit changes length afterwards.
          fillMusic();
          return 'The bed now loops for exactly the length of the finished video.';
        }
        const patch: { loop?: boolean; durationSec?: number | null } = {};
        if (loop !== undefined) patch.loop = loop;
        if (durationSec !== undefined) patch.durationSec = durationSec;
        updateMusic(patch);
        const said: string[] = [];
        if (loop !== undefined) said.push(loop ? 'looping on' : 'looping off');
        if (durationSec !== undefined) {
          said.push(durationSec === null ? 'playing for the whole program' : `playing for ${fmtShort(durationSec)}`);
        }
        return `Music: ${said.join(', ')}.`;
      },
      removeMusic: async () => {
        await removeMusic();
      },
      seek: (seconds) => seek(seconds),
      playSelection: () => playSelection(),
      setPlayback: (action) => {
        const video = videoRef.current;
        if (!video) return 'No media is loaded.';
        if (action === 'play' || (action === 'toggle' && video.paused)) void video.play();
        else video.pause();
        return video.paused ? 'Paused.' : 'Playing.';
      },
      splitAtPlayhead: () => splitAtPlayhead(),

      // ── clips ────────────────────────────────────────────────────────────
      splitClipAt: (atSec) => splitAt(atSec),
      moveClip: async (clipId, direction) => {
        const fresh = await moveClip(clipId, direction === 'earlier' ? -1 : 1);
        return fresh ? `Moved that clip ${direction}.` : 'The clip could not be moved.';
      },
      reorderClips: async (ids) => {
        const fresh = await run('reorderClip', async () => {
          await flushSave();
          await api.reorderClips(project!.id, ids);
          const fresh = await api.get(project!.id);
          setProject(fresh);
          openTranscript(fresh, editDefaults(caps));
          setResult(null);
          return fresh;
        });
        return fresh ? `Clips reordered — ${ids.length} in the new order.` : 'The reorder did not complete.';
      },
      removeClip: async (clipId) => {
        const fresh = await removeClip(clipId);
        return fresh ? 'Clip removed, along with its words.' : 'The clip could not be removed.';
      },

      customFillers: (patch) => {
        if (!patch) return customFillers;
        // Computed here rather than read back after setState, because the tool
        // has to report the resulting list in the same turn it changes it.
        const lower = new Set(customFillers.map((w) => w.toLowerCase()));
        const next = [...customFillers];
        for (const word of patch.add ?? []) {
          const clean = word.trim().toLowerCase();
          if (clean && !lower.has(clean)) {
            lower.add(clean);
            next.push(clean);
          }
        }
        const drop = new Set((patch.remove ?? []).map((w) => w.trim().toLowerCase()));
        const result = next.filter((w) => !drop.has(w.toLowerCase()));
        setCustomFillers(result);
        return result;
      },
      trackSubject: async (id, enable) => {
        if (!enable) {
          setMovePath(id, []);
          return 'Tracking cleared — the push-in holds its framing again.';
        }
        return (await followMove(id)) ?? 'Tracking finished.';
      },

      // ── improvising ──────────────────────────────────────────────────────
      //
      // Both of these come back as a FILE. Attaching it is deliberately the
      // ordinary import path — the same routes the picker and the drop target
      // use — so a summoned clip is indistinguishable from an imported one by
      // the time it lands, and none of the stitching logic exists twice.
      summonMedia: async (url, attachAs, name) => {
        if (!project) return 'No project is open.';
        const file = await api.summon.fetch(project.id, url);
        return attachSummoned(file, attachAs, name);
      },
      runMediaOp: async ({ purpose, attachAs = 'keep', ...op }) => {
        if (!project) return 'No project is open.';
        setNotice(purpose);
        const file = await api.summon.op(project.id, op);
        // `substituted` means this machine's ffmpeg could not write the container
        // asked for and a working one was used — a phone has no mp3 encoder. Said
        // plainly, because the model is about to tell the user what it made.
        const instead = file.substituted ? ` Wrote ${file.substituted} instead of ${op.format ?? 'mp4'}.` : '';
        const made = `${purpose} — made ${file.name} (${fmtBytes(file.bytes)}${file.durationSec ? `, ${fmtShort(file.durationSec)}` : ''}).${instead}`;
        if (attachAs === 'keep') {
          return `${made} It is not attached to anything yet; pass its url back as source "file" to build on it, or attach_as to place it.\nfile: ${file.url}`;
        }
        return `${made} ${await attachSummoned(file, attachAs)}`;
      },

      // ── the user's own disk ──────────────────────────────────────────────
      //
      // Read-only and folder-scoped on the server (summon.ts). The listing is
      // rendered as plain lines rather than JSON because the model has to quote
      // a path back exactly, and a flat "name — size — path" is the shape it
      // copies most reliably.
      useFolder: async (path, said) => {
        const { granted } = await api.local.grant(path, said);
        return `Opened ${granted}. You can browse and import media from it for the rest of this session — browse_local_media to see what is in it.`;
      },
      browseLocalMedia: async (folder) => {
        const listing = await api.local.list(folder);
        if (!listing.dir) {
          return listing.folders.length
            ? `Folders the user shared with you (call browse_local_media again with one of these paths to see inside):\n${listing.folders
                .map((f) => f.path)
                .join('\n')}`
            : 'The user has not shared any folders. They can add one under Settings → Folders.';
        }
        const lines = [
          ...listing.folders.map((f) => `[folder] ${f.name} — ${f.path}`),
          ...listing.files.map((f) => `${f.name} — ${fmtBytes(f.bytes)} — ${f.path}`),
        ];
        if (lines.length === 0) return `${listing.dir} has no media in it.`;
        const more = listing.truncated ? '\n(There were more; this listing was cut short.)' : '';
        return `In ${listing.dir}:\n${lines.join('\n')}${more}`;
      },
      importLocalMedia: async (path, attachAs, name) => {
        if (!project) return 'No project is open.';
        setNotice(`Importing ${path.split(/[\\/]/).pop()}…`);
        const file = await api.summon.local(project.id, path);
        const got = `Imported ${file.name} (${fmtBytes(file.bytes)}${file.durationSec ? `, ${fmtShort(file.durationSec)}` : ''}) — the original was left where it was.`;
        if (attachAs === 'keep') {
          return `${got} It is not attached to anything yet; pass its url back to run_media_op as source "file", or attach it with attach_as.\nfile: ${file.url}`;
        }
        return `${got} ${await attachSummoned(file, attachAs, name)}`;
      },
    };
    setAgentBridge(bridge);
  });
  useEffect(() => () => setAgentBridge(null), []);

  /**
   * Attach this window to the editor bridge, so an agent outside the browser can
   * run the same tools the panel does.
   *
   * Mounted AFTER the setAgentBridge effect above, and that order matters: every
   * executor calls requireBridge(), so a tool arriving before the bridge exists
   * would come back "The editor is not ready yet." — which is true for a few
   * milliseconds and confusing forever.
   */
  useEffect(() => connectEditorBridge(), []);

  // Keep the server's idea of what this window is showing current, so a caller
  // choosing between two open windows can tell them apart by project.
  useEffect(() => {
    reportProject(project?.id ?? null, project?.name ?? null);
  }, [project?.id, project?.name]);

  if (!caps || !asr) {
    return (
      <div className="boot">
        {bootError ? (
          <div className="boot-fail" role="alert">
            <h2>The workspace could not load</h2>
            <p className="boot-why">{bootError}</p>
            <p className="boot-hint">
              This usually means the API server is not running. Start it with{' '}
              <code>npm run server</code> and try again.
            </p>
            <button className="primary" onClick={loadWorkspace}>Try again</button>
          </div>
        ) : (
          'Loading workspace…'
        )}
      </div>
    );
  }

  // --- the start screen ---------------------------------------------------------
  /**
   * With nothing open, the app IS the project grid — not the workspace with its
   * five columns greyed out around a line of text. The editor is a view onto a
   * document; with no document there is nothing for it to be a view onto.
   *
   * Every hook above still runs, so this early return is a rendering choice and
   * not a second app: opening a project from here flips it back with all the
   * state — capabilities, fonts, the on-import chain — already in place.
   */
  if (!project) {
    return (
      <>
        <Dashboard
          /* Only what is in the open folder. '' is the Unfiled bucket — projects
             that predate folders or were taken out of one. */
          projects={
            openFolderId === null
              ? library
              : library.filter((p) => (p.folderId ?? '') === openFolderId)
          }
          folders={folders}
          openFolder={
            openFolderId === null
              ? null
              : folders.find((f) => f.id === openFolderId) ??
                { id: '', name: 'Unfiled', brief: '', createdAt: '', updatedAt: '' }
          }
          onOpenFolder={setOpenFolderId}
          onCreateFolder={(name) => void createFolder(name)}
          onRenameFolder={(id, name) => void patchFolder(id, { name })}
          onDeleteFolder={(id) => void removeFolder(id)}
          onSaveBrief={(id, brief) => void patchFolder(id, { brief })}
          onMoveProject={(id, folderId) => void moveProject(id, folderId)}
          importing={busy === 'import'}
          progress={job?.progress ?? null}
          opening={busy === 'open'}
          onOpen={(id) => void openProject(id)}
          onDelete={(id) => void deleteProject(id)}
          onRename={(id, name) => void renameProject(id, name)}
          onImport={importFile}
          onImportMany={importMany}
          error={error}
          onDismissError={() => setError(null)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={refreshCaps} />
        {/* Reachable from the projects page too — this is where you name things
            and decide what to shoot, and there was no assistant here at all. */}
        <FloatingAssistant
          enabled={Boolean(caps.agent?.enabled)}
          defaultModel={caps.agent?.defaultModel ?? 'grok-4'}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </>
    );
  }

  // --- workspace ---------------------------------------------------------------
  return (
    <div
      className={`app m-view-${mobileTab} m-mode-${phoneMode}${showTimeline ? ' m-tl' : ''}`}
      data-frame={frameOrientation}
      // Give the dock the extra height the music lane needs, rather than stealing
      // it from the waveform. Only when a bed is attached; no bed, no change.
      style={musicLane ? ({ '--h-dock': '298px' } as React.CSSProperties) : undefined}
    >
      <TitleBar
        name={project?.name ?? null}
        saveStatus={saveStatus}
        onRetrySave={retrySave}
        onToggleLibrary={() => setLibOpen((v) => !v)}
        onHome={() => void goHome()}
        canUndo={history.canUndo}
        canRedo={history.canRedo}
        undoLabel={history.undoLabel}
        redoLabel={history.redoLabel}
        onUndo={() => { const l = undoEdit(); if (l) setNotice(`Undid: ${l}`); }}
        onRedo={() => { const l = redoEdit(); if (l) setNotice(`Redid: ${l}`); }}
        stats={doc ? stats : null}
        onExport={() => setDialog('export')}
        canExport={!!doc}
        exporting={busy === 'render'}
      />

      {/* ---- the open project's clips + speakers: a drawer behind the ☰ ----
        * No longer the media library. Every project lives on the Dashboard, at a
        * size worth looking at; this is about the one you have open. */}
      <Library
        speakers={cast}
        hasScript={!!doc}
        clips={clips}
        activeClipId={activeClip?.id ?? null}
        addingClip={busy === 'addClip'}
        onAddClip={addClip}
        onRemoveClip={removeClip}
        onMoveClip={moveClip}
        onSelectClip={(c) => seek(c.offset)}
        open={libOpen}
        onClose={() => setLibOpen(false)}
        onSeek={seek}
        autoImport={autoImport}
        onAutoImport={setAutoImport}
        canTranscribe={!!caps?.hasAsr}
        asrProviders={{
          elevenlabs: Boolean(caps?.asrModels.some((model) => model.provider === 'elevenlabs' && model.available)),
          sarvam: Boolean(caps?.asrModels.some((model) => model.provider === 'sarvam' && model.available)),
        }}
      />

      {/* ---- the transcript: the left column, the surface you edit on ---- */}
      <main
        className="script"
        // A press anywhere on the surface that isn't a word clears the
        // selection — the whole scroll area, not just the 640px text column.
        // Words keep their own selection via onWordClick; the drag gesture
        // presses on a word too, so its mousedown is caught by closest('.w').
        // Guarded on `selection` so an ordinary click on empty space doesn't
        // churn the store when there's nothing to clear.
        onMouseDown={(e) => {
          if (selection && !(e.target as HTMLElement).closest('.w')) setSelection(null);
        }}
      >
        {error && <p className="error" onClick={() => setError(null)}>{error}</p>}
        {notice && !error && <p className="notice" onClick={() => setNotice(null)}>{notice}</p>}

        {/* No "nothing open" state here any more: with no project the app renders
          * the Dashboard instead of this workspace, so `project` is non-null from
          * here down. */}
        {project && !doc && (
          <div className="canvas-empty">
            <h2>{project.name}</h2>
            <p>
              {clock(project.duration)} · {project.hasVideo ? `${project.width}×${project.height}` : 'audio only'}
            </p>
            <p className="sub">
              No script yet. Choose your settings in the Transcribe panel and run it.
            </p>
          </div>
        )}

        {doc && project && (
          <Script
            transcript={{ mediaId: project.id, duration: project.duration, words }}
            selection={selectedSet}
            flash={flashSet}
            playingIndex={playingIndex}
            showDeleted={showDeleted}
            colors={castColors}
            onWordClick={clickWord}
            onCorrectWord={correctText}
            onSelectRange={(anchorId, focusId) => setSelection({ anchorId, focusId })}
            onMoveCursor={moveCursor}
            onDeleteSelection={() => setSelectionDeleted(true)}
            onRetranscribe={() => setDialog('transcribe')}
          />
        )}
      </main>

        <Splitter className="sp1" variable="--w-script" min={300} max={640} initial={440} side="left" />

        {/* ---- the program monitor holds the centre stage ---- */}
        <Monitor
          ref={videoRef}
          project={project}
          activeClip={activeClip}
          result={result}
          onTimeUpdate={onTimeUpdate}
          onMediaError={setError}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          frame={frame}
          frameRef={frameRef}
          onFrameChange={updateFrame}
          onFrameDragStart={beginFrameDrag}
          onFrameDragEnd={endFrameDrag}
          color={color}
          getCurrentTime={getCurrentTime}
          markingMoveId={markingMoveId}
          onMark={applyMark}
          onMarkCancel={() => setMarkingMoveId(null)}
          overlay={
            project?.hasVideo ? (
              <>
              {/* Images first, captions second — DOM order is z-order, and it
                * has to mirror the render, which composites the picture and
                * THEN burns the caption on top of it. */}
              {/* Above the images and the captions: a guide you cannot see
                  because a caption is sitting on it is no guide at all. */}
              <SafeAreaOverlay platform={safeArea} />
              <ImageOverlayLayer
                overlays={overlays}
                urls={imageUrls}
                getCurrentTime={getCurrentTime}
                editingId={editingOverlayId}
                playing={playing}
              />
              <CaptionOverlay
                videoRef={videoRef}
                frameRef={frameRef}
                words={words}
                edl={edl}
                captions={captions}
                customFamilies={customFonts.map((f) => f.family)}
                playing={playing}
                getCurrentTime={getCurrentTime}
                onDragStart={beginCaptionDrag}
                onMove={(x, y) => updateCaptions({ ...captions, x, y })}
                onResize={(boxWidth, boxHeight) =>
                  updateCaptions({ ...captions, boxWidth, boxHeight })
                }
                onDragEnd={endCaptionDrag}
              />
              </>
            ) : null
          }
        />

        {/* The music bed, played on the output clock by useMusicPreview. Hidden
          * and controlled entirely in code — the dock transport is the only
          * transport. Keyed on the music id so swapping the bed reloads the src. */}
        <audio
          ref={musicRef}
          key={project?.music?.id ?? 'no-music'}
          src={project?.music?.sourceUrl}
          preload="auto"
          hidden
        />

        <Splitter className="sp2" variable="--w-rail" min={300} max={560} initial={372} side="right" />

        {/* ---- phone-only: the Script | Tools switcher under the monitor ----
          * The transcript and the rail cannot share a phone's width, so one is
          * on screen at a time and this row picks which. Grid placement comes
          * from the mobile media query; on desktop the bar is display:none. */}
        {/*
          * The phone tool bar: one labelled icon per rail section, scrolling
          * sideways.
          *
          * It replaces a two-way Script/Tools switch, which cost a tap into a wall
          * of eleven collapsed rows, then a scroll, then a tap to open the one you
          * came for — three actions and a hunt to reach Captions. A scrolling row
          * of labelled icons is what mobile editors do, and the reason is that the
          * labels ARE the table of contents: finding a tool costs a glance.
          *
          * Tapping one opens that section as a sheet over the script; tapping it
          * again closes it. The script is never swapped away, so the line you are
          * working on stays readable while you change the thing.
          */}
        <nav className="m-tools" aria-label="Tools">
          {/*
            * The two view controls sit at the head of the tool bar, pinned while
            * the tools scroll past them. They belong here rather than in the
            * title bar because they are things you flick between constantly and
            * the bottom of the screen is where the thumb already is.
            */}
          <button
            className="m-view-btn"
            onClick={() => setPhoneMode(phoneMode === 'watch' ? 'script' : 'watch')}
            aria-label={phoneMode === 'watch' ? 'Show the script' : 'Show the picture'}
            title={phoneMode === 'watch' ? 'Show the script' : 'Show the picture'}
          >
            <Icon name={phoneMode === 'watch' ? 'captions' : 'video'} size={19} />
            <span>{phoneMode === 'watch' ? 'Script' : 'Watch'}</span>
          </button>
          <button
            className={showTimeline ? 'm-view-btn on' : 'm-view-btn'}
            onClick={() => setShowTimeline((v) => !v)}
            aria-pressed={showTimeline}
            aria-label="Timeline"
            title="Show the timeline"
          >
            <Icon name="grid" size={19} />
            <span>Timeline</span>
          </button>
          <span className="m-tools-sep" aria-hidden="true" />

          {MOBILE_TOOLS.map((t) => {
            const on = openSection === t.key;
            return (
              <button
                key={t.key}
                className={on ? 'm-tool on' : 'm-tool'}
                aria-pressed={on}
                onClick={() => {
                  const next = on ? null : t.key;
                  setOpenSection(next);
                  setMobileTab(next ? 'tools' : 'script');
                }}
              >
                <Icon name={t.icon} size={19} />
                <span>{t.label}</span>
              </button>
            );
          })}
        </nav>

        {/* ---- phone-only: banners float over the workspace ----
          * The in-script banners live in a surface a phone may have switched
          * away from, so a fixed copy shows regardless of the open tab. The
          * media query hides the in-script pair to keep the message single. */}
        {(error || notice) && (
          <div className="m-banners">
            {error && (
              <SwipeAway onDismiss={() => setError(null)}>
                <p className="error">{error}</p>
              </SwipeAway>
            )}
            {notice && !error && (
              <SwipeAway onDismiss={() => setNotice(null)}>
                <p className="notice">{notice}</p>
              </SwipeAway>
            )}
          </div>
        )}

        {/* ---- phone-only: the cut itself ----
          * On a desk the cut is Backspace, and the script's own footer names it.
          * A phone has no Backspace, so until this bar existed a touch user
          * could select a word and then do nothing with it — the one edit the
          * whole app is built around was unreachable, and an export came out
          * with every word still in it. It rides above the dock where a thumb
          * lands, and it names what it will do to THIS selection. */}
        {selectedWords.length > 0 && (
          <div className="m-cutbar" role="toolbar" aria-label="Selected words">
            <button
              className="m-cutbar-clear"
              onClick={() => setSelection(null)}
              aria-label="Clear selection"
            >
              ✕
            </button>
            <span className="m-cutbar-what">
              {selectedWords.length === 1
                ? selectedWords[0].text
                : `${selectedWords.length} words`}
            </span>
            <button
              className="m-cutbar-do"
              onClick={() => setSelectionDeleted(!selectionIsCut)}
            >
              {selectionIsCut ? 'Restore' : 'Cut'}
            </button>
          </div>
        )}

        {/* ---- the inspector for whatever is selected: the full-height right column ---- */}
        {/* The provider turns the rail's sections into an accordion the phone
            tool bar can drive. No provider on a desk, where each section keeps
            its own state and any number may be open. */}
        <SectionOpen.Provider value={{ key: openSection, set: setOpenSection }}>
          <Rail
            safeArea={safeArea}
            onSafeArea={chooseSafeArea}
            socialHasWords={words.length > 0}
              project={project}
              hasScript={!!doc}
              selectedWords={selectedWords}
              stats={stats}
              verbatim={project?.verbatim ?? true}
              asrProvider={project?.asrProvider ?? null}
              cut={cut ?? editDefaults(caps)}
              setCut={updateCut}
              onCutDragStart={beginCutDrag}
              onCutDragEnd={endCutDrag}
              captions={captions}
              setCaptions={updateCaptions}
              onCaptionDragStart={beginCaptionDrag}
              onCaptionDragEnd={endCaptionDrag}
              studioSound={doc?.studioSound ?? false}
              onToggleStudioSound={updateStudioSound}
              frame={frame}
              setFrame={updateFrame}
              onFrameDragStart={beginFrameDrag}
              onFrameDragEnd={endFrameDrag}
              onPunchIn={punchInOnSelection}
              punchBlocked={punchBlocked}
              onMarkMove={markMove}
              onRemoveMove={deletePunchIn}
              onSetMove={setMove}
              onFollowMove={followMove}
              onClearFollow={(id) => setMovePath(id, [])}
              markingMoveId={markingMoveId}
              following={following}
              onSeek={seek}
              overlays={overlays}
              imageUrls={imageUrls}
              imageNames={imageNames}
              onSetOverlay={setOverlay}
              onRemoveOverlay={deleteImageOverlay}
              onOverlayDragStart={beginOverlayDrag}
              onOverlayDragEnd={endOverlayDrag}
              editingOverlayId={editingOverlayId}
              onEditOverlay={setEditingOverlayId}
              onGenerateImage={generateImageForPrompt}
              onImportImage={importImageFile}
              onRetargetOverlayToWord={retargetOverlayToWord}
              generatingImage={generating}
              canGenerateImages={Boolean(caps?.images?.generate)}
              onMoveImageHere={movableOverlay ? moveImageHere : undefined}
              moveImageLabel={movableOverlay ? imageNames[movableOverlay.assetId] : undefined}
              color={color}
              setColor={updateColor}
              onColorDragStart={beginColorDrag}
              onColorDragEnd={endColorDrag}
              customFonts={customFonts}
              onImportFont={importFont}
              onRemoveFont={removeFont}
              fontBusy={fontBusy}
              onImportMusic={importMusic}
              onPickMusic={pickMusic}
              musicProviders={caps.musicProviders ?? ['openverse']}
              onUpdateMusic={updateMusic}
              onRemoveMusic={removeMusic}
              musicBusy={musicBusy}
              fillerMode={fillerMode}
              setFillerMode={setFillerMode}
              customFillers={customFillers}
              onAddCustomFiller={addCustomFiller}
              onRemoveCustomFiller={removeCustomFiller}
              retakeMin={retakeMin}
              setRetakeMin={setRetakeMin}
              fillerCount={doc ? countFillers(fillerMode === 'all', customFillers) : 0}
              retakeCount={doc ? countRetakes(retakeMin) : 0}
              onRemoveFillers={doFillers}
              onRemoveRetakes={doRetakes}
              onRestoreAll={doRestoreAll}
              onTranscribe={() => setDialog('transcribe')}
              onDeleteSelection={() => setSelectionDeleted(true)}
              onRestoreSelection={() => setSelectionDeleted(false)}
              onPlaySelection={playSelection}
              busy={busy}
              agentEnabled={caps.agent?.enabled ?? false}
              agentDefaultModel={caps.agent?.defaultModel ?? 'grok-4'}
              onOpenSettings={() => setSettingsOpen(true)}
            />
        </SectionOpen.Provider>

      <footer className="tl">
        <Transport
          getCurrentTime={getCurrentTime}
          duration={project?.duration ?? 0}
          edl={edl}
          playing={playing}
          followEdit={followEdit}
          setFollowEdit={setFollowEdit}
          showDeleted={showDeleted}
          setShowDeleted={setShowDeleted}
          speed={speed}
          setSpeed={updateSpeed}
          onPlayPause={togglePlay}
          onStep={stepWord}
          onHome={() => seek(0)}
          disabled={!project}
        />
        <Timeline
          peaks={project?.peaks ?? []}
          duration={project?.duration ?? 0}
          edl={edl}
          thumbs={project?.thumbs}
          getCurrentTime={getCurrentTime}
          playing={playing}
          onSeek={seek}
          selection={selectionRange}
          snapTargets={snapTargets}
          onSelectRange={selectRange}
          insertPoints={clipInsertPoints}
          clipBusy={busy === 'addClip' || busy === 'removeClip' || busy === 'reorderClip' || busy === 'splitClip'}
          onInsertClip={addClip}
          onSplit={project ? splitAtPlayhead : undefined}
          music={musicLane}
          onMusicResize={resizeMusic}
          onMusicFill={fillMusic}
          clipLane={clips.map((c, i) => ({ id: c.id, label: c.name ?? `Clip ${i + 1}` }))}
          onReorderClips={(ids) => void reorderClips(ids)}
        />
      </footer>

      <TranscribeDialog
        onOpenSettings={() => setSettingsOpen(true)}
        open={dialog === 'transcribe'}
        onClose={() => setDialog(null)}
        project={project}
        caps={caps}
        asr={asr}
        setAsr={setAsr}
        onTranscribe={doTranscribe}
        busy={busy}
        hasScript={!!doc}
        wordCount={stats.words}
        asrProvider={project?.asrProvider ?? null}
        verbatim={project?.verbatim ?? true}
        job={job?.kind === 'transcribe' ? job : null}
        onCancelJob={cancelJob}
        error={error}
      />

      <ExportDialog
        open={dialog === 'export'}
        onClose={() => setDialog(null)}
        project={project}
        stats={stats}
        burnCaptions={captions.enabled}
        setBurnCaptions={(v) => updateCaptions({ ...captions, enabled: v })}
        onRender={doRender}
        onCaptions={doCaptions}
        busy={busy}
        job={job?.kind === 'render' ? job : null}
        onCancelJob={cancelJob}
      />

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={refreshCaps} />

      {/* In the editor too, so asking a question no longer costs you sight of
          the Inspector you are asking about. One conversation, one model —
          this and the rail's tab are the same assistant. */}
      <FloatingAssistant
        enabled={Boolean(caps.agent?.enabled)}
        defaultModel={caps.agent?.defaultModel ?? 'grok-4'}
        onOpenSettings={() => setSettingsOpen(true)}
      />
    </div>
  );
}

/** The server ships defaults; the client used to hardcode over them. */
function editDefaults(caps: Capabilities | null): CutSettings {
  const d = caps?.editDefaults;
  return {
    padMs: d?.padMs ?? 40,
    fadeMs: d?.fadeMs ?? 12,
    mergeWithinMs: d?.mergeWithinMs ?? 20,
    // 0 from the wire means "keep every pause" — Infinity does not survive JSON.
    maxGapMs: d && d.maxGapMs > 0 ? d.maxGapMs : Infinity,
  };
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value;
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtShort(seconds: number): string {
  return seconds >= 60 ? clock(seconds) : `${seconds.toFixed(1)}s`;
}

/** File size for the assistant's reports — a summoned file's cost, in one glance. */
function fmtBytes(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
