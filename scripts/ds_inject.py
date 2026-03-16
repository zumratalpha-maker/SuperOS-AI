# DirectShell inject 表通用写入：click / text / scroll / drag
# 解耦“附着”：target 支持 [窗口名]|[元素名]（如 "微信|发送"），由执行端做「找窗口 -> 唤醒 -> 找元素 -> 操作」。
#
# 用法:
#   python scripts/ds_inject.py click "Element Name"
#   python scripts/ds_inject.py click "微信|发送"
#   python scripts/ds_inject.py text "content" ["窗口|元素"]
#   python scripts/ds_inject.py scroll "down" ["窗口|元素"]
#   python scripts/ds_inject.py drag "x1,y1" "x2,y2"
#
# 环境变量:
#   DS_PROFILES     - ds_profiles 目录，默认 D:\DirectShell\ds_profiles
#   DS_USE_GLOBAL_INJECT - 若为 1，写入 global_inject.db（单表，不依赖 is_active），供新 daemon 轮询

import os
import sys
import sqlite3
import time
from pathlib import Path

DEFAULT_PROFILES = "D:\\DirectShell\\ds_profiles"


def get_db_path(profiles_dir: Path):
    """返回 (db_path, target_column_value)。若 DS_USE_GLOBAL_INJECT=1 则用 global_inject.db。"""
    if os.environ.get("DS_USE_GLOBAL_INJECT", "").strip() == "1":
        return profiles_dir / "global_inject.db", "global"
    active_file = profiles_dir / "is_active"
    if not active_file.exists():
        raise FileNotFoundError("is_active not found; DirectShell may not be running")
    app = active_file.read_text(encoding="utf-8").strip().splitlines()[0].strip() or "cursor"
    if app == "none":
        app = "cursor"
    return profiles_dir / f"{app}.db", app


def ensure_inject_table(conn: sqlite3.Connection) -> None:
    """确保 inject 表存在（含 action, text, target, done）。"""
    conn.execute("""
        CREATE TABLE IF NOT EXISTS inject (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            action TEXT NOT NULL,
            text TEXT NOT NULL,
            target TEXT NOT NULL,
            done INTEGER NOT NULL DEFAULT 0
        )
    """)
    conn.commit()


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: ds_inject.py <action> [args...]", file=sys.stderr)
        print("  action: click <target> | text <content> [target] | scroll <direction> [target] | drag <x1,y1> <x2,y2>", file=sys.stderr)
        print("  target: \"WindowTitle|ElementName\" or \"ElementName\"", file=sys.stderr)
        sys.exit(1)
    action = sys.argv[1].strip().lower()
    if not action:
        sys.exit(1)

    profiles_dir = Path(os.environ.get("DS_PROFILES", DEFAULT_PROFILES))
    try:
        db_path, _ = get_db_path(profiles_dir)
    except FileNotFoundError as e:
        print(e, file=sys.stderr)
        sys.exit(1)

    if not db_path.parent.exists():
        db_path.parent.mkdir(parents=True, exist_ok=True)

    text_val = ""
    target_val = ""

    if action == "click":
        if len(sys.argv) < 3:
            print("click requires target (element name or window|element)", file=sys.stderr)
            sys.exit(1)
        target_val = sys.argv[2].strip()
    elif action == "text":
        if len(sys.argv) < 3:
            print("text requires content", file=sys.stderr)
            sys.exit(1)
        text_val = sys.argv[2].strip()
        target_val = sys.argv[3].strip() if len(sys.argv) > 3 else ""
    elif action == "scroll":
        direction = "down"
        if len(sys.argv) >= 3:
            d = sys.argv[2].strip().lower()
            if d in ("up", "down", "left", "right"):
                direction = d
        text_val = direction
        target_val = sys.argv[3].strip() if len(sys.argv) > 3 else ""
    elif action == "drag":
        if len(sys.argv) < 4:
            print("drag requires from and to: x1,y1 x2,y2", file=sys.stderr)
            sys.exit(1)
        target_val = f"{sys.argv[2].strip()},{sys.argv[3].strip()}"
    else:
        print(f"unknown action: {action}", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        ensure_inject_table(conn)
        cur = conn.execute(
            "INSERT INTO inject (action, text, target, done) VALUES (?, ?, ?, 0)",
            (action, text_val, target_val),
        )
        conn.commit()
        action_id = cur.lastrowid
    finally:
        conn.close()

    time.sleep(0.2)
    timeout, poll_interval = 12.0, 0.05
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
    print("timeout waiting for inject done", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
