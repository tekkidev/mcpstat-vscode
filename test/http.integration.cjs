// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:net');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { HttpStatistics } = require('../out/connection');
const { History, summarize } = require('../out/model');

async function main() {
    const probe = createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const directory = await mkdtemp(join(tmpdir(), 'mcpstat-http-'));
    const token = 'synthetic-dashboard-test-token';
    const python = process.env.MCPSTAT_TEST_PYTHON || 'python';
    const processServer = spawn(python, [join(__dirname, 'fixtures/http_server.py'), '--port', String(port),
        '--database', join(directory, 'stats.sqlite')], { stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, MCPSTAT_TEST_TOKEN: token, OTEL_SDK_DISABLED: 'true', OTEL_PROPAGATORS: 'none' } });
    let diagnostic = '';
    processServer.stderr.on('data', part => { diagnostic = (diagnostic + part).slice(-8000); });
    processServer.stdout.resume();
    const url = `http://127.0.0.1:${port}/mcp`;
    const actor = new Client({ name: 'synthetic-actor', version: '1' });
    const actorTransport = new StreamableHTTPClientTransport(new URL(url), { authProvider: { token: async () => token } });
    const dashboard = new HttpStatistics(url, token);
    try {
        const deadline = Date.now() + 15000;
        let ready = false;
        while (Date.now() < deadline && processServer.exitCode === null) {
            try { ready = (await fetch(url, { signal: AbortSignal.timeout(500) })).status === 401; }
            catch { /* Wait for the synthetic server to finish startup. */ }
            if (ready) { break; }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(ready, `Synthetic server did not start: ${diagnostic}`);
        await actor.connect(actorTransport);
        await actor.callTool({ name: 'get_weather', arguments: { city: 'London' } });
        await actor.callTool({ name: 'get_weather', arguments: { city: 'Paris' } });
        const failure = await actor.callTool({ name: 'fail_tool', arguments: {} });
        assert.equal(failure.isError, true);
        assert.deepEqual(await dashboard.tools(new AbortController().signal), ['get_tool_usage_stats']);
        const before = await dashboard.read('get_tool_usage_stats', new AbortController().signal);
        assert.equal(summarize(before.stats).calls, 3);
        assert.equal(summarize(before.stats).errors, 1);
        assert.equal(before.stats.find(row => row.name === 'unused_tool').call_count, 0);
        const history = new History(); history.observe(before, 1000, 15000);
        await actor.callTool({ name: 'get_weather', arguments: { city: 'Tokyo' } });
        const after = await dashboard.read('get_tool_usage_stats', new AbortController().signal);
        history.observe(after, 16000, 15000);
        assert.equal(summarize(after.stats).calls, 4);
        assert.equal(history.points.at(-1).calls, 4);
        await dashboard.close();
        assert.equal((await actor.callTool({ name: 'get_weather', arguments: { city: 'Oslo' } })).isError, false);
        console.log('PASS: installed mcpstat 0.3.0 over HTTP, bearer authentication, independent actor requests, statistics polling, chart deltas and session isolation.');
    } finally {
        await dashboard.close();
        await actorTransport.terminateSession().catch(() => undefined);
        await actor.close();
        processServer.kill('SIGTERM');
        await Promise.race([new Promise(resolve => processServer.once('exit', resolve)),
            new Promise(resolve => setTimeout(() => { processServer.kill('SIGKILL'); resolve(); }, 3000))]);
        await rm(directory, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
