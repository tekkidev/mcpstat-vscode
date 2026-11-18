// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT

// Configure this bundled validator before the MCP client's schemas initialize.
// JIT-free validation also avoids browser-environment probing in the extension host.
const { config }: typeof import('zod/v4/core') = require('zod/v4/core');
config({ jitless: true });
const extension: typeof import('./extension') = require('./extension');
export const activate = extension.activate;
