import type { Container } from "../types";

export type Origin = "compose" | "docker";

export const originOf = (c: Container): Origin =>
  c.compose_project ? "compose" : "docker";

/** kubelet names every container it creates
 *  `k8s_<container>_<pod>_<namespace>_<pod uid>_<attempt>`, so a name that matches that shape
 *  was made by a cluster and not by `docker run --name k8s_…`. When Colima runs Kubernetes on
 *  the docker runtime (cri-dockerd) those containers are ordinary Docker containers, so the
 *  list needs a way to say where they came from. */
const KUBELET_NAME =
  /^k8s_[^_]+_.+_[^_]+_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_\d+$/;

export const isKubernetesName = (name: string): boolean => KUBELET_NAME.test(name);

export const isKubernetesContainer = (c: Container): boolean => isKubernetesName(c.name);

export function OriginBadge({ c }: { c: Container }) {
  const origin = originOf(c);
  if (origin === "compose") return <span className="origin compose" title={c.compose_project}>compose</span>;
  return <span className="origin docker">docker</span>;
}
