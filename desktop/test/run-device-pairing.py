"""Run the real-renderer pairing test against a dedicated disposable PostgreSQL database."""
import asyncio
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import shutil
from urllib.request import urlopen
from urllib.parse import urlsplit, urlunsplit

import asyncpg

root = Path(__file__).resolve().parents[2]
dsn = os.environ.get("TEST_DATABASE_URL", "postgresql+asyncpg://quazar@127.0.0.1:55439/quazar")
url = urlsplit(dsn.replace("postgresql+asyncpg:", "postgresql:"))
if url.hostname not in {"127.0.0.1", "localhost", "::1"}:
    raise RuntimeError("The browser test requires a loopback-only PostgreSQL instance")
database = "quazar_pair_e2e_" + secrets.token_hex(6)
admin_dsn = urlunsplit(url._replace(path="/postgres"))
test_dsn = urlunsplit(url._replace(path="/" + database)).replace("postgresql:", "postgresql+asyncpg:", 1)


async def database_command(command):
    connection = await asyncpg.connect(admin_dsn)
    try:
        await connection.execute(command)
    finally:
        await connection.close()


asyncio.run(database_command(f'CREATE DATABASE "{database}"'))
with tempfile.TemporaryDirectory(prefix="quazar-device-e2e-") as folder:
    task = Path(folder)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0)); port = probe.getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    environment = {**os.environ, "DATABASE_URL": test_dsn, "JWT_SECRET": secrets.token_urlsafe(48), "JWT_ACCESS_EXPIRE_MINUTES": "30",
        "PUBLIC_URL": base, "CORS_ORIGINS": base, "MEDIA_ROOT": str(task / "media"),
        "VAPID_PUBLIC_KEY": "", "VAPID_PRIVATE_KEY": "", "ZVONOK_API_KEY": "", "ZVONOK_CAMPAIGN_ID": "",
        "YANDEX_CLIENT_ID": "", "YANDEX_CLIENT_SECRET": "", "LIVEKIT_API_KEY": "", "LIVEKIT_API_SECRET": "", "SUPERUSER_BOOTSTRAP": "",
        "LIVEKIT_URL": "", "LIVEKIT_PUBLIC_URL": "", "WEBRTC_STUN_URLS": "", "WEBRTC_TURN_URLS": "", "WEBRTC_TURN_USERNAME": "", "WEBRTC_TURN_CREDENTIAL": "",
        "PAIR_TEST_URL": base, "PAIR_TEST_BOOTSTRAP": str(task / "bootstrap.json"), "PAIR_TEST_PROFILE": str(task / "browser")}
    environment.pop("ELECTRON_RUN_AS_NODE", None)
    server = None
    try:
        with (task / "server.log").open("w") as output:
            server = subprocess.Popen([sys.executable, "-B", "-m", "uvicorn", "tests.device_pairing_browser:app", "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning", "--no-access-log"], cwd=root / "backend", env=environment, stdout=output, stderr=subprocess.STDOUT)
            for _ in range(150):
                if Path(environment["PAIR_TEST_BOOTSTRAP"]).exists(): break
                if server.poll() is not None: raise RuntimeError("Test API did not start")
                time.sleep(.2)
            else: raise RuntimeError("Test API startup timed out")
            for _ in range(30):
                try:
                    with urlopen(base + "/api/auth/providers", timeout=1) as response:
                        if response.status == 200: break
                except Exception:
                    time.sleep(.1)
            else: raise RuntimeError("Test API did not become ready")
            electron = subprocess.check_output(["node", "-e", "process.stdout.write(require('electron'))"], cwd=root / "desktop", text=True).strip()
            result = subprocess.run([electron, "--no-sandbox", str(root / "desktop/test/device-pairing-e2e.cjs")], env=environment, timeout=140)
            if result.returncode: raise RuntimeError("Real-renderer pairing test failed")
    except Exception:
        destination = Path(os.environ.get("PAIR_TEST_ARTIFACTS", str(Path(tempfile.gettempdir()) / "quazar-device-e2e-last")))
        destination.mkdir(parents=True, exist_ok=True)
        for picture in (task / "browser").glob("failure-*.png"):
            shutil.copy2(picture, destination / picture.name)
        if (task / "server.log").exists(): shutil.copy2(task / "server.log", destination / "server.log")
        print("Test diagnostics:", destination, file=sys.stderr)
        if (task / "server.log").exists(): print((task / "server.log").read_text()[-6000:], file=sys.stderr)
        raise
    finally:
        if server:
            server.terminate()
            try: server.wait(timeout=10)
            except subprocess.TimeoutExpired: server.kill(); server.wait()
        asyncio.run(database_command(f'DROP DATABASE "{database}" WITH (FORCE)'))
