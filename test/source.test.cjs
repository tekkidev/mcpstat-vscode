// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const vm = require('node:vm');

test('reader failures preserve specific safe diagnostics without forwarding interpreter output', async () => {
    const filename = join(__dirname, '../out/source.js');
    const actualRequire = createRequire(filename);
    const scenarios = [
        [{ code: 'ENOENT' }, '', /Python was not found/],
        [{ code: 1 }, '{"error_code":"unsupported_schema"}', /not mcpstat schema 4/],
        [{ code: 1 }, '{"error_code":"invalid_database"}', /Connect MCP server/],
        [{ code: 1 }, '{"error_code":"missing_sqlite"}', /lacks SQLite support/],
        [{ code: 1 }, '{"error_code":"missing_database"}', /no longer exists/],
        [{ code: 1 }, '{"error_code":"__proto__"}', /could not start/],
        [{ killed: true }, '', /exceeded its time or output limit/],
        [{ code: 1 }, 'private interpreter diagnostic', /could not start/],
    ];
    for (const [error, stdout, expected] of scenarios) {
        const exports = {};
        vm.runInNewContext(readFileSync(filename, 'utf8'), { exports, require: name =>
            name === 'node:child_process' ? { execFile: (_python, args, options, callback) => {
                assert.equal(options.shell, false);
                assert.ok(args.includes('--server=-weather'));
                callback(error, stdout);
            } } : actualRequire(name) }, { filename });
        await assert.rejects(exports.readDatabase('python', 'reader.py', 'synthetic.sqlite',
            new AbortController().signal, '-weather'), expected);
    }
});
