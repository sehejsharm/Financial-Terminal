"""Env-driven admin re-seed: deploy/.env must be the login source of truth."""
import lib.auth as auth


def _isolate(monkeypatch, tmp_path):
    monkeypatch.setattr(auth, "DATA_DIR", tmp_path)
    monkeypatch.setattr(auth, "USERS_PATH", tmp_path / "users.json")
    monkeypatch.setattr(auth, "INITIAL_PW_PATH", tmp_path / "INITIAL.txt")


def test_env_admin_created_when_missing(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    monkeypatch.setenv("MOTHERBOARD_ADMIN_USER", "Sehej")
    monkeypatch.setenv("MOTHERBOARD_ADMIN_PASSWORD", "first-password")
    auth.ensure_env_admin()
    assert auth.verify_credentials("Sehej", "first-password") == {
        "username": "Sehej", "role": auth.ROLE_MASTER}
    assert auth.verify_credentials("sehej", "first-password") is not None  # case-insens


def test_env_password_rotation_applies_on_reboot(monkeypatch, tmp_path):
    """The original bug: users.json froze the first-boot password and .env
    edits did nothing. A rotated password must work after re-seed, and the
    old one must stop working."""
    _isolate(monkeypatch, tmp_path)
    monkeypatch.setenv("MOTHERBOARD_ADMIN_USER", "Sehej")
    monkeypatch.setenv("MOTHERBOARD_ADMIN_PASSWORD", "first-password")
    auth.ensure_env_admin()

    monkeypatch.setenv("MOTHERBOARD_ADMIN_PASSWORD", "rotated-password")
    auth.ensure_env_admin()  # simulates the next boot
    assert auth.verify_credentials("Sehej", "rotated-password") is not None
    assert auth.verify_credentials("Sehej", "first-password") is None


def test_noop_without_env(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    monkeypatch.delenv("MOTHERBOARD_ADMIN_USER", raising=False)
    monkeypatch.delenv("MOTHERBOARD_ADMIN_PASSWORD", raising=False)
    auth.ensure_env_admin()
    assert not (tmp_path / "users.json").exists()
