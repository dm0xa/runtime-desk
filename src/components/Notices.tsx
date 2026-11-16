import { useState } from "react";
import { CheckIcon, InfoIcon, TriangleAlertIcon } from "./icons";

export type NoticeKind = "error" | "success" | "info";

export type Notice = {
  id: number;
  kind: NoticeKind;
  title: string;
  detail?: string;
  /** The CLI's own output. Collapsed behind "Show details"; never the headline. */
  evidence?: string;
  /** Docker container this notice is about, so related actions can clear it. */
  containerId?: string;
  actions?: { label: string; run: () => void }[];
};

const KIND_ICON = { error: TriangleAlertIcon, success: CheckIcon, info: InfoIcon } as const;

/** Prose longer than this is collapsed; evidence always starts collapsed. */
const COLLAPSE_OVER = 140;

export function Notices({ notices, onDismiss }: {
  notices: Notice[];
  onDismiss: (id: number) => void;
}) {
  if (notices.length === 0) return null;
  return (
    <div className="notices">
      {notices.map((n) => <NoticeCard key={n.id} notice={n} onDismiss={onDismiss} />)}
    </div>
  );
}

function NoticeCard({ notice: n, onDismiss }: {
  notice: Notice;
  onDismiss: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const Icon = KIND_ICON[n.kind];
  const detail = n.detail ?? "";
  const evidence = n.evidence ?? "";
  const long = detail.length > COLLAPSE_OVER || detail.includes("\n");
  const hasActions = !!n.actions?.length;
  const showToggle = long || !!evidence;

  return (
    <div className={`notice-card ${n.kind}`} role={n.kind === "error" ? "alert" : "status"}>
      <span className="notice-icon" aria-hidden="true"><Icon size={15} /></span>
      <div className="notice-body">
        <div className="notice-title">{n.title}</div>
        {detail && (
          <div className={long && !open ? "notice-detail clamped" : "notice-detail"}>{detail}</div>
        )}
        {open && evidence && (
          <div className="notice-evidence"><pre>{evidence}</pre></div>
        )}
        {(showToggle || hasActions) && (
          <div className="notice-foot">
            {showToggle && (
              <button className="notice-link" onClick={() => setOpen(!open)} aria-expanded={open}>
                {open ? "Hide details" : "Show details"}
              </button>
            )}
            {open && evidence && (
              <button className="notice-link" onClick={() => void navigator.clipboard?.writeText(evidence)}>Copy</button>
            )}
            {n.actions?.map((a) => (
              <button key={a.label} className="btn ghost" onClick={a.run}>{a.label}</button>
            ))}
          </div>
        )}
      </div>
      <button className="notice-close" aria-label="Dismiss" title="Dismiss" onClick={() => onDismiss(n.id)}>×</button>
    </div>
  );
}
