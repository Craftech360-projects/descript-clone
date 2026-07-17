import { forwardRef, type ReactNode } from 'react';
import type { Project, RenderResult } from '../api.ts';

interface Props {
  project: Project | null;
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
  { project, result, onTimeUpdate, onPlay, onPause, overlay },
  ref,
) {
  return (
    <div className="monitor">
      <div className="stage">
        {project ? (
          <>
            <video
              ref={ref}
              src={project.sourceUrl}
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
        {result && (
          <a href={result.url} download className="dl">
            Download render · {result.renderMs}ms
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
