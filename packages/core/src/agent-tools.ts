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
  tool(
    'read_transcript',
    'Read the script itself, as timestamped lines broken on speaker changes and pauses. Cut words come back ~~struck through~~. Use this whenever the request is about what was SAID (summarise, find the weak intro, pick a pull-quote) rather than a keyword you can search for. Long transcripts page — the reply says how to fetch the rest.',
    {
      offset: { type: 'integer', description: 'Word index to start at. Default 0.' },
      limit: { type: 'integer', description: 'How many words to return, up to 2000. Default 400.' },
      include_deleted: { type: 'boolean', description: 'Include already-cut words, struck through. Default true.' },
      include_ids: { type: 'boolean', description: 'Append each word id, so you can edit exactly what you read. Default false — it roughly doubles the length.' },
    },
  ),

  // ── transcript edits (instant, undoable) ───────────────────────────────────
  tool(
    'tag_fillers',
    'Flag filler words in the script WITHOUT cutting them, so the user can see what would go. Use when they ask what the fillers are rather than to remove them.',
    { mode: { type: 'string', enum: ['hesitations', 'all'], description: 'Default "hesitations".' } },
  ),
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
  tool(
    'set_speaker',
    'Label who is talking over a stretch of transcript. Give a phrase, an explicit word-id range, or neither to use the current selection.',
    {
      speaker: { type: 'string', description: 'The name to apply, e.g. "Alex".' },
      query: { type: 'string', description: 'A phrase whose words get the label.' },
      occurrence: { type: 'string', enum: ['first', 'all'], description: 'For query. Default "first".' },
      from_word_id: { type: 'string' },
      to_word_id: { type: 'string' },
    },
    ['speaker'],
  ),

  // ── selection, history & playback ──────────────────────────────────────────
  tool(
    'select_text',
    'Highlight words in the script for the user — the same selection they would make by dragging. Use it to SHOW them something (then play_selection), not as a step before delete_text, which selects for itself.',
    {
      query: { type: 'string', description: 'A phrase to select (the first match).' },
      from_word_id: { type: 'string' },
      to_word_id: { type: 'string' },
      clear: { type: 'boolean', description: 'Pass true to clear the selection instead.' },
    },
  ),
  tool(
    'undo',
    'Undo the last edit(s) — the same Ctrl+Z the user has. Use when they ask to take something back or when an edit of yours did the wrong thing. Returns what was undone.',
    { steps: { type: 'integer', description: 'How many edits to undo, up to 50. Default 1.' } },
  ),
  tool('redo', 'Redo edits that were just undone. Mirror of undo.', {
    steps: { type: 'integer', description: 'How many edits to redo, up to 50. Default 1.' },
  }),
  tool(
    'set_playback',
    'Start, stop or toggle playback from the playhead. Pair with seek to show the user a moment.',
    { action: { type: 'string', enum: ['play', 'pause', 'toggle'] } },
    ['action'],
  ),
  tool(
    'split_at_playhead',
    'The razor: cut the source clip under the playhead into two clips. This is a media-level split, not a transcript edit — seek first to put the playhead where the split belongs.',
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
    'Configure burned-in captions: on/off and every style knob the Captions panel has. Video projects only. Fonts other than the three built-ins must be ones list_fonts reports.',
    {
      enabled: { type: 'boolean' },
      karaoke: { type: 'boolean', description: 'Light words up one at a time as spoken.' },
      all_caps: { type: 'boolean' },
      font: { type: 'string', description: 'A family from list_fonts: Arial, Times New Roman, Courier New, or an imported one.' },
      color: { type: 'string', description: 'Text colour as #RRGGBB.' },
      font_size: { type: 'integer', description: 'Type size in px at 1080p.' },
      highlight_color: { type: 'string', description: 'The karaoke highlight, #RRGGBB.' },
      stroke_color: { type: 'string', description: 'Outline colour, #RRGGBB.' },
      stroke_width: { type: 'number', description: 'Outline thickness in px. 0 is none.' },
      backdrop: { type: 'string', enum: ['none', 'shadow', 'box'], description: 'What sits behind the text.' },
      max_chars: { type: 'integer', description: 'Characters per caption line before it wraps.' },
    },
  ),
  tool(
    'set_frame',
    'Set the output shape and the crop inside it. "source" keeps the original shape; "reel" is 9:16; "youtube" is 16:9; "square" is 1:1; "custom" takes width/height. x/y move the crop within the overflow — the way to keep a speaker who stands off-centre in a vertical reel.',
    {
      preset: { type: 'string', enum: ['source', 'reel', 'youtube', 'square', 'custom'] },
      zoom: { type: 'number', description: 'Crop zoom, 0.1 to 4. 1 fills the frame; below 1 shrinks the picture and bars the rest.' },
      x: { type: 'number', description: 'Crop position, -1 (hard left) to 1 (hard right). 0 is centred.' },
      y: { type: 'number', description: 'Crop position, -1 (top) to 1 (bottom). 0 is centred.' },
      width: { type: 'integer', description: 'For preset "custom" only.' },
      height: { type: 'integer', description: 'For preset "custom" only.' },
    },
    ['preset'],
  ),
  tool(
    'set_color_knobs',
    'Grade by hand, past the presets: exposure, white balance, saturation, contrast, lifted or crushed blacks. Use when the user asks for something a preset does not name ("a bit warmer", "flatter", "lift the blacks"). Pass only the knobs you are changing.',
    {
      exposure: { type: 'number', description: 'Stops, -1 to 1. Positive is brighter.' },
      temperature: { type: 'number', description: '-1 (cool) to 1 (warm).' },
      tint: { type: 'number', description: '-1 (green) to 1 (magenta).' },
      saturation: { type: 'number', description: '0 (greyscale) to 2. 1 is untouched.' },
      contrast: { type: 'number', description: '-1 (flat) to 1 (hard). 0 is untouched.' },
      shadows: { type: 'number', description: '-1 (crushed) to 1 (lifted, filmic). 0 is untouched.' },
    },
  ),
  tool(
    'set_cut_settings',
    'The fine controls behind every cut: padding kept around each kept range, the crossfade at each join, and how close two ranges must be to merge. Defaults are good — reach for this only when the user complains about the cuts themselves (clipped words, audible seams).',
    {
      pad_ms: { type: 'integer', description: 'Milliseconds kept either side of a kept range. Higher is safer, looser.' },
      fade_ms: { type: 'integer', description: 'Crossfade at each join, in ms. Higher hides seams; too high smears.' },
      merge_within_ms: { type: 'integer', description: 'Ranges closer than this become one cut.' },
    },
  ),
  tool(
    'set_color',
    'Apply a colour-grade look, or "none" to remove grading.',
    { preset: { type: 'string', enum: ['none', 'warm', 'cool', 'vintage', 'mono', 'punch', 'faded', 'noir'] } },
    ['preset'],
  ),

  // ── push-ins: timed reframes over the picture (video only) ─────────────────
  tool('list_push_ins', 'List the push-ins on this project with their id, times, zoom and framing.'),
  tool(
    'add_push_in',
    'Add a push-in: a stretch of the video that is punched in on, easing in and out at its ends. Times are SOURCE seconds (the same clock as the playhead and find_in_transcript), so a push-in stays on the words it was aimed at even after cuts. Ranges may not overlap an existing push-in.',
    {
      start_sec: { type: 'number' },
      end_sec: { type: 'number', description: 'Must be after start_sec.' },
      zoom: { type: 'number', description: 'How far in. 1 is no push-in; default 1.5.' },
      x: { type: 'number', description: 'Horizontal framing, -1 (left) to 1 (right). 0 is centred.' },
      y: { type: 'number', description: 'Vertical framing, -1 (top) to 1 (bottom). 0 is centred.' },
      ease_sec: { type: 'number', description: 'Ramp at each end in seconds. 0 is a hard cut to the new framing.' },
    },
    ['start_sec', 'end_sec'],
  ),
  tool(
    'update_push_in',
    'Change one push-in. Pass only the fields you want to change; get the id from list_push_ins.',
    {
      id: { type: 'string' },
      start_sec: { type: 'number' },
      end_sec: { type: 'number' },
      zoom: { type: 'number' },
      x: { type: 'number' },
      y: { type: 'number' },
      ease_sec: { type: 'number' },
    },
    ['id'],
  ),
  tool('remove_push_in', 'Remove a push-in by id.', { id: { type: 'string' } }, ['id']),

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
  tool(
    'set_music_options',
    'How the bed sits under the video: whether it loops, how long it plays, or fitted to the finished video in one move. Volume is set with set_music_volume.',
    {
      loop: { type: 'boolean', description: 'Repeat the track to fill the program.' },
      duration_sec: { type: ['number', 'null'], description: 'How long the bed plays. null plays it for the whole program.' },
      fit_to_video: { type: 'boolean', description: 'One move: run the bed for exactly the length of the finished edit.' },
    },
  ),

  // ── images over the picture (B-roll) ───────────────────────────────────────
  //
  // The tool the user reaches for by saying "show a picture of a robot when I
  // say robot". Deliberately ONE call for the whole gesture: the model should
  // not have to search, then place, then time, then set a transition — every
  // one of those is a round trip where it can pick something worse than the
  // default, and the timing default is a real rule (see suggestWindow) rather
  // than a guess it should be re-deriving.
  tool(
    'add_image_at_words',
    'Show an image over the video while a word or phrase is spoken — a B-roll cutaway. Give a phrase from the transcript to place it on, plus EITHER a description of the picture to GENERATE, or the id of an image already in the project (from list_images). The picture is generated at this video\'s own aspect ratio. The duration is chosen for you from the words you target and is always long enough to read; pass duration_sec only if the user asked for a specific length. Returns the overlay id.',
    {
      query: { type: 'string', description: 'What picture to generate, e.g. "a friendly robot waving". Omit when using image_id.' },
      image_id: { type: 'string', description: 'An image already imported into this project. Omit when using query.' },
      phrase: {
        type: 'string',
        description:
          'The word or phrase in the transcript to show the image on. The image appears as that word is said.',
      },
      occurrence: {
        type: 'string',
        enum: ['first', 'all'],
        description: 'Place on the first match or on every match of the phrase. Default "first".',
      },
      duration_sec: {
        type: 'number',
        description: 'Only if the user asked for a specific length. Otherwise leave it out and a sensible one is chosen.',
      },
      transition: {
        type: 'string',
        enum: ['cut', 'fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down'],
        description: 'How it arrives and leaves. Default "fade" — a smooth dissolve. "cut" is a hard switch.',
      },
      size: {
        type: 'string',
        enum: ['full', 'corner'],
        description:
          'Default "full": the image fills the frame, which is the usual cutaway. "corner" is a small picture-in-picture card that leaves the speaker visible.',
      },
    },
    ['phrase'],
  ),
  tool(
    'list_images',
    'List the images placed over this project — each one\'s id, which words it plays on, how long it lasts and its transition. Also lists any imported pictures not currently placed.',
  ),
  tool(
    'update_image',
    'Change one placed image: its timing, transition, size, or opacity. Get the id from list_images.',
    {
      id: { type: 'string' },
      start_sec: { type: 'number' },
      end_sec: { type: 'number' },
      transition: {
        type: 'string',
        enum: ['cut', 'fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down'],
      },
      ease_sec: { type: 'number', description: 'Length of the transition at each end, in seconds.' },
      size: { type: 'string', enum: ['full', 'corner'] },
      opacity: { type: 'number', description: '0 to 1. 1 is fully opaque.' },
    },
    ['id'],
  ),
  tool('remove_image', 'Remove a placed image from the video. The picture stays in the project.', {
    id: { type: 'string' },
  }, ['id']),

  // ── clips: the source files behind the timeline ────────────────────────────
  tool(
    'list_clips',
    'List the source clips in play order — id, name, where each starts on the timeline and how long it runs. A project is one clip until footage is added or a clip is split.',
  ),
  tool(
    'split_clip',
    'Cut a clip in two at a time on the timeline, making two independent clips that can be reordered or removed. Non-destructive: the halves share one file. Use split_at_playhead instead when the user means "here".',
    { at_sec: { type: 'number', description: 'Timeline seconds — the same clock as the playhead.' } },
    ['at_sec'],
  ),
  tool(
    'move_clip',
    'Move one clip one place earlier or later in play order. For a wholesale re-sequence use reorder_clips.',
    { clip_id: { type: 'string' }, direction: { type: 'string', enum: ['earlier', 'later'] } },
    ['clip_id', 'direction'],
  ),
  tool(
    'reorder_clips',
    'Set the whole play order at once. Pass every clip id from list_clips, in the order you want them.',
    { clip_ids: { type: 'array', items: { type: 'string' } } },
    ['clip_ids'],
  ),
  tool(
    'remove_clip',
    'Remove a clip and its words from the project. The last remaining clip cannot be removed. Undoable only by re-importing, so confirm with the user first.',
    { clip_id: { type: 'string' }, confirm: { type: 'boolean' } },
    ['clip_id', 'confirm'],
  ),

  // ── jobs & project management (async) ──────────────────────────────────────
  tool(
    'transcribe',
    'Transcribe the open project (a server job that can take a while). Required before any transcript editing if the project has no script yet. Options change how the script comes out — verbatim keeps the ums, diarize labels the speakers — and re-transcribing REPLACES the current script, so ask first if there are edits to lose.',
    {
      model: { type: 'string', description: 'An ASR model id from list_asr_models. Omit for the current one.' },
      language: { type: 'string', description: 'Language code, e.g. "en". Omit to auto-detect.' },
      diarize: { type: 'boolean', description: 'Label who is speaking.' },
      speakers: { type: 'integer', description: 'How many speakers to expect, when known.' },
      verbatim: { type: 'boolean', description: 'Keep filler words in the script. Off means the model drops them before you ever see them — so filler tools have nothing to cut.' },
    },
  ),
  tool('list_asr_models', 'List the transcription models this server can use, with their notes.'),
  tool(
    'job_status',
    'What the server is working on right now — transcription, render or filmstrip — and how far in it is.',
  ),
  tool('cancel_job', 'Stop the job that is currently running.'),
  tool(
    'export_captions',
    'Export a subtitle file timed to the current edit, and save it to the user\'s machine. A sidecar file, not burned-in captions — for that use set_captions.',
    { format: { type: 'string', enum: ['srt', 'vtt', 'ass'], description: 'Default "srt".' } },
  ),
  tool('list_fonts', 'List the caption fonts available — the three built-ins plus any the user has imported.'),
  tool(
    'custom_filler_words',
    'Read or change the user\'s own list of filler words, which remove_fillers and tag_fillers use on top of the built-in ones. Call with no arguments to just list them.',
    {
      add: { type: 'array', items: { type: 'string' }, description: 'Words to start treating as filler.' },
      remove: { type: 'array', items: { type: 'string' }, description: 'Words to stop treating as filler.' },
    },
  ),
  tool(
    'count_cleanup',
    'How much a cleanup would cut, WITHOUT cutting it — fillers and retakes, counted separately. Use before offering to clean up, so the offer is concrete.',
    {
      mode: { type: 'string', enum: ['hesitations', 'all'], description: 'Which fillers to count. Default "hesitations".' },
      min_words: { type: 'integer', description: 'Retake threshold. Default 2.' },
    },
  ),
  tool(
    'track_subject',
    'Make a push-in FOLLOW whoever is inside it, instead of holding one framing — the automatic "keep them in shot" move. Pass enable=false to drop the tracking and go back to the fixed framing.',
    { id: { type: 'string', description: 'The push-in id, from list_push_ins.' }, enable: { type: 'boolean', description: 'Default true.' } },
    ['id'],
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

  // ── improvising: the two tools that are not features of the app ────────────
  //
  // Everything above drives something the interface can also do. These two do
  // not, and they are why the assistant can attempt a request the product has no
  // button for. The model is told, in the brief below, to reach for them rather
  // than answer "the app can't do that" — so their descriptions are written to
  // be recognised from a user's words ("reverse it", "make a gif", "just the
  // audio") rather than from ffmpeg vocabulary.
  tool(
    'summon_media',
    'Bring a file in from the open web by URL — footage, a sound effect, a picture — and attach it to the project or hand it to the user. Use it when what they want is not in the library and not something the app can make: a specific clip they linked, an image from a page, a sound effect. For music prefer add_music (a searchable, licence-cleared library) and for B-roll prefer add_image_at_words.',
    {
      url: { type: 'string', description: 'A direct http(s) link to the file itself, not to a page about it.' },
      attach_as: {
        type: 'string',
        enum: ['clip', 'music', 'image', 'download'],
        description:
          '"clip" appends it to the timeline (video/audio, transcribed if the project is); "music" makes it the bed; "image" adds it to the B-roll library for add_image_at_words; "download" just saves it for the user. Default "clip".',
      },
      name: { type: 'string', description: 'What to call it. Defaults to the filename.' },
    },
    ['url'],
  ),
  tool(
    'run_media_op',
    `Do something to media that no other tool covers — the escape hatch. One ffmpeg pass over one input, producing one file.

Reach for this when the user asks for something real that the app has no feature for. Worked examples of the arguments:
- "make a gif of that bit" → source clip, start_sec/end_sec around the moment, format gif
- "just the audio as an mp3" → format mp3
- "play it backwards" → video_filters "reverse", audio_filters "areverse"
- "grab a still of that frame" → seek time in start_sec, format png
- "make it black and white and grainy" → video_filters "hue=s=0,noise=alls=8:allf=t"
- "put a title card on the front" → source url or file (an image), still_duration_sec 3, format mp4, then attach it as a clip and move it first
- "the audio is too quiet" → audio_filters "loudnorm" or "volume=6dB", format mp4

The result is a NEW file; it never overwrites the project. attach_as decides what becomes of it. Filters are ordinary ffmpeg chains and may not open inputs of their own.

Trim with start_sec/end_sec whenever the user means a moment rather than the whole thing: an untrimmed pass re-encodes the entire source, which on a long video will run past this machine's time limit and come back with nothing — and that machine may be a phone, where encoding is many times slower. Say what you are about to try before you try it, and report what actually came back.`,
    {
      purpose: { type: 'string', description: 'One plain sentence on what this is for — shown to the user beside the result.' },
      source: {
        type: 'string',
        enum: ['clip', 'music', 'url', 'file'],
        description: '"clip" is the project\'s footage (default), "music" the bed, "url" something on the web, "file" the output of an earlier run_media_op.',
      },
      clip_id: { type: 'string', description: 'Which clip, from list_clips. Defaults to the first.' },
      url: { type: 'string', description: 'For source "url".' },
      file: { type: 'string', description: 'For source "file": the URL a previous call returned.' },
      start_sec: { type: 'number', description: 'Where to start in the source. Omit for the beginning.' },
      end_sec: { type: 'number', description: 'Where to stop. Omit to run to the end.' },
      video_filters: { type: 'string', description: 'An ffmpeg video filter chain, e.g. "reverse", "hue=s=0", "scale=640:-2,fps=12".' },
      audio_filters: { type: 'string', description: 'An ffmpeg audio filter chain, e.g. "areverse", "loudnorm", "atempo=1.5".' },
      format: { type: 'string', enum: ['mp4', 'webm', 'gif', 'mp3', 'wav', 'png', 'jpg'], description: 'Default "mp4".' },
      still_duration_sec: { type: 'number', description: 'When the input is a still image: how many seconds of video to make from it.' },
      attach_as: {
        type: 'string',
        enum: ['clip', 'music', 'image', 'download', 'keep'],
        description: '"keep" (default) leaves the file for a later call to build on; "download" saves it for the user; the rest attach it to the project.',
      },
    },
    ['purpose'],
  ),
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
- When the request is about WHAT WAS SAID — summarise it, tighten the intro, find a pull-quote, is this any good — read_transcript first. Never answer from the stats alone, and never invent lines you have not read.
- You can take edits back: undo (and redo) drive the same history as the user's Ctrl+Z. If an edit of yours overshot, undo it rather than trying to patch around it.
- Push-ins and split_at_playhead work on SOURCE seconds, the same clock find_in_transcript and the playhead report — so find the words first, then aim at their times.
- To illustrate the video with a picture — "show a robot when I say robot", "add some B-roll here" — use add_image_at_words. Give it the PHRASE, not a time: it finds the words and works out the timing itself, always long enough to actually read. Do not compute a duration unless the user named one, and do not call find_in_transcript first — this tool does its own matching.
- Default to a "fade" transition and "full" size; those are what a cutaway normally looks like. Reach for "corner" when the speaker should stay visible, and for a slide only when the user asks for movement.
- An image cannot be placed on words that are currently cut, because they are not in the output. If the user asks for one there, tell them the words are deleted and offer to restore them.
- Three actions are irreversible or expensive and need explicit user agreement in the conversation before you pass confirm=true: delete_project, remove_clip and export_video. Never confirm these on your own initiative.
- Speed is 0.5–2. Pause cap is in milliseconds (or null to keep all pauses). Frame presets: source, reel (9:16), youtube (16:9), square, custom. Colour looks: none, warm, cool, vintage, mono, punch, faded, noir — and set_color_knobs for anything they do not name.
- After acting, reply briefly and concretely about what changed (counts, new settings). Keep answers short — a sentence or two. If a tool reports an error, tell the user plainly and suggest the fix.

When there is no tool for what they asked:
- Try anyway. "The app can't do that" is almost always the wrong answer, and it is the one thing you should be slow to say. Work down this ladder before you say anything is impossible.
- 1. COMPOSE. Most requests that sound like missing features are two or three tools in a row. "Make me a 30-second teaser" is read_transcript, delete the rest, set_frame reel, export_video. "Make the intro punchier" is read it, cut the throat-clearing, cap the pauses, maybe speed 1.1. Plan the sequence, then run it.
- 2. IMPROVISE with run_media_op — one ffmpeg pass over the project's own media. Reversal, gifs, stills, audio-only extracts, loudness, grain, blur, chroma key, a title card from an image, a freeze frame: none of these are features of this app and all of them are one filter chain. Give the filters yourself; you know ffmpeg.
- 3. FETCH with summon_media when the missing thing is a file rather than an operation — a clip they linked, a sound effect, a picture from a page.
- Say what you are about to try in one short line before a summon or an op, because these take a few seconds and can fail in ways the tidy tools cannot. Then report what actually came back: the length, the size, where it went. If it failed, say what failed and try a different chain rather than going quiet.
- Do not invent a capability that produces nothing. You have no text-to-speech, no image generation, no music generation, no translation of the audio itself, and you cannot upload anywhere. For those, say plainly what is missing and offer the nearest real thing you CAN do.`;
