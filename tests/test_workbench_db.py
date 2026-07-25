import importlib.util
import json
import stat
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "scripts" / "workbench_db.py"
SPEC = importlib.util.spec_from_file_location("workbench_db", MODULE_PATH)
workbench_db = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(workbench_db)


class WorkbenchDbTest(unittest.TestCase):
    def test_allows_private_business_paths_and_rejects_other_service_families(self):
        self.assertEqual(
            workbench_db.normalize_path("/api/candidates?q=Agent"),
            "/api/candidates?q=Agent",
        )
        for path in (
            "/api/connector/tasks/claim",
            "/api/candidate-ingest/tasks",
            "/api/public/jd-intakes",
            "https://example.com/api/candidates",
        ):
            with self.assertRaises(SystemExit):
                workbench_db.normalize_path(path)

    def test_configure_writes_owner_only_config_without_echoing_token(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            args = workbench_db.parser().parse_args([
                "configure", "--url", "https://workbench.example",
                "--token-stdin", "--config", str(path),
            ])
            original = workbench_db.sys.stdin
            workbench_db.sys.stdin = type("Input", (), {"read": lambda self: "x" * 40})()
            try:
                workbench_db.configure(args)
            finally:
                workbench_db.sys.stdin = original
            payload = json.loads(path.read_text())
            self.assertEqual(payload["url"], "https://workbench.example")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)


if __name__ == "__main__":
    unittest.main()
