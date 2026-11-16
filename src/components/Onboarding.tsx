import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SystemStatus } from "../types";
import { TOOLS, type ToolKey } from "../dependencies";
import { useModalFocus } from "../lib/modalFocus";
import { RefreshIcon } from "./RefreshIcon";

const STEPS = ["Welcome", "Tools"];
const REQUIRED: ToolKey[] = ["colima", "docker"];

/** The headline names the CLIs the app reads. Every entry is a runtime it actually
 *  talks to (Colima profile runtime, Docker daemon, Podman machine, containerd through
 *  colima's nerdctl wrapper, kubectl for the k3s cluster inside a profile) — do not add a
 *  tool the app never runs. */
const ROTOR = ["Colima", "Docker", "Podman", "kubectl", "containerd"];
const ROTOR_MS = 2200;

const ICON = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

/** One inline slot that crossfades through `words` in random order. The slot is measured
 *  once (inline probes: an inline box is exactly as wide as its text in every engine, no
 *  intrinsic-sizing keyword needed) and then animates to the incoming word's width — the
 *  sentence around it slides instead of jumping, and no word leaves a hole behind. */
function RotatingWord({ words }: { words: string[] }) {
  const [at, setAt] = useState(() => Math.floor(Math.random() * words.length));
  const [from, setFrom] = useState<number | null>(null);
  const [widths, setWidths] = useState<number[]>([]);
  const atRef = useRef(at);
  const beforeRef = useRef<number | null>(null);
  const probeRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const [still, setStill] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  useLayoutEffect(() => {
    setWidths(probeRefs.current.map((el) => el?.getBoundingClientRect().width ?? 0));
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setStill(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (still || words.length < 2) return;
    const id = window.setInterval(() => {
      // A background window has no viewer; don't animate it.
      if (document.hidden) return;
      const prev = atRef.current;
      // Two guardrails: never repeat the word on screen, and never bounce straight back
      // to the one before it (Docker → Podman → Docker is a metronome, not a rotation).
      // With fewer than three words the second rule is unsatisfiable, so it is dropped.
      const avoid = words.length >= 3 ? beforeRef.current : null;
      let next = prev;
      while (next === prev || next === avoid) next = Math.floor(Math.random() * words.length);
      beforeRef.current = prev;
      atRef.current = next;
      setFrom(prev);
      setAt(next);
    }, ROTOR_MS);
    return () => window.clearInterval(id);
  }, [still, words.length]);

  const width = widths[at];

  return (
    <span
      className="onboarding-rotor"
      role="img"
      aria-label={words.join(", ")}
      style={width ? { width: `${width}px` } : undefined}
    >
      <span className="onboarding-rotor-ghost" aria-hidden="true">{words[at]}</span>
      <span className="onboarding-rotor-probes" aria-hidden="true">
        {words.map((word, i) => (
          <span key={word} ref={(el) => { probeRefs.current[i] = el; }} className="onboarding-rotor-probe">{word}</span>
        ))}
      </span>
      {words.map((word, i) => (
        <span
          key={word}
          className="onboarding-rotor-word"
          aria-hidden="true"
          data-live={i === at ? "true" : undefined}
          data-leaving={i === from ? "true" : undefined}
        >
          {word}
        </span>
      ))}
    </span>
  );
}

const SURFACES = [
  {
    title: "Dashboard",
    text: "VM counts, engine totals and per-container CPU. Updates arrive from the runtime's event stream, so the numbers move when something changes.",
    icon: <svg {...ICON}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>,
  },
  {
    title: "Docker",
    text: "Containers, images, volumes and networks — with used-by links, a topology map, logs and live stats.",
    icon: <svg {...ICON}><path d="M21 8l-9-5-9 5 9 5 9-5Z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></svg>,
  },
  {
    title: "Podman",
    text: "Podman machines and their containers, images and volumes — listed and controlled separately from Colima profiles.",
    icon: <svg {...ICON}><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M9 9h6v6H9z" /></svg>,
  },
  {
    title: "Kubernetes",
    text: "The single-node k3s Colima runs inside the VM: nodes, pods, workloads and services per profile, read through kubectl.",
    icon: <svg {...ICON}><path d="M12 2.6l8.1 4.7v9.4L12 21.4 3.9 16.7V7.3L12 2.6Z" /><circle cx="12" cy="12" r="2.6" /></svg>,
  },
  {
    title: "Machine",
    text: "The Linux VM itself: runtime, sockets, kernel and load, guest memory, disk and OOM kills, plus other Lima VMs.",
    icon: <svg {...ICON}><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><path d="M7 7h.01M7 17h.01" /></svg>,
  },
];

export function Onboarding({ tools, onRecheck, onFinish, onSkip }: {
  tools: SystemStatus | null;
  onRecheck: () => void;
  onFinish: () => void;
  onSkip: () => void;
}) {
  const [step, setStep] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  // No Esc handler on purpose: dismissing first run is the Skip setup button's job, not
  // a keystroke the user can hit by reflex.
  useModalFocus(ref);
  // Continue is disabled while the tool probe is in flight, so the hook parks focus on the
  // dialog. Hand it to the primary action the moment that action exists.
  useEffect(() => {
    const node = ref.current;
    if (!node || document.activeElement !== node) return;
    node.querySelector<HTMLElement>("[data-autofocus]:not([disabled])")?.focus();
  }, [tools, step]);
  const keys = Object.keys(TOOLS) as ToolKey[];
  const installed = tools ? keys.filter((k) => tools[k]) : [];
  const coreReady = !!tools?.colima && !!tools?.docker;

  return (
    <div className="onboarding-backdrop">
      <div className="onboarding" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="First-time setup">
        <div className="onboarding-top">
          <div className="onboarding-brand">
            <img src="/logo.png" alt="" width={22} height={22} />
            Runtime Desk
          </div>
          <div className="onboarding-step">Step {step + 1} of {STEPS.length} · {STEPS[step]}</div>
        </div>
        <div className="onboarding-progress"><span style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} /></div>

        <div className="onboarding-body">
          {step === 0 && (
            <div className="onboarding-welcome">
              <h2>Everything <RotatingWord words={ROTOR} /> runs, in one window.</h2>
              <p className="onboarding-lead">
                Your containers run inside a Linux VM. Runtime Desk reads the container
                command-line tools already on this machine — <code>colima</code>, <code>docker</code>,{" "}
                <code>podman</code>, <code>nerdctl</code> — and shows what they report. Nothing is
                installed or changed.
              </p>
              <ul className="onboarding-surfaces">
                {SURFACES.map((s) => (
                  <li key={s.title}>
                    <span className="onboarding-surface-icon">{s.icon}</span>
                    <span>
                      <strong>{s.title}</strong>
                      <span className="onboarding-surface-text">{s.text}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="onboarding-note">Next: what is installed, and what each tool adds.</p>
            </div>
          )}

          {step === 1 && (
            <>
              <div className="onboarding-head">
                <div>
                  <h2>{tools ? `${installed.length} of ${keys.length} tools detected` : "Checking your machine…"}</h2>
                  <p className="onboarding-lead">Required tools unlock whole sections; optional ones add detail.</p>
                </div>
                <button className="icon-plain" onClick={onRecheck} disabled={!tools} aria-label="Recheck installed tools" title="Recheck installed tools">
                  <RefreshIcon />
                </button>
              </div>
              <ul className="onboarding-tools">
                {[
                  { title: "Required for most views", keys: REQUIRED },
                  ...(["Runtimes", "Kubernetes", "AI", "VMs"] as const).map((title) => ({
                    title,
                    keys: keys.filter((k) => !REQUIRED.includes(k) && TOOLS[k].group === title),
                  })),
                ]
                  .filter((group) => group.keys.length > 0)
                  .map((group) => (
                    <Fragment key={group.title}>
                      <li className="onboarding-group">{group.title === "Required for most views" ? "Required" : `${group.title} · optional`}</li>
                      {group.keys.map((key) => {
                        const ok = tools?.[key] ?? false;
                        const info = TOOLS[key];
                        return (
                          <li key={key} className={ok ? "ok" : "missing"}>
                            <span className={`tool-pill ${ok ? "on" : "off"}`}><span className="tool-dot" />{ok ? "ready" : "missing"}</span>
                            <div className="onboarding-tool-text">
                              <div className="onboarding-tool-name">{info.label}</div>
                              <div className="onboarding-tool-why">{info.why}</div>
                              <div className="onboarding-tool-unlocks"><span className="onboarding-unlock-k">In app</span> {info.unlocks}</div>
                              {!ok && (
                                <div className="onboarding-install">
                                  <code title={info.install}>{info.install}</code>
                                  <button className="btn ghost" onClick={() => navigator.clipboard?.writeText(info.install)}>Copy</button>
                                </div>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </Fragment>
                  ))}
              </ul>
              {tools && !coreReady && (
                <p className="onboarding-warn">
                  Colima or Docker is missing — the views that read them stay empty until one is installed.
                </p>
              )}
              <p className="onboarding-note">Reopen this any time from Settings → General → Run setup again.</p>
            </>
          )}
        </div>

        <div className="onboarding-actions">
          <button className="onboarding-skip" onClick={onSkip}>Skip setup</button>
          <div className="onboarding-actions-right">
            {step > 0 && <button className="btn ghost" onClick={() => setStep(step - 1)}>Back</button>}
            {step === 0
              ? <button className="btn primary" data-autofocus onClick={() => setStep(1)} disabled={!tools}>Continue</button>
              : <button className="btn primary" data-autofocus onClick={onFinish} title={coreReady ? undefined : "Colima or Docker is missing"}>Open Dashboard</button>}
          </div>
        </div>
      </div>
    </div>
  );
}
