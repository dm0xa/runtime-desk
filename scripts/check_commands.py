#!/usr/bin/env python3
"""Command-surface check for the Tauri backend.

Two failures this catches that `tsc` and `cargo` cannot:

1. **Name parity** — an `invoke("<x>_cmd")` with no handler fails only at runtime, and a
   handler no UI reaches is dead code.
2. **Argument shape** — `invoke` is untyped, so `stop_cmd(profile: String)` called as
   `invoke("stop_cmd", { opts: { profile } })` compiles, type-checks, and is rejected by
   Tauri with "invalid args" on every click.

    python3 scripts/check_commands.py            # exit 1 on any problem
    python3 scripts/check_commands.py --json     # machine-readable
    python3 scripts/check_commands.py --self-test

Tauri v2 maps camelCase JS keys onto snake_case Rust parameters, so `memoryMb` satisfies
`memory_mb`; the comparison normalises both sides.

What it cannot see, and therefore lists instead of guessing: a command name held in a variable
(`invoke(target.cmd, …)`), and a payload that is a variable or contains a spread. Those lines are
printed as unchecked so a reviewer looks at them; they are not failures.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LIB = ROOT / "src-tauri/src/lib.rs"
SRC = ROOT / "src"

COMMAND_RE = re.compile(r"#\[tauri::command\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(", re.M)


def snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


# Parameters Tauri injects: the frontend cannot and must not pass them.
INJECTED = ("tauri::state", "state<", "apphandle", "window", "webview", "manager<", "ipc(")


def is_injected(ty: str) -> bool:
    low = ty.replace(" ", "").lower()
    return any(token in low for token in INJECTED)


def split_params(raw: str) -> list[tuple[str, str]]:
    """`profile: String, opts: StartOpts` → [(profile, String), (opts, StartOpts)]."""
    out: list[tuple[str, str]] = []
    depth = 0
    current: list[str] = []
    for ch in raw:
        if ch in "<([":
            depth += 1
        elif ch in ">)]":
            depth -= 1
        if ch == "," and depth == 0:
            out.append("".join(current))
            current = []
            continue
        current.append(ch)
    out.append("".join(current))
    params: list[tuple[str, str]] = []
    for part in out:
        part = part.strip()
        if not part:
            continue
        name, _, ty = part.partition(":")
        if is_injected(ty):
            continue
        params.append((snake(name.strip()), ty.strip()))
    return params


def rust_commands(text: str) -> dict[str, list[tuple[str, str]]]:
    commands: dict[str, list[tuple[str, str]]] = {}
    for match in COMMAND_RE.finditer(text):
        name = match.group(1)
        start = match.end()
        depth, i = 1, start
        while i < len(text) and depth:
            if text[i] == "(":
                depth += 1
            elif text[i] == ")":
                depth -= 1
            i += 1
        commands[name] = split_params(text[start:i - 1])
    return commands


def registered(commands: dict[str, list[tuple[str, str]]], text: str) -> set[str]:
    match = re.search(r"generate_handler!\[(.*?)\]", text, re.S)
    if not match:
        return set()
    names = {n.strip() for n in re.split(r"[,\s]+", match.group(1)) if n.strip()}
    return {n for n in names if n in commands}


def top_level_keys(obj: str) -> list[str] | None:
    """Keys of an object literal, or None when the payload is not a literal."""
    obj = obj.strip()
    if not obj.startswith("{"):
        return None
    keys: list[str] = []
    depth = 0
    quote: str | None = None
    i = 1
    expect_key = True
    while i < len(obj):
        ch = obj[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
            i += 1
            continue
        if ch in "\"'`":
            quote = ch
            i += 1
            continue
        if ch in "{[(":
            depth += 1
        elif ch in "}])":
            if depth == 0:
                break
            depth -= 1
        elif ch == "," and depth == 0:
            expect_key = True
        elif expect_key and depth == 0 and ch == "." and obj[i:i + 3] == "...":
            return None  # a spread can supply keys we cannot see: treat as dynamic
        elif expect_key and depth == 0 and (ch.isalnum() or ch in "_$"):
            m = re.match(r"[A-Za-z_$][\w$]*", obj[i:])
            if m:
                name = m.group(0)
                rest = obj[i + len(name):].lstrip()
                if rest.startswith(":"):
                    keys.append(snake(name))
                    expect_key = False
                elif rest[:1] in (",", "}"):
                    keys.append(name)  # shorthand: `{ id, action }` passes id and action
                    expect_key = False
                i += len(name)
                continue
        i += 1
    return keys


INVOKE_RE = re.compile(r"invoke\s*(?:<[^>]*>)?\s*\(\s*[\"'`]([a-z0-9_]+)[\"'`]")
# A command name held in a variable cannot be checked statically; it is listed, not guessed.
DYNAMIC_INVOKE_RE = re.compile(r"invoke\s*(?:<[^>]*>)?\s*\(\s*([A-Za-z_$][\w$.]*)")


def referenced_names(src: Path) -> dict[str, str]:
    """Every `"<name>_cmd"` literal, wherever it appears."""
    names: dict[str, str] = {}
    for path in sorted(list(src.rglob("*.ts")) + list(src.rglob("*.tsx"))):
        for match in re.finditer(r"\"([a-z0-9_]+_cmd)\"", path.read_text()):
            names.setdefault(match.group(1), str(path.relative_to(ROOT)))
    return names


def dynamic_sites(src: Path) -> list[str]:
    out: list[str] = []
    for path in sorted(list(src.rglob("*.ts")) + list(src.rglob("*.tsx"))):
        text = path.read_text()
        for match in DYNAMIC_INVOKE_RE.finditer(text):
            if match.group(1) in ("async", "await", "if", "function"):
                continue
            line = text.count("\n", 0, match.start()) + 1
            out.append(f"{path.relative_to(ROOT)}:{line} invoke({match.group(1)}…)")
    return out


def call_sites(src: Path) -> list[dict]:
    sites: list[dict] = []
    for path in sorted(list(src.rglob("*.ts")) + list(src.rglob("*.tsx"))):
        text = path.read_text()
        for match in INVOKE_RE.finditer(text):
            command = match.group(1)
            rest = text[match.end():]
            keys: list[str] | None = None
            dynamic = False
            stripped = rest.lstrip()
            if stripped.startswith(","):
                payload = stripped[1:].lstrip()
                if payload.startswith("{"):
                    depth, i, quote = 0, 0, None
                    while i < len(payload):
                        ch = payload[i]
                        if quote:
                            if ch == "\\":
                                i += 2
                                continue
                            if ch == quote:
                                quote = None
                        elif ch in "\"'`":
                            quote = ch
                        elif ch in "{([":
                            depth += 1
                        elif ch in "})]":
                            depth -= 1
                            if depth == 0:
                                break
                        i += 1
                    keys = top_level_keys(payload[: i + 1])
                    if keys is None:
                        dynamic = True
                elif payload and payload[0] not in ")":
                    dynamic = True
            line = text.count("\n", 0, match.start()) + 1
            sites.append({"file": str(path.relative_to(ROOT)), "line": line,
                          "command": command, "keys": keys, "dynamic": dynamic})
    return sites


def check(rust_text: str, sites: list[dict], referenced: dict[str, str] | None = None) -> dict:
    commands = rust_commands(rust_text)
    wired = registered(commands, rust_text)
    invoked = set(referenced) if referenced is not None else {site["command"] for site in sites}
    problems: list[dict] = []
    for name in sorted(invoked - set(commands)):
        where = [f"{s['file']}:{s['line']}" for s in sites if s["command"] == name][:3]
        if not where and referenced:
            where = [referenced[name]]
        problems.append({"kind": "unhandled", "command": name, "where": where})
    for name in sorted(set(commands) - wired):
        problems.append({"kind": "unregistered", "command": name, "where": []})
    for name in sorted(set(commands) - invoked):
        problems.append({"kind": "dead", "command": name, "where": []})
    for site in sites:
        params = commands.get(site["command"])
        if params is None or site["dynamic"]:
            continue
        expected = {p for p, _ in params}
        got = set(site["keys"] or [])
        missing = sorted(expected - got)
        unknown = sorted(got - expected)
        if missing or unknown:
            problems.append({"kind": "args", "command": site["command"],
                             "where": [f"{site['file']}:{site['line']}"],
                             "missing": missing, "unknown": unknown,
                             "expected": sorted(expected), "passed": sorted(got)})
    dynamic = [f"{s['file']}:{s['line']} {s['command']} (non-literal payload)" for s in sites if s["dynamic"]]
    return {"commands": len(commands), "invoked": len(invoked), "problems": problems, "dynamic": dynamic}


SELF_TEST_RUST = """
#[tauri::command]
async fn start_cmd(opts: StartOpts) -> R<String> { todo!() }

#[tauri::command]
async fn stateful_cmd(state: tauri::State<'_, Servers>) -> Vec<u8> { todo!() }

#[tauri::command]
async fn stop_cmd(profile: String) -> R<String> { todo!() }
"""

SELF_TEST_TS = [
    ('invoke("start_cmd", { opts: { profile: "x" } })', True),
    ('invoke("stop_cmd", { opts: { profile: "x" } })', False),
    ('invoke("stop_cmd", { profile: "x" })', True),
    ('invoke("gone_cmd", {})', False),
]


def self_test() -> int:
    failures = 0
    for source, should_pass in SELF_TEST_TS:
        fake = ROOT / "src/__self_test__.tsx"
        text = SELF_TEST_RUST + "\n" + source
        # build the call site directly instead of touching the tree
        match = INVOKE_RE.search(source)
        assert match
        payload = source[match.end():].lstrip()
        payload = payload[1:].lstrip() if payload.startswith(",") else ""
        keys = top_level_keys(payload) if payload.startswith("{") else None
        site = {"file": "self-test", "line": 1, "command": match.group(1),
                "keys": keys, "dynamic": bool(payload) and not payload.startswith("{")}
        result = check(SELF_TEST_RUST, [site], {site["command"]: "self-test"})
        relevant = [p for p in result["problems"] if p["kind"] in ("args", "unhandled")]
        ok = not relevant
        status = "ok" if ok == should_pass else "WRONG"
        if ok != should_pass:
            failures += 1
        print(f"  {status}: {source}  -> problems={[p['kind'] for p in relevant]}")
    print(f"self-test: {'pass' if failures == 0 else f'{failures} wrong'}")
    return 1 if failures else 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        raise SystemExit(self_test())
    if not LIB.exists():
        raise SystemExit(f"missing {LIB}")
    result = check(LIB.read_text(), call_sites(SRC), referenced_names(SRC))
    result["dynamic"] += dynamic_sites(SRC)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"{result['commands']} commands, {result['invoked']} invoked, {len(result['problems'])} problems")
        for problem in result["problems"]:
            where = f" at {', '.join(problem['where'])}" if problem["where"] else ""
            if problem["kind"] == "args":
                print(f"  args {problem['command']}{where}: missing {problem['missing']}, unknown {problem['unknown']} (expected {problem['expected']})")
            else:
                print(f"  {problem['kind']} {problem['command']}{where}")
        if result["dynamic"]:
            print(f"  {len(result['dynamic'])} call(s) pass a non-literal payload (not shape-checked):")
            for line in result["dynamic"]:
                print(f"    {line}")
    raise SystemExit(1 if result["problems"] else 0)


if __name__ == "__main__":
    main()
