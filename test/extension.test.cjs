// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function harness(storage = new Map(), secrets = new Map(), fakeClock = false) {
    const commands = new Map(), posts = [], dialogs = [], links = [], errors = [], panels = [];
    const picks = [], inputs = [], executed = [], trees = new Map(), contexts = new Map();
    const availableCommands = ['workbench.action.chat.editToolApproval'];
    const timers = new Map(); let timerId = 0;
    const uri = fsPath => ({ fsPath, toString: () => `file://${fsPath}` });
    const source = {
        readDatabase: async () => ({ servers: ['weather'] }),
    };
    const snapshot = () => require('../out/model').parseSnapshot({ stats: [{ name: 'weather', type: 'tool', call_count: 1, success_count: 1 }] });
    const editor = {
        statisticsTools: () => [{ name: 'mcp_weather_get_tool_usage_stats', description: 'Statistics' }],
        readEditor: async () => snapshot(),
    };
    const discovery = {
        chooseSource: async () => [
            ...editor.statisticsTools().map(tool => ({ sourceKind: 'editor', tool: tool.name })),
            { sourceKind: 'http', tool: '' },
        ][picks.shift() ?? 0],
        showDiscoveryInfo: async () => undefined,
    };
    const httpCalls = [];
    let httpTools = ['get_tool_usage_stats'];
    class HttpStatistics {
        constructor(url, token) { httpCalls.push({ url, token }); }
        async tools() { return httpTools; }
        async read() { return snapshot(); }
        async close() {}
    }
    const context = { extensionUri: uri(path.resolve(__dirname, '..')), extension: { id: 'vadikus.mcpstat-dashboard' }, subscriptions: [],
        workspaceState: { get: key => storage.get(key), update: async (key, value) => { storage.set(key, value); } },
        secrets: { get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); },
            delete: async key => { secrets.delete(key); } } };
    const vscode = {
        EventEmitter: class {
            listeners = new Set();
            event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
            fire() { for (const listener of this.listeners) { listener(); } }
            dispose() { this.listeners.clear(); }
        },
        ThemeIcon: class { constructor(id) { this.id = id; } },
        Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)), parse: value => value },
        ViewColumn: { One: 1 },
        workspace: { isTrusted: true, getConfiguration: () => ({ get: (_key, fallback) => fallback }),
            onDidChangeConfiguration: () => ({ dispose() {} }) },
        env: { openExternal: async value => { links.push(value); } },
        commands: { registerCommand: (name, fn) => { commands.set(name, fn); return { dispose() {} }; },
            getCommands: async () => availableCommands,
            executeCommand: async (name, ...args) => {
                if (name === 'setContext') { contexts.set(args[0], args[1]); }
                else { executed.push(name); }
            } },
        window: {
            registerTreeDataProvider: (name, provider) => { trees.set(name, provider); return { dispose() { trees.delete(name); } }; },
            showOpenDialog: async () => dialogs.shift(), showQuickPick: async choices => choices[picks.shift() ?? 0],
            showInputBox: async () => inputs.shift(),
            showWarningMessage: value => errors.push(value), showErrorMessage: value => errors.push(value),
            createWebviewPanel: () => {
                const disposed = [];
                const panel = { visible: true, options: undefined, reveal() {},
                    dispose() { for (const fn of disposed.splice(0)) { fn(); } },
                    onDidDispose(fn) { disposed.push(fn); }, onDidChangeViewState(fn) { panel.viewChanged = fn; },
                    webview: { cspSource: 'vscode-resource:', html: '',
                        asWebviewUri: value => value, postMessage: value => { posts.push(value); return Promise.resolve(true); },
                        onDidReceiveMessage(fn) { panel.message = fn; } } };
                panels.push(panel); return panel;
            },
        },
    };
    const exports = {};
    const extensionPath = path.resolve(__dirname, '../out/extension.js');
    const realRequire = createRequire(extensionPath);
    vm.runInNewContext(readFileSync(extensionPath, 'utf8'), { exports,
        require: name => name === 'vscode' ? vscode : name === './source' ? source : name === './editor' ? editor :
            name === './connection' ? { ...realRequire(name), HttpStatistics } :
                name === './discovery' ? discovery : realRequire(name),
        AbortController, URL,
        setTimeout: fakeClock ? (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; } : setTimeout,
        clearTimeout: fakeClock ? id => timers.delete(id) : clearTimeout }, { filename: extensionPath });
    exports.activate(context);
    return { commands, posts, dialogs, links, errors, panels, source, editor, vscode, storage, secrets, picks, inputs, httpCalls, timers,
        executed, availableCommands, trees, contexts, context, setHttpTools: tools => { httpTools = tools; },
        close: () => { for (const subscription of context.subscriptions) { subscription.dispose?.(); } } };
}

test('sidebar reflects source, statistics, stale reads and disconnect without starting polling', async () => {
    const app = harness(new Map(), new Map(), true);
    try {
        const tree = app.trees.get('mcpstat.connection');
        assert.ok(tree);
        assert.deepEqual(Array.from(tree.getChildren()), []);
        let changes = 0;
        const listener = tree.onDidChangeTreeData(() => changes++);
        await app.commands.get('mcpstat.connectServer')();
        const rows = tree.getChildren();
        assert.equal(rows.find(row => row.id === 'source').label, 'mcp_weather_get_tool_usage_stats');
        assert.equal(rows.find(row => row.id === 'calls').description, '1');
        assert.equal(rows.find(row => row.id === 'status').label, 'Manual refresh');
        assert.equal(app.contexts.get('mcpstat.hasStatistics'), true);
        app.editor.readEditor = async () => { throw new Error('Approval cancelled.'); };
        await app.commands.get('mcpstat.refresh')();
        assert.equal(tree.getChildren().find(row => row.id === 'status').label, 'Last request failed');
        assert.equal(tree.getChildren().find(row => row.id === 'calls').description, '1', 'Keep the last observation');
        app.panels[0].dispose();
        assert.equal(app.timers.size, 0, 'Sidebar never starts background collection');
        await app.commands.get('mcpstat.disconnect')();
        assert.deepEqual(Array.from(tree.getChildren()), []);
        assert.equal(app.contexts.get('mcpstat.hasStatistics'), false);
        assert.ok(changes > 0);
        listener.dispose();
    } finally { app.close(); }
});

test('getting started commands open the walkthrough and the fixed server integration guide', async () => {
    const app = harness();
    try {
        await app.commands.get('mcpstat.openWalkthrough')();
        assert.deepEqual(app.executed, ['workbench.action.openWalkthrough']);
        await app.commands.get('mcpstat.openIntegration')();
        assert.deepEqual(app.links, ['https://github.com/tekkidev/mcpstat/blob/main/docs/quickstart.md']);
    } finally { app.close(); }
});

test('untrusted workspaces never read files or run a database adapter', async () => {
    const app = harness();
    try {
        app.vscode.workspace.isTrusted = false;
        app.source.readDatabase = app.editor.readEditor = async () => { throw new Error('must not run'); };
        await app.commands.get('mcpstat.connectDatabase')();
        await app.commands.get('mcpstat.connectServer')();
        assert.equal(app.panels.length, 0);
        assert.equal(app.errors.length, 2);
    } finally { app.close(); }
});

test('existing editor tool supplies statistics; only fixed documentation links can open', async () => {
    const app = harness();
    try {
        await app.commands.get('mcpstat.connectServer')();
        assert.equal(app.posts.at(-1).snapshot.stats[0].call_count, 1);
        assert.equal(app.posts.at(-1).source.name, 'mcp_weather_get_tool_usage_stats');
        await app.panels[0].message({ action: 'link:https://untrusted.invalid' });
        await app.panels[0].message({ action: 'link:source' });
        await app.panels[0].message({ action: 'link:library' });
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(app.links, ['https://github.com/tekkidev/mcpstat-vscode', 'https://github.com/tekkidev/mcpstat']);
        assert.ok(app.panels[0].webview.html.includes("connect-src 'none'"));
        assert.ok(!app.panels[0].webview.html.includes('{{nonce}}'));
        assert.ok(!app.panels[0].webview.html.includes('{{link_'));
        assert.ok(app.panels[0].webview.html.includes('href="https://github.com/tekkidev/mcpstat"'));
        await app.commands.get('mcpstat.disconnect')();
        assert.equal(app.posts.at(-1).snapshot, undefined);
    } finally { app.close(); }
});

test('a late editor response cannot restore a disconnected source', async () => {
    const app = harness();
    try {
        let finish;
        app.editor.readEditor = () => new Promise(resolve => { finish = resolve; });
        const pending = app.commands.get('mcpstat.connectServer')();
        const deadline = Date.now() + 2000;
        while (!finish && Date.now() < deadline) { await new Promise(resolve => setImmediate(resolve)); }
        assert.equal(typeof finish, 'function');
        await app.commands.get('mcpstat.disconnect')();
        finish(require('../out/model').parseSnapshot({ stats: [] }));
        await pending;
        assert.equal(app.posts.at(-1).source, undefined);
    } finally { app.close(); }
});

test('connection selection survives extension reload and disconnect forgets it', async () => {
    const app = harness();
    try {
        await app.commands.get('mcpstat.connectServer')();
        const restarted = harness(app.storage, app.secrets);
        try {
            await restarted.commands.get('mcpstat.openDashboard')();
            await restarted.panels[0].message({ action: 'ready' });
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(restarted.posts.at(-1).source.kind, 'editor');
            assert.equal(restarted.posts.at(-1).snapshot.stats[0].call_count, 1);
            await restarted.commands.get('mcpstat.disconnect')();
            assert.equal(app.storage.get('mcpstat.connection.v1'), undefined);
        } finally { restarted.close(); }
    } finally { app.close(); }
});

test('HTTP credentials are stored only in SecretStorage and removed on disconnect', async () => {
    const app = harness();
    try {
        app.picks.push(1, 1);
        app.inputs.push('https://example.com/mcp', 'synthetic-bearer-token');
        await app.commands.get('mcpstat.connectServer')();
        assert.equal(app.posts.at(-1).source.kind, 'http');
        assert.equal(app.httpCalls.at(-1).token, 'synthetic-bearer-token');
        assert.equal(JSON.stringify([...app.storage]).includes('synthetic-bearer-token'), false);
        assert.equal(JSON.stringify(app.posts).includes('synthetic-bearer-token'), false);
        assert.equal(app.secrets.size, 1);
        await app.commands.get('mcpstat.disconnect')();
        assert.equal(app.secrets.size, 0);
    } finally { app.close(); }
});

test('database selection reads one server and disconnect aborts outstanding requests', async () => {
    const app = harness();
    try {
        let signal;
        app.source.readDatabase = async (_python, _reader, _path, requestSignal, server) => {
            signal = requestSignal;
            return server === undefined ? { servers: ['weather'] } :
                { stats: [{ name: 'get_weather', type: 'tool', call_count: 3, success_count: 3 }] };
        };
        app.dialogs.push([{ fsPath: '/synthetic/stats.sqlite' }]);
        await app.commands.get('mcpstat.connectDatabase')();
        assert.equal(app.posts.at(-1).source.server, 'weather');
        assert.equal(app.posts.at(-1).snapshot.stats[0].call_count, 3);
        app.source.readDatabase = (_python, _reader, _path, requestSignal) => new Promise((_resolve, reject) => {
            signal = requestSignal;
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        const pending = app.commands.get('mcpstat.refresh')();
        await new Promise(resolve => setImmediate(resolve));
        await app.commands.get('mcpstat.disconnect')();
        await pending;
        assert.equal(signal.aborted, true);
        assert.equal(app.posts.at(-1).source, undefined);
    } finally { app.close(); }
});

test('editor approval is not subject to the HTTP timeout and does not enable polling', async () => {
    const app = harness(new Map(), new Map(), true);
    try {
        let finish, calls = 0;
        app.editor.readEditor = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
        const pending = app.commands.get('mcpstat.connectServer')();
        while (!finish) { await new Promise(resolve => setImmediate(resolve)); }
        assert.equal(app.timers.size, 0, 'No 15-second controller timer while approval is pending');
        finish(require('../out/model').parseSnapshot({ stats: [] }));
        await pending;
        assert.equal(app.posts.at(-1).automatic, false);
        assert.equal(app.timers.size, 0, 'Manual editor connections do not schedule further confirmations');
        app.panels[0].viewChanged();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(calls, 1, 'Revealing the panel does not invoke another manual request');
    } finally { app.close(); }
});

test('failed polling pauses until a manual retry succeeds, preserving existing values', async () => {
    const app = harness(new Map(), new Map(), true);
    try {
        await app.commands.get('mcpstat.connectServer')();
        await app.panels[0].message({ action: 'automatic' });
        await app.panels[0].message({ action: 'automatic-start' });
        assert.equal(app.posts.at(-1).automatic, true);
        assert.equal([...app.timers.values()][0].ms, 15000);
        const snapshot = app.posts.findLast(post => post.snapshot)?.snapshot;
        app.editor.readEditor = async () => { throw new Error('Approval cancelled.'); };
        await app.commands.get('mcpstat.refresh')();
        assert.equal(app.timers.size, 0, 'A failed request must not schedule another confirmation');
        assert.equal(app.posts.at(-1).pollingPaused, true);
        assert.equal(app.posts.at(-1).snapshot, undefined, 'Status updates retain the webview snapshot without resending it');
        assert.match(app.posts.at(-1).error, /Previous values may be stale/);
        app.panels[0].viewChanged();
        await app.panels[0].message({ action: 'ready' });
        assert.equal(app.timers.size, 0);
        app.editor.readEditor = async () => snapshot;
        await app.commands.get('mcpstat.refresh')();
        assert.equal(app.posts.at(-1).pollingPaused, false);
        assert.equal(app.posts.at(-1).error, undefined);
        assert.equal(app.timers.size, 1, 'Successful explicit retry resumes opted-in polling');
        await app.panels[0].message({ action: 'automatic' });
        assert.equal(app.timers.size, 0);
    } finally { app.close(); }
});

test('a first denied editor request has no stale label and never retries automatically', async () => {
    const app = harness(new Map(), new Map(), true);
    try {
        let calls = 0;
        app.editor.readEditor = async () => { calls++; throw new Error('Approval cancelled.'); };
        await app.commands.get('mcpstat.connectServer')();
        assert.equal(app.posts.at(-1).snapshot, undefined);
        assert.equal(app.posts.at(-1).error.includes('stale'), false);
        assert.equal(app.timers.size, 0);
        app.panels[0].viewChanged();
        await app.panels[0].message({ action: 'ready' });
        assert.equal(calls, 1);
    } finally { app.close(); }
});

test('editor auto-refresh waits for an explicit choice and offers only the available approval command', async () => {
    const app = harness(new Map(), new Map(), true);
    try {
        await app.commands.get('mcpstat.connectServer')();
        const panel = app.panels[0];
        await panel.message({ action: 'automatic' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(app.posts.at(-1).approvalHelp, true);
        assert.equal(app.posts.at(-1).approvalManagerAvailable, true);
        assert.equal(app.posts.at(-1).automatic, false);
        assert.equal(app.timers.size, 0);
        await panel.message({ action: 'approval-manage' });
        assert.deepEqual(app.executed, ['workbench.action.chat.editToolApproval']);
        assert.equal(app.timers.size, 0, 'Opening approval controls never starts polling');
        await panel.message({ action: 'approval-dismiss' });
        await panel.message({ action: 'automatic-start' });
        assert.equal(app.posts.at(-1).automatic, false, 'A dismissed guide cannot start polling');
        app.availableCommands.length = 0;
        await panel.message({ action: 'automatic' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(app.posts.at(-1).approvalManagerAvailable, false);
        await panel.message({ action: 'approval-manage' });
        assert.equal(app.executed.length, 1);
        await panel.message({ action: 'automatic-start' });
        assert.equal(app.posts.at(-1).automatic, true);
        assert.equal(app.posts.at(-1).approvalHelp, false);
        assert.equal(app.timers.size, 1);
        await panel.message({ action: 'automatic' });
        assert.equal(app.timers.size, 0);
        await panel.message({ action: 'automatic' });
        await app.commands.get('mcpstat.disconnect')();
        await panel.message({ action: 'automatic-start' });
        assert.equal(app.posts.at(-1).automatic, false);
        assert.equal(app.posts.at(-1).approvalHelp, false);
    } finally { app.close(); }
});

test('editor reminder acknowledgement survives reload and help remains available while polling', async () => {
    const storage = new Map();
    const app = harness(storage, new Map(), true);
    let restored;
    try {
        await app.commands.get('mcpstat.connectServer')();
        const panel = app.panels[0];
        await panel.message({ action: 'automatic' });
        await panel.message({ action: 'approval-dismiss' });
        assert.equal(storage.get('mcpstat.connection.v1').approvalHelpAcknowledged, undefined);
        await panel.message({ action: 'automatic' });
        await panel.message({ action: 'automatic-start' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(storage.get('mcpstat.connection.v1').approvalHelpAcknowledged, true);
        await panel.message({ action: 'automatic' });
        await panel.message({ action: 'automatic' });
        assert.equal(app.posts.at(-1).automatic, true);
        assert.equal(app.posts.at(-1).approvalHelp, false, 'Acknowledged tools start without repeating the guide');
        await panel.message({ action: 'approval-help' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(app.posts.at(-1).approvalHelp, true, 'Instructions can be reopened while automatic refresh is active');
        await panel.message({ action: 'approval-dismiss' });
        assert.equal(app.posts.at(-1).automatic, false, 'Keep manual refresh pauses an active timer');
        assert.equal(app.timers.size, 0);
        await app.commands.get('mcpstat.connectServer')();
        assert.equal(storage.get('mcpstat.connection.v1').approvalHelpAcknowledged, true, 'Reconnecting the same tool preserves acknowledgement');
        app.close();
        restored = harness(storage, new Map(), true);
        await restored.commands.get('mcpstat.openDashboard')();
        await restored.panels[0].message({ action: 'ready' });
        assert.equal(restored.posts.at(-1).automatic, false, 'Reload still starts editor connections manually');
        await restored.panels[0].message({ action: 'automatic' });
        assert.equal(restored.posts.at(-1).automatic, true);
        assert.equal(restored.posts.at(-1).approvalHelp, false);
        assert.equal(restored.timers.size, 1);
    } finally { restored?.close(); app.close(); }
});

test('reminder acknowledgement belongs to the selected tool and workspace', async () => {
    const app = harness(new Map(), new Map(), true);
    const other = harness(new Map(), new Map(), true);
    try {
        await app.commands.get('mcpstat.connectServer')();
        await app.panels[0].message({ action: 'automatic' });
        await app.panels[0].message({ action: 'automatic-start' });
        await new Promise(resolve => setImmediate(resolve));
        await other.commands.get('mcpstat.connectServer')();
        await other.panels[0].message({ action: 'automatic' });
        assert.equal(other.posts.at(-1).approvalHelp, true, 'Another workspace has its own reminder');
        app.editor.statisticsTools = () => [{ name: 'mcp_other_get_tool_usage_stats', description: 'Statistics' }];
        await app.commands.get('mcpstat.connectServer')();
        await app.panels[0].message({ action: 'automatic' });
        assert.equal(app.posts.at(-1).approvalHelp, true, 'A different tool needs its own acknowledgement');
        assert.equal(app.posts.at(-1).automatic, false);
        await app.commands.get('mcpstat.disconnect')();
        assert.equal(app.storage.get('mcpstat.connection.v1'), undefined);
    } finally { app.close(); other.close(); }
});

test('a late acknowledgement save cannot restart collection after disconnect', async () => {
    const app = harness(new Map(), new Map(), true);
    try {
        await app.commands.get('mcpstat.connectServer')();
        await app.panels[0].message({ action: 'automatic' });
        const originalUpdate = app.context.workspaceState.update;
        let complete;
        app.context.workspaceState.update = async (key, value) => {
            await originalUpdate(key, value);
            if (value?.approvalHelpAcknowledged) { await new Promise(resolve => { complete = resolve; }); }
        };
        const pending = app.panels[0].message({ action: 'automatic-start' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(typeof complete, 'function');
        await app.commands.get('mcpstat.disconnect')();
        complete();
        await pending;
        assert.equal(app.posts.at(-1).automatic, false);
        assert.equal(app.posts.at(-1).source, undefined);
        assert.equal(app.timers.size, 0);
        assert.equal(app.storage.get('mcpstat.connection.v1'), undefined);
    } finally { app.close(); }
});

test('HTTP sources without a statistics tool show an inline installation notice and preserve an existing connection', async () => {
    const app = harness();
    try {
        await app.commands.get('mcpstat.connectServer')();
        const previous = app.posts.at(-1).source;
        app.setHttpTools([]);
        app.picks.push(1, 0);
        app.inputs.push('https://example.com/mcp');
        await app.commands.get('mcpstat.connectServer')();
        assert.match(app.posts.at(-1).connectionIssue, /mcpstat installed/);
        assert.equal(app.posts.at(-1).needsMcpstat, true);
        assert.deepEqual(app.posts.at(-1).source, previous);
        assert.equal(app.errors.length, 0, 'Compatibility guidance stays in the dashboard');
    } finally { app.close(); }
});

test('unsupported editor statistics show setup guidance and clear it after a compatible response', async () => {
    const app = harness();
    try {
        await app.commands.get('mcpstat.connectServer')();
        const snapshot = app.posts.at(-1).snapshot;
        app.editor.readEditor = async () => { throw new (require('../out/model').IncompatibleSourceError)(); };
        await app.commands.get('mcpstat.refresh')();
        assert.equal(app.posts.at(-1).needsMcpstat, true);
        assert.equal(app.posts.at(-1).snapshot, undefined, 'An error updates status without replacing the previous data');
        app.editor.readEditor = async () => snapshot;
        await app.commands.get('mcpstat.refresh')();
        assert.equal(app.posts.at(-1).needsMcpstat, false);
    } finally { app.close(); }
});

test('workspace HTTP credentials survive reload independently and are cleaned on replacement', async () => {
    const secrets = new Map();
    const a = harness(new Map(), secrets, true), b = harness(new Map(), secrets, true);
    let resumed;
    try {
        for (const [app, token] of [[a, 'synthetic-A'], [b, 'synthetic-B']]) {
            app.picks.push(1, 1);
            app.inputs.push('https://example.com/mcp', token);
            await app.commands.get('mcpstat.connectServer')();
        }
        assert.equal(secrets.size, 2);
        assert.notEqual(a.storage.get('mcpstat.connection.v1').credentialId,
            b.storage.get('mcpstat.connection.v1').credentialId);
        resumed = harness(a.storage, secrets, true);
        await resumed.commands.get('mcpstat.refresh')();
        assert.equal(resumed.httpCalls.at(-1).token, 'synthetic-A');
        await b.commands.get('mcpstat.disconnect')();
        assert.deepEqual([...secrets.values()], ['synthetic-A']);
        // Reusing this connection's saved credential creates a new owned entry.
        a.picks.push(1, 0);
        a.inputs.push('https://example.com/mcp');
        await a.commands.get('mcpstat.connectServer')();
        assert.equal(a.httpCalls.at(-1).token, 'synthetic-A');
        assert.deepEqual([...secrets.values()], ['synthetic-A']);
        // Explicit anonymous reconnection must not retain the previous token.
        a.picks.push(1, 1);
        a.inputs.push('https://example.com/mcp');
        await a.commands.get('mcpstat.connectServer')();
        assert.equal(a.httpCalls.at(-1).token, undefined);
        assert.equal(secrets.size, 0);
        a.picks.push(1, 1);
        a.inputs.push('https://example.com/mcp', 'synthetic-C');
        await a.commands.get('mcpstat.connectServer')();
        assert.equal(secrets.size, 1);
        await a.commands.get('mcpstat.connectServer')();
        assert.equal(secrets.size, 0, 'Switching to an editor source removes its HTTP credential');
    } finally { a.close(); b.close(); resumed?.close(); }
});

test('legacy HTTP profiles require reconnection without reusing or deleting a shared token', async () => {
    const url = 'https://example.com/mcp';
    const key = 'mcpstat.bearer.' + require('node:crypto').createHash('sha256').update(url).digest('hex');
    const secrets = new Map([[key, 'synthetic-legacy']]);
    const app = harness(new Map([['mcpstat.connection.v1', { kind: 'http', url, tool: 'get_tool_usage_stats' }]]), secrets, true);
    try {
        await app.commands.get('mcpstat.openDashboard')();
        await app.commands.get('mcpstat.refresh')();
        assert.match(app.posts.at(-1).error, /Reconnect this HTTP source/);
        assert.equal(app.httpCalls.length, 0);
        await app.commands.get('mcpstat.disconnect')();
        assert.equal(secrets.get(key), 'synthetic-legacy');
    } finally { app.close(); }
});

test('closing an in-flight read allows reopening without a stale failure or overlapping result', async () => {
    const app = harness(new Map(), new Map(), true);
    try {
        await app.commands.get('mcpstat.connectServer')();
        const originalRead = app.editor.readEditor;
        let signal, rejectRead;
        app.editor.readEditor = async (_tool, requestSignal) => {
            signal = requestSignal;
            return new Promise((_resolve, reject) => { rejectRead = reject; });
        };
        const pending = app.commands.get('mcpstat.refresh')();
        app.panels[0].dispose();
        assert.equal(signal.aborted, true);
        app.editor.readEditor = originalRead;
        await app.commands.get('mcpstat.openDashboard')();
        await app.commands.get('mcpstat.refresh')();
        rejectRead(new Error('cancelled after panel closed'));
        await pending;
        assert.equal(app.posts.at(-1).error, undefined);
        assert.equal(app.posts.at(-1).pollingPaused, false);
        assert.equal(app.posts.at(-1).busy, false);
        assert.equal(app.posts.at(-1).snapshot.stats[0].call_count, 1);
        assert.equal(app.posts.at(-1).automatic, false, 'Manual mode remains manual');
    } finally { app.close(); }
});

test('automatic database collection resumes on ready after an in-flight panel close', async () => {
    const profile = { kind: 'database', path: '/synthetic/stats.sqlite', server: 'weather' };
    const app = harness(new Map([['mcpstat.connection.v1', profile]]), new Map(), true);
    try {
        await app.commands.get('mcpstat.openDashboard')();
        app.source.readDatabase = async (_python, _reader, _path, signal) =>
            new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
        const pending = app.commands.get('mcpstat.refresh')();
        app.panels[0].dispose();
        await pending;
        let reads = 0;
        app.source.readDatabase = async () => {
            reads++;
            return { stats: [{ name: 'weather', type: 'tool', call_count: 2 }] };
        };
        await app.commands.get('mcpstat.openDashboard')();
        app.panels[1].message({ action: 'ready' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(reads, 1);
        assert.equal(app.posts.at(-1).automatic, true);
        assert.equal(app.posts.at(-1).pollingPaused, false);
        assert.equal(app.posts.at(-1).error, undefined);
        assert.equal(app.timers.size, 1, 'Automatic refresh is scheduled again');
    } finally { app.close(); }
});

test('status messages omit data and ready restores a complete connection-scoped snapshot', async () => {
    const app = harness();
    try {
        app.vscode.env.remoteName = 'ssh-remote';
        await app.commands.get('mcpstat.connectServer')();
        const full = app.posts.at(-1);
        assert.ok(full.snapshot);
        assert.ok(Array.isArray(full.points));
        assert.equal(full.remote, true);
        await app.panels[0].message({ action: 'approval-help' });
        const status = app.posts.at(-1);
        assert.equal(status.revision, full.revision);
        assert.equal(Object.hasOwn(status, 'snapshot'), false);
        assert.equal(Object.hasOwn(status, 'points'), false);
        await app.panels[0].message({ action: 'ready' });
        assert.equal(app.posts.at(-1).snapshot, full.snapshot);
        assert.equal(app.posts.at(-1).revision, full.revision);
        await app.commands.get('mcpstat.clearHistory')();
        assert.ok(app.posts.at(-1).revision > full.revision);
        assert.equal(app.posts.at(-1).points.length, 0);
        assert.equal(app.posts.at(-1).snapshot, full.snapshot);
        const revision = app.posts.at(-1).revision;
        await app.commands.get('mcpstat.disconnect')();
        assert.ok(app.posts.at(-1).revision > revision);
        assert.equal(app.posts.at(-1).snapshot, undefined);
        assert.equal(app.posts.at(-1).points.length, 0);
        assert.equal(app.posts.at(-1).source, undefined);
        assert.ok(!JSON.stringify([...app.storage]).includes('call_count'));
    } finally { app.close(); }
});

test('a failed delivery is retried in full and a disposed panel cannot control its replacement', async () => {
    const app = harness();
    try {
        await app.commands.get('mcpstat.connectServer')();
        const oldPanel = app.panels[0];
        oldPanel.dispose();
        await app.commands.get('mcpstat.openDashboard')();
        const panel = app.panels[1];
        panel.webview.postMessage = value => { app.posts.push(value); return Promise.resolve(false); };
        await panel.message({ action: 'ready' });
        await panel.message({ action: 'approval-help' });
        assert.ok(app.posts.at(-1).snapshot, 'Undelivered data must not be treated as cached');
        panel.webview.postMessage = value => { app.posts.push(value); return Promise.resolve(true); };
        await panel.message({ action: 'ready' });
        assert.ok(app.posts.at(-1).snapshot, 'A recreated document always receives the full snapshot');
        const count = app.posts.length;
        await oldPanel.message({ action: 'disconnect' });
        assert.equal(app.posts.length, count, 'A disposed webview cannot change the active connection');
        await panel.message({ action: 'approval-help' });
        assert.equal(Object.hasOwn(app.posts.at(-1), 'snapshot'), false);
        assert.ok(app.posts.at(-1).source);
    } finally { app.close(); }
});

test('statistics caches remain separate for local and remote workspaces using the same tool', async () => {
    const local = harness(), remote = harness();
    try {
        remote.vscode.env.remoteName = 'ssh-remote';
        remote.editor.readEditor = async () => require('../out/model').parseSnapshot({ stats: [{
            name: 'synthetic_remote_handler', type: 'tool', call_count: 7,
        }] });
        await Promise.all([local.commands.get('mcpstat.connectServer')(), remote.commands.get('mcpstat.connectServer')()]);
        const localData = local.posts.at(-1), remoteData = remote.posts.at(-1);
        assert.equal(localData.source.name, remoteData.source.name);
        assert.equal(localData.remote, false);
        assert.equal(remoteData.remote, true);
        assert.equal(localData.snapshot.stats[0].call_count, 1);
        assert.equal(remoteData.snapshot.stats[0].call_count, 7);
        await local.commands.get('mcpstat.disconnect')();
        await remote.panels[0].message({ action: 'ready' });
        assert.equal(remote.posts.at(-1).snapshot, remoteData.snapshot);
        assert.equal(local.posts.at(-1).snapshot, undefined);
        for (const app of [local, remote]) assert.ok(!JSON.stringify([...app.storage]).includes('call_count'));
    } finally { local.close(); remote.close(); }
});
