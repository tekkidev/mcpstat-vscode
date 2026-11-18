# Choose a connection

- **VS Code:** start your server in the editor, then choose its prefixed
  `get_tool_usage_stats` tool. The dashboard uses the editor's existing connection.
- **HTTP:** select **Connect an HTTP MCP endpoint** and enter the Streamable HTTP
  URL. Use HTTPS remotely. Anonymous access and bearer tokens are supported.
- **SQLite:** select an existing mcpstat schema-4 database. Set **mcpstat: Python
  Path** to a Python 3.10+ executable on the workspace host if needed.

Connections require a trusted workspace. If a server has no compatible statistics,
the dashboard shows a link to the integration guide.
