"""deploy/backup.sh and deploy/restore.sh, driven end to end.

WHY THESE EXIST AS A TEST FILE. The two scripts carry a `--self-test` that
proves the round trip on the host, and install-autodeploy.sh runs it. That is
the right thing for an operator and the wrong thing for a regression: it only
runs when somebody runs it, and it covers the happy path. These tests run in
CI on every push, and most of them cover a REFUSAL — the paths that decide
whether an incident stays recoverable.

The refusals matter more than the round trip here. A backup that silently
produces a bad archive is worse than no backup, because it is believed. So the
assertions are mostly of the form "this is rejected, and the live data is
still there afterwards".

EVERY TEST RUNS AGAINST SCRATCH DIRECTORIES. MB_DATA_DIR, MB_BACKUP_DIR and
MB_BACKUP_LOG are set on every invocation, so nothing here can touch the
repo's real data/, the VM's /var/backups/motherboard, or /var/log.

NOT COVERED HERE, AND THE REASON:
  * exit 3 (no quiet window could be proven). Forcing it needs a writer racing
    the copy, and the outcome depends on how fast `cp` of a few small files
    returns. A test that usually fails the right way is still a flaky test, so
    it is left to the `--self-test`'s manual exercise rather than shipped here.
  * the off-host hook against a real provider. No credentials, by instruction.
    What IS covered is that the hook receives the archive, the checksum and the
    manifest as $1/$2/$3, and that a nonzero exit from it is reported as 5.
  * anything requiring a running container. There is no Docker in this
    environment; restore.sh's backend-running check is written to be a no-op
    without it, which is why the rest of this file works at all.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
BACKUP = REPO / "deploy" / "backup.sh"
RESTORE = REPO / "deploy" / "restore.sh"

pytestmark = pytest.mark.skipif(
    not BACKUP.exists() or not RESTORE.exists(),
    reason="deploy/backup.sh or deploy/restore.sh is missing",
)


# ── harness ─────────────────────────────────────────────────────────────────
def _seed_data(data: Path) -> None:
    """A data dir shaped like the real one.

    Specifically includes the things a file list would miss: a dot-file
    credential, a 0600 document, an append-only log, a .bak sibling, and one of
    the atomic writer's in-flight .tmp files that must NOT come back.
    """
    data.mkdir(parents=True, exist_ok=True)
    (data / "users.json").write_text(
        json.dumps({"users": {"admin": {"hash": "x", "role": "master_admin"}}}))
    (data / "users.json.bak").write_text((data / "users.json").read_text())
    (data / "portfolios.json").write_text(
        json.dumps({"admin": [{"sym": "RELIANCE.NS", "qty": 10}]}))
    (data / "audit.jsonl").write_text('{"ev":"login"}\n{"ev":"screen"}\n')
    (data / ".jwt_secret").write_text("jwt-secret-material")
    os.chmod(data / "users.json", 0o600)
    os.chmod(data / ".jwt_secret", 0o600)
    # The atomic writer's temp shape: lib/atomic.py uses
    # mkstemp(prefix=name + '.', suffix='.tmp').
    (data / "users.json.zz99.tmp").write_text('{"half-writ')


def _run(script: Path, *args: str, data: Path, backups: Path,
         log: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    full = {
        **os.environ,
        "MB_DATA_DIR": str(data),
        "MB_BACKUP_DIR": str(backups),
        "MB_BACKUP_LOG": str(log),
        # Empty unless a test sets one, so no test can accidentally inherit a
        # real destination from the environment it runs in.
        "MB_BACKUP_OFFHOST_CMD": "",
        **(env or {}),
    }
    return subprocess.run(
        ["bash", str(script), *args],
        capture_output=True, text=True, timeout=300, env=full,
    )


@pytest.fixture
def box(tmp_path):
    """A scratch data dir, a scratch backup dir, and runners bound to them."""
    data, backups, log = tmp_path / "data", tmp_path / "backups", tmp_path / "b.log"
    _seed_data(data)

    class Box:
        root = tmp_path

        def __init__(self):
            self.data, self.backups, self.log = data, backups, log

        def backup(self, *args, env=None):
            return _run(BACKUP, *args, data=data, backups=backups, log=log, env=env)

        def restore(self, *args, env=None):
            return _run(RESTORE, *args, data=data, backups=backups, log=log, env=env)

        def archives(self) -> list[Path]:
            return sorted(backups.glob("mb-data-*.tar.gz"))

        def files(self) -> set[str]:
            if not data.is_dir():
                return set()
            return {str(p.relative_to(data)) for p in data.rglob("*") if p.is_file()}

        def manifest(self, archive: Path) -> dict:
            return json.loads(
                archive.with_suffix("").with_suffix(".manifest.json").read_text())

    return Box()


# ── the round trip ──────────────────────────────────────────────────────────
class TestTheRoundTrip:
    def test_snapshot_destroy_restore_comes_back_identical(self, box):
        """The one that matters: a lost volume, recovered.

        Asserted on the file set and the bytes rather than on the scripts'
        output, because the question is whether the data came back, not whether
        the log says it did.
        """
        before = {name: (box.data / name).read_bytes()
                  for name in box.files() if not name.endswith(".tmp")}
        assert box.backup().returncode == 0
        archive, = box.archives()

        # What a lost volume looks like.
        subprocess.run(["rm", "-rf", str(box.data)], check=True)
        assert not box.data.exists()

        r = box.restore("--latest", "--yes")
        assert r.returncode == 0, r.stdout + r.stderr
        after = {name: (box.data / name).read_bytes() for name in box.files()}
        assert after == before

    def test_the_credential_files_keep_their_modes(self, box):
        """A restore that widens 0600 on users.json or .jwt_secret is a
        security regression, not an inconvenience — the archive holds password
        hashes and the material for forging a session."""
        assert box.backup().returncode == 0
        subprocess.run(["rm", "-rf", str(box.data)], check=True)
        assert box.restore("--latest", "--yes").returncode == 0
        for name in ("users.json", ".jwt_secret"):
            mode = (box.data / name).stat().st_mode & 0o777
            assert mode == 0o600, f"{name} came back as {oct(mode)}"

    def test_the_dot_file_secret_is_included(self, box):
        """`cp -a "$DIR"` would skip dot-files; the script copies "$DIR/.".

        Lose .jwt_secret and every signed-in user is logged out even though
        users.json survived — a restore that looks successful and is not.
        """
        assert box.backup().returncode == 0
        subprocess.run(["rm", "-rf", str(box.data)], check=True)
        assert box.restore("--latest", "--yes").returncode == 0
        assert (box.data / ".jwt_secret").read_text() == "jwt-secret-material"

    def test_an_in_flight_writer_temp_file_does_not_come_back(self, box):
        """A half-written document is not data. Restoring it would litter the
        data dir with files nothing ever cleans up."""
        assert box.backup().returncode == 0
        archive, = box.archives()
        assert "users.json.zz99.tmp" in box.manifest(archive)["tmp_excluded"]
        subprocess.run(["rm", "-rf", str(box.data)], check=True)
        assert box.restore("--latest", "--yes").returncode == 0
        assert not list(box.data.glob("*.tmp"))

    def test_a_partial_trailing_jsonl_record_is_trimmed(self, box):
        """audit.jsonl is appended, not atomically replaced, so a snapshot can
        catch one mid-write. The incomplete record is dropped: it is one audit
        event, and keeping it hands the restore a file whose last line cannot
        be parsed."""
        (box.data / "audit.jsonl").write_text('{"ev":"login"}\n{"ev":"par')
        assert box.backup().returncode == 0
        archive, = box.archives()
        assert "audit.jsonl" in box.manifest(archive)["jsonl_trimmed"]

        subprocess.run(["rm", "-rf", str(box.data)], check=True)
        assert box.restore("--latest", "--yes").returncode == 0
        lines = (box.data / "audit.jsonl").read_text().splitlines()
        assert lines == ['{"ev":"login"}']
        for line in lines:          # the whole point: it parses now
            json.loads(line)


# ── the refusals ────────────────────────────────────────────────────────────
class TestRestoreRefusesWhatItCannotTrust:
    def test_a_truncated_archive_is_refused_and_live_data_survives(self, box):
        """Silent truncation in transit is exactly what the checksum is for —
        an archive fetched back from off-host storage is where it happens. The
        assertion that matters is the second one: restoring a truncated archive
        over live data turns a recoverable incident into an unrecoverable one.

        MEASURED, because I assumed otherwise first: the checksum is the ONLY
        thing that catches this. With the gate removed, this exact case exits
        0 — `tar -xzf` extracts what it can from a half-truncated gzip and
        reports success, so the restore completes and replaces the live data
        with a partial payload. There is no second line of defence here.
        """
        assert box.backup().returncode == 0
        archive, = box.archives()
        intact = box.files()

        with open(archive, "r+b") as fh:          # lop off the tail
            fh.truncate(archive.stat().st_size // 2)

        r = box.restore("--latest", "--yes")
        assert r.returncode != 0
        assert "CHECKSUM MISMATCH" in r.stdout + r.stderr
        assert box.files() == intact, "live data was modified by a refused restore"

    def test_an_archive_with_no_checksum_is_refused_until_asked(self, box):
        assert box.backup().returncode == 0
        archive, = box.archives()
        Path(str(archive) + ".sha256").unlink()

        refused = box.restore("--latest", "--yes")
        assert refused.returncode != 0
        assert "--skip-checksum" in refused.stdout + refused.stderr

        # And the escape hatch works, because sometimes it is the only copy.
        allowed = box.restore("--latest", "--yes", "--skip-checksum")
        assert allowed.returncode == 0, allowed.stdout + allowed.stderr

    def test_a_snapshot_whose_contents_do_not_parse_is_refused(self, box):
        """A damaged payload is refused by default and restorable with --force.

        Default-refuse is right because the usual cause is picking the wrong
        snapshot; --force exists because sometimes it is the only copy and the
        app's readers fall back to .bak siblings.
        """
        assert box.backup().returncode == 0
        archive, = box.archives()
        # Damage the payload inside the archive, then re-checksum it so the
        # checksum gate passes and the JSON gate is the one under test.
        work = box.root / "tamper"
        work.mkdir()
        subprocess.run(["tar", "-xzf", str(archive), "-C", str(work)], check=True)
        (work / "payload" / "users.json").write_text("{not json")
        subprocess.run(["tar", "-czf", str(archive), "-C", str(work), "payload"],
                       check=True)
        subprocess.run(f'cd {archive.parent} && sha256sum {archive.name} '
                       f'> {archive.name}.sha256', shell=True, check=True)

        refused = box.restore("--latest", "--yes")
        assert refused.returncode != 0
        assert "do not parse" in refused.stdout + refused.stderr
        assert box.files(), "live data was removed by a refused restore"

        forced = box.restore("--latest", "--yes", "--force")
        assert forced.returncode == 0, forced.stdout + forced.stderr

    def test_an_unattended_restore_without_yes_is_refused(self, box):
        """No tty and no --yes: refuse rather than block forever or assume
        consent. A restore that silently proceeds from a cron job is how the
        wrong snapshot lands on live data."""
        assert box.backup().returncode == 0
        r = box.restore("--latest")
        assert r.returncode != 0
        assert "not a terminal" in r.stdout + r.stderr

    def test_restoring_from_an_empty_backup_dir_says_so(self, box):
        box.backups.mkdir(parents=True, exist_ok=True)
        r = box.restore("--latest", "--yes")
        assert r.returncode != 0
        assert "no snapshots found" in r.stdout + r.stderr

    def test_an_archive_that_backup_did_not_produce_is_refused(self, box):
        """No payload/ root means it is somebody else's tarball. Refusing is
        better than extracting an unknown tree over the data dir."""
        box.backups.mkdir(parents=True, exist_ok=True)
        stray = box.backups / "mb-data-20200101T000000Z.tar.gz"
        junk = box.root / "junk"
        (junk / "elsewhere").mkdir(parents=True)
        (junk / "elsewhere" / "f.txt").write_text("x")
        subprocess.run(["tar", "-czf", str(stray), "-C", str(junk), "elsewhere"],
                       check=True)
        subprocess.run(f'cd {stray.parent} && sha256sum {stray.name} '
                       f'> {stray.name}.sha256', shell=True, check=True)
        r = box.restore("--latest", "--yes")
        assert r.returncode != 0
        assert "no payload" in (r.stdout + r.stderr)


class TestTheNonDestructivePaths:
    def test_verify_only_changes_nothing(self, box):
        """The command an operator should be running on a schedule, so it must
        be safe to run on a schedule."""
        assert box.backup().returncode == 0
        before = box.files()
        r = box.restore("--latest", "--verify-only")
        assert r.returncode == 0, r.stdout + r.stderr
        assert "VERIFY-ONLY" in r.stdout
        assert box.files() == before

    def test_dry_run_reports_the_plan_and_changes_nothing(self, box):
        assert box.backup().returncode == 0
        before = box.files()
        r = box.restore("--latest", "--dry-run")
        assert r.returncode == 0, r.stdout + r.stderr
        assert "restore plan" in r.stdout
        assert box.files() == before

    def test_a_restore_over_live_data_keeps_the_replaced_copy(self, box):
        """Restoring the wrong snapshot has to be recoverable too, so the
        directory being replaced is moved aside rather than deleted."""
        assert box.backup().returncode == 0
        (box.data / "later.json").write_text('{"written":"after the snapshot"}')

        r = box.restore("--latest", "--yes")
        assert r.returncode == 0, r.stdout + r.stderr
        # The snapshot predates it, so it is gone from the data dir...
        assert "later.json" not in box.files()
        # ...and still on disk, which is the difference between a mistake and
        # a loss.
        aside = list(box.root.glob("data.pre-restore-*"))
        assert len(aside) == 1, aside
        assert json.loads((aside[0] / "later.json").read_text()) == {
            "written": "after the snapshot"}


# ── backup-side guards ──────────────────────────────────────────────────────
class TestBackupGuards:
    def test_a_backup_dir_inside_the_data_dir_is_refused(self, box):
        """Otherwise each snapshot is copied into the next one, and a restore
        writes old snapshots back over live data."""
        inside = box.data / "backups"
        r = _run(BACKUP, data=box.data, backups=inside, log=box.log)
        assert r.returncode == 1
        assert "inside the data dir" in r.stdout + r.stderr
        assert not list(inside.glob("*.tar.gz")) if inside.exists() else True

    def test_a_data_dir_inside_the_backup_dir_is_refused(self, box):
        """The mirror image, and worse: retention would delete live data."""
        backups = box.root / "outer"
        data = backups / "data"
        _seed_data(data)
        r = _run(BACKUP, data=data, backups=backups, log=box.log)
        assert r.returncode == 1
        assert "inside the backup dir" in r.stdout + r.stderr
        assert (data / "users.json").exists(), "live data was touched"

    def test_a_missing_data_dir_is_an_abort_not_an_empty_snapshot(self, box):
        """An empty archive would quietly become the newest snapshot and then
        be the one a restore picks."""
        r = _run(BACKUP, data=box.root / "nope", backups=box.backups, log=box.log)
        assert r.returncode == 1
        assert not box.archives()

    def test_the_disk_guard_refuses_rather_than_fill_the_volume(self, box):
        """A backup must never cause the outage it exists to recover from:
        below the free-space floor the backend can no longer write data/ and a
        build fails."""
        r = box.backup(env={"MB_BACKUP_MIN_FREE_MB": "999999999"})
        assert r.returncode == 1
        assert "refusing to take the volume below" in r.stdout + r.stderr
        assert not box.archives(), "a snapshot was written despite the refusal"

    def test_invalid_json_in_the_live_data_is_reported_but_still_snapshotted(self, box):
        """Exit 4 means the LIVE data is already damaged. The snapshot is kept
        on purpose — it is still the only copy of the undamaged parts — and the
        manifest records which file, so this is found months before a restore
        rather than during one.
        """
        (box.data / "portfolios.json").write_text("{corrupt")
        r = box.backup()
        assert r.returncode == 4, r.stdout + r.stderr
        archive, = box.archives()
        assert box.manifest(archive)["json_invalid"] == ["portfolios.json"]

    def test_a_concurrent_run_skips_instead_of_overlapping(self, box):
        """flock, held for the whole run including the off-host upload. Two
        overlapping runs would both prune and both push."""
        assert box.backup().returncode == 0
        lock = box.backups / ".lock"
        assert lock.exists()
        # Hold the lock from outside and prove the script declines the tick.
        r = subprocess.run(
            ["flock", "-x", str(lock), "-c",
             f'MB_DATA_DIR={box.data} MB_BACKUP_DIR={box.backups} '
             f'MB_BACKUP_LOG={box.log} MB_BACKUP_OFFHOST_CMD= '
             f'MB_BACKUP_STAMP=20300101T000000Z bash {BACKUP}'],
            capture_output=True, text=True, timeout=120)
        assert r.returncode == 0, r.stdout + r.stderr
        assert "another backup is running" in r.stdout
        assert not (box.backups / "mb-data-20300101T000000Z.tar.gz").exists()


class TestRetention:
    def _plant(self, box, *stamps: str) -> None:
        """Fake snapshot triples. prune() only lists and removes, so these do
        not need to be real archives — which is the point: it lets the test
        assert on which files were removed, deterministically."""
        box.backups.mkdir(parents=True, exist_ok=True)
        for s in stamps:
            base = box.backups / f"mb-data-{s}"
            Path(f"{base}.tar.gz").write_bytes(b"x" * 1024)
            Path(f"{base}.tar.gz.sha256").write_text("deadbeef  archive\n")
            Path(f"{base}.manifest.json").write_text("{}")

    def test_pruning_removes_the_checksum_and_manifest_too(self, box):
        """A pruned archive that leaves its manifest behind looks like a
        snapshot that exists, which is what a restore script goes looking for.
        """
        self._plant(box, "20200101T000000Z", "20200102T000000Z")
        assert box.backup(env={"MB_BACKUP_KEEP": "1",
                               "MB_BACKUP_STAMP": "20300101T000000Z"}).returncode == 0
        left = sorted(p.name for p in box.backups.iterdir() if not p.name.startswith("."))
        assert left == ["mb-data-20300101T000000Z.manifest.json",
                        "mb-data-20300101T000000Z.tar.gz",
                        "mb-data-20300101T000000Z.tar.gz.sha256"]

    def test_the_oldest_goes_first(self, box):
        self._plant(box, "20200101T000000Z", "20200102T000000Z", "20200103T000000Z")
        assert box.backup(env={"MB_BACKUP_KEEP": "3",
                               "MB_BACKUP_STAMP": "20300101T000000Z"}).returncode == 0
        stamps = sorted(p.name for p in box.archives())
        assert stamps == ["mb-data-20200102T000000Z.tar.gz",
                          "mb-data-20200103T000000Z.tar.gz",
                          "mb-data-20300101T000000Z.tar.gz"]

    def test_the_size_ceiling_never_deletes_the_last_snapshot(self, box):
        """A disk so full that one snapshot will not fit is a disk problem.
        Deleting the last backup to make room for a new one is how you end up
        with none — so the size loop stops at one, whatever the ceiling says.
        """
        self._plant(box, "20200101T000000Z", "20200102T000000Z")
        assert box.backup(env={"MB_BACKUP_KEEP": "99",
                               "MB_BACKUP_MAX_TOTAL_MB": "0",
                               "MB_BACKUP_STAMP": "20300101T000000Z"}).returncode == 0
        remaining = box.archives()
        assert len(remaining) == 1
        assert remaining[0].name == "mb-data-20300101T000000Z.tar.gz"


class TestTheOffHostHook:
    def test_the_hook_receives_the_archive_checksum_and_manifest(self, box):
        """$1/$2/$3 are a contract: restore.sh refuses an archive it cannot
        verify, so a hook that ships only $1 produces a destination full of
        archives that cannot be restored."""
        got = box.root / "received.txt"
        r = box.backup(env={
            "MB_BACKUP_OFFHOST_CMD": f'printf "%s\\n" "$1" "$2" "$3" > {got}'})
        assert r.returncode == 0, r.stdout + r.stderr
        archive, = box.archives()
        assert got.read_text().split() == [
            str(archive), f"{archive}.sha256",
            str(archive.with_suffix("").with_suffix(".manifest.json"))]
        assert box.manifest(archive)["offhost"] == "sent"

    def test_a_failing_hook_exits_5_and_keeps_the_local_snapshot(self, box):
        """The upload failing must be loud — a local-only snapshot does not
        survive losing the instance — without throwing away the snapshot that
        was successfully taken."""
        r = box.backup(env={"MB_BACKUP_OFFHOST_CMD": "exit 7"})
        assert r.returncode == 5, r.stdout + r.stderr
        assert "off-host push FAILED" in r.stdout
        archive, = box.archives()
        assert archive.exists()
        assert box.manifest(archive)["offhost"] == "failed"

    def test_no_hook_warns_on_every_run_and_records_it(self, box):
        """Not once at install time. A local-only backup looks exactly like a
        working backup right up to the moment the volume is gone, so the
        warning has to be in front of whoever reads the log."""
        for _ in range(2):
            r = box.backup()
            assert r.returncode == 0, r.stdout + r.stderr
            assert "OFF-HOST step is NOT CONFIGURED" in r.stdout
        assert box.manifest(box.archives()[-1])["offhost"] == "not configured"

    def test_the_hook_gets_paths_as_arguments_not_spliced_into_the_text(self, box):
        """bash -c with positional args rather than eval. The hook still gets a
        shell — it needs one for a pipe or an rclone flag — but a path is never
        part of the command text, so a path cannot become command."""
        marker = box.root / "must-not-exist"
        r = box.backup(env={
            # If $1 were spliced into the command text, this is where a crafted
            # path would run. As an argument it is inert.
            "MB_BACKUP_OFFHOST_CMD": f'test -n "$1" || touch {marker}'})
        assert r.returncode == 0, r.stdout + r.stderr
        assert not marker.exists()


def test_the_manifest_records_what_the_snapshot_actually_is(box):
    """The manifest is read during an incident, by someone deciding whether to
    trust this snapshot. Every field it claims has to be true."""
    assert box.backup().returncode == 0
    archive, = box.archives()
    m = box.manifest(archive)

    assert m["schema"] == 1
    assert m["archive"] == archive.name
    assert m["verified"] is True
    assert m["quiesced"] is True          # nothing is writing in this test
    assert m["bytes"] == archive.stat().st_size
    assert m["sha256"] == Path(f"{archive}.sha256").read_text().split()[0]
    assert m["data_dir"] == str(box.data)
    # file_count excludes the .tmp that was dropped: 5 real files (users.json,
    # users.json.bak, portfolios.json, audit.jsonl, .jwt_secret).
    assert m["file_count"] == 5
    assert m["json_invalid"] == []


def test_the_scripts_self_test_passes(box):
    """`backup.sh --self-test` is what install-autodeploy.sh runs on the VM, so
    it has to keep working — it is the operator's only proof that the restore
    path works on the host it will be needed on.

    It manages its own throwaway directories; the env here only keeps it off
    /var/log.
    """
    r = _run(BACKUP, "--self-test", data=box.data, backups=box.backups, log=box.log)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "self-test PASSED" in r.stdout
