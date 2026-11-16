import type { Container, Image } from "../types";

export type Problem = {
  title: string;
  detail?: string;
  /** The CLI's own output, shown only when the user asks for it. */
  evidence?: string;
  /** Container the problem refers to, when Docker named one. */
  containerId?: string;
};

const stripPrefix = (raw: string) => raw.replace(/^Error response from daemon:\s*/i, "").replace(/^Error:\s*/i, "").trim();

function containerName(id: string, containers: Container[]) {
  const hit = containers.find((c) => id.startsWith(c.id) || c.id.startsWith(startOf(id)));
  return hit?.name ?? id.slice(0, 12);
}

const startOf = (id: string) => id.slice(0, 12);

/** The sentence is the message; the CLI text is evidence, so it never crowds the message
 *  out. Kept whenever the raw output says more than the sentence does. */
function withEvidence(problem: Problem, msg: string): Problem {
  const worthKeeping = msg !== problem.detail && (/permission denied|operation not permitted/i.test(msg) || msg.includes("\n") || msg.length > 140);
  return worthKeeping ? { ...problem, evidence: msg } : problem;
}

/**
 * Turns Docker/Colima/Podman CLI output into something a person can act on.
 * Every branch states what the CLI proved, not what it usually means: a "permission
 * denied" line is only the socket's fault when the socket is what it names.
 */
export function humanizeDockerError(raw: string, images: Image[], containers: Container[]): Problem {
  const msg = stripPrefix(raw);

  const inUse = msg.match(/unable to delete ([0-9a-f]{6,})[^(]*\(cannot be forced\)\s*-\s*image is being used by (?:running )?container ([0-9a-f]{6,})/i);
  if (inUse) {
    // The image list may itself have failed, in which case there is no repo:tag to quote
    // and the sentence must not fall back to a bare hex id.
    const hit = images.find((i) => inUse[1].startsWith(i.id) || i.id.startsWith(inUse[1]));
    const label = hit && hit.repository !== "<none>" ? `${hit.repository}:${hit.tag}` : null;
    return withEvidence({
      title: label ? `Image ${label} is in use` : "An image is still in use",
      detail: `Container ${containerName(inUse[2], containers)} still uses image ${startOf(inUse[1])}. Stop or remove that container first.`,
      containerId: inUse[2],
    }, msg);
  }

  const running = msg.match(/cannot remove a running container ([0-9a-f]{6,})/i) ?? msg.match(/container ([0-9a-f]{6,}) is running/i);
  if (running) {
    return withEvidence({
      title: `Container ${containerName(running[1], containers)} is running`,
      detail: "Stop it before removing.",
      containerId: running[1],
    }, msg);
  }

  // A missing socket file is a stopped profile, not a permission problem: docker prints
  // "permission denied while trying to connect ... connect: no such file or directory" for
  // both, and matching on "permission denied" alone diagnoses the wrong one.
  if (/dial unix [^\s]*\.sock: connect: no such file or directory|no such file or directory[^\n]*\.sock/i.test(msg)) {
    return withEvidence({ title: "The container socket is not there", detail: "The selected profile is not running, or its socket moved. Start the profile, then retry." }, msg);
  }
  if (/cannot connect to the docker daemon/i.test(msg)) {
    return withEvidence({ title: "Docker daemon is not reachable", detail: "Start the selected profile, then retry." }, msg);
  }
  if (/permission denied|operation not permitted/i.test(msg)) {
    // Quote whatever the CLI actually tried to touch: the socket, a volume's backing
    // directory, a bind mount. Guessing "the socket" turns one denial into the wrong one.
    const target = /(?:permission denied|operation not permitted)[^\n]*?((?:\/|unix:\/\/|~\/)[^\s"',]+)/i.exec(msg)?.[1]?.replace(/[:.,;]+$/, "");
    return withEvidence({ title: "Permission denied", detail: target ? `The container CLI was denied access to ${target}.` : undefined }, msg);
  }
  if (/no such (container|image|volume|network|object)/i.test(msg)) {
    return withEvidence({ title: "Already gone", detail: msg }, msg);
  }
  if (/address already in use/i.test(msg)) {
    return withEvidence({ title: "Port already in use", detail: msg }, msg);
  }

  const lines = msg.split("\n").map((l) => l.trim()).filter(Boolean);
  const first = lines.find((l) => !/^unknown error$/i.test(l)) ?? lines[0];
  const rest = lines.filter((l) => l !== first);
  return withEvidence({ title: (first ?? "Command failed").slice(0, 120), detail: rest.length ? rest.join("\n") : undefined }, msg);
}

/**
 * Turns Podman's stderr into the same sentence+evidence shape. Podman prints a paragraph of
 * advice ("Cannot connect to Podman … try podman machine init …") and *then* the failure it
 * actually hit, so the headline comes from the dial result, never from the advice.
 */
export function humanizePodmanError(raw: string): Problem {
  const msg = stripPrefix(raw);

  // "… dial tcp 127.0.0.1:54379: connect: connection refused"
  const dial = /dial (tcp|unix) (\S+?):\s*(?:connect:\s*)?(connection refused|no such file or directory|permission denied|operation not permitted)/i.exec(msg);
  if (dial) {
    const [, net, address, why] = dial;
    const refused = /refused/i.test(why);
    return withEvidence({
      title: refused ? "Nothing is listening for Podman" : "The Podman socket is missing",
      detail: refused
        ? `The CLI dialled ${address} over ${net === "unix" ? "a unix socket" : "tcp"} and the connection was refused, so no machine is serving it. Start a Podman machine, then retry.`
        : `The CLI expected a socket at ${address} and found no file. Start a Podman machine, then retry.`,
    }, msg);
  }

  if (/cannot connect to podman|unable to connect to podman/i.test(msg)) {
    return withEvidence({
      title: "Podman is not reachable",
      detail: "No Podman machine is running, or its socket moved. Start a machine under Podman → Machines, then retry.",
    }, msg);
  }

  // Spawning the binary is the only thing that reports this: the CLI never runs to speak.
  if (/os error 2\b|No such file or directory$/i.test(msg) && !msg.includes("/")) {
    return withEvidence({
      title: "The podman CLI is not installed",
      detail: "Runtime Desk could not find podman on PATH. Install it with brew install podman, then retry.",
    }, msg);
  }

  if (/no such (container|image|volume|network|machine)|image not known|container not found/i.test(msg)) {
    return withEvidence({ title: "Already gone", detail: msg }, msg);
  }
  if (/address already in use/i.test(msg)) {
    return withEvidence({ title: "Port already in use", detail: msg }, msg);
  }
  if (/permission denied|operation not permitted/i.test(msg)) {
    const target = /(?:permission denied|operation not permitted)[^\n]*?((?:\/|~\/)[^\s"',]+)/i.exec(msg)?.[1]?.replace(/[:.,;]+$/, "");
    return withEvidence({ title: "Permission denied", detail: target ? `The container CLI was denied access to ${target}.` : undefined }, msg);
  }

  // Advice first, failure last: the trailing Error: line is what the command actually hit.
  const lines = msg.split("\n").map((l) => l.trim()).filter(Boolean);
  const failure = lines.filter((l) => !/^unknown error$/i.test(l));
  const first = [...failure].reverse().find((l) => /^error:/i.test(l)) ?? failure[0] ?? "podman failed";
  const rest = failure.filter((l) => l !== first);
  return withEvidence({ title: first.replace(/^error:\s*/i, "").slice(0, 120), detail: rest.length ? rest.join("\n") : undefined }, msg);
}
