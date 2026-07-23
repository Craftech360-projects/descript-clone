import { forwardRef, type ReactNode } from 'react';
import { clipsOf, type Clip, type Project, type RenderResult } from '../api.ts';
import { renderFilename } from '../download.ts';

interface Props {
  project: Project | null;
  /** The clip the monitor is showing. Playback swaps this as the playhead crosses
   *  a seam; for a single-source project it is the one clip. */
  activeClip?: Clip | null;
  result: RenderResult | null;
  onTimeUpdate: () => void;
  onPlay: () => void;
  onPause: () => void;
  /** Drawn over the picture. The monitor stays ignorant of what it is. */
  overlay?: ReactNode;
}

/**
 * The program monitor.
 *
 * The script keeps primacy — but primacy comes from the caret, not from area.
 * The script is the only surface with a cursor, the only one that takes keyboard
 * focus, the only one that mutates the document; the monitor is a read-only
 * viewport onto a derived artifact. So it can have real presence without
 * dethroning anything.
 *
 * The layout makes this free: the script has max-width 640px, so past that it
 * cannot use more pixels. Surplus width flows here by construction, and the
 * monitor grows at zero cost to the page.
 *
 * Still no native `controls` — the transport in the dock is the only transport,
 * and it survives the monitor being hidden.
 */
const Monitor = forwardRef<HTMLVideoElement, Props>(function Monitor(
  { project, activeClip, result, onTimeUpdate, onPlay, onPause, overlay },
  ref,
) {
  // The clip the monitor is showing. Playback drives it by playhead via
  // `activeClip`; falling back to the first clip covers the initial render before
  // the active clip is set and the single-source case.
  const clip = activeClip ?? (project ? clipsOf(project)[0] : null);

  return (
    <div className="monitor">
      <div className="stage">
        {project && clip ? (
          <>
            <video
              ref={ref}
              src={clip.sourceUrl}
              onTimeUpdate={onTimeUpdate}
              onPlay={onPlay}
              onPause={onPause}
            />
            {overlay}
          </>
        ) : (
          <div className="stage-empty">
            <span>No media</span>
          </div>
        )}
      </div>

      <div className="stage-meta">
        {project && (
          <span className="dims">
            {project.hasVideo ? `${project.width}×${project.height}` : 'Audio only'}
            {project.fps ? ` · ${formatFps(project.fps)}` : ''}
          </span>
        )}
        {/* The save already happened when the render finished. This is here for
          * the second copy, or for a cancelled Save dialog. */}
        {project && result && (
          <a href={result.url} download={renderFilename(project, result)} className="dl">
            Save render again
          </a>
        )}
      </div>
    </div>
  );
});

/** 59.94, not 59.940000000000005. */
function formatFps(fps: number): string {
  const rounded = Math.round(fps * 100) / 100;
  return `${rounded} fps`;
}

export default Monitor;
