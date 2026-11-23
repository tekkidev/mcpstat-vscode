# Changelog

## 0.3.1 - 2026-11-23

### Improvements

- Reduce repeated statistics transfers and dashboard redraws during refresh,
  search and sorting.
- Remember the tool-approval reminder for the saved editor connection and keep
  instructions available through the Tool approvals button.
- Show unavailable measurements as a dash, with explanatory tooltips.

### Security

- Verify the origin of incoming dashboard messages.

### Fixed

- Read valid Unicode tags consistently from MCP tools and SQLite databases.

## 0.3.0

### Features

- View mcpstat statistics through VS Code's existing MCP tools, a Streamable HTTP
  endpoint, or a schema-4 SQLite database opened read-only.
- Compare handler usage, outcomes, latency and token measurements. Filter tools,
  prompts and resources by name or tag, and chart changes observed during a session.
- Follow the setup walkthrough and optionally show connection status and the latest
  statistics in the Activity Bar.
