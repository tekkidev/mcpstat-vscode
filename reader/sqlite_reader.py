#!/usr/bin/env python3
"""Read bounded mcpstat schema-4 snapshots without importing or modifying mcpstat.

Copyright (c) 2026 Vadim Bakhrenkov
SPDX-License-Identifier: MIT
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

# The configured executable can be older than the reader's supported minimum.
if sys.version_info < (3, 10):  # noqa: UP036
    print(json.dumps({"error_code": "unsupported_python"}))
    sys.exit(1)

try:
    import sqlite3
except ImportError:
    print(json.dumps({"error_code": "missing_sqlite"}))
    sys.exit(1)

MAX_ROWS = 1000
MAX_BYTES = 4 * 1024 * 1024
# Allow 50 tags of 100 characters, including JSON-escaped surrogate pairs.
MAX_TAG_JSON_BYTES = 50 * (100 * 12 + 4) + 2
ERRORS = {
    "invalid_database": "Select an existing mcpstat SQLite database, not a JSON file.",
    "unsupported_schema": "This dashboard requires mcpstat 0.3.0 or newer with database schema 4.",
    "invalid_servers": "The database contains too many or invalid server identities.",
    "missing_server": "The selected server is no longer present in this database.",
    "too_large": "Statistics exceed the dashboard's 4 MiB limit.",
}


class ReaderError(ValueError):
    """A fixed diagnostic code, safe to pass to the extension without private data."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(ERRORS[code])


def read_snapshot(path: Path, server: str | None = None) -> dict[str, Any]:
    """Use one read transaction, including committed WAL data from active writers."""
    path = path.resolve(strict=True)
    if not path.is_file():
        raise ReaderError("invalid_database")
    with path.open("rb") as file:
        if file.read(16) != b"SQLite format 3\0":
            raise ReaderError("invalid_database")
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.5)
    connection.row_factory = sqlite3.Row
    deadline = time.monotonic() + 2
    connection.set_progress_handler(lambda: int(time.monotonic() > deadline), 1000)
    if hasattr(connection, "setlimit"):
        connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, MAX_BYTES)
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("PRAGMA trusted_schema=OFF")
        connection.execute("BEGIN")
        if connection.execute("PRAGMA user_version").fetchone()[0] != 4:
            raise ReaderError("unsupported_schema")
        servers = [
            row[0]
            for row in connection.execute(
                "SELECT substr(server,1,2049) FROM mcpstat_usage UNION "
                "SELECT substr(server,1,2049) FROM mcpstat_metadata LIMIT 101"
            )
        ]
        if len(servers) > 100 or any(
            not isinstance(name, str) or len(name) > 2048 for name in servers
        ):
            raise ReaderError("invalid_servers")
        if server is None:
            return {"servers": servers}
        if server not in servers:
            raise ReaderError("missing_server")
        query = """WITH identities AS (
            SELECT type,name FROM mcpstat_usage WHERE server=? UNION
            SELECT type,name FROM mcpstat_metadata WHERE server=? AND active=1)
            SELECT i.type,substr(i.name,1,2049) AS name,
                COALESCE(u.call_count,0) AS call_count,
                COALESCE(u.success_count,0) AS success_count,
                COALESCE(u.error_count,0) AS error_count,
                COALESCE(u.cancelled_count,0) AS cancelled_count,
                COALESCE(u.incomplete_count,0) AS incomplete_count,
                COALESCE(u.total_duration_ms,0) AS total_duration_ms,
                COALESCE(u.duration_sample_count,0) AS duration_sample_count,
                COALESCE(u.total_input_tokens,0) AS total_input_tokens,
                COALESCE(u.total_output_tokens,0) AS total_output_tokens,
                COALESCE(u.estimated_tokens,0) AS estimated_tokens,
                u.last_accessed,u.min_duration_ms,u.max_duration_ms,
                COALESCE(u.latency_complete,1) AS latency_complete,
                CASE WHEN length(CAST(COALESCE(m.tags,'[]') AS BLOB)) <= ?
                    THEN COALESCE(m.tags,'[]') ELSE NULL END AS tags,
                substr(COALESCE(m.short_description,''),1,4097) AS short_description
            FROM identities i
            LEFT JOIN mcpstat_usage u ON u.server=? AND u.type=i.type AND u.name=i.name
            LEFT JOIN mcpstat_metadata m ON m.server=? AND m.type=i.type AND m.name=i.name
            ORDER BY call_count DESC,i.type,i.name LIMIT ?"""
        rows = connection.execute(
            query, (server, server, MAX_TAG_JSON_BYTES, server, server, MAX_ROWS + 1)
        ).fetchall()
        result = []
        for row in rows[:MAX_ROWS]:
            item = dict(row)
            if item["tags"] is None:
                raise ValueError("Invalid statistics tags")
            item["tags"] = json.loads(item["tags"])
            if not isinstance(item["tags"], list) or len(item["tags"]) > 50 or any(
                not isinstance(tag, str) or len(tag) > 100
                for tag in item["tags"]
            ):
                raise ValueError("Invalid statistics tags")
            result.append(item)
        return {"stats": result, "tracked_count": len(rows)}
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", type=Path)
    parser.add_argument("--server")
    arguments = parser.parse_args()
    try:
        result = read_snapshot(arguments.database, arguments.server)
        encoded = json.dumps(result, ensure_ascii=True, allow_nan=False)
        if len(encoded.encode("utf-8")) > MAX_BYTES:
            raise ReaderError("too_large")
        print(encoded)
    except ReaderError as error:
        print(json.dumps({"error_code": error.code}))
        sys.exit(1)
    except FileNotFoundError:
        print(json.dumps({"error_code": "missing_database"}))
        sys.exit(1)
    except PermissionError:
        print(json.dumps({"error_code": "permission_denied"}))
        sys.exit(1)
    except ValueError:
        print(json.dumps({"error_code": "invalid_data"}))
        sys.exit(1)
    except (OSError, sqlite3.Error):
        print(json.dumps({"error_code": "unavailable_database"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
