import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  initAgent,
  resetChat,
  sendMessage,
  setModel,
  useAgent,
} from '../store/agent.ts';
import Markdown from './Markdown.tsx';
import Icon from '../ui/Icon.tsx';

interface Props {
  /** From capabilities: whether the server has an xAI key, and its default model. */
  enabled: boolean;
  defaultModel: string;
  /** Open the API-keys dialog, so the assistant can be turned on from here. */
  onOpenSettings: () => void;
}

/** A few things to say to a blank chat — clickable so the first turn is one tap. */
const STARTERS = [
  'Cut the filler words',
  'Make it a 9:16 reel',
  'Remove the retakes and speed it up to 1.2x',
  'Add calm background music',
];

/**
 * The assistant, as a chat surface in the rail. This is the whole point of the
 * feature — the user should be able to drive the editor from here without touching
 * anything else — so it is deliberately the rail's default tab.
 *
 * The layout follows the conventions people already know from other AI chats: the
 * assistant speaks full-width with a small avatar, the user's own turns sit in a
 * bubble on the right, every tool the model ran shows as a chip under the reply,
 * and the composer is a single rounded field that grows with what you type, with a
 * round send button. Enter sends; Shift+Enter is a newline.
 */
export default function AgentPanel({ enabled, defaultModel, onOpenSettings }: Props) {
  const { entries, status, model, models } = useAgent();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Load the model list once, when the panel first appears.
  useEffect(() => {
    void initAgent(defaultModel, enabled);
  }, [defaultModel, enabled]);

  // Keep the newest turn in view as the conversation grows.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, status]);

  // Grow the composer to fit its content, up to a cap, then let it scroll — the
  // behaviour every chat input has. Runs whenever the draft changes (including the
  // reset to '' after sending, which snaps it back to one line).
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [draft]);

  const busy = status === 'busy';

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setDraft('');
    void sendMessage(trimmed);
  };

  if (!enabled) {
    return (
      <div className="agent">
        <div className="agent-empty">
          <p>The AI assistant is off.</p>
          <p className="sub">
            Add a key in Settings to enable chat-driven editing: <code>XAI_API_KEY</code> for Grok, or
            run <code>claude setup-token</code> and add the <code>CLAUDE_CODE_OAUTH_TOKEN</code> to drive
            it on your Claude subscription (an <code>ANTHROPIC_API_KEY</code> also works, billed per token).
          </p>
          <button className="primary" onClick={onOpenSettings}>
            Add a key…
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="agent">
      <div className="agent-msgs" ref={scrollRef}>
        {entries.length === 0 && (
          <div className="agent-welcome">
            <span className="agent-avatar agent-avatar-lg" aria-hidden="true">
              <Icon name="sparkle" size={18} />
            </span>
            <p className="agent-welcome-title">Ask me to edit your video.</p>
            <p className="agent-welcome-sub">
              I can cut, reframe, restyle, add music, and export — just say what you want.
            </p>
            <div className="agent-suggest">
              {STARTERS.map((s) => (
                <button key={s} className="agent-chip" onClick={() => submit(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {entries.map((e) => (
          <div key={e.id} className={`agent-msg ${e.role}`}>
            {e.role !== 'user' && (
              <span className="agent-avatar" aria-hidden="true">
                <Icon name={e.role === 'error' ? 'close' : 'sparkle'} size={13} />
              </span>
            )}
            <div className="agent-body">
              {e.tools && e.tools.length > 0 && (
                <div className="agent-tools">
                  {e.tools.map((t, i) => (
                    <div key={i} className="agent-tool" title={t.result}>
                      <span className="agent-tool-name">{t.name.replace(/_/g, ' ')}</span>
                      <span className="agent-tool-result">{t.result}</span>
                    </div>
                  ))}
                </div>
              )}
              {e.text && (
                <div className={`agent-text ${e.role === 'assistant' ? 'md' : ''}`}>
                  {/* The model replies in Markdown; render it. What the user typed and
                    * error strings are shown verbatim — they are not Markdown. */}
                  {e.role === 'assistant' ? <Markdown text={e.text} /> : e.text}
                </div>
              )}
            </div>
          </div>
        ))}

        {busy && (
          <div className="agent-msg assistant">
            <span className="agent-avatar" aria-hidden="true">
              <Icon name="sparkle" size={13} />
            </span>
            <div className="agent-body">
              <div className="agent-thinking">
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="agent-compose">
        <div className="agent-input">
          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit(draft);
              }
            }}
            placeholder={busy ? 'Working…' : 'Message the assistant…'}
            rows={1}
            disabled={busy}
          />
          <button
            className="agent-send"
            aria-label="Send"
            title="Send"
            onClick={() => submit(draft)}
            disabled={busy || !draft.trim()}
          >
            <Icon name="arrow-up" size={16} />
          </button>
        </div>

        {/* The model picker and Clear live with the input, not in a bar above the
          * conversation — the controls sit where the typing happens. */}
        <div className="agent-controls">
          <select
            className="agent-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={busy}
            title="Model"
          >
            {/* The current model always appears, even if the live list hasn't loaded. */}
            {(models.includes(model) ? models : [model, ...models]).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button className="agent-clear" onClick={resetChat} disabled={busy || entries.length === 0}>
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}
