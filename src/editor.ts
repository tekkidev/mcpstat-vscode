// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import { setTimeout as delay } from 'node:timers/promises';
import { isStatisticsTool } from './connection';
import { IncompatibleSourceError, MAX_BYTES, MAX_ROWS, parseSnapshot, Snapshot } from './model';

// The public invocation API includes time spent in VS Code's approval dialog.
export const EDITOR_REQUEST_TIMEOUT = 120_000;

export function statisticsTools(): vscode.LanguageModelToolInformation[] {
    return vscode.lm.tools.filter(tool => isStatisticsTool(tool.name)).slice(0, MAX_ROWS);
}

/** Use the editor's registered tool and existing server connection. */
export async function readEditor(tool: string, signal: AbortSignal): Promise<Snapshot> {
    // On first access the public API can still be loading its initial tool catalog.
    for (let attempt = 0; attempt < 20 && !statisticsTools().some(candidate => candidate.name === tool); attempt++) {
        await delay(100, undefined, { signal });
    }
    if (!statisticsTools().some(candidate => candidate.name === tool)) {
        throw new Error('Start this MCP server in VS Code, then refresh or choose its statistics tool again.');
    }
    if (signal.aborted) { throw new Error('Statistics request cancelled.'); }
    const cancellation = new vscode.CancellationTokenSource();
    let rejectAbort: (reason: Error) => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const abort = () => { cancellation.cancel(); rejectAbort(new Error('Statistics request cancelled.')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            vscode.lm.invokeTool(tool, { input: {}, toolInvocationToken: undefined }, cancellation.token).then(
                result => result,
                () => { throw new Error('VS Code did not return statistics. Approve the request, or check that the server is running, then use Refresh to retry.'); },
            ),
            cancelled,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                    cancellation.cancel();
                    reject(new Error('Statistics request timed out after two minutes, including approval time. Use Refresh to try again.'));
                }, EDITOR_REQUEST_TIMEOUT);
            }),
        ]);
        const content = result.content.filter(part => part instanceof vscode.LanguageModelTextPart)
            .map(part => ({ type: 'text', text: part.value }));
        if (content.reduce((sum, part) => sum + Buffer.byteLength(part.text, 'utf8'), 0) > MAX_BYTES) {
            throw new Error('The statistics response exceeds the 4 MiB limit.');
        }
        try { return parseSnapshot({ content }); }
        catch { throw new IncompatibleSourceError(); }
    } finally {
        if (timer) { clearTimeout(timer); }
        signal.removeEventListener('abort', abort);
        cancellation.dispose();
    }
}
