// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT

/** Fixed public destinations shared by rendered links and host-side actions. */
export const links: Readonly<Record<string, string>> = {
    approvals: 'https://code.visualstudio.com/docs/agents/run/approvals#manage-tool-approvals',
    docs: 'https://mcpstat.vadim.dev',
    integration: 'https://github.com/tekkidev/mcpstat/blob/main/docs/quickstart.md',
    library: 'https://github.com/tekkidev/mcpstat',
    source: 'https://github.com/tekkidev/mcpstat-vscode',
    issues: 'https://github.com/tekkidev/mcpstat-vscode/issues',
    license: 'https://github.com/tekkidev/mcpstat-vscode/blob/main/LICENSE',
    notices: 'https://github.com/tekkidev/mcpstat-vscode/blob/main/ThirdPartyNotices.md',
    pypi: 'https://pypi.org/project/mcpstat/',
    registry: 'https://registry.modelcontextprotocol.io/?q=io.github.tekkidev%2Fmcpstat',
    security: 'https://github.com/tekkidev/mcpstat-vscode/blob/main/SECURITY.md',
};
