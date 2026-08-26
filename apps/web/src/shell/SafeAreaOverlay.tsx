import { insetsFor, PLATFORM_GUIDES, type Platform } from '../../../../packages/core/src/safe-area.ts';

/**
 * Where the platform will draw its own interface over your reel.
 *
 * A preview aid and nothing else: it is never burned in, never reaches the
 * render, and changes no pixel of the output. It exists because you cannot
 * compose around furniture you cannot see — this app's own caption default sits
 * at y=0.85, which on Instagram is underneath their caption bar, and the only
 * way to discover that today is to post it.
 *
 * Drawn as four dimmed bands rather than one outlined rectangle. An outline says
 * "here is a box"; shading says "do not put anything here", which is the actual
 * instruction. The safe middle stays completely untouched so the picture is
 * still judged on its own.
 */
export default function SafeAreaOverlay({ platform }: { platform: Platform | 'off' }) {
  if (platform === 'off') return null;

  const i = insetsFor(platform as Platform);
  const guide = PLATFORM_GUIDES.find((g) => g.id === platform);
  const pct = (n: number) => `${n * 100}%`;

  return (
    <div className="safe-layer" aria-hidden="true">
      <div className="safe-band" style={{ top: 0, left: 0, right: 0, height: pct(i.top) }} />
      <div className="safe-band" style={{ bottom: 0, left: 0, right: 0, height: pct(i.bottom) }} />
      <div
        className="safe-band"
        style={{ top: pct(i.top), bottom: pct(i.bottom), left: 0, width: pct(i.left) }}
      />
      <div
        className="safe-band"
        style={{ top: pct(i.top), bottom: pct(i.bottom), right: 0, width: pct(i.right) }}
      />
      {/* A hairline on the safe edge, so the boundary is readable even where the
          picture underneath is already dark. */}
      <div
        className="safe-box"
        style={{
          top: pct(i.top),
          bottom: pct(i.bottom),
          left: pct(i.left),
          right: pct(i.right),
        }}
      />
      {guide && <span className="safe-tag">{guide.label}</span>}
    </div>
  );
}
