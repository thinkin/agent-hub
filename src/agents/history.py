import json
import os
import sqlite3
import sys
import uuid
from pathlib import Path

PREFIX = "__AGENT_HUB_JSON__"
MAX_BYTES = 96 * 1024


def identifier(value):
    try:
        return str(uuid.UUID(value)) == value.lower()
    except (ValueError, TypeError, AttributeError):
        return False


def records(path):
    with path.open("rb") as stream:
        start = stream.read(MAX_BYTES)
        size = path.stat().st_size
        chunks = [start]
        if size > MAX_BYTES:
            stream.seek(max(MAX_BYTES, size - MAX_BYTES))
            chunks.append(stream.read(MAX_BYTES).split(b"\n", 1)[-1])
    for chunk in chunks:
        for line in chunk.splitlines():
            try:
                value = json.loads(line)
                if isinstance(value, dict): yield value
            except (ValueError, UnicodeDecodeError): continue


def claude_summary(path, modified):
    result = {"id": path.stem, "cwd": "", "title": "", "modified": modified}
    for item in records(path):
        if item.get("isSidechain"): continue
        if isinstance(item.get("cwd"), str): result["cwd"] = item["cwd"]
        if item.get("type") == "custom-title" and isinstance(item.get("customTitle"), str): result["title"] = item["customTitle"][:180]
        elif not result["title"] and item.get("type") == "user" and not item.get("isMeta"):
            message = item.get("message")
            content = message.get("content", "") if isinstance(message, dict) else ""
            if isinstance(content, list): content = " ".join(part["text"] for part in content if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str))
            if isinstance(content, str): result["title"] = " ".join(content.split())[:180]
    return result


def claude_history(options):
    root = Path(os.path.expanduser(options.get("configDir") or os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude")) / "projects"
    if not root.exists(): return {"items": [], "total": 0, "warnings": ["Claude 尚未创建 projects 历史目录"]}
    files, warnings = [], []
    wanted, wanted_ids = options.get("sessionId"), options.get("sessionIds")
    for project in root.iterdir():
        if not project.is_dir(): continue
        try:
            paths = (project / (value + ".jsonl") for value in wanted_ids) if wanted_ids is not None else project.glob((wanted or "*") + ".jsonl")
            for path in paths:
                if identifier(path.stem) and path.is_file(): files.append((path.stat().st_mtime, path))
        except OSError: warnings.append("部分项目历史不可读取")
    files.sort(key=lambda pair: (pair[0], str(pair[1])), reverse=True)
    ordered = list(dict((path.stem, (modified, path)) for modified, path in files).values())
    offset, limit = page(options)
    items = []
    for modified, path in ordered[offset:offset + limit]:
        try: items.append(claude_summary(path, modified))
        except OSError: warnings.append("部分会话已删除或无法读取")
    return {"items": items, "total": len(ordered), "warnings": list(dict.fromkeys(warnings))}


def agent_home(options):
    if options["type"] == "codex": return Path(os.path.expanduser(options.get("configDir") or os.environ.get("CODEX_HOME") or "~/.codex"))
    explicit = options.get("configDir") or os.environ.get("TRAECLI_HOME")
    if explicit: return Path(os.path.expanduser(explicit))
    return Path(os.path.expanduser(os.path.join(os.environ.get("TRAE_HOME", "~/.trae"), "cli")))


def sqlite_history(options):
    database = agent_home(options) / "state_5.sqlite"
    if not database.exists(): return {"items": [], "total": 0, "warnings": ["Agent 尚未创建历史数据库"]}
    wanted, wanted_ids = options.get("sessionId"), options.get("sessionIds")
    conditions, values = ["archived = 0"], []
    if wanted:
        conditions.append("id = ?"); values.append(wanted)
    elif wanted_ids is not None:
        if not wanted_ids: return {"items": [], "total": 0, "warnings": []}
        conditions.append("id IN (%s)" % ",".join("?" for _ in wanted_ids)); values.extend(wanted_ids)
    where = " AND ".join(conditions)
    offset, limit = page(options)
    connection = sqlite3.connect("file:%s?mode=ro" % database, uri=True, timeout=2)
    connection.row_factory = sqlite3.Row
    try:
        columns = {row[1] for row in connection.execute("PRAGMA table_info(threads)")}
        title_parts = [name for name in ("name", "title", "preview", "first_user_message") if name in columns]
        title = "COALESCE(%s, '')" % ", ".join("NULLIF(%s, '')" % name for name in title_parts)
        modified = "COALESCE(updated_at_ms / 1000.0, updated_at)" if "updated_at_ms" in columns else "updated_at"
        total = connection.execute("SELECT COUNT(*) FROM threads WHERE " + where, values).fetchone()[0]
        rows = connection.execute(f"SELECT id, cwd, {title} AS title, {modified} AS modified FROM threads WHERE {where} ORDER BY {modified} DESC, id DESC LIMIT ? OFFSET ?", values + [limit, offset])
        items = [{"id": row["id"], "cwd": row["cwd"] or "", "title": " ".join((row["title"] or "").split())[:180], "modified": float(row["modified"])} for row in rows if identifier(row["id"])]
        return {"items": items, "total": total, "warnings": []}
    finally: connection.close()


def page(options):
    return max(0, int(options.get("offset", 0))), min(100, max(1, int(options.get("limit", 30))))


def main():
    options = json.loads(sys.argv[1])
    options.setdefault("type", "claude-code")
    wanted = [options.get("sessionId")] if options.get("sessionId") else options.get("sessionIds")
    if wanted is not None and (len(wanted) > 100 or not all(identifier(value) for value in wanted)): raise ValueError("Invalid session IDs")
    return claude_history(options) if options.get("type") == "claude-code" else sqlite_history(options)


if __name__ == "__main__":
    try: print(PREFIX + json.dumps(main(), ensure_ascii=True))
    except Exception as error:
        print(str(error), file=sys.stderr); sys.exit(1)
