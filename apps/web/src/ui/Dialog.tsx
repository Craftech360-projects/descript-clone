import { useEffect, useRef, type ReactNode } from 'react';
import Icon from './Icon.tsx';

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * A thin wrapper over the native <dialog>.
 *
 * showModal() gives focus trapping, focus restore on close, Escape-to-dismiss,
 * ::backdrop, the top layer, and inert background content — which is the entire
 * reason people reach for a dialog library. Forty lines, zero dependencies.
 */
export default function Dialog({ open, title, onClose, children, footer }: Props) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      // Escape fires `cancel`, which would close the element without telling
      // React — the two would then disagree about `open`.
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClose={onClose}
      // Clicking the backdrop hits the dialog element itself, never a child.
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      aria-label={title}
    >
      <div className="dl-head">
        <h2>{title}</h2>
        <button className="icon" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
      </div>

      <div className="dl-body">{children}</div>

      {footer && <div className="dl-foot">{footer}</div>}
    </dialog>
  );
}
