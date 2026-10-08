"""In-process limits for sign-in (ADR 0008).

- Per IP: at most ``IP_LIMIT`` attempts per ``IP_WINDOW_S`` (sliding window).
- Unknown emails get the same lockout as real accounts (5 in a row → 15
  minutes), kept here instead of in the database, so a 423 never tells an
  attacker that an email has an account.

Each backend process counts on its own; with several processes the per-IP
limit is per process.
"""

from __future__ import annotations

import threading
import time
from collections import deque

IP_LIMIT = 20
IP_WINDOW_S = 5 * 60
MAX_FAILED = 5
LOCK_S = 15 * 60
_MAX_KEYS = 50_000  # bound memory under a spray of distinct IPs/emails


class SlidingWindow:
    def __init__(self, limit: int, window_s: float) -> None:
        self.limit = limit
        self.window_s = window_s
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def hit(self, key: str, now: float | None = None) -> bool:
        """Count one attempt; False if the key is over the limit (the attempt is refused)."""
        t = time.monotonic() if now is None else now
        with self._lock:
            q = self._hits.get(key)
            if q is None:
                if len(self._hits) >= _MAX_KEYS:
                    self._prune(t)
                q = self._hits[key] = deque()
            while q and q[0] <= t - self.window_s:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(t)
            return True

    def retry_after(self, key: str, now: float | None = None) -> int:
        t = time.monotonic() if now is None else now
        with self._lock:
            q = self._hits.get(key)
            if not q:
                return 0
            return max(1, int(q[0] + self.window_s - t) + 1)

    def _prune(self, t: float) -> None:
        for k in [k for k, q in self._hits.items() if not q or q[-1] <= t - self.window_s]:
            del self._hits[k]
        while len(self._hits) >= _MAX_KEYS:  # still full: drop the oldest keys
            del self._hits[next(iter(self._hits))]

    def clear(self) -> None:
        with self._lock:
            self._hits.clear()


class GhostLockout:
    """Failed-attempt counter for emails without an account."""

    def __init__(self) -> None:
        self._state: dict[str, tuple[int, float]] = {}  # email -> (fails, locked_until monotonic)
        self._lock = threading.Lock()

    def locked(self, email: str) -> bool:
        with self._lock:
            _, until = self._state.get(email, (0, 0.0))
            return until > time.monotonic()

    def fail(self, email: str) -> bool:
        """Record a failure; True if this one locked the email."""
        with self._lock:
            if len(self._state) >= _MAX_KEYS:
                self._state.clear()
            fails, _ = self._state.get(email, (0, 0.0))
            fails += 1
            if fails >= MAX_FAILED:
                self._state[email] = (0, time.monotonic() + LOCK_S)
                return True
            self._state[email] = (fails, 0.0)
            return False

    def clear(self) -> None:
        with self._lock:
            self._state.clear()


signin_by_ip = SlidingWindow(IP_LIMIT, IP_WINDOW_S)
# Other open, unauthenticated endpoints (forgot, reset, invite, verify, setup,
# signup): same budget, own bucket, so they can't be used to spray email.
open_by_ip = SlidingWindow(IP_LIMIT, IP_WINDOW_S)
ghosts = GhostLockout()


def reset_all() -> None:
    """Tests."""
    signin_by_ip.clear()
    open_by_ip.clear()
    ghosts.clear()
