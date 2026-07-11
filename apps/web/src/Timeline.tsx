import { useEffect, useRef } from 'react';
import type { Edl } from '../../../packages/core/src/types.ts';

interface Props {
  peaks: number[];
  duration: number;
  edl: Edl | null;
  currentTime: number;
  onSeek: (time: number) => void;
}

/**
 * The waveform, with cut material shown as removed.
 *
 * Descript keeps a timeline at the bottom but does not make you live in it — it
 * is for orienting and for precision work, while the script is where you edit.
 * The key thing it must show honestly is WHICH AUDIO SURVIVES: kept ranges are
 * bright, cut ranges are dimmed and struck. Anything else is decoration.
 */
export default function Timeline({ peaks, duration, edl, currentTime, onSeek }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || peaks.length === 0 || duration === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;

    canvas.width = width * dpr;
    canvas.height = height * dpr;

    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const mid = height / 2;
    const timeToX = (t: number) => (t / duration) * width;

    // Which x-columns survive the edit? Precompute so the draw loop stays cheap.
    const isKept = (t: number) => edl?.keep.some((r) => t >= r.start && t < r.end) ?? true;

    for (let x = 0; x < width; x++) {
      const t = (x / width) * duration;
      const peakIndex = Math.floor((x / width) * peaks.length);
      const amp = peaks[peakIndex] ?? 0;
      const h = Math.max(1, amp * (height - 8));

      ctx.fillStyle = isKept(t) ? '#5b8cff' : '#2b3040';
      ctx.fillRect(x, mid - h / 2, 1, h);
    }

    // Cut regions get a strike line, so a removed pause reads as removed rather
    // than as quiet audio.
    if (edl) {
      ctx.strokeStyle = '#ff6b6b';
      ctx.lineWidth = 1;
      let cursor = 0;
      for (const r of edl.keep) {
        if (r.start > cursor) {
          ctx.beginPath();
          ctx.moveTo(timeToX(cursor), mid);
          ctx.lineTo(timeToX(r.start), mid);
          ctx.stroke();
        }
        cursor = r.end;
      }
      if (cursor < duration) {
        ctx.beginPath();
        ctx.moveTo(timeToX(cursor), mid);
        ctx.lineTo(timeToX(duration), mid);
        ctx.stroke();
      }
    }

    // Playhead.
    const px = timeToX(currentTime);
    ctx.fillStyle = '#fff';
    ctx.fillRect(px, 0, 1, height);
  }, [peaks, duration, edl, currentTime]);

  return (
    <canvas
      ref={canvasRef}
      className="timeline"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek(((e.clientX - rect.left) / rect.width) * duration);
      }}
    />
  );
}
