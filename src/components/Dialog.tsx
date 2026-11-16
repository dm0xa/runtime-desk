import { useRef, type ReactNode } from "react";
import { useModalFocus } from "../lib/modalFocus";

/**
 * Modal shell: labelled, focus-trapped, Esc-closable, and it restores focus on close.
 * The visual chrome stays with the caller so prune/logs keep their own headers.
 */
export function Dialog({ label, onClose, children, className = "", width }: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref, onClose);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={ref}
        className={`modal ${className}`.trim()}
        style={width ? { width } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
