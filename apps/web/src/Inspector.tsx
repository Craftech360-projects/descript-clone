import { useState } from 'react';
import type { AsrOptions, Capabilities, CutSettings, Project } from './api.ts';

export type Tab = 'transcribe' | 'cuts' | 'tools' | 'export';

interface Props {
  tab: Tab;
  setTab: (t: Tab) => void;
  project: Project | null;
  caps: Capabilities;
  busy: string | null;

  asr: AsrOptions;
  setAsr: (o: AsrOptions) => void;
  onTranscribe: () => void;

  cut: CutSettings;
  setCut: (c: CutSettings) => void;

  fillerMode: FillerMode;
  setFillerMode: (m: FillerMode) => void;
  retakeMin: number;
  setRetakeMin: (n: number) => void;

  onRemoveFillers: () => void;
  onRemoveRetakes: () => void;
  onRestoreAll: () => void;
  onCaptions: (format: string) => void;
  onRender: () => void;

  stats: { words: number; kept: number; cuts: number; outputSec: number; sourceSec: number };
}

export type FillerMode = 'off' | 'hesitations' | 'all';

const TABS: Array<[Tab, string]> = [
  ['transcribe', 'Transcribe'],
  ['cuts', 'Cuts'],
  ['tools', 'Tools'],
  ['export', 'Export'],
];

/**
 * The inspector is where the editor stops being a wizard.
 *
 * Nothing here runs on its own. Every stage — transcription, filler removal,
 * cut shaping, captions, export — is a panel with its own settings and its own
 * button. The defaults are sensible; none of them are decisions made for you.
 */
export default function Inspector(p: Props) {
  return (
    <aside className="inspector">
      <nav className="tabs">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            className={p.tab === id ? 'tab on' : 'tab'}
            onClick={() => p.setTab(id)}
            disabled={id !== 'transcribe' && !p.project?.transcript}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="panel">
        {p.tab === 'transcribe' && <TranscribePanel {...p} />}
        {p.tab === 'cuts' && <CutsPanel {...p} />}
        {p.tab === 'tools' && <ToolsPanel {...p} />}
        {p.tab === 'export' && <ExportPanel {...p} />}
      </div>
    </aside>
  );
}

function TranscribePanel({ project, caps, asr, setAsr, onTranscribe, busy }: Props) {
  if (!project) {
    return <Empty>Import a file to begin.</Empty>;
  }

  const model = caps.asrModels.find((m) => m.id === asr.model);
  const done = project.status === 'transcribed';

  return (
    <>
      <Field label="Model">
        <select value={asr.model} onChange={(e) => setAsr({ ...asr, model: e.target.value })}>
          {caps.asrModels.map((m) => (
            <option key={m.id} value={m.id} disabled={m.id !== 'mock' && !caps.hasFal}>
              {m.label}
              {m.id !== 'mock' && !caps.hasFal ? ' — needs FAL_KEY' : ''}
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
        <select
          value={asr.speakers}
          onChange={(e) => setAsr({ ...asr, speakers: Number(e.target.value) })}
          disabled={!asr.diarize}
        >
          <option value={0}>Detect automatically</option>
          {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
            <option key={n} value={n}>{n} speaker{n > 1 ? 's' : ''}</option>
          ))}
        </select>
        <Check
          checked={asr.diarize}
          onChange={(v) => setAsr({ ...asr, diarize: v })}
          label="Label who is speaking"
        />
      </Field>

      <Field label="Verbatim">
        <Check
          checked={asr.verbatim}
          onChange={(v) => setAsr({ ...asr, verbatim: v })}
          label='Keep filler words ("um", "uh")'
        />
        {asr.verbatim && model && !model.verbatim && (
          <Warn>
            {model.label} normalizes fillers away regardless of this setting. Filler removal will
            find little to nothing. A verbatim model (CrisperWhisper-class) is needed for it to work.
          </Warn>
        )}
      </Field>

      <button className="primary go" onClick={onTranscribe} disabled={!!busy}>
        {busy === 'transcribe' ? 'Transcribing…' : done ? 'Re-transcribe' : 'Transcribe'}
      </button>

      {done && (
        <Hint>
          {project.transcript?.words.length} words · {project.asrProvider}
          {!project.verbatim && ' · not verbatim'}
        </Hint>
      )}
    </>
  );
}

function CutsPanel({ cut, setCut, fillerMode, setFillerMode, retakeMin, setRetakeMin,
                     onRemoveFillers, onRemoveRetakes, onRestoreAll, busy, stats }: Props) {
  return (
    <>
      <Field label="Filler words">
        <Radio
          name="filler"
          value={fillerMode}
          onChange={(v) => setFillerMode(v as FillerMode)}
          options={[
            ['off', 'Do not flag'],
            ['hesitations', 'Hesitations only — um, uh, er'],
            ['all', 'Also discourse markers — you know, I mean'],
          ]}
        />
        {fillerMode === 'all' && (
          <Warn>
            "Sort of" and "kind of" are sometimes load-bearing. Review before cutting — these are
            flagged, never cut automatically.
          </Warn>
        )}
        <button onClick={onRemoveFillers} disabled={!!busy || fillerMode === 'off'}>
          Cut flagged fillers
        </button>
      </Field>

      <Field label="Retakes / false starts">
        <Slider
          value={retakeMin}
          min={2}
          max={8}
          step={1}
          onChange={setRetakeMin}
          format={(v) => `${v}+ repeated words`}
        />
        <Hint>Lower catches more false starts, but starts matching ordinary repetition.</Hint>
        <button onClick={onRemoveRetakes} disabled={!!busy}>Cut retakes</button>
      </Field>

      <Field label="Pauses">
        <Slider
          value={cut.maxGapMs}
          min={0}
          max={2000}
          step={50}
          onChange={(v) => setCut({ ...cut, maxGapMs: v })}
          format={(v) => (v === 0 ? 'Keep every pause' : `Cap at ${v}ms`)}
        />
      </Field>

      <Field label="Cut shaping">
        <Slider
          value={cut.padMs}
          min={0}
          max={200}
          step={5}
          onChange={(v) => setCut({ ...cut, padMs: v })}
          format={(v) => `${v}ms padding`}
        />
        <Hint>Breathing room around each cut. Too little clips consonants.</Hint>

        <Slider
          value={cut.fadeMs}
          min={0}
          max={50}
          step={1}
          onChange={(v) => setCut({ ...cut, fadeMs: v })}
          format={(v) => (v === 0 ? 'No crossfade' : `${v}ms crossfade`)}
        />
        {cut.fadeMs === 0 && <Warn>0ms will click audibly at every cut.</Warn>}
      </Field>

      <div className="readout">
        <span>{stats.kept} of {stats.words} words kept</span>
        <span>{stats.cuts} segments</span>
      </div>

      <button onClick={onRestoreAll} disabled={!!busy}>Restore everything</button>
    </>
  );
}

function ToolsPanel({ caps, onCaptions, busy }: Props) {
  const [format, setFormat] = useState('srt');

  return (
    <>
      <Field label="Captions">
        <select value={format} onChange={(e) => setFormat(e.target.value)}>
          <option value="srt">SRT — subtitle file</option>
          <option value="vtt">WebVTT — for the web</option>
          <option value="ass">ASS — animated karaoke, for burn-in</option>
        </select>
        <Hint>Timed against the edited cut, not the original.</Hint>
        <button onClick={() => onCaptions(format)} disabled={!!busy}>Generate captions</button>
      </Field>

      <Field label="AI tools">
        {caps.aiTools.map((tool) => (
          <div key={tool.id} className="tool">
            <div className="tool-head">
              <strong>{tool.label}</strong>
              {!tool.wired && <span className="badge">not wired</span>}
            </div>
            <Hint>{tool.hint}</Hint>
            <button disabled title="No verified endpoint for this yet.">Apply</button>
          </div>
        ))}
        <Warn>
          These are shown because they are the plan, not because they work. Each needs a verified
          endpoint before it does anything — a button that pretends is worse than one that admits.
        </Warn>
      </Field>
    </>
  );
}

function ExportPanel({ onRender, busy, stats, project }: Props) {
  return (
    <>
      <Field label="Output">
        <div className="readout big">
          <span>{fmt(stats.outputSec)}</span>
          <small>from {fmt(stats.sourceSec)} · {stats.cuts} segments</small>
        </div>
        <Hint>
          {project?.hasVideo ? 'H.264 + AAC .mp4' : 'AAC .m4a'} · re-encoded from the source with
          the current cut settings.
        </Hint>
      </Field>

      <button className="primary go" onClick={onRender} disabled={!!busy || stats.kept === 0}>
        {busy === 'render' ? 'Rendering…' : 'Render'}
      </button>
    </>
  );
}

// --- small pieces -----------------------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <h3>{label}</h3>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="hint">{children}</p>;
}

function Warn({ children }: { children: React.ReactNode }) {
  return <p className="warn-box">{children}</p>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="empty-panel">{children}</p>;
}

function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function Radio({ name, value, onChange, options }: {
  name: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <div className="radios">
      {options.map(([v, label]) => (
        <label key={v} className="check">
          <input type="radio" name={name} checked={value === v} onChange={() => onChange(v)} />
          {label}
        </label>
      ))}
    </div>
  );
}

function Slider({ value, min, max, step, onChange, format }: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
}) {
  return (
    <div className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span>{format(value)}</span>
    </div>
  );
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${seconds.toFixed(1)}s`;
}
