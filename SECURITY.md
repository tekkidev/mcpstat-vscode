# Security policy

Report suspected vulnerabilities privately to **hello@vadim.dev**. Include the
extension and VS Code versions, connection type, reproduction steps and potential
impact. Do not include credentials or production usage databases. Please do not
report vulnerabilities through public issues.

Security fixes apply to the current 0.3.x extension series.

The extension reads server-provided statistics and optional local SQLite data.
Workspace Trust is required for connections. HTTP bearer tokens are stored in
VS Code SecretStorage; saved source settings belong to the workspace, and chart
history stays in memory. The configured Python executable runs on the workspace
extension host for database access. Configure one you trust.

Authorize statistics tools in the MCP server and protect database files with
appropriate filesystem permissions. Handler names, descriptions and tags may
contain sensitive information. MCP invocation permissions are controlled by
VS Code and the server. The read-only database adapter preserves schema and
statistics; SQLite may use its normal shared-memory coordination files.

Third-party licenses are listed in [ThirdPartyNotices.md](ThirdPartyNotices.md).
The project's [MIT license](LICENSE) includes its warranty disclaimer.

Copyright (c) 2026 Vadim Bakhrenkov. SPDX-License-Identifier: MIT.
