import json, sys
from pathlib import Path

# Read the DirectShell a11y snapshot and convert to a simple JSON that matches our TrajectoryRecord A11yState
profiles_dir = Path(r"D:\DirectShell\ds_profiles")
a11y_path = profiles_dir / "cursor.a11y"

nodes = []
if a11y_path.exists():
    for line in a11y_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith("# ") or not line.strip():
            continue
        nodes.append({"raw": line})

snapshot = {
    "timestamp": __import__("time").time() * 1000,
    "nodes": nodes,
}

record = {
    "timestamp": snapshot["timestamp"],
    "action": "ds_snapshot",
    "target": "cursor",
    "afterState": snapshot,
}

Path("D:/SuperOS/tmp_trajectory_record.json").write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
