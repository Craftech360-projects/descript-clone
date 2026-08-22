import { useEffect, useRef, useState } from 'react';

import Icon from '../ui/Icon.tsx';
import Markdown from './Markdown.tsx';
import { initAgent, sendMessage, setModel, useAgent } from '../store/agent.ts';

/**
 * The assistant, reachable from anywhere.
 *
 * It already existed as a tab in the right rail, which has two problems. The
 * rail only exists in the EDITOR, so on the projects page — where you are
 * naming things, filing them, deciding what to shoot next — there was no
 * assistant at all. And in the editor, reaching it meant swapping out the
 * Inspector, so you lost sight of the very settings you were asking about.
 *
 * A floating button fixes both: it sits above whatever screen you are on, and
 * opening it covers a corner rather than replacing a panel.
 *
 * ── it can see the screen ───────────────────────────────────────────────────
 *
 * The context sent each turn now says where the user is — the folder list, a
 * folder and its memory, or an open project — so "what should I call this?" is
 * answerable without them explaining where they are standing. That is the whole
 * reason this is more useful than a chat box in a tab.
 *
 * It shares ONE conversation and one model with the rail's panel, deliberately:
 * two assistants with two histories in the same app is two things to keep in
 * your head, and they would disagree about what you had already asked.
 */
export default function FloatingAssistant(p: {
  enabled: boolean;
  defaultModel: string;
  onOpenSettings: () => void;
}) {
  const { entries, status, model, models, catalogue } = useAgent();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const busy = status === 'thinking' || status === 'tooling';

  // The model list is fetched by whichever surface opens first; this makes sure
  // the floating one is never the surface with an empty picker.
  useEffect(() => {
    if (open && !model) void initAgent(p.defaultModel, p.enabled);
  }, [open, model, p.defaultModel, p.enabled]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Follow the conversation as it grows, the same as the rail's panel.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length, status]);

  // Escape closes it. A floating panel with no keyboard way out is a trap, and
  // this one can cover content.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const send = () => {
    const t = text.trim();
    if (!t || busy) return;
    setText('');
    void sendMessage(t);
  };

  return (
    <>
      <button
        className={`fab ${open ? 'fab-on' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Close Jumpy' : 'Ask Jumpy'}
        aria-expanded={open}
        title="Jumpy — the assistant"
      >
        <Icon name={open ? 'close' : 'sparkle'} size={18} />
      </button>

      {open && (
        <div className="fab-panel" role="dialog" aria-label="Jumpy">
          <div className="fab-head">
            <strong>Jumpy</strong>
            {/* The picker lives HERE, not only in a tab three clicks away. The
                model is the single biggest thing that changes what Jumpy can
                do — a local one never touches the network, a hosted one is
                stronger at long tool chains — so it belongs where the work is.
                The choice is remembered across reloads. */}
            <select
              className="fab-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              aria-label="Model Jumpy uses"
              title={catalogue.find((c) => c.id === model)?.hint}
            >
              {(models.includes(model) ? models : [model, ...models]).filter(Boolean).map((m) => {
                const c = catalogue.find((x) => x.id === m);
                return (
                  <option key={m} value={m} title={c?.hint}>
                    {c ? `${c.label}${c.where === 'On this machine' ? ' · offline' : ''}` : m}
                  </option>
                );
              })}
            </select>
          </div>

          <div className="fab-scroll" ref={scrollRef}>
            {!p.enabled && !model.startsWith('local:') && (
              <p className="fab-empty">
                No model is configured. Start a local one, or{' '}
                <button className="linkish" onClick={p.onOpenSettings}>add a key</button>.
              </p>
            )}

            {entries.length === 0 && (
              <p className="fab-empty">
                It can see what is on your screen — the folder you are in, its memory, the
                project you have open. Ask it to cut the fillers, write a title, or tighten
                a take.
              </p>
            )}

            {entries.map((e, i) => (
              <div key={i} className={`fab-msg fab-${e.role}`}>
                {e.role === 'assistant' ? <Markdown text={e.text} /> : <p>{e.text}</p>}
              </div>
            ))}

            {busy && <p className="fab-busy">{status === 'tooling' ? 'Working…' : 'Thinking…'}</p>}
          </div>

          <div className="fab-compose">
            <textarea
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter breaks the line — the convention every
                // chat box uses, and the one people try first.
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder="Ask Jumpy…"
              aria-label="Message Jumpy"
              disabled={busy}
            />
            <button className="primary" onClick={send} disabled={busy || !text.trim()}>
              Send
            </button>
          </div>
        </div>
      )}
    </>
  );
}
