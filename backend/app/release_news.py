"""Queue release news after a successful deployment; JSON notes arrive on stdin."""
import argparse
import asyncio
import json
import sys

from app.core.database import AsyncSessionLocal
from app.core.news import bot_user, enqueue_release
from app.core.release_notes import parse_release_notes


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expected-version", required=True)
    args = parser.parse_args()
    notes = parse_release_notes(json.load(sys.stdin), args.expected_version)
    async with AsyncSessionLocal() as db:
        await bot_user(db)
        count = await enqueue_release(db, notes)
    print(f"Release news {notes.version}: {count} new recipients queued")


if __name__ == "__main__":
    asyncio.run(main())
