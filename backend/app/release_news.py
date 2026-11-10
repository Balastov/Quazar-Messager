"""After a successful deployment, store the release news as a draft; JSON notes arrive on stdin.

Никому ничего не отправляется: суперпользователи проверяют и одобряют текст в «Чёрной дыре».
"""
import argparse
import asyncio
import json
import sys

from app.core.database import AsyncSessionLocal
from app.core.news import add_draft, bot_user
from app.core.release_notes import parse_release_notes

RESULT = {
    "baseline": "historical version, nothing to announce",
    "draft": "draft is waiting for approval in the Black Hole",
    "merged": "draft is waiting for approval in the Black Hole (merged with earlier unapproved drafts)",
    "refreshed": "unedited draft updated from the release notes file",
    "exists": "already reviewed, the file is not applied again",
    "older": "a newer version is already known, nothing to announce",
}


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-version", required=True)
    args = parser.parse_args()
    notes = parse_release_notes(json.load(sys.stdin), args.expected_version)
    async with AsyncSessionLocal() as db:
        await bot_user(db)
        result = await add_draft(db, notes)
    print(f"Release news {notes.version}: {RESULT[result]}")


if __name__ == "__main__":
    asyncio.run(main())
