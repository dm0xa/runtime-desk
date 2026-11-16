import { useEffect, useState } from "react";
import { Dialog } from "./Dialog";
import { TagIcon } from "./icons";
import { addTag, removeTag, subscribeTags, tagsFor, type TagKind } from "../lib/tags";

/** Opens the local tag editor for one Podman object. */
export function TagButton({ kind, id, name }: { kind: TagKind; id: string; name: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="icon-btn" title="Edit tags" aria-label="Edit tags" onClick={() => setOpen(true)}>
        <TagIcon size={14} />
      </button>
      {open && <TagDialog kind={kind} id={id} name={name} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The editor itself, so a row menu or an expanded panel can open the same dialog without
 *  spending an icon in the actions cell. */
export function TagDialog({ kind, id, name, onClose }: { kind: TagKind; id: string; name: string; onClose: () => void }) {
  const [value, setValue] = useState("");
  const [, force] = useState(0);
  useEffect(() => subscribeTags(() => force((n) => n + 1)), []);
  const tags = tagsFor(kind, id);

  return (
    <Dialog label={`Tags for ${name}`} onClose={onClose}>
      <h2>Tags · {name}</h2>
      <div className="tag-row">
        {tags.map((tag) => (
          <span className="tag-chip" key={tag}>
            {tag}
            <button aria-label={`Remove tag ${tag}`} onClick={() => removeTag(kind, id, tag)}>×</button>
          </span>
        ))}
        <input
          className="tag-input"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          placeholder="add tag…"
          aria-label="Add tag"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) {
              e.preventDefault();
              addTag(kind, id, value);
              setValue("");
            }
          }}
        />
      </div>
      <div className="modal-actions"><button className="btn" onClick={onClose}>Done</button></div>
    </Dialog>
  );
}
