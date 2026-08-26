import { useState } from 'react';
import { EXPORT_PRESETS, overBy, presetFor } from '../../../../packages/core/src/export-preset.ts';
import Dialog from '../ui/Dialog.tsx';
import Progress from '../ui/Progress.tsx';
import { Field, Check, Hint, Segmented, Warn } from '../ui/Field.tsx';
import { timecode } from '../../../../packages/core/src/timeline.ts';
import type { Project } from '../api.ts';

interface Props {
  open: boolean;
  onClose: () => void;
  project: Project | null;
  stats: {
    words: number;
    kept: number;
    cuts: number;
    /** Already divided by speed — this is the finished file's length. */
    outputSec: number;
    sourceSec: number;
    speed: number;
  };
  burnCaptions: boolean;
  setBurnCaptions: (v: boolean) => void;
  onRender: (preset: string) => void;
  onCaptions: (format: string) => void;
  busy: string | null;
  job: { progress: number; stage: string } | null;
  onCancelJob: () => void;
}

/**
 * Where the Export tab and Tools › Captions went.
 *
 * Export is a terminal commitment with a result artifact — Premiere puts it in a
 * dialog, Resolve gives it a whole page, Descript has a Publish dialog. Nobody
 * ships export as an inspector tab, because an inspector reflects what you have
 * selected and export does not care.
 */
export default function ExportDialog(p: Props) {
  const [format, setFormat] = useState('srt');
  /**
   * Where this file is going. Local to the dialog rather than the document: it
   * describes an ACT of exporting, not a property of the project, and the same
   * cut is often sent to more than one place.
   */
  const [preset, setPreset] = useState<string>('source');
  const hasVideo = Boolean(p.project?.hasVideo);
  const rendering = p.busy === 'render';
  // Not clamped at 0 any more: below 1x the render comes out LONGER than the
  // source, and "−0:00 removed" would be a lie in both halves.
  const removed = p.stats.sourceSec - p.stats.outputSec;
  const nothingLeft = p.stats.kept === 0;

  const over = overBy(preset, p.stats.outputSec);
  const chosen = presetFor(preset);

  return (
    <Dialog
      open={p.open}
      title="Export"
      onClose={p.onClose}
      footer={
        <>
          <button onClick={p.onClose} disabled={rendering}>Cancel</button>
          {/* Any in-flight work blocks a render, not just another render. The
              sibling caption button below already reads `p.busy`; this one only
              knew about renders, so Render stayed clickable while a caption
              export was running and two jobs could be started at once. */}
          <button className="primary" onClick={() => p.onRender(preset)} disabled={!!p.busy || nothingLeft}>
            {rendering ? 'Rendering…' : 'Render video'}
          </button>
        </>
      }
    >
      {/* Speed is set in the transport, which is behind this dialog — so say it
        * here. It changes the file you are about to commit to, and finding that
        * out after a two-minute render is the wrong time. */}
      <div className="hero">
        <strong>{timecode(p.stats.outputSec)}</strong>
        <small>
          from {timecode(p.stats.sourceSec)} · {removed >= 0 ? '−' : '+'}
          {timecode(Math.abs(removed))} {removed >= 0 ? 'removed' : 'longer'}
        </small>
        <small>
          {p.stats.cuts} segments
          {p.stats.speed !== 1 && ` · ${Number(p.stats.speed.toFixed(2))}x speed`}
        </small>
      </div>

      {/* The server 400s on an empty EDL. Catch it before the button, not after. */}
      {nothingLeft && (
        <Warn>Every word is cut, so there would be nothing to render. Restore something first.</Warn>
      )}

      {/* Real, determinate progress: ffmpeg reports encoded time and the EDL
        * already told us the target length. */}
      {p.job && <Progress progress={p.job.progress} stage={p.job.stage} onCancel={p.onCancelJob} />}

      {/* Where the file is going. A preset fixes the shape and the loudness —
        * platforms normalise playback, so a reel that arrives quieter than the
        * target is simply played quieter than everything around it. */}
      <Field label="Destination">
        <Segmented
          name="export-preset"
          value={preset}
          onChange={setPreset}
          options={EXPORT_PRESETS.map((x) => [x.id, x.label] as [string, string])}
        />
        <Hint>{chosen.hint}</Hint>
        {over !== null && (
          <Warn>
            This cut is {timecode(over)} over {chosen.label}&rsquo;s {timecode(chosen.maxSeconds!)}{' '}
            limit. It will still render — trim it, or post it somewhere without the limit.
          </Warn>
        )}
      </Field>

      <Field label="Video">
        <Check
          checked={p.burnCaptions}
          onChange={p.setBurnCaptions}
          label="Burn captions into the picture"
          disabled={!hasVideo}
        />
        <Hint>
          {hasVideo
            ? 'H.264 · CRF 20 · AAC 192k. Cuts get a 12ms micro-fade so they do not click. Font, colour and placement live in the Project panel — drag the caption on the monitor to move it.'
            : 'This project is audio only — there is no picture to burn captions onto.'}
        </Hint>
      </Field>

      <Field label="Captions">
        <select value={format} onChange={(e) => setFormat(e.target.value)}>
          <option value="srt">SRT — subtitle file</option>
          <option value="vtt">WebVTT — for the web</option>
          <option value="ass">ASS — animated karaoke</option>
        </select>
        <Hint>A sidecar file, timed against the edit rather than the source.</Hint>
        <button onClick={() => p.onCaptions(format)} disabled={!!p.busy || nothingLeft}>
          Download captions
        </button>
      </Field>
    </Dialog>
  );
}
