# Track calls in your server

The extension displays statistics recorded by the Python mcpstat library. Install
**mcpstat 0.3.0** in your MCP server's environment, add tracking to its handlers,
and register the `get_tool_usage_stats` tool. Restart the server after setup.

Installing the extension alone does not instrument other MCP servers.
Follow the [integration guide](https://github.com/tekkidev/mcpstat/blob/main/docs/quickstart.md)
for a working example.
