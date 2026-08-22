import { useEffect, useState } from 'react';

import { Field, Hint, Segmented, Warn } from '../ui/Field.tsx';
import { SOCIAL_TARGETS } from '../../../../packages/core/src/social.ts';
import { api, type Folder, type Project, type SocialDraft } from '../api.ts';
import { initAgent } from '../store/agent.ts';

/**
 * The Social tab: what to actually post, written from the transcript AND from
 * what this folder says the channel is.
 *
 * The folder brief is the reason this is worth having. A model given only the
 * transcript writes a competent summary of the words, which is the one thing a
 * title must not be — measured on this project's own footage, the same local
 * model produced "Listen to a silly crow story" with no brief and "Cheeko's
 * first try at a rhyming game" with one.
 *
 * So the brief is not tucked away in settings. It sits here, above the button,
 * where you can see whether it is empty before you wonder why the copy is bland.
 */
export default function SocialPanel(p: {
  project: Project | null;
  /** The model chosen in the Assistant tab — one picker for the whole app. */
  model: string;
  defaultModel: string;
  agentEnabled: boolean;
  hasWords: boolean;
}) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [target, setTarget] = useState('reels');
  const [draft, setDraft] = useState<SocialDraft | null>(null);
  const [usedBrief, setUsedBrief] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);


  const folderId = p.project?.folderId ?? '';
  const folder = folders.find((f) => f.id === folderId) ?? null;

  const load = () => api.folders.list().then(setFolders).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  /**
   * Make sure a model is chosen even if the Assistant tab was never opened.
   *
   * The model list is fetched by the Assistant panel on mount, so coming
   * straight here left `model` empty and the Write button permanently disabled —
   * a dead button with no explanation, which is the worst version of this. One
   * picker still governs both tabs; this only guarantees it has loaded.
   */
  useEffect(() => {
    if (!p.model) void initAgent(p.defaultModel, p.agentEnabled);
  }, [p.model, p.defaultModel, p.agentEnabled]);
  useEffect(() => { setDraft(null); setError(null); }, [p.project?.id]);

  if (!p.project) return <div className="panel"><Hint>Open a project to write its post.</Hint></div>;

  const write = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await api.social(p.project!.id, { model: p.model, target });
      setDraft(r.draft);
      setUsedBrief(r.usedBrief);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string, what: string) => {
    navigator.clipboard?.writeText(text).then(
      () => setNote(`${what} copied.`),
      () => setError('Could not reach the clipboard.'),
    );
  };

  return (
    <div className="panel social">
      {/* The memory is edited on the folder's own page, where the folder is.
          Here it is only reported, so you can see WHY the copy reads as it does
          without a second place to edit the same paragraph. */}
      {folder ? (
        <Hint>
          Writing with <strong>{folder.name}</strong>&rsquo;s memory
          {folder.brief.trim() ? '' : ' — which is still empty. Add one on the folder page.'}
        </Hint>
      ) : (
        <Hint>
          This project is not in a folder, so there is no memory to write from — the copy will
          read like a summary of the words. Put it in a folder from the projects page.
        </Hint>
      )}

      <Field label="Written for">
        <Segmented
          name="social-target"
          value={target}
          onChange={setTarget}
          options={SOCIAL_TARGETS.map((t) => [t.id, t.label] as [string, string])}
        />
      </Field>

      {!p.hasWords && <Warn>Transcribe this project first — there are no words to write from.</Warn>}

      <button className="primary social-go" onClick={() => void write()} disabled={busy || !p.hasWords || !p.model}>
        {busy ? 'Writing…' : draft ? 'Write again' : 'Write the post'}
      </button>
      {p.model ? (
        <Hint>
          Using {p.model.replace(/^local:/, '')}
          {p.model.startsWith('local:') ? ' — on this machine, nothing leaves it' : ''}. Change it in
          the Assistant tab.
        </Hint>
      ) : (
        <Warn>
          No model is available. Start a local one (Ollama or LM Studio) or add a key in Settings,
          then come back.
        </Warn>
      )}

      {error && <Warn alert>{error}</Warn>}
      {note && <Hint>{note}</Hint>}

      {draft && (
        <div className="social-draft">
          {!usedBrief && (
            <Hint>
              Written without a memory. Add one above and press Write again — it is the
              single biggest difference in how this reads.
            </Hint>
          )}

          <Field label="Title">
            <p className="social-out">{draft.title}</p>
            <button onClick={() => copy(draft.title, 'Title')}>Copy title</button>
          </Field>

          <Field label="Description">
            <p className="social-out">{draft.description}</p>
            <button onClick={() => copy(draft.description, 'Description')}>Copy description</button>
          </Field>

          {draft.hashtags.length > 0 && (
            <Field label="Hashtags">
              <p className="social-tags">{draft.hashtags.join(' ')}</p>
              <button onClick={() => copy(draft.hashtags.join(' '), 'Hashtags')}>Copy hashtags</button>
            </Field>
          )}

          <button
            onClick={() =>
              copy(
                `${draft.title}\n\n${draft.description}\n\n${draft.hashtags.join(' ')}`.trim(),
                'The whole post',
              )
            }
          >
            Copy everything
          </button>
        </div>
      )}
    </div>
  );
}
