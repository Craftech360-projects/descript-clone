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
 * The Android shell's save bridge, when this is running inside it. Android
 * WebView silently drops `<a download>` clicks — there is no downloads shelf
 * and no dialog, the file just never appears — so the shell injects this
 * object (see desktop/android DownloadBridge.kt) and we hand it the save
 * instead. Feature-detected: absent everywhere but the Android app.
 */
declare global {
  interface Window {
    JumpCutAndroid?: {
      saveUrl(url: string, filename: string): void;
      saveText(content: string, filename: string, mime: string): void;
    };
  }
}

/**
 * Hand a URL to the browser as a save.
 *
 * Appended to the document before clicking: a detached anchor works in Chrome
 * but not everywhere, and this costs one node for the length of a call.
 */
export function saveAs(url: string, filename: string): void {
  if (window.JumpCutAndroid?.saveUrl) {
    window.JumpCutAndroid.saveUrl(url, filename);
    return;
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Save generated text (caption sidecars) as a file.
 *
 * Same fork as saveAs: the Android bridge takes the content directly — a
 * `createObjectURL` blob anchor is doubly dead in a WebView — and everywhere
 * else the blob+anchor dance still works, including the desktop shells.
 */
export function saveTextAs(content: string, filename: string, mime = 'text/plain'): void {
  if (window.JumpCutAndroid?.saveText) {
    window.JumpCutAndroid.saveText(content, filename, mime);
    return;
  }
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  saveAs(url, filename);
  URL.revokeObjectURL(url);
}
