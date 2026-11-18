// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import { statisticsTools } from './editor';

export interface SourceChoice extends vscode.QuickPickItem {
    sourceKind: 'editor' | 'http' | 'discovery';
    tool: string;
}

/** Keep the picker synchronized with the editor's asynchronously populated catalog. */
export function chooseSource(current: () => boolean): Promise<SourceChoice | undefined> {
    const picker = vscode.window.createQuickPick<SourceChoice>();
    picker.title = 'Connect to MCP statistics';
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    picker.ignoreFocusOut = true;
    const started = Date.now();
    let timer: ReturnType<typeof setInterval> | undefined;
    let signature = '';
    let settled = false;
    const subscriptions: vscode.Disposable[] = [];
    return new Promise(resolve => {
        const finish = (choice?: SourceChoice) => {
            if (settled) { return; }
            settled = true;
            if (timer) { clearInterval(timer); }
            for (const subscription of subscriptions) { subscription.dispose(); }
            picker.dispose();
            resolve(choice);
        };
        const refresh = () => {
            if (!current()) { finish(); return; }
            const tools = statisticsTools();
            const items: SourceChoice[] = tools.map(tool => ({
                label: tool.name, description: 'Connected through VS Code',
                detail: tool.description.slice(0, 300), sourceKind: 'editor', tool: tool.name,
            }));
            if (!items.length) {
                items.push({ label: 'Find my STDIO server', sourceKind: 'discovery', tool: '',
                    description: 'Check VS Code tool discovery',
                    detail: 'Start the server in VS Code. Available statistics tools appear here automatically.' });
            }
            items.push({ label: 'Connect an HTTP MCP endpoint', description: 'Remote or local development server',
                detail: 'Enter the server endpoint and authentication.', sourceKind: 'http', tool: '' });
            const next = JSON.stringify(items);
            if (next !== signature) {
                const active = picker.activeItems[0];
                signature = next;
                picker.items = items;
                const previous = items.find(item => item.sourceKind === active?.sourceKind && item.tool === active.tool);
                if (previous) { picker.activeItems = [previous]; }
                else if (items[0]) { picker.activeItems = [items[0]]; }
            }
            picker.busy = tools.length === 0 && Date.now() - started < 5000;
            picker.placeholder = tools.length ? 'Choose the statistics tool of your existing server' :
                'Waiting for VS Code statistics tools. You can start your server while this picker is open.';
        };
        subscriptions.push(picker.onDidAccept(() => finish(picker.selectedItems[0])), picker.onDidHide(() => finish()));
        refresh();
        if (!settled) {
            timer = setInterval(refresh, 500);
            picker.show();
        }
    });
}

export async function showDiscoveryInfo(): Promise<void> {
    const tools = vscode.lm.tools;
    const aiDisabled = vscode.workspace.getConfiguration('chat').get<boolean>('disableAIFeatures', false);
    const summary = {
        vscodeVersion: vscode.version,
        remoteExtensionHost: Boolean(vscode.env.remoteName),
        registeredTools: tools.length,
        mcpNamedTools: tools.filter(tool => /(?:^|[_./:-])mcp(?:[_./:-]|$)/i.test(tool.name)).length,
        statisticsTools: statisticsTools().length,
        builtInAIFeaturesDisabled: aiDisabled,
    };
    const action = await vscode.window.showInformationMessage(
        `VS Code exposes ${summary.registeredTools} tools to the dashboard, including ${summary.statisticsTools} statistics tools. ` +
        (aiDisabled ? 'Chat: Disable AI Features is enabled, which hides the built-in Chat and MCP controls. ' +
            'Review that setting, reload the window, then run MCP: List Servers. Direct HTTP and database connections are also available.' :
            'Start your server in the VS Code MCP server controls and reopen Connect MCP Server. The picker updates automatically.'),
        'Copy discovery summary', ...(aiDisabled ? ['Open AI setting'] : []));
    if (action === 'Copy discovery summary') { await vscode.env.clipboard.writeText(JSON.stringify(summary, null, 2)); }
    if (action === 'Open AI setting') { await vscode.commands.executeCommand('workbench.action.openSettings', '@id:chat.disableAIFeatures'); }
}
