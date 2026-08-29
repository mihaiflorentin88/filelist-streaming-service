import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import docker_env_validate

DOCS_LINE = f"Full variable reference: {docker_env_validate.DOCS_URL}"

STALE_KEYS = (
    "QBITTORRENT_USERNAME",
    "QBITTORRENT_PASSWORD",
    "QBITTORRENT_FORCE_CREDENTIAL_ROTATION",
    "MAXIMUM_DOWNLOAD_BYTES",
    "RESERVE_FREE_BYTES",
)

DEFAULT_CIDRS = "127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"

VALID_LINES = [
    "FILELIST_STREAMING_VERSION=0.2.7",
    "QBITTORRENT_IMAGE=qbittorrentofficial/qbittorrent-nox:5.2.3-1",
    "QBT_LEGAL_NOTICE=confirm",
    "SERVER_BIND_IP=0.0.0.0",
    "SERVER_HOST_PORT=8097",
    "SERVER_INSTANCE_NAME=Living room media server",
    "QBITTORRENT_WEBUI_BIND_IP=0.0.0.0",
    "QBITTORRENT_WEBUI_HOST_PORT=8080",
    "QBITTORRENT_WEBUI_CONTAINER_PORT=8080",
    "QBITTORRENT_BIND_IP=0.0.0.0",
    "QBITTORRENT_HOST_PORT=6881",
    "QBITTORRENT_CONTAINER_PORT=6881",
    "APP_DATA_DIR=/srv/filelist/data",
    "QBITTORRENT_CONFIG_DIR=/srv/filelist/qbittorrent",
    "DOWNLOADS_DIR=/mnt/big/downloads",
    "PUID=1000",
    "PGID=1000",
    "PAGID=",
    "UMASK=002",
    "TZ=Europe/Bucharest",
    f"TRUSTED_CIDRS={DEFAULT_CIDRS}",
    "FILELIST_URL=https://filelist.io",
    "FILELIST_USERNAME=filelist-user",
    "FILELIST_PASSKEY=filelist-passkey",
    "TMDB_API_KEY=tmdb-key",
    "SUBDL_URL=https://api.subdl.com",
    "SUBDL_API_KEY=subdl-key",
    "METADATA_LANGUAGE=ro-RO",
    "METADATA_FALLBACK_LANGUAGE=en-US",
    "INITIAL_BUFFER_BYTES=134217728",
    "READ_AHEAD_BYTES=268435456",
    "PIECE_WAIT_TIMEOUT_SECONDS=600",
    "ALLOCATION_GB=15",
    "RESERVE_GB=8",
    "WATCHED_THRESHOLD_PERCENT=90",
    "CATALOG_MAX_AGE_HOURS=24",
    "ARTWORK_CACHE_MAX_BYTES=536870912",
    "SUBTITLE_CACHE_MAX_BYTES=268435456",
    "MAX_CONCURRENT_JOBS=10",
    "TITLE_REFRESH_TIMEOUT_MINUTES=30",
    "PREFERRED_AUDIO_LANGUAGE=en",
    "PREFERRED_SUBTITLE_LANGUAGE=ro",
    "FALLBACK_SUBTITLE_LANGUAGE=en",
]
VALID_ENV = "\n".join(VALID_LINES) + "\n"


def replace_line(env, old, new):
    line = old + "\n"
    assert line in env, f"fixture line not found: {old!r}"
    return env.replace(line, new + "\n")


class DockerEnvValidateTests(unittest.TestCase):
    def run_validator(self, content):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "env-under-test"
            path.write_text(content, encoding="utf-8")
            out = io.StringIO()
            with redirect_stdout(out):
                code = docker_env_validate.main([str(path)])
        return code, out.getvalue()

    def assert_reference_last(self, out):
        self.assertEqual(out.strip().splitlines()[-1], DOCS_LINE)

    def test_valid_env_exits_zero_with_reference_last(self):
        code, out = self.run_validator(VALID_ENV)
        self.assertEqual(code, 0)
        for prefix in ("error:", "warning:", "info:"):
            self.assertNotIn(prefix, out)
        self.assertEqual(out.strip(), DOCS_LINE)

    def test_missing_file_hints_docker_configure_and_exits_two(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = str(Path(tmp) / "absent.env")
            out = io.StringIO()
            with redirect_stdout(out):
                code = docker_env_validate.main([missing])
        output = out.getvalue()
        self.assertEqual(code, 2)
        self.assertTrue(output.startswith("error: "))
        self.assertIn("absent.env is missing", output)
        self.assertIn("make docker-configure", output)
        self.assertIn("1 error(s), 0 warning(s)", output)
        self.assertEqual(output.strip().splitlines()[-1], DOCS_LINE)

    def test_missing_required_key_reports_the_missing_key(self):
        env = replace_line(VALID_ENV, "APP_DATA_DIR=/srv/filelist/data", "# removed")
        code, out = self.run_validator(env)
        self.assertEqual(code, 2)
        self.assertIn("APP_DATA_DIR is required by compose.yml but is missing", out)

    def test_empty_required_key_is_rejected(self):
        env = replace_line(VALID_ENV, "APP_DATA_DIR=/srv/filelist/data", "APP_DATA_DIR=")
        code, out = self.run_validator(env)
        self.assertEqual(code, 2)
        self.assertIn("APP_DATA_DIR is required by compose.yml but the value is empty", out)

    def test_example_placeholder_path_is_rejected(self):
        env = replace_line(
            VALID_ENV,
            "APP_DATA_DIR=/srv/filelist/data",
            "APP_DATA_DIR=/absolute/path/to/filelist-data",
        )
        code, out = self.run_validator(env)
        self.assertEqual(code, 2)
        self.assertIn("still contains the example placeholder", out)

    def test_change_me_placeholder_is_rejected(self):
        env = replace_line(
            VALID_ENV,
            "QBITTORRENT_CONFIG_DIR=/srv/filelist/qbittorrent",
            "QBITTORRENT_CONFIG_DIR=CHANGE_ME",
        )
        code, out = self.run_validator(env)
        self.assertEqual(code, 2)
        self.assertIn(
            "QBITTORRENT_CONFIG_DIR still contains the example placeholder", out
        )

    def test_relative_required_path_is_rejected(self):
        env = replace_line(VALID_ENV, "DOWNLOADS_DIR=/mnt/big/downloads", "DOWNLOADS_DIR=downloads")
        code, out = self.run_validator(env)
        self.assertEqual(code, 2)
        self.assertIn('DOWNLOADS_DIR must be an absolute host path starting with "/"', out)

    def test_stale_keys_warn_without_failing(self):
        env = VALID_ENV + "".join(f"{key}=dummy-value\n" for key in STALE_KEYS)
        code, out = self.run_validator(env)
        self.assertEqual(code, 0)
        for key in STALE_KEYS:
            self.assertIn(
                f"warning: {key} is ignored by compose;"
                " see the migration section of the reference below",
                out,
            )
        self.assertIn("0 error(s), 5 warning(s)", out)
        self.assert_reference_last(out)

    def test_unknown_key_warns_and_compose_keys_pass_silently(self):
        env = VALID_ENV + "SOME_REMOVED_SETTING=1\nCOMPOSE_PROJECT_NAME=filelist\n"
        code, out = self.run_validator(env)
        self.assertEqual(code, 0)
        self.assertIn("warning: SOME_REMOVED_SETTING is ignored by compose", out)
        self.assertNotIn("COMPOSE_PROJECT_NAME", out)

    def test_bad_port_cidr_and_percent_report_one_error_each(self):
        env = replace_line(VALID_ENV, "SERVER_HOST_PORT=8097", "SERVER_HOST_PORT=70000")
        env = replace_line(
            env, f"TRUSTED_CIDRS={DEFAULT_CIDRS}", "TRUSTED_CIDRS=10.0.0.0/8,300.300.300.300/24"
        )
        env = replace_line(env, "WATCHED_THRESHOLD_PERCENT=90", "WATCHED_THRESHOLD_PERCENT=150")
        code, out = self.run_validator(env)
        self.assertEqual(code, 2)
        self.assertIn(
            'error: SERVER_HOST_PORT must be an integer between 1 and 65535 (got "70000")', out
        )
        self.assertIn("error: TRUSTED_CIDRS must be a comma-separated list of CIDRs", out)
        self.assertIn(
            'error: WATCHED_THRESHOLD_PERCENT must be an integer between 0 and 100 (got "150")',
            out,
        )
        self.assertIn("3 error(s), 0 warning(s)", out)

    def test_format_boundaries_and_shorthand_are_accepted(self):
        env = replace_line(VALID_ENV, "PAGID=", "PAGID=100,200")
        env = replace_line(env, "ALLOCATION_GB=15", "ALLOCATION_GB=15.5")
        env = replace_line(env, f"TRUSTED_CIDRS={DEFAULT_CIDRS}", "TRUSTED_CIDRS=192.168.1.10,::1")
        env = replace_line(env, "WATCHED_THRESHOLD_PERCENT=90", "WATCHED_THRESHOLD_PERCENT=100")
        code, out = self.run_validator(env)
        self.assertEqual(code, 0)

    def test_empty_optional_credentials_become_infos(self):
        env = replace_line(VALID_ENV, "FILELIST_USERNAME=filelist-user", "FILELIST_USERNAME=")
        env = replace_line(env, "FILELIST_PASSKEY=filelist-passkey", "FILELIST_PASSKEY=")
        env = replace_line(env, "TMDB_API_KEY=tmdb-key", "TMDB_API_KEY=")
        env = replace_line(env, "SUBDL_API_KEY=subdl-key", "SUBDL_API_KEY=")
        code, out = self.run_validator(env)
        self.assertEqual(code, 0)
        self.assertEqual(out.count("info: "), 4)
        for key in ("FILELIST_USERNAME", "FILELIST_PASSKEY", "TMDB_API_KEY", "SUBDL_API_KEY"):
            self.assertIn(f"info: {key} is (empty);", out)
        self.assertIn("the server still starts", out)
        self.assertIn("0 error(s), 4 warning(s)", out)
        self.assert_reference_last(out)

    def test_legal_notice_must_be_confirm_when_present(self):
        env = replace_line(VALID_ENV, "QBT_LEGAL_NOTICE=confirm", "QBT_LEGAL_NOTICE=accepted")
        code, out = self.run_validator(env)
        self.assertEqual(code, 2)
        self.assertIn(
            'error: QBT_LEGAL_NOTICE must be "confirm" to accept the qBittorrent legal notice',
            out,
        )

    def test_absent_legal_notice_is_allowed(self):
        env = replace_line(VALID_ENV, "QBT_LEGAL_NOTICE=confirm", "# compose defaults to confirm")
        code, out = self.run_validator(env)
        self.assertEqual(code, 0)

    def test_template_placeholders_produce_three_errors(self):
        env = replace_line(
            VALID_ENV,
            "APP_DATA_DIR=/srv/filelist/data",
            "APP_DATA_DIR=/absolute/path/to/filelist-data",
        )
        env = replace_line(
            env,
            "QBITTORRENT_CONFIG_DIR=/srv/filelist/qbittorrent",
            "QBITTORRENT_CONFIG_DIR=/absolute/path/to/qbittorrent-config",
        )
        env = replace_line(
            env,
            "DOWNLOADS_DIR=/mnt/big/downloads",
            "DOWNLOADS_DIR=/absolute/path/on-the-large-disk/filelist-downloads",
        )
        code, out = self.run_validator(env)
        self.assertEqual(code, 2)
        self.assertEqual(out.count("error:"), 3)
        self.assertIn("3 error(s), 0 warning(s)", out)

    def test_quotes_export_comments_and_compose_machinery_parse(self):
        env = (
            "# leading comment\n"
            "; also a comment\n"
            "\n"
            + VALID_ENV
            + 'export SERVER_HOST_PORT="8097"\n'
            + "TZ='Europe/Bucharest'\n"
            + "COMPOSE_PROJECT_NAME=filelist\n"
        )
        code, out = self.run_validator(env)
        self.assertEqual(code, 0)

    def test_duplicate_key_uses_last_value_like_compose(self):
        env = VALID_ENV + "SERVER_HOST_PORT=70000\nSERVER_HOST_PORT=8097\n"
        code, out = self.run_validator(env)
        self.assertEqual(code, 0)

    def test_duplicate_key_with_bad_final_value_errors_once(self):
        env = VALID_ENV + "SERVER_HOST_PORT=8097\nSERVER_HOST_PORT=70000\n"
        code, out = self.run_validator(env)
        self.assertEqual(code, 2)
        self.assertEqual(out.count("error: SERVER_HOST_PORT"), 1)

    def test_value_may_contain_equals(self):
        env = replace_line(
            VALID_ENV,
            "FILELIST_URL=https://filelist.io",
            "FILELIST_URL=https://filelist.io/?sort=name&x=1",
        )
        code, out = self.run_validator(env)
        self.assertEqual(code, 0)

    def test_malformed_line_reports_a_parse_error(self):
        code, out = self.run_validator(VALID_ENV + "JUST_A_TOKEN\n")
        self.assertEqual(code, 2)
        self.assertIn("expected KEY=VALUE", out)

    def test_invalid_key_name_reports_a_parse_error(self):
        code, out = self.run_validator(VALID_ENV + "1BAD=1\n")
        self.assertEqual(code, 2)
        self.assertIn("is not a valid variable name", out)

    def test_value_errors_never_echo_secret_values(self):
        message = docker_env_validate._value_error(
            "FILELIST_PASSKEY", "must be a passkey", "super-secret-passkey"
        )
        self.assertNotIn("super-secret-passkey", message)
        self.assertIn("FILELIST_PASSKEY", message)


if __name__ == "__main__":
    unittest.main()
