/** Case-insensitive match highlighting for the Logs and Inspect windows: one
 *  tokenizer, so a hit looks the same in both sheets. */
export function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const needle = query.toLowerCase();
  const hay = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let at = 0;
  let hit = hay.indexOf(needle);
  while (hit >= 0) {
    if (hit > at) parts.push(text.slice(at, hit));
    parts.push(<mark key={hit} className="log-hit">{text.slice(hit, hit + query.length)}</mark>);
    at = hit + query.length;
    hit = hay.indexOf(needle, at);
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
