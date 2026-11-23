// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { endpoint, isStatisticsTool, boundedResponse, HttpStatistics } = require('../out/connection');
const { parseProfile } = require('../out/profile');
const { MAX_BYTES } = require('../out/model');

test('connection profiles accept statistics sources and reject embedded credentials', () => {
    for (const url of ['https://example.com/mcp', 'http://localhost:3000/mcp', 'http://127.0.0.1/mcp', 'http://[::1]/mcp']) {
        assert.equal(endpoint(url).href, new URL(url).href);
    }
    for (const url of ['file:///etc/passwd', 'http://example.com/mcp', 'https://user:secret@example.com/mcp',
        'https://example.com/mcp?token=secret', 'https://example.com/mcp#secret', 'invalid']) {
        assert.throws(() => endpoint(url));
        assert.equal(parseProfile({ kind: 'http', url, tool: 'get_tool_usage_stats' }), undefined);
    }
    assert.ok(isStatisticsTool('mcp_weather_get_tool_usage_stats'));
    assert.ok(isStatisticsTool('fetch_tool_usage_stats'));
    assert.equal(isStatisticsTool('delete_files'), false);
    assert.deepEqual(parseProfile({ kind: 'editor', tool: 'mcp_weather_get_tool_usage_stats', token: 'secret' }),
        { kind: 'editor', tool: 'mcp_weather_get_tool_usage_stats' });
    const editorProfile = { kind: 'editor', tool: 'mcp_weather_get_tool_usage_stats' };
    assert.deepEqual(parseProfile({ ...editorProfile, approvalHelpAcknowledged: true, token: 'secret' }),
        { ...editorProfile, approvalHelpAcknowledged: true });
    for (const value of [false, 'true', 1, null, {}]) {
        assert.deepEqual(parseProfile({ ...editorProfile, approvalHelpAcknowledged: value }), editorProfile);
    }
    assert.equal(parseProfile({ kind: 'editor', tool: 'delete_files' }), undefined);
    const httpProfile = { kind: 'http', url: 'https://example.com/mcp',
        tool: 'get_tool_usage_stats', credentialId: 'a'.repeat(64) };
    assert.deepEqual(parseProfile(httpProfile), httpProfile);
    for (const credentialId of ['', '../another-secret', 'a'.repeat(65), 123]) {
        assert.equal(parseProfile({ ...httpProfile, credentialId }), undefined);
    }
    assert.ok(parseProfile({ kind: 'database', path: '/synthetic/stats.sqlite', server: 'weather' }));
});

test('wire responses are bounded before JSON or SSE parsing', async () => {
    assert.throws(() => boundedResponse(new Response('large', { headers: { 'content-length': String(MAX_BYTES + 1) } })), /4 MiB/);
    const response = boundedResponse(new Response(new Uint8Array(MAX_BYTES + 1)));
    await assert.rejects(response.arrayBuffer(), /4 MiB/);
    assert.equal(await boundedResponse(new Response('{"stats":[]}')).text(), '{"stats":[]}');
});

async function fixture(handler) {
    const server = createServer(handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => new Promise(resolve => server.close(resolve)) };
}

test('official client discovers and invokes only selected statistics tools with bearer authentication', async () => {
    const requests = [];
    let responseMode = 'valid';
    const server = await fixture(async (request, response) => {
        if (request.headers.authorization !== 'Bearer synthetic-token') { response.writeHead(401).end(); return; }
        if (request.method === 'DELETE') { response.writeHead(204).end(); return; }
        if (request.method === 'GET') { response.writeHead(405).end(); return; }
        let body = '';
        for await (const part of request) { body += part; }
        const message = JSON.parse(body);
        requests.push(message);
        if (message.id === undefined) { response.writeHead(202).end(); return; }
        const result = message.method === 'initialize' ? {
            protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' },
        } : message.method === 'tools/list' ? { tools: [
            { name: 'get_tool_usage_stats', inputSchema: { type: 'object' } },
            { name: 'delete_files', inputSchema: { type: 'object' } },
        ] } : responseMode === 'invalid' ? { content: [{ type: 'text', text: '{"unrelated":true}' }] } :
            responseMode === 'error' ? { isError: true, content: [{ type: 'text', text: 'synthetic internal error' }] } :
                { content: [{ type: 'text', text: JSON.stringify({ stats: [{ name: 'get_weather', type: 'tool', call_count: 3, success_count: 3 }] }) }] };
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    const client = new HttpStatistics(server.url, 'synthetic-token');
    try {
        assert.deepEqual(await client.tools(new AbortController().signal), ['get_tool_usage_stats']);
        assert.equal((await client.read('get_tool_usage_stats', new AbortController().signal)).stats[0].call_count, 3);
        await assert.rejects(client.read('delete_files', new AbortController().signal), /statistics tool/);
        assert.deepEqual(requests.filter(message => message.method === 'tools/call').map(message => message.params.name), ['get_tool_usage_stats']);
        responseMode = 'invalid';
        await assert.rejects(client.read('get_tool_usage_stats', new AbortController().signal), error =>
            error instanceof require('../out/model').IncompatibleSourceError && /mcpstat installed/.test(error.message));
        responseMode = 'error';
        await assert.rejects(client.read('get_tool_usage_stats', new AbortController().signal), error =>
            !(error instanceof require('../out/model').IncompatibleSourceError) && /statistics tool failed/.test(error.message));
    } finally { await client.close(); await server.close(); }
});

test('credentials are not sent through redirects and authentication failures are actionable', async () => {
    let leaked = false;
    const target = await fixture((_request, response) => { leaked = true; response.end(); });
    const redirect = await fixture((_request, response) => { response.writeHead(307, { location: target.url }).end(); });
    const denied = await fixture((_request, response) => { response.writeHead(401).end(); });
    try {
        for (const server of [redirect, denied]) {
            const client = new HttpStatistics(server.url, 'synthetic-token');
            try {
                await assert.rejects(client.tools(new AbortController().signal), server === denied ? /denied access/ : /Cannot retrieve/);
            } finally { await client.close(); }
        }
    } finally { await redirect.close(); await target.close(); await denied.close(); }
    assert.equal(leaked, false);
});
