"""Входящие вебхуки: событие внешнего сервиса → короткий текст для Спутника.

Сервис определяем по заголовкам и телу: GitHub (X-GitHub-Event), GitLab (X-Gitlab-Event),
Jira (webhookEvent), Grafana и Prometheus Alertmanager (alerts), а иначе — свой JSON
({"text": …}, {"content": …} или {"message": …}, как у Slack и Discord).
Ссылки пишем в текст как есть — клиент сделает их кликабельными.
"""
from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

KINDS = ("auto", "github", "gitlab", "jira", "grafana", "alertmanager", "generic")
MAX_TEXT = 4000
MAX_ITEMS = 5


class Unsupported(ValueError):
    """Не поняли, что прислали."""


def _s(value: Any, limit: int = 300) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _first_line(value: Any, limit: int = 120) -> str:
    return _s(str(value or "").strip().splitlines()[0] if str(value or "").strip() else "", limit)


def detect(headers: dict[str, str], body: Any) -> str:
    h = {k.lower(): v for k, v in headers.items()}
    if "x-github-event" in h:
        return "github"
    if "x-gitlab-event" in h:
        return "gitlab"
    if isinstance(body, dict):
        if str(body.get("webhookEvent", "")).startswith(("jira:", "comment_", "worklog_")):
            return "jira"
        if isinstance(body.get("alerts"), list):
            return "grafana" if ("orgId" in body or "title" in body or "state" in body) else "alertmanager"
        if "ruleName" in body or "evalMatches" in body:
            return "grafana"
    return "generic"


def render(kind: str, headers: dict[str, str], body: Any) -> str:
    """Текст сообщения. Unsupported — не получилось (неизвестное или пустое событие)."""
    if kind == "auto":
        kind = detect(headers, body)
    h = {k.lower(): v for k, v in headers.items()}
    if not isinstance(body, dict):
        raise Unsupported("Ждём JSON-объект")
    if kind == "github":
        text = _github(h.get("x-github-event", ""), body)
    elif kind == "gitlab":
        text = _gitlab(h.get("x-gitlab-event", body.get("object_kind", "")), body)
    elif kind == "jira":
        text = _jira(body)
    elif kind in ("grafana", "alertmanager"):
        text = _alerts(body)
    else:
        text = _generic(body)
    if not text.strip():
        raise Unsupported("Пустое событие")
    return text if len(text) <= MAX_TEXT else text[: MAX_TEXT - 1] + "…"


# --- Свой JSON -------------------------------------------------------------------


def _generic(body: dict) -> str:
    for key in ("text", "content", "message", "body"):
        if isinstance(body.get(key), str) and body[key].strip():
            title = body.get("title")
            text = body[key].strip()
            return f"{_s(title, 200)}\n{text}" if isinstance(title, str) and title.strip() else text
    raise Unsupported('Нужно поле "text" (или "content", "message")')


# --- Grafana и Alertmanager --------------------------------------------------------


def _alerts(body: dict) -> str:
    alerts = body.get("alerts")
    if not isinstance(alerts, list):
        # Старые оповещения Grafana: title, ruleName, state, message, ruleUrl.
        state = str(body.get("state", "")).lower()
        icon = {"alerting": "🔥", "ok": "✅", "no_data": "❔", "paused": "⏸", "pending": "⏳"}.get(state, "🔔")
        lines = [f"{icon} {_s(body.get('title') or body.get('ruleName'), 200)}"]
        if body.get("message"):
            lines.append(_s(body["message"], 500))
        if body.get("ruleUrl"):
            lines.append(str(body["ruleUrl"]))
        return "\n".join(lines)

    status = str(body.get("status", "")).lower()
    firing = [a for a in alerts if isinstance(a, dict) and str(a.get("status", status)).lower() == "firing"]
    resolved = [a for a in alerts if isinstance(a, dict) and str(a.get("status", status)).lower() == "resolved"]
    common = body.get("commonLabels") or {}
    name = (
        _s(body.get("title"), 200)
        if body.get("title")
        else _s(common.get("alertname") or (body.get("groupLabels") or {}).get("alertname") or "Оповещение", 200)
    )
    head = f"🔥 Сработало: {name}" if firing else f"✅ Решено: {name}"
    if firing and resolved:
        head += f" ({len(firing)} активно, {len(resolved)} решено)"
    elif len(alerts) > 1:
        head += f" ({len(alerts)})"
    lines = [head]
    for alert in (firing + resolved)[:MAX_ITEMS]:
        labels = alert.get("labels") or {}
        notes = alert.get("annotations") or {}
        mark = "🔴" if alert in firing else "🟢"
        what = labels.get("alertname") or name
        where = labels.get("instance") or labels.get("job") or labels.get("service") or ""
        summary = notes.get("summary") or notes.get("description") or notes.get("message") or ""
        line = f"{mark} {_s(what, 120)}"
        if where:
            line += f" · {_s(where, 80)}"
        if labels.get("severity"):
            line += f" · {_s(labels['severity'], 20)}"
        if summary:
            line += f" — {_s(summary, 300)}"
        lines.append(line)
        link = alert.get("dashboardURL") or alert.get("panelURL") or alert.get("generatorURL")
        if link:
            lines.append(f"   {link}")
    if len(alerts) > MAX_ITEMS:
        lines.append(f"…и ещё {len(alerts) - MAX_ITEMS}")
    if body.get("externalURL") and not any(a.get("generatorURL") for a in alerts if isinstance(a, dict)):
        lines.append(str(body["externalURL"]))
    return "\n".join(lines)


# --- GitHub --------------------------------------------------------------------------


def _github(event: str, b: dict) -> str:
    repo = (b.get("repository") or {}).get("full_name", "")
    who = (b.get("sender") or {}).get("login", "")
    action = b.get("action", "")
    if event == "ping":
        return f"🔗 GitHub подключён: {repo or 'вебхук'}"
    if event == "push":
        ref = str(b.get("ref", "")).removeprefix("refs/heads/").removeprefix("refs/tags/")
        commits = b.get("commits") or []
        if b.get("deleted"):
            return f"🗑 {who} удалил(а) {ref} в {repo}"
        lines = [f"⬆️ {who} → {repo}:{ref} — коммитов: {len(commits)}"]
        for c in commits[:MAX_ITEMS]:
            lines.append(f"• {_first_line(c.get('message'))} ({str(c.get('id', ''))[:7]})")
        if b.get("compare"):
            lines.append(b["compare"])
        return "\n".join(lines)
    if event == "pull_request":
        pr = b.get("pull_request") or {}
        verb = "слил(а)" if action == "closed" and pr.get("merged") else {
            "opened": "открыл(а)", "closed": "закрыл(а)", "reopened": "переоткрыл(а)",
            "ready_for_review": "отдал(а) на ревью", "review_requested": "запросил(а) ревью",
        }.get(action)
        if not verb:
            raise Unsupported("Это действие с PR не показываем")
        return f"🔀 {who} {verb} PR #{pr.get('number')} «{_s(pr.get('title'), 200)}» в {repo}\n{pr.get('html_url', '')}".strip()
    if event == "issues":
        issue = b.get("issue") or {}
        verb = {"opened": "открыл(а)", "closed": "закрыл(а)", "reopened": "переоткрыл(а)"}.get(action)
        if not verb:
            raise Unsupported("Это действие с задачей не показываем")
        return f"📌 {who} {verb} задачу #{issue.get('number')} «{_s(issue.get('title'), 200)}» в {repo}\n{issue.get('html_url', '')}".strip()
    if event == "issue_comment" and action == "created":
        issue = b.get("issue") or {}
        comment = b.get("comment") or {}
        return f"💬 {who} в #{issue.get('number')} «{_s(issue.get('title'), 120)}»: {_s(comment.get('body'), 300)}\n{comment.get('html_url', '')}".strip()
    if event == "release" and action in ("published", "released"):
        rel = b.get("release") or {}
        return f"🚀 Релиз {rel.get('tag_name')} в {repo}: {_s(rel.get('name') or rel.get('tag_name'), 200)}\n{rel.get('html_url', '')}".strip()
    if event == "workflow_run" and action == "completed":
        run = b.get("workflow_run") or {}
        ok = run.get("conclusion") == "success"
        return f"{'✅' if ok else '❌'} {run.get('name')} в {repo} ({run.get('head_branch')}): {run.get('conclusion')}\n{run.get('html_url', '')}".strip()
    raise Unsupported(f"Событие GitHub «{event}» не показываем")


# --- GitLab --------------------------------------------------------------------------


def _gitlab(event: str, b: dict) -> str:
    project = (b.get("project") or {}).get("path_with_namespace", "")
    who = (b.get("user") or {}).get("name") or b.get("user_name") or ""
    kind = b.get("object_kind") or ""
    attrs = b.get("object_attributes") or {}
    if kind in ("push", "tag_push") or event in ("Push Hook", "Tag Push Hook"):
        ref = str(b.get("ref", "")).removeprefix("refs/heads/").removeprefix("refs/tags/")
        commits = b.get("commits") or []
        lines = [f"⬆️ {b.get('user_name', who)} → {project}:{ref} — коммитов: {b.get('total_commits_count', len(commits))}"]
        for c in commits[:MAX_ITEMS]:
            lines.append(f"• {_first_line(c.get('message'))} ({str(c.get('id', ''))[:8]})")
        return "\n".join(lines)
    if kind == "merge_request":
        verb = {"open": "открыл(а)", "close": "закрыл(а)", "merge": "слил(а)", "reopen": "переоткрыл(а)",
                "approved": "одобрил(а)"}.get(attrs.get("action"))
        if not verb:
            raise Unsupported("Это действие с MR не показываем")
        return f"🔀 {who} {verb} MR !{attrs.get('iid')} «{_s(attrs.get('title'), 200)}» в {project}\n{attrs.get('url', '')}".strip()
    if kind == "issue":
        verb = {"open": "открыл(а)", "close": "закрыл(а)", "reopen": "переоткрыл(а)"}.get(attrs.get("action"))
        if not verb:
            raise Unsupported("Это действие с задачей не показываем")
        return f"📌 {who} {verb} задачу #{attrs.get('iid')} «{_s(attrs.get('title'), 200)}» в {project}\n{attrs.get('url', '')}".strip()
    if kind == "note":
        return f"💬 {who} в {project}: {_s(attrs.get('note'), 300)}\n{attrs.get('url', '')}".strip()
    if kind == "pipeline":
        state = attrs.get("status")
        if state not in ("success", "failed", "canceled"):
            raise Unsupported("Промежуточные статусы пайплайна не показываем")
        icon = {"success": "✅", "failed": "❌", "canceled": "⏹"}[state]
        url = f"{(b.get('project') or {}).get('web_url', '')}/-/pipelines/{attrs.get('id')}"
        return f"{icon} Пайплайн #{attrs.get('id')} в {project} ({attrs.get('ref')}): {state}\n{url}"
    if kind == "release":
        return f"🚀 Релиз {attrs.get('tag') or b.get('tag')} в {project}: {_s(b.get('name'), 200)}\n{b.get('url', '')}".strip()
    raise Unsupported(f"Событие GitLab «{event or kind}» не показываем")


# --- Jira ----------------------------------------------------------------------------


def _jira(b: dict) -> str:
    event = b.get("webhookEvent", "")
    issue = b.get("issue") or {}
    fields = issue.get("fields") or {}
    key = issue.get("key", "")
    who = (b.get("user") or (b.get("comment") or {}).get("author") or {}).get("displayName", "")
    link = ""
    if issue.get("self") and key:
        parts = urlsplit(issue["self"])
        link = f"{parts.scheme}://{parts.netloc}/browse/{key}"
    title = f"{key} «{_s(fields.get('summary'), 200)}»"
    if event == "jira:issue_created":
        text = f"📌 {who} создал(а) {title}"
    elif event == "jira:issue_updated":
        changes = [
            f"{i.get('field')}: {_s(i.get('fromString'), 40) or '—'} → {_s(i.get('toString'), 40) or '—'}"
            for i in (b.get("changelog") or {}).get("items", [])[:3]
        ]
        text = f"✏️ {who} изменил(а) {title}" + (f"\n{'; '.join(changes)}" if changes else "")
    elif event == "jira:issue_deleted":
        text = f"🗑 {who} удалил(а) {title}"
    elif event == "comment_created":
        text = f"💬 {who} в {title}: {_s((b.get('comment') or {}).get('body'), 300)}"
    else:
        raise Unsupported(f"Событие Jira «{event}» не показываем")
    return f"{text}\n{link}".strip()
