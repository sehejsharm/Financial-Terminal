"""Crash-safe JSON persistence.

WHY THIS EXISTS: the previous writes were `open(path, "w")` followed by
`json.dump`. Opening with "w" TRUNCATES the file immediately — so if the write
then fails (a full disk is the realistic case; the deploy VM rebuilds a Docker
image on every commit and had no image pruning), the file is left empty. For
users.json that means every account disappears and nobody can log in, and the
damage survives freeing the disk.

The fix is the standard atomic-replace dance: write the new content to a
temporary file in the SAME directory, flush it all the way to disk, then
os.replace() it over the target. os.replace is atomic on POSIX and on Windows,
so a reader (and a crash) only ever sees the whole old file or the whole new
one — never a half-written one. A `.bak` of the last known-good content is
kept alongside so a corrupted or externally-mangled file is still recoverable.
"""
from __future__ import annotations

import json
import os
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

__all__ = ["write_json_atomic", "read_json_resilient"]


def write_json_atomic(path: Path, data: Any, *, keep_backup: bool = True,
                      indent: int | None = 2, default: Any = None) -> None:
    """Serialize `data` to `path` atomically.

    Raises on failure (a caller that silently swallows a failed write would
    let the app believe it saved something it did not). The target file is
    left untouched when the write fails, which is the whole point.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    # ORDER MATTERS. The new content is fully written and fsynced BEFORE the
    # existing file is touched at all — so a failure here (ENOSPC being the
    # one that actually bit us) leaves the target exactly as it was. Backing
    # the old file up first would have moved it out of the way and left
    # nothing behind when the write then failed.
    #
    # Same directory: os.replace is only atomic within a filesystem, and /tmp
    # is frequently a different mount.
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".",
                               suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=indent, default=default)
            fh.flush()
            # fsync the DATA before the rename. Without it a power loss can
            # leave the rename durable but the contents not.
            os.fsync(fh.fileno())
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

    # Only now that the replacement is safely on disk: copy the previous good
    # content aside, then swap. These files are small config documents, so a
    # copy is cheaper than the complexity of hard-linking across edge cases.
    if keep_backup and path.exists():
        try:
            shutil.copy2(path, path.with_suffix(path.suffix + ".bak"))
        except OSError:
            # Losing the backup must never block the save itself.
            pass

    try:
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

    # fsync the DIRECTORY so the rename itself is durable.
    try:
        dfd = os.open(str(path.parent), os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        # Not supported on every platform/filesystem; the replace already
        # happened, so this is best-effort hardening only.
        pass


def read_json_resilient(path: Path, default: Any) -> Any:
    """Read JSON, falling back to the `.bak` copy if the primary is unusable.

    A corrupt primary is preserved as `<name>.corrupt-<timestamp>` rather than
    being overwritten, so nothing is destroyed by a later successful save and
    the damage can be inspected after the fact.
    """
    path = Path(path)
    if not path.exists():
        return default

    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        pass

    bak = path.with_suffix(path.suffix + ".bak")
    recovered = None
    if bak.exists():
        try:
            with open(bak, "r", encoding="utf-8") as fh:
                recovered = json.load(fh)
        except Exception:
            recovered = None

    # Quarantine the unreadable file so it isn't silently clobbered later.
    try:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        os.replace(path, path.with_suffix(path.suffix + f".corrupt-{stamp}"))
    except OSError:
        pass

    return recovered if recovered is not None else default
