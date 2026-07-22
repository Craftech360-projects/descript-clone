import type { Project, RenderResult } from './api.ts';

/**
 * Getting the finished file out of the app.
 *
 * A render that lands in a folder you did not choose, under a name you did not
 * pick, has not really been delivered. The server names its output
 * `<projectId>-<epoch>.mp4` because that is what a content-addressed cache
 * wants; nobody wants that in their Videos folder. So the download attribute
 * carries a human name, and the desktop shell turns the click into a real
 * Save dialog (see the desktop shell's main.cjs).
 */

/** "interview-final.mov" → "interview-final (edited).mp4" */
export function renderFilename(project: Project, result: RenderResult): string {
  const base = project.name.replace(/\.[^.]+$/, '') || 'render';
  // Trust the URL, not hasVideo: the server picks .m4a for audio-only projects
  // and it is the one that knows what it actually wrote.
  const ext = result.url.match(/\.[a-z0-9]+$/i)?.[0] ?? '.mp4';
  return `${base} (edited)${ext}`;
}

/**
 * Hand a URL to the browser as a save.
 *
 * Appended to the document before clicking: a detached anchor works in Chrome
 * but not everywhere, and this costs one node for the length of a call.
 */
export function saveAs(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
