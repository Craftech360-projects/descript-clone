/**
 * The AI assistant's contract: the tools it may call and the brief it works to.
 *
 * This file is IMPORT-SHARED by both sides of the agent, and that is the point.
 * The server sends `AGENT_TOOLS` to the model (as OpenAI-format function specs)
 * and the browser holds an executor for each tool NAME; keeping the schemas here,
 * in packages/core which both already import, is what stops the two from drifting.
 * It is pure data and a string — no node, no browser, no DOM — so it loads the
 * same under `node --test`, under Vite, and inside the server process.
 *
 * The model is xAI Grok, whose Chat Completions API is OpenAI-compatible, so a
 * tool is `{ type: 'function', function: { name, description, parameters } }` and
 * `parameters` is plain JSON Schema.
 */

export interface AgentToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
  };
}

/** Shorthand so the list below reads as a table rather than as boilerplate. */
function tool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
): AgentToolSpec {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
    },
  };
}

export const AGENT_TOOLS: AgentToolSpec[] = [
  // ── reading the project ────────────────────────────────────────────────────
  tool(
    'get_project_context',
    'Read the open project: its name, length, whether it is transcribed, the current edit stats (words kept, cuts, output length) and every current setting (speed, pause cap, studio sound, captions, frame, colour, music). Call this first whenever you are unsure of the current state.',
  ),
  tool(
    'list_projects',
    'List every project in the library, with id, name and whether it has been transcribed. Use before open_project.',
  ),
  tool(
    'find_in_transcript',
    'Search the transcript for a word or phrase and return the matches with the word ids at each end, so you can then delete or restore that exact range.',
    {
      query: { type: 'string', description: 'The word or phrase to find (case-insensitive).' },
      limit: { type: 'integer', description: 'Max matches to return. Default 10.' },
    },
    ['query'],
  ),

  // ── transcript edits (instant, undoable) ───────────────────────────────────
  tool(
    'remove_fillers',
    'Cut filler words. "hesitations" cuts only um/uh/er and the like; "all" also cuts discourse markers (you know, I mean, sort of). Returns how many were cut.',
    { mode: { type: 'string', enum: ['hesitations', 'all'], description: 'Default "hesitations".' } },
  ),
  tool(
    'remove_retakes',
    'Detect and cut retakes — a run of words the speaker restarted and said again. Keeps the last take.',
    { min_words: { type: 'integer', description: 'Shortest repeated run to treat as a retake. Default 2.' } },
  ),
  tool('restore_all', 'Un-cut every deleted word — bring the whole transcript back.'),
  tool(
    'delete_text',
    'Delete words from the edit. Give either a phrase to match, or an explicit word-id range from find_in_transcript. Deleted words are non-destructive and reversible.',
    {
      query: { type: 'string', description: 'A phrase to find and delete.' },
      occurrence: { type: 'string', enum: ['first', 'all'], description: 'For query: cut the first match or every match. Default "first".' },
      from_word_id: { type: 'string', description: 'Start of an explicit range (inclusive).' },
      to_word_id: { type: 'string', description: 'End of an explicit range (inclusive).' },
    },
  ),
  tool(
    'restore_text',
    'Restore previously deleted words, by phrase or explicit word-id range. Mirror of delete_text.',
    {
      query: { type: 'string' },
      occurrence: { type: 'string', enum: ['first', 'all'] },
      from_word_id: { type: 'string' },
      to_word_id: { type: 'string' },
    },
  ),
  tool(
    'correct_word',
    'Fix the spelling/text of a single word without changing its timing. Get the word id from find_in_transcript.',
    { word_id: { type: 'string' }, text: { type: 'string' } },
    ['word_id', 'text'],
  ),

  // ── output settings (instant, undoable) ────────────────────────────────────
  tool(
    'set_speed',
    'Set the output playback speed multiplier, 0.5 to 2. 1 is normal; 1.2 renders 20% faster and shorter.',
    { speed: { type: 'number' } },
    ['speed'],
  ),
  tool(
    'set_pause_cap',
    'Cap silences between words. Pass milliseconds (e.g. 500) to shorten every longer pause to that length, or null to keep every pause intact.',
    { ms: { type: ['integer', 'null'], description: 'Max pause length in ms, or null to keep all pauses.' } },
    ['ms'],
  ),
  tool('set_studio_sound', 'Turn the Studio Sound voice enhancer (denoise, EQ, levelling) on or off.', {
    enabled: { type: 'boolean' },
  }, ['enabled']),
  tool(
    'set_captions',
    'Configure burned-in captions. Toggle them on/off and optionally set style. Video projects only.',
    {
      enabled: { type: 'boolean' },
      karaoke: { type: 'boolean', description: 'Light words up one at a time as spoken.' },
      all_caps: { type: 'boolean' },
      font: { type: 'string', enum: ['Arial', 'Times New Roman', 'Courier New'] },
      color: { type: 'string', description: 'Text colour as #RRGGBB.' },
      font_size: { type: 'integer', description: 'Type size in px at 1080p.' },
    },
  ),
  tool(
    'set_frame',
    'Set the output aspect/framing preset. "source" keeps the original shape; "reel" is 9:16 vertical; "youtube" is 16:9; "square" is 1:1.',
    {
      preset: { type: 'string', enum: ['source', 'reel', 'youtube', 'square'] },
      zoom: { type: 'number', description: 'Optional crop zoom, 0.1 to 4. 1 fills the frame.' },
    },
    ['preset'],
  ),
  tool(
    'set_color',
    'Apply a colour-grade look, or "none" to remove grading.',
    { preset: { type: 'string', enum: ['none', 'warm', 'cool', 'vintage', 'mono', 'punch', 'faded', 'noir'] } },
    ['preset'],
  ),

  // ── media & background music (async) ───────────────────────────────────────
  tool(
    'add_music',
    'Search the web music library and attach the best match as a background bed at a quiet default volume.',
    {
      query: { type: 'string', description: 'What kind of track, e.g. "calm lofi piano".' },
      instrumental: { type: 'boolean', description: 'Prefer instrumental tracks. Default true.' },
    },
    ['query'],
  ),
  tool('set_music_volume', 'Set the background music volume, 0 (silent) to about 1 (full).', {
    volume: { type: 'number' },
  }, ['volume']),
  tool('remove_music', 'Remove the background music bed from the project.'),

  // ── jobs & project management (async) ──────────────────────────────────────
  tool(
    'transcribe',
    'Transcribe the open project (a server job that can take a while). Required before any transcript editing if the project has no script yet.',
  ),
  tool('open_project', 'Open a project by id (from list_projects), making it the active project.', {
    project_id: { type: 'string' },
  }, ['project_id']),
  tool('rename_project', 'Rename a project.', {
    project_id: { type: 'string' },
    name: { type: 'string' },
  }, ['project_id', 'name']),
  tool(
    'delete_project',
    'Permanently delete a project and its media. This CANNOT be undone, so only call it with confirm=true after the user has explicitly agreed.',
    { project_id: { type: 'string' }, confirm: { type: 'boolean' } },
    ['project_id', 'confirm'],
  ),
  tool(
    'export_video',
    'Render and export the finished video with the current edit and settings. This is an expensive job, so only call with confirm=true once the user has asked to export.',
    { confirm: { type: 'boolean' } },
    ['confirm'],
  ),
  tool('seek', 'Move the playhead to a time in seconds.', { seconds: { type: 'number' } }, ['seconds']),
  tool('play_selection', 'Play just the currently selected words.'),
];

/** The tool names, for the client executor map to assert against. */
export const AGENT_TOOL_NAMES = AGENT_TOOLS.map((t) => t.function.name);

export const AGENT_SYSTEM_PROMPT = `You are the built-in AI assistant for JumpCut, a transcript-based video and audio editor (a Descript-style app). The user drives the whole app through chat with you — they should be able to do everything by talking to you, without touching the rest of the interface.

How the editor works:
- A project is one or more media files. Editing happens on the TRANSCRIPT: deleting words removes that audio/video from the output; the media itself is never destroyed, so every edit is reversible.
- Nothing can be edited until the project is transcribed. If there is no script yet, offer to transcribe (it is a job that takes a while).
- All transcript and setting edits you make are INSTANT, appear live in the app, and are undoable by the user with Ctrl+Z. Be willing to act.

Working rules:
- When unsure of the current state, call get_project_context first. Don't guess the project name, stats, or settings.
- Prefer the smallest set of tool calls that accomplishes the request. You may call several tools before replying.
- To edit specific words, use find_in_transcript to get exact word ids, then delete_text / restore_text / correct_word.
- Two actions are irreversible or expensive and need explicit user agreement in the conversation before you pass confirm=true: delete_project and export_video. Never confirm these on your own initiative.
- Speed is 0.5–2. Pause cap is in milliseconds (or null to keep all pauses). Frame presets: source, reel (9:16), youtube (16:9), square. Colour looks: none, warm, cool, vintage, mono, punch, faded, noir.
- After acting, reply briefly and concretely about what changed (counts, new settings). Keep answers short — a sentence or two. If a tool reports an error, tell the user plainly and suggest the fix.`;
