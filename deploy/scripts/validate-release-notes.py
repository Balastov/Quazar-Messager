"""Stop a versioned deployment if its user-facing release notes have been forgotten."""
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "backend"))
from app.core.release_notes import parse_release_notes

version = json.loads((root / "web/package.json").read_text())["version"]
notes = parse_release_notes(json.loads((root / "deploy/release-notes.json").read_text()), version)
print(notes.message)
