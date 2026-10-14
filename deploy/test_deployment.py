"""Offline validation of the production configuration's fail-closed boundaries."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("render_runtime", Path(__file__).with_name("render-runtime.py"))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
storage_spec = importlib.util.spec_from_file_location("verify_storage", Path(__file__).with_name("verify-storage.py"))
storage = importlib.util.module_from_spec(storage_spec)
storage_spec.loader.exec_module(storage)


class StorageIdentityTests(unittest.TestCase):
    def test_expected_ebs_volume_is_accepted(self):
        storage.verify_identity("vol-012abc", "/dev/nvme1n1 /srv/nudge\n", "vol012abc\n")

    def test_different_ebs_volume_is_rejected(self):
        with self.assertRaises(ValueError):
            storage.verify_identity("vol-012abc", "/dev/nvme1n1 /srv/nudge\n", "volfffffff\n")

    def test_parent_root_mount_is_rejected(self):
        with self.assertRaises(ValueError):
            storage.verify_identity("vol-012abc", "/dev/nvme1n1 /\n", "vol012abc\n")

    def test_missing_mount_is_rejected(self):
        with self.assertRaises(ValueError):
            storage.verify_identity("vol-012abc", "", "vol012abc\n")

    def test_non_block_mount_is_rejected(self):
        with self.assertRaises(ValueError):
            storage.verify_identity("vol-012abc", "tmpfs /srv/nudge\n", "vol012abc\n")


class RuntimeConfigTests(unittest.TestCase):
    def setUp(self):
        self.release = {
            "hostname": "nudge.example.com", "feastAdminOrigin": "https://feast-admin.netlify.app",
            "sourceUrl": "https://github.com/example/nudge/archive/" + "a" * 40 + ".tar.gz",
            "ownedInstagramIds": ["123456789012345"],
            "images": {key: "example/image@sha256:" + "b" * 64 for key in ("web", "worker", "migrate", "postgres", "redis", "caddy")},
        }
        self.secrets = {key: "x" * 40 for key in (
            "NEXTAUTH_SECRET", "CRON_SECRET", "FEAST_SSO_SECRET", "POSTGRES_PASSWORD",
            "INSTAGRAM_APP_SECRET", "FACEBOOK_APP_SECRET", "WEBHOOK_VERIFY_TOKEN",
        )}
        self.secrets.update(ENCRYPTION_KEY="a" * 64, INSTAGRAM_APP_ID="123456789")

    def test_default_disables_sends_and_forces_internal_auth(self):
        app, db, _ = runtime.make_environment(self.release, self.secrets)
        self.assertEqual(app["FEAST_SEND_ENABLED"], "false")
        self.assertEqual(app["FEAST_MODE"], "true")
        self.assertEqual(app["FEAST_OWNED_INSTAGRAM_IDS"], "123456789012345")
        self.assertEqual(db["POSTGRES_PASSWORD"], self.secrets["POSTGRES_PASSWORD"])

    def test_missing_sso_secret_cannot_start(self):
        del self.secrets["FEAST_SSO_SECRET"]
        with self.assertRaises(ValueError): runtime.make_environment(self.release, self.secrets)

    def test_empty_account_allowlist_cannot_start(self):
        self.release["ownedInstagramIds"] = []
        with self.assertRaises(ValueError): runtime.make_environment(self.release, self.secrets)

    def test_mutable_images_cannot_start(self):
        self.release["images"]["worker"] = "example/image:latest"
        with self.assertRaises(ValueError): runtime.make_environment(self.release, self.secrets)

    def test_source_branch_is_not_an_exact_source_offer(self):
        self.release["sourceUrl"] = "https://github.com/example/nudge/archive/main.tar.gz"
        with self.assertRaises(ValueError): runtime.make_environment(self.release, self.secrets)

    def test_origin_cannot_include_credentials_or_path(self):
        for value in ("http://admin.example.com", "https://user:secret@admin.example.com", "https://admin.example.com/path"):
            with self.subTest(value=value):
                self.release["feastAdminOrigin"] = value
                with self.assertRaises(ValueError): runtime.make_environment(self.release, self.secrets)

    def test_string_false_is_not_a_boolean(self):
        self.release["sendEnabled"] = "false"
        with self.assertRaises(ValueError): runtime.make_environment(self.release, self.secrets)

    def test_newline_cannot_inject_an_environment_variable(self):
        self.secrets["CRON_SECRET"] = "x" * 40 + "\nFEAST_MODE=false"
        with self.assertRaises(ValueError): runtime.make_environment(self.release, self.secrets)

    def test_backslash_cannot_escape_env_file_quotes(self):
        self.secrets["CRON_SECRET"] = "x" * 40 + "\\"
        with self.assertRaises(ValueError): runtime.make_environment(self.release, self.secrets)

    def test_database_password_is_url_encoded(self):
        self.secrets["POSTGRES_PASSWORD"] = "a" * 32 + "@:/%$"
        app, _, _ = runtime.make_environment(self.release, self.secrets)
        self.assertIn("%40%3A%2F%25%24@postgres", app["DATABASE_URL"])

    def test_env_file_is_private_and_dollar_is_literal(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "app.env"
            runtime.write_env(path, {"TOKEN": "literal$VALUE"})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(path.read_text(), "TOKEN='literal$VALUE'\n")


if __name__ == "__main__": unittest.main()
