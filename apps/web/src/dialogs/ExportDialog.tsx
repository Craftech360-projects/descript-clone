import { useState } from 'react';
import Dialog from '../ui/Dialog.tsx';
import Progress from '../ui/Progress.tsx';
import { Field, Check, Hint, Warn } from '../ui/Field.tsx';
import { timecode } from '../../../../packages/core/src/timeline.ts';
import type { Project } from '../api.ts';

interface Props {
  open: boolean;
  onClose: () => void;
  project: Project | null;
  stats: { words: number; kept: number; cuts: number; outputSec: number; sourceSec: number };
  burnCaptions: boolean;
  setBurnCaptions: (v: boolean) => void;
  onRender: () => void;
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
  const hasVideo = Boolean(p.project?.hasVideo);
  const rendering = p.busy === 'render';
  const removed = Math.max(0, p.stats.sourceSec - p.stats.outputSec);
  const nothingLeft = p.stats.kept === 0;

  return (
    <Dialog
      open={p.open}
      title="Export"
      onClose={p.onClose}
      footer={
        <>
          <button onClick={p.onClose} disabled={rendering}>Cancel</button>
          <button className="primary" onClick={p.onRender} disabled={rendering || nothingLeft}>
            {rendering ? 'Rendering…' : 'Render video'}
          </button>
        </>
      }
    >
      <div className="hero">
        <strong>{timecode(p.stats.outputSec)}</strong>
        <small>from {timecode(p.stats.sourceSec)} · −{timecode(removed)} removed</small>
        <small>{p.stats.cuts} segments</small>
      </div>

      {/* The server 400s on an empty EDL. Catch it before the button, not after. */}
      {nothingLeft && (
        <Warn>Every word is cut, so there would be nothing to render. Restore something first.</Warn>
      )}

      {/* Real, determinate progress: ffmpeg reports encoded time and the EDL
        * already told us the target length. */}
      {p.job && <Progress progress={p.job.progress} stage={p.job.stage} onCancel={p.onCancelJob} />}

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
