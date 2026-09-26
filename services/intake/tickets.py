"""Eastudy V3 — intake tickets.

The browser must prove it is allowed to talk to a loopback service without the
service needing a shared long-lived secret in the page. The handshake:

  1. Admin page asks the cloud edge function for a challenge
     (edge signs it with the operator's Supabase session).
  2. Page presents the challenge to the local service at /v3/capability.
  3. Local service asks the edge function to verify the challenge against the
     same operator, then mints a short-lived ticket bound to that admin id.
  4. Every later request carries `Authorization: Bearer <ticket>`.

Tickets live in memory only. Restarting the service invalidates every ticket
and the page re-handshakes, which is the desired behaviour: it means a stolen
ticket file cannot exist, because no ticket file exists.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time
from dataclasses import dataclass

TICKET_TTL_SECONDS = 600          # 10 min, matching the legacy refresh window
CLOCK_SKEW_SECONDS = 30


@dataclass
class Ticket:
    value: str
    admin_id: str
    issued_at: float
    expires_at: float
    worker_id: str

    @property
    def expired(self) -> bool:
        return time.time() > self.expires_at


class TicketAuthority:
    def __init__(self, *, worker_id: str, verify_remote=None):
        self.worker_id = worker_id
        # Per-process salt: two runs of the service never share ticket space,
        # so a ticket captured from an old run cannot be replayed.
        self._salt = secrets.token_bytes(32)
        self._tickets: dict[str, Ticket] = {}
        self._challenges: dict[str, tuple[str, float]] = {}
        self._verify_remote = verify_remote

    def issue_challenge(self, admin_id: str) -> str:
        challenge = secrets.token_urlsafe(32)
        self._challenges[challenge] = (admin_id, time.time() + TICKET_TTL_SECONDS)
        self._prune()
        return challenge

    def consume_challenge(self, challenge: str) -> str:
        entry = self._challenges.pop(challenge, None)
        if entry is None:
            raise PermissionError("INTAKE_TICKET_INVALID")
        admin_id, expires_at = entry
        if time.time() > expires_at + CLOCK_SKEW_SECONDS:
            raise PermissionError("INTAKE_TICKET_INVALID")
        return admin_id

    def mint(self, admin_id: str) -> Ticket:
        raw = secrets.token_bytes(32)
        value = hmac.new(self._salt, raw + admin_id.encode("utf-8"), hashlib.sha256).hexdigest()
        now = time.time()
        ticket = Ticket(
            value=value,
            admin_id=admin_id,
            issued_at=now,
            expires_at=now + TICKET_TTL_SECONDS,
            worker_id=self.worker_id,
        )
        self._tickets[value] = ticket
        self._prune()
        return ticket

    def redeem(self, token: str | None) -> Ticket:
        if not token:
            raise PermissionError("INTAKE_TICKET_INVALID")
        ticket = self._tickets.get(token)
        if ticket is None or ticket.expired:
            self._tickets.pop(token or "", None)
            raise PermissionError("INTAKE_TICKET_INVALID")
        if ticket.worker_id != self.worker_id:
            # The upload started against a different worker process.
            raise PermissionError("WORKER_MISMATCH")
        return ticket

    def refresh(self, token: str) -> Ticket:
        current = self.redeem(token)
        self._tickets.pop(token, None)
        return self.mint(current.admin_id)

    def _prune(self) -> None:
        now = time.time()
        for value, ticket in list(self._tickets.items()):
            if ticket.expired:
                del self._tickets[value]
        for challenge, (_, expires_at) in list(self._challenges.items()):
            if now > expires_at + CLOCK_SKEW_SECONDS:
                del self._challenges[challenge]

    @property
    def active_tickets(self) -> int:
        self._prune()
        return len(self._tickets)


def generate_worker_id() -> str:
    """Stable for the lifetime of the process, unique across simultaneous runs
    on the same machine, so 'continue on the same computer' can be enforced."""
    host = os.environ.get("COMPUTERNAME") or os.environ.get("HOSTNAME") or "local"
    return f"{host}-{secrets.token_hex(4)}"
