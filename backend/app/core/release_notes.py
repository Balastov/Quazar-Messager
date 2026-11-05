"""User-facing release notes, shared by deployment validation and the server CLI."""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class ReleaseNotes:
    version: str
    title: str
    changes: tuple[str, ...]

    @property
    def message(self) -> str:
        return f"Quazar {self.version} · {self.title}\n\n" + "\n".join(f"• {change}" for change in self.changes)


def parse_release_notes(raw: object, expected_version: str) -> ReleaseNotes:
    if not isinstance(raw, dict) or set(raw) != {"version", "title", "changes"}:
        raise ValueError("Release notes require version, title and changes")
    version, title, changes = raw["version"], raw["title"], raw["changes"]
    if not isinstance(version, str) or len(version) > 32 or not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", version) or version != expected_version:
        raise ValueError("Release notes must match the application version")
    def single_line(value: object, limit: int) -> bool:
        return isinstance(value, str) and 0 < len(value.strip()) <= limit and not any(ord(ch) < 32 for ch in value)
    if not single_line(title, 100) or not isinstance(changes, list) or not 1 <= len(changes) <= 8:
        raise ValueError("Provide a short title and 1–8 user-facing changes")
    if not all(single_line(change, 400) for change in changes):
        raise ValueError("Each change must be a short, single-line description")
    return ReleaseNotes(version, title.strip(), tuple(change.strip() for change in changes))
