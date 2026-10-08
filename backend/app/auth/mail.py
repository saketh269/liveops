"""Outgoing email for invite / reset / verification links.

With ``LIVEOPS_SMTP_HOST`` set, mail goes out over SMTP (STARTTLS by
default). Without it, the link is written to the backend log as one INFO line,
so a local install still works; admins also see invite/reset links in the UI.
"""

from __future__ import annotations

import logging
import smtplib
import ssl
from email.message import EmailMessage
from urllib.parse import urlsplit

from starlette.requests import HTTPConnection

from app.config import get_settings

log = logging.getLogger("liveops.auth.mail")


def public_base(conn: HTTPConnection) -> str:
    """Where links in emails point: ``LIVEOPS_PUBLIC_URL``, else the page the
    request came from (its Origin, if it is one of our allowed hosts), else
    this server's own address."""
    settings = get_settings()
    if settings.public_url:
        return settings.public_url.rstrip("/")
    origin = conn.headers.get("origin")
    if origin:
        host = (urlsplit(origin).hostname or "").strip("[]")
        if host in {h.strip("[]") for h in settings.allowed_hosts}:
            return origin.rstrip("/")
    return str(conn.base_url).rstrip("/")


def link(conn: HTTPConnection, page: str, token: str) -> str:
    return f"{public_base(conn)}/{page}?token={token}"


SUBJECTS = {
    "invite": "You're invited to Live Ops",
    "reset": "Reset your Live Ops password",
    "verify": "Confirm your email for Live Ops",
}
BODIES = {
    "invite": "You've been invited to Live Ops. Open this link to choose a password (valid for 7 days):\n\n{link}\n",
    "reset": (
        "Someone asked to reset the password of your Live Ops account. Open this link to choose a new one "
        "(valid for 1 hour):\n\n{link}\n\nIf it wasn't you, ignore this email; your password stays the same.\n"
    ),
    "verify": "Open this link to confirm your email address for Live Ops (valid for 3 days):\n\n{link}\n",
}


def _send_smtp(to: str, subject: str, body: str) -> None:
    s = get_settings()
    msg = EmailMessage()
    msg["From"] = s.smtp_from or s.smtp_user or f"liveops@{s.smtp_host}"
    msg["To"] = to
    msg["Subject"] = subject
    msg.set_content(body)
    with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=15) as smtp:
        if s.smtp_starttls:
            smtp.starttls(context=ssl.create_default_context())
        if s.smtp_user:
            smtp.login(s.smtp_user, s.smtp_password)
        smtp.send_message(msg)


def send_link(to: str, kind: str, url: str) -> bool:
    """Email (or log) a link. Returns False if SMTP is set up but sending failed.
    Blocking: call it from a worker thread or a background task."""
    if not get_settings().smtp_host:
        log.info("Email not configured; %s link for %s: %s", kind, to, url)
        return True
    try:
        _send_smtp(to, SUBJECTS[kind], BODIES[kind].format(link=url))
        return True
    except (OSError, smtplib.SMTPException) as e:
        log.warning("Could not email the %s link to %s: %s", kind, to, e)
        return False
