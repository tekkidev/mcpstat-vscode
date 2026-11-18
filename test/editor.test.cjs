// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');

function harness() {
    const name = 'mcp_synthetic_get_tool_usage_stats';
    let finish, fail, cancelled = 0, disposed = 0, invoked = 0, now = 0, timerId = 0;
    const timers = new Map();
    class LanguageModelTextPart { constructor(value) { this.value = value; } }
    const vscode = { LanguageModelTextPart, lm: { tools: [{ name }], invokeTool: () => {
        invoked++;
        return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    } }, CancellationTokenSource: class {
        token = {}; cancel() { cancelled++; } dispose() { disposed++; }
    } };
    const filename = resolve(__dirname, '../out/editor.js');
    const realRequire = createRequire(filename), exports = {};
    vm.runInNewContext(readFileSync(filename, 'utf8'), { exports,
        require: name => name === 'vscode' ? vscode : realRequire(name), Buffer,
        setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; },
        clearTimeout: id => timers.delete(id) }, { filename });
    return { ...exports, name, timers, get invoked() { return invoked; },
        get cancelled() { return cancelled; }, get disposed() { return disposed; },
        respond: (text = '{"stats":[]}') => finish({ content: [new LanguageModelTextPart(text)] }),
        deny: () => fail(new Error('Host approval was cancelled.')),
        advance: ms => { now += ms; for (const [id, timer] of timers) {
            if (timer.at <= now) { timers.delete(id); timer.fn(); }
        } } };
}

test('approval after the former 15-second deadline still produces statistics', async () => {
    const app = harness();
    const request = app.readEditor(app.name, new AbortController().signal);
    app.advance(16000);
    assert.equal(app.cancelled, 0);
    app.respond();
    assert.equal((await request).stats.length, 0);
    assert.equal(app.timers.size, 0);
    assert.equal(app.disposed, 1);
});

test('editor requests remain bounded while waiting for approval', async () => {
    const app = harness();
    const request = app.readEditor(app.name, new AbortController().signal);
    app.advance(app.EDITOR_REQUEST_TIMEOUT);
    await assert.rejects(request, /timed out after two minutes/);
    assert.equal(app.cancelled, 1);
    assert.equal(app.disposed, 1);
});

test('denial, cancellation and malformed responses produce actionable, bounded errors', async () => {
    const denied = harness();
    const request = denied.readEditor(denied.name, new AbortController().signal);
    denied.deny();
    await assert.rejects(request, /Use Refresh|use Refresh/);
    assert.equal(denied.timers.size, 0);
    const cancelled = harness(), controller = new AbortController();
    const pending = cancelled.readEditor(cancelled.name, controller.signal);
    controller.abort();
    await assert.rejects(pending, /cancelled/);
    assert.equal(cancelled.cancelled, 1);
    const malformed = harness();
    const invalid = malformed.readEditor(malformed.name, new AbortController().signal);
    malformed.respond('private-response-must-not-appear');
    await assert.rejects(invalid, error => /supported mcpstat/.test(error.message) && !error.message.includes('private-response'));
    const aborted = harness();
    await assert.rejects(aborted.readEditor(aborted.name, AbortSignal.abort()), /cancelled/);
    assert.equal(aborted.invoked, 0);
});
