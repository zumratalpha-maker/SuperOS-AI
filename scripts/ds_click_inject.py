# DirectShell inject-table click: same mechanism as MCP ds_click (UIA mode).
# Usage: py scripts/ds_click_inject.py "Element Name"
# Env: DS_PROFILES (optional) = path to ds_profiles directory.

import os
import sys
import sqlite3
import time
from pathlib import Path

DEFAULT_PROFILES = "D:\\DirectShell\\ds_profiles"

def main():
    if len(sys.argv) < 2:
        print("usage: ds_click_inject.py <element_name>", file=sys.stderr)
        sys.exit(1)
    name = sys.argv[1].strip()
    if not name:
        print("element_name must be non-empty", file=sys.stderr)
        sys.exit(1)

    profiles_dir = Path(os.environ.get("DS_PROFILES", DEFAULT_PROFILES))
    active_file = profiles_dir / "is_active"
    if not active_file.exists():
        print("is_active not found; DirectShell may not be running", file=sys.stderr)
        sys.exit(1)
    app = active_file.read_text(encoding="utf-8").strip().splitlines()[0].strip() or "cursor"
    if app == "none":
        app = "cursor"
    db_path = profiles_dir / f"{app}.db"
    if not db_path.exists():
        print(f"db not found: {db_path}", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        cur = conn.execute(
            "INSERT INTO inject (action, text, target, done) VALUES (?, ?, ?, 0)",
            ("click", "", name),
        )
        conn.commit()
        action_id = cur.lastrowid
    finally:
        conn.close()

    # 给 daemon 一轮轮询时间（~33 Hz）再开始检查 done
    time.sleep(0.2)
    timeout, poll_interval = 10.0, 0.05
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            row = conn.execute("SELECT done FROM inject WHERE id=?", (action_id,)).fetchone()
            conn.close()
            if row and row[0] == 1:
                print("ok")
                sys.exit(0)
        except sqlite3.OperationalError:
            pass
        time.sleep(poll_interval)
    print(
        "timeout waiting for inject done — 请确认 directshell.exe 已运行且已附着到当前窗口（Cursor）",
        file=sys.stderr,
    )
    sys.exit(1)

if __name__ == "__main__":
    main()
