"""Идемпотентный маршрут файлов обновлений на общем nginx-хосте."""
from pathlib import Path
import subprocess

SITE = Path("/etc/nginx/sites-available/quazar-msg.ru")
BLOCK = """
    # Quazar desktop update feed
    location ^~ /desktop-updates/ {
        alias /opt/quazar/desktop-updates/;
        autoindex off;
        add_header Cache-Control "no-cache" always;
        add_header X-Content-Type-Options "nosniff" always;
        limit_except GET HEAD { deny all; }
    }

"""


def updated(text):
    if "location ^~ /desktop-updates/" in text:
        if "alias /opt/quazar/desktop-updates/;" not in text:
            raise ValueError("Unexpected desktop update location")
        return text
    anchor = "    location /api/ {"
    if text.count(anchor) != 1:
        raise ValueError("Expected one HTTPS API location")
    return text.replace(anchor, BLOCK + anchor, 1)


if __name__ == "__main__" and SITE.exists():
    before = SITE.read_text()
    after = updated(before)
    if after != before:
        SITE.with_name(SITE.name + ".before-desktop-updates").write_text(before)
        SITE.write_text(after)
        checked = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
        if checked.returncode:
            SITE.write_text(before)
            raise SystemExit(checked.stderr)
        subprocess.run(["systemctl", "reload", "nginx"], check=True)
        print("nginx desktop update route enabled")
    else:
        print("nginx desktop update route already configured")
