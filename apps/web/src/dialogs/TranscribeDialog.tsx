import Dialog from '../ui/Dialog.tsx';
import Progress from '../ui/Progress.tsx';
import { Field, Check, Hint, Warn } from '../ui/Field.tsx';
import { timecode } from '../../../../packages/core/src/timeline.ts';
import type { AsrOptions, Capabilities, Project } from '../api.ts';

interface Props {
  open: boolean;
  onClose: () => void;
  project: Project | null;
  caps: Capabilities;
  asr: AsrOptions;
  setAsr: (o: AsrOptions) => void;
  onTranscribe: () => void;
  busy: string | null;
  hasScript: boolean;
  /** The current script's word count — shown as the "what you have now" summary. */
  wordCount: number;
  /** The model that produced the current script, and whether it kept fillers. */
  asrProvider: string | null;
  verbatim: boolean;
  job: { progress: number; stage: string } | null;
  onCancelJob: () => void;
  /** A request error belongs in this modal; otherwise the workspace banner sits behind it. */
  error: string | null;
}

/**
 * Where the Transcribe tab went.
 *
 * Transcription is a per-import decision, made once and occasionally redone —
 * not a permanent state that deserves a quarter of the inspector forever. It is
 * asked at the one moment it is relevant.
 *
 * The model stays the first field and never hides behind Advanced: verbatim vs
 * normalized decides whether filler removal finds anything at all, which makes
 * it the most load-bearing control in the app.
 */
export default function TranscribeDialog({
  open,
  onClose,
  project,
  caps,
  asr,
  setAsr,
  onTranscribe,
  busy,
  hasScript,
  wordCount,
  asrProvider,
  verbatim,
  job,
  onCancelJob,
  error,
}: Props) {
  const model = caps.asrModels.find((m) => m.id === asr.model);
  const running = busy === 'transcribe';

  return (
    <Dialog
      open={open}
      title={hasScript ? 'Re-transcribe' : 'Transcribe'}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} disabled={running}>Cancel</button>
          <button type="button" className="primary" onClick={() => void onTranscribe()} disabled={running}>
            {running ? 'Transcribing…' : hasScript ? 'Re-transcribe' : 'Transcribe'}
          </button>
        </>
      }
    >
      {project && (
        <p className="dl-sub">
          {project.name} · {timecode(project.duration)} ·{' '}
          {project.hasVideo ? `${project.width}×${project.height}` : 'audio only'}
        </p>
      )}

      {/* In place, where the button was — not a toast. The work is the subject
        * of this dialog, so this is where you look for it. */}
      {job && <Progress progress={job.progress} stage={job.stage} onCancel={onCancelJob} />}
      {error && <Warn alert>{error}</Warn>}

      {/* What the project holds right now — the summary that used to sit in the
        * Project rail. It belongs here: it is the state a re-transcribe replaces,
        * so it reads as the "before" to this dialog's action. */}
      {hasScript && (
        <>
          <p className="dl-sub">
            {wordCount} words · {asrProvider ?? 'unknown model'}
            {verbatim ? ' · verbatim' : ' · not verbatim'}
          </p>
          {!verbatim && (
            <Warn>
              This transcript is not verbatim — the model dropped fillers before you saw them, so
              the filler tool will find little to nothing. Re-transcribe with ElevenLabs Scribe v2
              to keep them.
            </Warn>
          )}
          <Warn>
            Re-transcribing replaces the script, and the cuts you have made go with it.
          </Warn>
        </>
      )}

      <Field label="Model">
        <select value={asr.model} onChange={(e) => setAsr({ ...asr, model: e.target.value })}>
          {caps.asrModels.map((m) => (
            <option key={m.id} value={m.id} disabled={!m.available}>
              {m.label}
              {!m.available && ` - needs ${m.provider === 'sarvam' ? 'SARVAM_API_KEY' : 'ELEVENLABS_API_KEY'}`}
            </option>
          ))}
        </select>
        {model && <Hint>{model.hint}</Hint>}
        {model && !model.verified && (
          <Warn>Endpoint not verified — word-level timestamps are assumed, not confirmed.</Warn>
        )}
      </Field>

      <Field label="Language">
        <select value={asr.language} onChange={(e) => setAsr({ ...asr, language: e.target.value })}>
          <option value="auto">Auto-detect</option>
          <option value="en">English</option>
          <option value="es">Spanish</option>
          <option value="fr">French</option>
          <option value="de">German</option>
          <option value="hi">Hindi</option>
          <option value="pt">Portuguese</option>
          <option value="ja">Japanese</option>
          <option value="zh">Chinese</option>
        </select>
      </Field>

      <Field label="Speakers">
        <Check
          checked={asr.diarize}
          onChange={(v) => setAsr({ ...asr, diarize: v })}
          label="Label who is speaking"
        />
        <Check
          checked={asr.verbatim}
          onChange={(v) => setAsr({ ...asr, verbatim: v })}
          label='Keep filler words ("um", "uh")'
        />
        {!caps.hasAsr && (
          <Hint>
            No ELEVENLABS_API_KEY, so the mock provider runs: real timings, invented words. The
            whole pipeline still works.
          </Hint>
        )}
      </Field>
    </Dialog>
  );
}
