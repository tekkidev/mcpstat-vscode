// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { IncompatibleSourceError, MAX_BYTES, MAX_ROWS, parseSnapshot, Snapshot } from './model';

export const REQUEST_TIMEOUT = 15000;
export function isStatisticsTool(name: string): boolean {
    return name.length <= 2048 && /(?:^|[_./:-])tool_usage_stats$/.test(name);
}

export function endpoint(value: string): URL {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new Error('Enter the full MCP endpoint URL, for example https://example.com/mcp.'); }
    if (value.length > 4096 || url.username || url.password || url.search || url.hash) {
        throw new Error('Use an endpoint URL without credentials, query parameters or fragments. Enter the bearer token separately.');
    }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        throw new Error('Use HTTPS for a remote server, or HTTP on localhost for a development server.');
    }
    return url;
}

export class ConnectionError extends Error {}

/** Bound wire responses before the SDK parses JSON or SSE content. */
export function boundedResponse(response: Response): Response {
    if (!response.body) { return response; }
    if (Number(response.headers.get('content-length')) > MAX_BYTES) {
        void response.body.cancel();
        throw new ConnectionError('The server response exceeds the 4 MiB limit.');
    }
    const reader = response.body.getReader();
    let size = 0;
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const part = await reader.read();
                if (part.done) { controller.close(); return; }
                size += part.value.byteLength;
                if (size > MAX_BYTES) {
                    await reader.cancel();
                    controller.error(new ConnectionError('The server response exceeds the 4 MiB limit.'));
                    return;
                }
                controller.enqueue(part.value);
            } catch (error) { controller.error(error); }
        },
        cancel: reason => reader.cancel(reason),
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

/** One owned HTTP session. Only the selected statistics tool is invoked. */
export class HttpStatistics {
    private readonly client = new Client({ name: 'mcpstat-dashboard', version: '0.3.0' },
        { listMaxPages: 10, versionNegotiation: { mode: 'auto' } });
    private readonly transport: StreamableHTTPClientTransport;
    private readonly lifetime = new AbortController();
    private connected = false;
    private closing?: Promise<void>;
    private failure?: ConnectionError;

    constructor(value: string, token: string | undefined) {
        const url = endpoint(value);
        this.transport = new StreamableHTTPClientTransport(url, {
            authProvider: { token: async () => token },
            fetch: async (input, init) => {
                const target = new URL(input instanceof Request ? input.url : input.toString());
                if (target.origin !== url.origin) { throw new ConnectionError('The server attempted a request to a different origin.'); }
                const signals = [this.lifetime.signal];
                if (init?.signal) { signals.push(init.signal); }
                if (input instanceof Request) { signals.push(input.signal); }
                const signal = AbortSignal.any(signals);
                const response = await fetch(input, { ...init, signal, redirect: 'error' });
                if (response.status === 401 || response.status === 403) {
                    await response.body?.cancel();
                    this.failure = new ConnectionError('The server denied access. Reconnect with a valid bearer token or use its authenticated VS Code connection.');
                    throw this.failure;
                }
                return boundedResponse(response);
            },
            reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000,
                initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1.5 },
        });
    }

    private async connect(signal: AbortSignal): Promise<void> {
        if (this.closing) { throw new ConnectionError('This MCP connection has been closed. Reconnect to the server.'); }
        if (!this.connected) {
            await this.client.connect(this.transport, { signal, timeout: REQUEST_TIMEOUT });
            this.connected = true;
        }
    }

    async tools(signal: AbortSignal): Promise<string[]> {
        this.failure = undefined;
        try {
            await this.connect(signal);
            const result = await this.client.listTools(undefined, { signal, timeout: REQUEST_TIMEOUT });
            if (result.tools.length > MAX_ROWS) { throw new ConnectionError('The server advertises more than 1000 tools. Select its statistics tool through VS Code.'); }
            return result.tools.map(tool => tool.name).filter(isStatisticsTool);
        } catch (error) { throw this.diagnostic(error); }
    }

    async read(tool: string, signal: AbortSignal): Promise<Snapshot> {
        this.failure = undefined;
        if (!isStatisticsTool(tool)) { throw new ConnectionError('Select a mcpstat statistics tool.'); }
        try {
            await this.connect(signal);
            const result = await this.client.callTool({ name: tool, arguments: {} },
                { signal, timeout: REQUEST_TIMEOUT });
            if (result.isError) { throw new ConnectionError('The statistics tool failed. Check the server and try Refresh again.'); }
            try { return parseSnapshot(result); }
            catch { throw new IncompatibleSourceError(); }
        } catch (error) { throw this.diagnostic(error); }
    }

    private diagnostic(error: unknown): Error {
        return this.failure ?? (error instanceof ConnectionError || error instanceof IncompatibleSourceError ? error :
            new ConnectionError('Cannot retrieve MCP statistics. Check the endpoint, server availability, authentication and selected statistics tool.'));
    }

    close(): Promise<void> {
        this.closing ??= (async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([this.transport.terminateSession().catch(() => undefined),
                    new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); })]);
            } finally {
                if (timer) { clearTimeout(timer); }
                this.lifetime.abort();
                await this.client.close().catch(() => undefined);
            }
        })();
        return this.closing;
    }
}
