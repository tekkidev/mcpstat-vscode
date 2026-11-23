"""Verify read-only access, isolation and bounded mcpstat database snapshots.

Copyright (c) 2026 Vadim Bakhrenkov
SPDX-License-Identifier: MIT
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
from typing import Any

READER = Path(__file__).resolve().parents[1] / "reader" / "sqlite_reader.py"
SPEC = importlib.util.spec_from_file_location("sqlite_reader", READER)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReadOnlyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory(prefix="mcpstat-reader-")
        self.path = Path(self.directory.name) / "stats.sqlite"
        self.connection = sqlite3.connect(self.path)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA user_version=4")
        self.connection.execute(
            """CREATE TABLE mcpstat_usage (
                server TEXT,type TEXT,name TEXT,call_count INTEGER DEFAULT 0,
                success_count INTEGER DEFAULT 0,error_count INTEGER DEFAULT 0,
                cancelled_count INTEGER DEFAULT 0,incomplete_count INTEGER DEFAULT 0,
                total_duration_ms INTEGER DEFAULT 0,duration_sample_count INTEGER DEFAULT 0,
                total_input_tokens INTEGER DEFAULT 0,total_output_tokens INTEGER DEFAULT 0,
                estimated_tokens INTEGER DEFAULT 0,last_accessed TEXT,
                min_duration_ms INTEGER,max_duration_ms INTEGER,latency_complete INTEGER DEFAULT 1)"""
        )
        self.connection.execute(
            "CREATE TABLE mcpstat_metadata (server TEXT,type TEXT,name TEXT,tags TEXT DEFAULT '[]',short_description TEXT,active INTEGER DEFAULT 1)"
        )
        self.connection.execute(
            "INSERT INTO mcpstat_usage (server,type,name,call_count,success_count) VALUES ('weather','tool','get_weather',2,2)"
        )
        self.connection.execute(
            "INSERT INTO mcpstat_usage (server,type,name,call_count) VALUES ('other','tool','get_weather',999)"
        )
        self.connection.execute(
            "INSERT INTO mcpstat_metadata (server,type,name) VALUES ('weather','tool','unused_tool')"
        )
        self.connection.commit()

    def tearDown(self) -> None:
        self.connection.close()
        self.directory.cleanup()

    def read(self, server: str | None = None) -> dict[str, Any]:
        return MODULE.read_snapshot(self.path, server)  # type: ignore[no-any-return]

    def test_live_wal_is_read_without_modifying_database_or_wal(self) -> None:
        def hashes() -> dict[str, str]:
            return {
                path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                for path in Path(self.directory.name).glob("stats.sqlite*")
                if not path.name.endswith("-shm")
            }

        before = hashes()
        result = self.read("weather")
        self.assertEqual(result["stats"][0]["call_count"], 2)
        self.assertEqual(result["stats"][1]["name"], "unused_tool")
        self.assertEqual(result["stats"][1]["call_count"], 0)
        self.assertEqual(hashes(), before)
        self.connection.execute("BEGIN IMMEDIATE")
        self.connection.execute("UPDATE mcpstat_usage SET call_count=3 WHERE server='weather'")
        self.assertEqual(self.read("weather")["stats"][0]["call_count"], 2)
        self.connection.commit()
        self.assertEqual(self.read("weather")["stats"][0]["call_count"], 3)

    def test_isolation_and_bound_parameters(self) -> None:
        self.assertEqual(set(self.read()["servers"]), {"weather", "other"})
        self.assertEqual(self.read("other")["stats"][0]["call_count"], 999)
        with self.assertRaises(ValueError):
            self.read("weather' OR 1=1 --")

    def test_row_limit_reports_truncation(self) -> None:
        self.connection.executemany(
            "INSERT INTO mcpstat_metadata (server,type,name) VALUES ('weather','tool',?)",
            [(f"tool_{index}",) for index in range(1005)],
        )
        self.connection.commit()
        result = self.read("weather")
        self.assertEqual(len(result["stats"]), 1000)
        self.assertGreater(result["tracked_count"], 1000)

    def test_other_schema_versions_are_not_migrated(self) -> None:
        for version in (3, 5):
            self.connection.execute(f"PRAGMA user_version={version}")
            self.connection.commit()
            with self.assertRaisesRegex(ValueError, "schema 4"):
                self.read("weather")
            self.assertEqual(self.connection.execute("PRAGMA user_version").fetchone()[0], version)

    def test_unicode_tags_are_read_intact_and_invalid_tags_are_bounded(self) -> None:
        for character, repetitions in (("界", 98), ("\U0001f30d", 98)):
            tags = [character * repetitions + f"{index:02d}" for index in range(50)]
            encoded = json.dumps(tags)
            self.assertGreater(len(encoded), 16384)
            self.connection.execute("UPDATE mcpstat_metadata SET tags=?", (encoded,))
            self.connection.commit()
            self.assertEqual(self.read("weather")["stats"][1]["tags"], tags)
        for value in ("[", json.dumps(["tag"] * 51), json.dumps([123]),
                      json.dumps(["\U0001f30d" * 101])):
            self.connection.execute("UPDATE mcpstat_metadata SET tags=?", (value,))
            self.connection.commit()
            with self.assertRaises(ValueError):
                self.read("weather")
        self.connection.execute(
            "UPDATE mcpstat_metadata SET tags=?", (" " * (MODULE.MAX_TAG_JSON_BYTES + 1),)
        )
        self.connection.commit()
        with self.assertRaises(ValueError):
            self.read("weather")

    def test_embedded_nul_cannot_bypass_tag_size_limit(self) -> None:
        value = "[]\0" + "x" * (MODULE.MAX_TAG_JSON_BYTES + 1)
        self.connection.execute("UPDATE mcpstat_metadata SET tags=?", (value,))
        self.connection.commit()
        loads = json.loads

        def bounded_loads(value: str) -> Any:
            self.assertLessEqual(len(value.encode("utf-8")), MODULE.MAX_TAG_JSON_BYTES)
            return loads(value)

        with patch.object(MODULE.json, "loads", side_effect=bounded_loads):
            with self.assertRaises(ValueError):
                self.read("weather")

    def test_cli_is_dependency_free_and_does_not_leak_private_paths(self) -> None:
        result = subprocess.run(
            [sys.executable, "-I", "-S", str(READER), str(self.path), "--server", "weather"],
            check=True,
            capture_output=True,
            text=True,
            timeout=6,
        )
        self.assertEqual(json.loads(result.stdout)["stats"][0]["call_count"], 2)
        missing = Path(self.directory.name) / "private-missing.sqlite"
        result = subprocess.run(
            [sys.executable, "-I", "-S", str(READER), str(missing)],
            check=False,
            capture_output=True,
            text=True,
            timeout=6,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(str(missing), result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)["error_code"], "missing_database")
        self.assertFalse(missing.exists())

    def test_cli_distinguishes_json_from_old_database_schema(self) -> None:
        snapshot = Path(self.directory.name) / "snapshot.json"
        snapshot.write_text('{"stats": []}', encoding="utf-8")
        for path, code in ((snapshot, "invalid_database"), (self.path, "unsupported_schema")):
            self.connection.execute("PRAGMA user_version=3")
            self.connection.commit()
            result = subprocess.run(
                [sys.executable, "-I", "-S", str(READER), str(path)],
                check=False,
                capture_output=True,
                text=True,
                timeout=6,
            )
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)["error_code"], code)
            self.assertNotIn(str(path), result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
