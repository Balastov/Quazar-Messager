"""Add one reversible location to the existing Quazar vhost, then nginx -t."""
from pathlib import Path
import subprocess

BEGIN = "    # BEGIN isolated Bitrix24 pilot\n"
END = "    # END isolated Bitrix24 pilot\n"
BLOCK = BEGIN + """    location = /bitrix24-pilot {
        return 302 /bitrix24-pilot/bitrix24.html;
    }
    location ^~ /bitrix24-pilot/ {
        proxy_pass http://127.0.0.1:18084/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        add_header Referrer-Policy no-referrer always;
        add_header X-Content-Type-Options nosniff always;
    }
""" + END


def render(text: str) -> str:
    if BEGIN in text:
        before, rest = text.split(BEGIN, 1)
        _, after = rest.split(END, 1)
        return before + BLOCK + after
    if "location ^~ /bitrix24-pilot/" in text:
        raise ValueError("Unknown existing pilot route; refusing to overwrite")
    anchor = "    location /api/ {"
    if text.count(anchor) != 1 or "server_name quazar-msg.ru" not in text:
        raise ValueError("Unexpected Quazar vhost; refusing to change it")
    return text.replace(anchor, BLOCK + "\n" + anchor, 1)


def main():
    site = Path("/etc/nginx/sites-available/quazar-msg.ru")
    before = site.read_text()
    after = render(before)
    if after == before:
        print("Bitrix24 pilot route already configured")
        return
    backup = site.with_name(site.name + ".before-bitrix24-pilot")
    if not backup.exists():
        backup.write_text(before)
    site.write_text(after)
    try:
        subprocess.run(["nginx", "-t"], check=True)
        subprocess.run(["systemctl", "reload", "nginx"], check=True)
    except Exception:
        site.write_text(before)
        raise
    print("Added isolated Bitrix24 pilot route")


if __name__ == "__main__":
    main()
