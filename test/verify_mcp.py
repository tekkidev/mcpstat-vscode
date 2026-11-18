"""Verify dashboard inputs against an installed mcpstat and a live weather server.

Copyright (c) 2026 Vadim Bakhrenkov
SPDX-License-Identifier: MIT
"""

from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import subprocess
import sys
from importlib.metadata import version
from pathlib import Path
from typing import Any

from mcp import Client
from mcp.client.stdio import StdioServerParameters

READER = Path(__file__).resolve().parents[1] / "reader" / "sqlite_reader.py"
SERVER = Path(__file__).resolve().parent / "fixtures" / "http_server.py"


async def verify(output: Path) -> None:
    assert version("mcpstat") == "0.3.0", "Use an isolated installation of mcpstat 0.3.0"
    output.mkdir(parents=True, exist_ok=True)
    server = output / "weather_server.py"
    shutil.copyfile(SERVER, server)
    for mode in ("auto", "legacy"):
        database = output / f"{mode}.sqlite"
        assert not database.exists(), "Use a fresh synthetic output directory"
        params = StdioServerParameters(
            command=sys.executable,
            args=[str(server), "--stdio", "--database", str(database)],
            env={
                "MCPSTAT_DB_PATH": str(database),
                "MCPSTAT_LOG_ENABLED": "false",
                "OTEL_SDK_DISABLED": "true",
                "OTEL_PROPAGATORS": "none",
            },
        )
        async with Client(params, mode=mode) as client:
            for city in ("London", "Paris"):
                result = await client.call_tool("get_weather", {"city": city})
                assert not result.is_error
            failure = await client.call_tool("fail_tool", {})
            assert failure.is_error

            def read(database: Path = database) -> dict[str, Any]:
                result = subprocess.run(
                    [sys.executable, "-I", "-S", str(READER), str(database), "--server", "weather"],
                    capture_output=True,
                    text=True,
                    check=True,
                    timeout=6,
                )
                return json.loads(result.stdout)  # type: ignore[no-any-return]

            # Read from the active WAL while the MCP server records another call.
            await asyncio.gather(
                asyncio.to_thread(read), client.call_tool("get_weather", {"city": "Tokyo"})
            )
            result = await client.call_tool("get_tool_usage_stats", {})
            stats = result.structured_content
            assert stats is not None
            stored = read()
            for payload in (stats, stored):
                rows = {row["name"]: row for row in payload["stats"]}
                assert rows["get_weather"]["call_count"] == 3
                assert rows["get_weather"]["success_count"] == 3
                assert rows["get_weather"]["duration_sample_count"] == 3
                assert rows["fail_tool"]["error_count"] == 1
                assert rows["unused_tool"]["call_count"] == 0
            (output / f"{mode}-tool-result.json").write_text(json.dumps(stats), encoding="utf-8")
            (output / f"{mode}-database-result.json").write_text(
                json.dumps(stored), encoding="utf-8"
            )
        async with Client(params, mode=mode) as client:
            stats = (await client.call_tool("get_tool_usage_stats", {})).structured_content
            assert stats is not None
            assert (
                next(row for row in stats["stats"] if row["name"] == "get_weather")["call_count"]
                == 3
            )
        print(
            f"PASS {mode}: installed library, local MCP requests, live WAL reader, outcomes, unused tools and restart persistence"
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "output", type=Path, help="Fresh directory for synthetic verification files"
    )
    arguments = parser.parse_args()
    asyncio.run(asyncio.wait_for(verify(arguments.output.resolve()), timeout=60))
