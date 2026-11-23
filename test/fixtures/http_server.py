#!/usr/bin/env python3
"""Serve synthetic, mcpstat-instrumented weather tools over HTTP for integration tests.

Copyright (c) 2026 Vadim Bakhrenkov
SPDX-License-Identifier: MIT
"""

from __future__ import annotations

import argparse
import hmac
import os
from contextlib import asynccontextmanager
from importlib.metadata import version
from typing import TYPE_CHECKING, Any

import uvicorn
from mcp.server import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations

from mcpstat import MCPStat, disable_sdk_tracing

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from starlette.types import Receive, Scope, Send


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    transport = parser.add_mutually_exclusive_group(required=True)
    transport.add_argument("--port", type=int)
    transport.add_argument("--stdio", action="store_true")
    parser.add_argument("--database", required=True)
    arguments = parser.parse_args()
    assert version("mcpstat").startswith("0.3.")
    stat = MCPStat("weather", db_path=arguments.database, log_enabled=False)

    @asynccontextmanager
    async def lifespan(server: MCPServer) -> AsyncIterator[dict[str, Any]]:
        try:
            await stat.sync_tools(await server.list_tools())
            yield {}
        finally:
            stat.close()

    app = MCPServer("weather", lifespan=lifespan)
    disable_sdk_tracing(app)

    @app.tool(
        annotations=ToolAnnotations(
            read_only_hint=True, destructive_hint=False, open_world_hint=False
        )
    )
    @stat.track(name="get_weather")
    async def get_weather(city: str) -> dict[str, Any]:
        """Return synthetic weather for a requested city."""
        return {"city": city, "temperature_c": 21}

    @app.tool()
    @stat.track(name="fail_tool")
    async def fail_tool() -> str:
        """Return an intentional tool error."""
        raise ToolError("Intentional synthetic error")

    @app.tool()
    @stat.track(name="unused_tool")
    async def unused_tool() -> str:
        """Provide an unused registration."""
        return "Unused synthetic tool"

    @app.tool(
        annotations=(
            None
            if os.environ.get("MCPSTAT_TEST_APPROVAL") == "1"
            else ToolAnnotations(read_only_hint=True, destructive_hint=False, open_world_hint=False)
        )
    )
    async def get_tool_usage_stats() -> dict[str, Any]:
        """Return cumulative usage statistics."""
        return await stat.get_stats()

    if arguments.stdio:
        app.run()
        return
    asgi = app.streamable_http_app(json_response=True, host="127.0.0.1")
    token = os.environ.get("MCPSTAT_TEST_TOKEN", "")

    async def authenticated(scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and token:
            header = dict(scope["headers"]).get(b"authorization", b"")
            if not hmac.compare_digest(header, f"Bearer {token}".encode()):
                await send({"type": "http.response.start", "status": 401, "headers": []})
                await send({"type": "http.response.body", "body": b"Authentication required"})
                return
        await asgi(scope, receive, send)

    uvicorn.run(authenticated, host="127.0.0.1", port=arguments.port, log_level="error")


if __name__ == "__main__":
    main()
