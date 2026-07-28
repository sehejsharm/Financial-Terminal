"""Storage layer — file-backed JSON today, Postgres-ready interface.

Swapping to SQL later means writing a single new implementation of `Storage`
and rebinding `get_storage()`. Nothing else in the backend changes.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from backend.config import DATA_DIR

from lib.atomic import read_json_resilient, write_json_atomic


class Storage:
    """Pluggable storage interface (watchlists, saved screens, audit log)."""

    def watchlists_for(self, username: str) -> list[dict]: ...
    def upsert_watchlist(self, username: str, wl: dict) -> dict: ...
    def delete_watchlist(self, username: str, wl_id: str) -> bool: ...

    def append_audit(self, event: dict) -> None: ...
    def recent_audit(self, limit: int = 200) -> list[dict]: ...

    # Generic per-user JSON documents (portfolios, alerts, notes, workspaces).
    def user_doc(self, kind: str, username: str, default: Any = None) -> Any: ...
    def save_user_doc(self, kind: str, username: str, doc: Any) -> None: ...
    def all_user_docs(self, kind: str) -> dict[str, Any]: ...


class JSONStore(Storage):
    """Simple thread-safe JSON store. Each entity is a single file."""

    def __init__(self, root: Path = DATA_DIR):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.wl_path = self.root / "watchlists.json"
        self.audit_path = self.root / "audit.jsonl"

    # ── private helpers ──────────────────────────────────────────────────────
    def _load_watchlists(self) -> dict:
        data = read_json_resilient(self.wl_path, {})
        return data if isinstance(data, dict) else {}

    def _save_watchlists(self, data: dict) -> None:
        write_json_atomic(self.wl_path, data)

    # ── watchlists ──────────────────────────────────────────────────────────
    def watchlists_for(self, username: str) -> list[dict]:
        with self._lock:
            return self._load_watchlists().get(username.lower(), [])

    def upsert_watchlist(self, username: str, wl: dict) -> dict:
        with self._lock:
            data = self._load_watchlists()
            bucket = data.setdefault(username.lower(), [])
            for i, existing in enumerate(bucket):
                if existing.get("id") == wl["id"]:
                    bucket[i] = wl
                    self._save_watchlists(data)
                    return wl
            bucket.append(wl)
            self._save_watchlists(data)
            return wl

    def delete_watchlist(self, username: str, wl_id: str) -> bool:
        with self._lock:
            data = self._load_watchlists()
            bucket = data.get(username.lower(), [])
            new_bucket = [w for w in bucket if w.get("id") != wl_id]
            if len(new_bucket) == len(bucket):
                return False
            data[username.lower()] = new_bucket
            self._save_watchlists(data)
            return True

    # ── generic per-user documents ───────────────────────────────────────────
    # One JSON file per entity kind: data/{kind}.json = {username: doc}.
    # Powers portfolios / alerts / notes / workspaces without a new schema
    # per feature. `kind` is allow-listed to keep file paths safe.
    _DOC_KINDS = {"portfolios", "alerts", "notes", "workspaces", "api_tokens"}

    def _doc_path(self, kind: str) -> Path:
        if kind not in self._DOC_KINDS:
            raise ValueError(f"unknown doc kind '{kind}'")
        return self.root / f"{kind}.json"

    def _load_docs(self, kind: str) -> dict:
        data = read_json_resilient(self._doc_path(kind), {})
        return data if isinstance(data, dict) else {}

    def user_doc(self, kind: str, username: str, default: Any = None) -> Any:
        with self._lock:
            docs = self._load_docs(kind)
            return docs.get(username.lower(), default)

    def save_user_doc(self, kind: str, username: str, doc: Any) -> None:
        with self._lock:
            docs = self._load_docs(kind)
            docs[username.lower()] = doc
            # Atomic: a truncate-then-write here could wipe every user's
            # portfolios if the disk filled part-way through.
            write_json_atomic(self._doc_path(kind), docs, default=str)

    def all_user_docs(self, kind: str) -> dict[str, Any]:
        with self._lock:
            return self._load_docs(kind)

    # ── audit log (append-only JSONL) ────────────────────────────────────────
    def append_audit(self, event: dict) -> None:
        with self._lock:
            with open(self.audit_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(event, default=str) + "\n")

    def recent_audit(self, limit: int = 200) -> list[dict]:
        if not self.audit_path.exists():
            return []
        # Read last `limit` lines efficiently enough for our scale.
        with open(self.audit_path, "r", encoding="utf-8") as fh:
            lines = fh.readlines()[-limit:]
        out: list[dict] = []
        for line in lines:
            try:
                out.append(json.loads(line))
            except Exception:
                continue
        return out


_storage: Storage | None = None


def get_storage() -> Storage:
    global _storage
    if _storage is None:
        _storage = JSONStore()
    return _storage
