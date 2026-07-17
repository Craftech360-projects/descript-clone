interface Props {
  /** 0..1, or -1 for genuinely indeterminate. */
  progress: number;
  stage: string;
  onCancel?: () => void;
}

/**
 * A progress card.
 *
 * The -1 case is the point. Transcription is one blocking POST that reports
 * nothing until it returns, so during the remote leg there is no fraction to
 * show — and a bar that advances on a guess is worse than an honest
 * indeterminate one, because it teaches the user to distrust every bar you ever
 * show them. Render progress IS real (ffmpeg reports encoded time against a
 * length we know), so it gets a real bar.
 */
export default function Progress({ progress, stage, onCancel }: Props) {
  const determinate = progress >= 0;
  const percent = Math.round(progress * 100);

  return (
    <div className="progress">
      <div className="pg-head">
        <span className="pg-stage">{stage}</span>
        {determinate && <span className="pg-pct">{percent}%</span>}
      </div>

      <div
        className="pg-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        // Omitting valuenow is what tells a screen reader "indeterminate".
        aria-valuenow={determinate ? percent : undefined}
        aria-label={stage}
      >
        <div
          className={determinate ? 'pg-fill' : 'pg-fill indeterminate'}
          style={determinate ? { width: `${percent}%` } : undefined}
        />
      </div>

      {onCancel && (
        <button className="pg-cancel" onClick={onCancel}>Cancel</button>
      )}
    </div>
  );
}
