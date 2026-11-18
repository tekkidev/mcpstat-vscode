// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');

const candidate = { name: 'mcp_synthetic_get_tool_usage_stats', description: 'Usage statistics' };
function harness(aiDisabled = false, action = 'Copy discovery summary') {
    const callbacks = {};
    let tools = [], poll, cleared = 0, copied, message, command;
    const picker = { items: [], activeItems: [], selectedItems: [], disposed: false,
        onDidAccept: fn => { callbacks.accept = fn; return { dispose() {} }; },
        onDidHide: fn => { callbacks.hide = fn; return { dispose() {} }; },
        show() {}, dispose() { this.disposed = true; } };
    const exports = {};
    const filename = resolve(__dirname, '../out/discovery.js');
    const realRequire = createRequire(filename);
    const vscode = {
        window: { createQuickPick: () => picker, showInformationMessage: async value => { message = value; return action; } },
        workspace: { getConfiguration: () => ({ get: () => aiDisabled }) },
        commands: { executeCommand: async (...args) => { command = args; } },
        lm: { get tools() { return tools; } }, version: '1.146.0',
        env: { clipboard: { writeText: async value => { copied = value; } } },
    };
    vm.runInNewContext(readFileSync(filename, 'utf8'), { exports,
        require: name => name === 'vscode' ? vscode : name === './editor' ? { statisticsTools: () => tools } : realRequire(name),
        setInterval: fn => { poll = fn; return 1; }, clearInterval: () => { cleared++; }, Date }, { filename });
    return { ...exports, picker, callbacks, setTools: value => { tools = value; },
        tick: () => poll(), get cleared() { return cleared; }, get copied() { return copied; },
        get message() { return message; }, get command() { return command; } };
}

test('an initially empty catalog discovers a later STDIO tool without reopening the picker', async () => {
    const app = harness();
    const selected = app.chooseSource(() => true);
    assert.equal(app.picker.items[0].sourceKind, 'discovery');
    assert.equal(app.picker.busy, true);
    app.setTools([candidate]);
    app.tick();
    assert.equal(app.picker.items[0].tool, candidate.name);
    assert.equal(app.picker.activeItems[0].sourceKind, 'editor');
    assert.equal(app.picker.busy, false);
    app.picker.selectedItems = [app.picker.activeItems[0]];
    app.callbacks.accept();
    assert.equal((await selected).tool, candidate.name);
    assert.equal(app.picker.disposed, true);
    assert.equal(app.cleared, 1);
});

test('a catalog refresh preserves an explicitly selected HTTP option', async () => {
    const app = harness();
    const selected = app.chooseSource(() => true);
    app.picker.activeItems = [app.picker.items.find(item => item.sourceKind === 'http')];
    app.setTools([candidate]); app.tick();
    assert.equal(app.picker.activeItems[0].sourceKind, 'http');
    app.picker.selectedItems = [app.picker.activeItems[0]]; app.callbacks.accept();
    assert.equal((await selected).sourceKind, 'http');
});

test('closing or invalidating discovery disposes its timer and resolves cancellation', async () => {
    for (const close of ['hide', 'invalidate']) {
        const app = harness(); let current = true;
        const selected = app.chooseSource(() => current);
        if (close === 'hide') { app.callbacks.hide(); }
        else { current = false; app.tick(); }
        assert.equal(await selected, undefined);
        assert.equal(app.cleared, 1);
        assert.equal(app.picker.disposed, true);
    }
});

test('discovery summary contains versions and counts, not tool names or paths', async () => {
    const app = harness(); app.setTools([candidate]);
    await app.showDiscoveryInfo();
    const summary = JSON.parse(app.copied);
    assert.equal(summary.statisticsTools, 1);
    assert.equal(summary.registeredTools, 1);
    assert.equal(summary.vscodeVersion, '1.146.0');
    assert.equal(summary.builtInAIFeaturesDisabled, false);
    assert.equal(app.copied.includes(candidate.name), false);
});

test('disabled AI controls have an actionable setting link without changing user preferences', async () => {
    const app = harness(true, 'Open AI setting');
    await app.showDiscoveryInfo();
    assert.match(app.message, /Disable AI Features is enabled/);
    assert.match(app.message, /MCP: List Servers/);
    assert.deepEqual(app.command, ['workbench.action.openSettings', '@id:chat.disableAIFeatures']);
});

test('saved editor connections wait for the initial public catalog and respect cancellation', async () => {
    const filename = resolve(__dirname, '../out/editor.js');
    const realRequire = createRequire(filename);
    let tools = [], invoked = 0;
    class LanguageModelTextPart { constructor(value) { this.value = value; } }
    const vscode = { lm: { get tools() { return tools; }, invokeTool: async () => {
        invoked++;
        return { content: [new LanguageModelTextPart('{"stats":[]}')] };
    } }, LanguageModelTextPart,
        CancellationTokenSource: class { token = {}; cancel() {} dispose() {} } };
    const exports = {};
    vm.runInNewContext(readFileSync(filename, 'utf8'), { exports,
        require: name => name === 'vscode' ? vscode : realRequire(name),
        Buffer, setTimeout, clearTimeout, AbortController });
    const arriving = exports.readEditor(candidate.name, new AbortController().signal);
    tools = [candidate];
    assert.equal((await arriving).stats.length, 0);
    assert.equal(invoked, 1);
    tools = [];
    const controller = new AbortController();
    const cancelled = exports.readEditor(candidate.name, controller.signal);
    controller.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    assert.equal(invoked, 1);
});
