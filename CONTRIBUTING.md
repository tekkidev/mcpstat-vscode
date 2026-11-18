# Contributing to mcpstat for Visual Studio Code

This repository contains the VS Code extension. The Python library is maintained
separately at [tekkidev/mcpstat](https://github.com/tekkidev/mcpstat).
Use Node.js 22+ and Python 3.10+. From the repository root:

```bash
npm ci --ignore-scripts
npm test
python -m unittest discover -s test -p 'test_*.py' -v
npm run test:ui
npm run package
code --install-extension ./mcpstat-dashboard-0.3.0.vsix --force
```

The browser check uses an installed Chrome/Chromium executable, selected with
`CHROME_PATH` if necessary. It uses synthetic data, checks interactions and injection
handling, and can write a screenshot when `MCPSTAT_SCREENSHOT` names an output file.
Build tools and tests are excluded from the VSIX.
CI uploads the tested `mcpstat-dashboard.vsix` as the `mcpstat-dashboard-vsix`
workflow artifact.

## Debug with F5

Open this repository's root in VS Code and run `npm ci --ignore-scripts` once.
Select **Run mcpstat extension** in Run and Debug, then press **F5**. The pre-launch
task builds the extension and opens an Extension Development Host with a temporary
profile. Run **mcpstat: Get Started** or **mcpstat: Open Dashboard** there. Add a
synthetic MCP server to that profile when testing editor connections.

Set breakpoints in `src/extension.ts`. The bundled source map maps execution back
to TypeScript; it is excluded from the VSIX. After changing source or webview files,
stop debugging and press F5 again to rebuild. The extension-host debugger does not
attach to webview scripts; use **Developer: Open Webview Developer Tools** in the
development window to inspect those.

## Assets and verification

The build copies the Bootstrap Icons font locally and regenerates
`ThirdPartyNotices.md` from bundled dependencies and assets. Retain upstream license
and NOTICE files when adding dependencies. The Bootstrap Icons notice covers its
WOFF2 icon font, glyph CSS, SVG logo and derived PNG. The logo source is
`media/icons/logo.svg`; `media/icon.png` is its transparent 512-pixel Marketplace
version with a violet-to-cyan gradient, regenerated with `npm run icon`. Marketplace icons must be PNG rather than SVG.

Use synthetic data for screenshots. Set `MCPSTAT_SCREENSHOT` to a temporary PNG path
when running `npm run test:ui` to capture dark and light previews. Review the images
before updating `media/screenshots/dashboard.png`. Keep the main screenshot focused
on the populated dashboard, with calls, errors, latency, charts and handler inventory.

To verify a live server, install `mcpstat[server]==0.3.0` in a separate environment
and run `test/verify_mcp.py` with that environment's Python and a fresh output directory.
Run outside the source checkout so imports resolve to the installed distribution.
The check uses the synthetic weather fixture in `test/fixtures/http_server.py`, compares
its statistics with the database reader and verifies persistence after restart in
both MCP client modes.

The extension's build and tests do not need a sibling checkout of the library.
To test a library change, install its wheel in the isolated server
environment instead of the PyPI release.

`npm run package` resolves relative README links and screenshots against this
repository's default branch on GitHub.

Run `npm run test:mcp` with `MCPSTAT_TEST_PYTHON` pointing to that environment's Python
to verify live HTTP polling, authentication and chart deltas. `npm run test:vscode`
uses an installed VS Code executable (`VSCODE_EXECUTABLE` if necessary) and a temporary
profile to verify the editor's actual MCP connection. Its synthetic provider and
workbench startup commands are confined to the test fixture.
Set `MCPSTAT_TEST_APPROVAL=1` for the editor check to exercise an unannotated statistics
tool. Browser automation approves only the synthetic tool in an isolated editor,
waits beyond 15 seconds before the first approval and checks that a manual dashboard
connection does not repeatedly prompt. This check needs `playwright-core` and uses a
temporary loopback debugging port.

## Security checks

Run `npm audit --omit=dev` to check runtime dependencies. CI runs the build and
tests; CodeQL scans TypeScript, JavaScript, Python and GitHub Actions.

Keep snapshot parsing and calculations in `src/model.ts`, shared by the extension
and browser builds. Keep database access read-only and limited to schema 4. Preserve
server/primitive identities, unknown historical measurements and collection gaps.
Test against synthetic servers and databases only. Keep HTTP polling restricted to
the configured origin and selected statistics tool. Keep credentials in SecretStorage
and ensure saved source profiles contain connection settings only.

Copyright (c) 2026 Vadim Bakhrenkov. SPDX-License-Identifier: MIT.
