// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { History, IncompatibleSourceError, parseSnapshot, Snapshot, summarize } from './model';
import { readDatabase } from './source';
import { endpoint, HttpStatistics, REQUEST_TIMEOUT } from './connection';
import { readEditor, statisticsTools } from './editor';
import { chooseSource, showDiscoveryInfo } from './discovery';
import { parseProfile, PROFILE_KEY, Source } from './profile';
import { links } from './links';

function secretKey(credentialId: string): string {
    return `mcpstat.connection.bearer.${credentialId}`;
}
const APPROVAL_COMMAND = 'workbench.action.chat.editToolApproval';

class Dashboard implements vscode.Disposable, vscode.TreeDataProvider<vscode.TreeItem> {
    private readonly treeChanges = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.treeChanges.event;
    private panel?: vscode.WebviewPanel;
    private source?: Source;
    private snapshot?: Snapshot;
    private readonly history = new History();
    private timer?: ReturnType<typeof setTimeout>;
    private readonly requests = new Set<AbortController>();
    private generation = 0;
    private selection = 0;
    private busy = false;
    private automatic = false;
    private pollingPaused = false;
    private lastRead?: number;
    private error?: string;
    private connectionIssue?: string;
    private incompatible = false;
    private approvalHelp = false;
    private approvalManagerAvailable?: boolean;
    private disposed = false;
    private http?: HttpStatistics;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.source = parseProfile(context.workspaceState.get(PROFILE_KEY));
        this.automatic = !!this.source && this.source.kind !== 'editor';
    }

    getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }
    getChildren(item?: vscode.TreeItem): vscode.TreeItem[] {
        if (item || !this.source) { return []; }
        const source = this.source;
        const name = source.kind === 'database' ? basename(source.path) :
            source.kind === 'http' ? new URL(source.url).host : source.tool;
        const status = this.busy ? 'Reading statistics' : this.error ? 'Last request failed' :
            !this.panel?.visible ? 'Collection paused - dashboard is hidden' :
                this.pollingPaused ? 'Automatic refresh paused' : this.automatic ? 'Automatic refresh' : 'Manual refresh';
        const rows: vscode.TreeItem[] = [
            { id: 'source', label: name, description: source.kind === 'editor' ? 'VS Code tool' : source.kind === 'http' ? 'HTTP' : 'SQLite',
                tooltip: name, iconPath: new vscode.ThemeIcon('plug'),
                command: { command: 'mcpstat.openDashboard', title: 'Open Dashboard' } },
            { id: 'status', label: status, iconPath: new vscode.ThemeIcon(this.error ? 'warning' : 'info'),
                tooltip: this.error ?? 'Automatic collection runs only while the dashboard is visible.' },
        ];
        if (this.snapshot) {
            const totals = summarize(this.snapshot.stats);
            const partial = this.snapshot.truncated ? ' (partial)' : '';
            rows.push({ id: 'calls', label: `Calls${partial}`, description: String(totals.calls) },
                { id: 'errors', label: `Errors${partial}`, description: String(totals.errors) },
                { id: 'handlers', label: `Used / tracked${partial}`, description: `${totals.used} / ${this.snapshot.trackedCount}` });
        }
        rows.push({ id: 'observed', label: 'Last observation',
            description: this.lastRead ? new Date(this.lastRead).toLocaleTimeString() : 'None',
            tooltip: this.lastRead ? new Date(this.lastRead).toISOString() : 'Refresh to request statistics.' });
        return rows;
    }

    async show(): Promise<void> {
        if (this.panel) { this.panel.reveal(); return; }
        const panel = vscode.window.createWebviewPanel('mcpstat.dashboard', 'mcpstat Dashboard',
            vscode.ViewColumn.One, {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
            });
        this.panel = panel;
        const nonce = randomBytes(24).toString('base64');
        const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
        try {
            const html = await readFile(vscode.Uri.joinPath(media, 'dashboard.html').fsPath, 'utf8');
            if (this.panel !== panel) { return; }
            const replacements: Record<string, string> = {
                ...Object.fromEntries(Object.entries(links).map(([name, url]) => [`{{link_${name}}}`, url])),
                '{{cspSource}}': panel.webview.cspSource,
                '{{nonce}}': nonce,
                '{{css}}': panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'dashboard.css')).toString(),
                '{{icons}}': panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'generated', 'icons.css')).toString(),
                '{{script}}': panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'generated', 'webview.js')).toString(),
            };
            panel.webview.onDidReceiveMessage((message: unknown) => {
                void this.message(message).catch(() => {
                    this.error = 'The action could not be completed. Check the selected source and try again.';
                    this.send();
                });
            }, undefined, this.context.subscriptions);
            panel.onDidDispose(() => {
                if (this.panel === panel) {
                    this.panel = undefined;
                    this.generation++;
                    this.stop();
                    this.busy = false;
                    this.send();
                }
            }, undefined, this.context.subscriptions);
            panel.onDidChangeViewState(() => {
                if (panel.visible && this.source && this.automatic && !this.pollingPaused) { void this.refresh(); }
                else { this.stopTimer(); }
                this.send();
            }, undefined, this.context.subscriptions);
            panel.webview.html = html.replace(/\{\{\w+\}\}/g, token => replacements[token] ?? '');
        } catch {
            panel.dispose();
            void vscode.window.showErrorMessage('Could not open the mcpstat dashboard assets.');
        }
    }

    private trusted(): boolean {
        if (vscode.workspace.isTrusted) { return true; }
        void vscode.window.showWarningMessage('Trust this workspace before connecting to a statistics source.');
        return false;
    }

    private async database(path: string, server?: string): Promise<unknown> {
        const controller = new AbortController();
        this.requests.add(controller);
        try {
            const python = vscode.workspace.getConfiguration('mcpstat').get<string>('pythonPath', 'python3');
            if (!python || python.length > 4096 || /[\r\n\0]/.test(python)) {
                throw new Error('Configure a valid Python executable in mcpstat.pythonPath.');
            }
            return await readDatabase(python,
                vscode.Uri.joinPath(this.context.extensionUri, 'reader', 'sqlite_reader.py').fsPath,
                path, controller.signal, server);
        } finally { this.requests.delete(controller); }
    }

    async connect(): Promise<void> {
        if (!this.trusted()) { return; }
        const selection = ++this.selection;
        this.connectionIssue = undefined;
        this.send();
        const choice = await chooseSource(() => selection === this.selection && !this.disposed);
        if (!choice || selection !== this.selection || this.disposed) { return; }
        if (choice.sourceKind === 'discovery') {
            if (!statisticsTools().length) {
                await this.show();
                if (selection !== this.selection || this.disposed) { return; }
                this.connectionIssue = new IncompatibleSourceError().message; this.send();
            }
            await showDiscoveryInfo(); return;
        }
        if (choice.sourceKind === 'http') { await this.connectHttp(selection); return; }
        const previous = this.replace({ kind: 'editor', tool: choice.tool });
        await this.remember(previous);
        await this.show();
        await this.refresh();
    }

    private async connectHttp(selection: number): Promise<void> {
        const current = () => selection === this.selection && !this.disposed && this.trusted();
        const value = await vscode.window.showInputBox({ title: 'MCP server endpoint',
            prompt: 'Enter the Streamable HTTP endpoint of the server using mcpstat.',
            placeHolder: 'https://example.com/mcp', ignoreFocusOut: true,
            value: this.source?.kind === 'http' ? this.source.url : undefined,
            validateInput: input => { try { endpoint(input.trim()); return undefined; } catch (error) { return (error as Error).message; } },
        });
        if (value === undefined || !current()) { return; }
        const url = endpoint(value.trim()).href;
        const savedId = this.source?.kind === 'http' && this.source.url === url ? this.source.credentialId : undefined;
        const savedToken = savedId ? await this.context.secrets.get(secretKey(savedId)) : undefined;
        const auth = await vscode.window.showQuickPick([
            ...(savedToken ? [{ label: 'Use saved bearer token', mode: 'saved' }] : []),
            { label: 'No authentication', mode: 'none' }, { label: 'Bearer token', mode: 'token' },
        ], { title: 'MCP server authentication' });
        if (!auth || !current()) { return; }
        let token = auth.mode === 'saved' ? savedToken : undefined;
        if (auth.mode === 'token') {
            token = await vscode.window.showInputBox({ title: 'MCP bearer token', password: true,
                prompt: 'Stored in VS Code SecretStorage for this endpoint.', ignoreFocusOut: true,
                validateInput: input => !input.trim() || /[\r\n]/.test(input) || input.length > 8192 ? 'Enter a valid bearer token.' : undefined });
            if (token === undefined || !current()) { return; }
            token = token.trim();
        }
        const connection = new HttpStatistics(url, token);
        const credentialId = randomBytes(32).toString('hex');
        const controller = new AbortController();
        this.requests.add(controller);
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        try {
            const tools = await connection.tools(controller.signal);
            if (!current()) { return; }
            if (!tools.length) { throw new IncompatibleSourceError(); }
            const tool = tools.length === 1 ? tools[0] : await vscode.window.showQuickPick(tools,
                { title: 'Select the statistics tool to monitor' });
            if (!tool || !current()) { return; }
            if (token) { await this.context.secrets.store(secretKey(credentialId), token); }
            if (!current()) { return; }
            const previous = this.replace({ kind: 'http', url, tool, credentialId });
            await this.remember(previous);
            await this.show();
            await this.refresh();
        } catch (error) {
            if (current()) {
                if (error instanceof IncompatibleSourceError) {
                    await this.show();
                    if (current()) { this.connectionIssue = error.message; this.send(); }
                } else { this.report(error); }
            }
        }
        finally {
            clearTimeout(timer); this.requests.delete(controller);
            try {
                if (this.source?.kind !== 'http' || this.source.credentialId !== credentialId) {
                    await this.context.secrets.delete(secretKey(credentialId));
                }
            } finally { await connection.close(); }
        }
    }

    async connectDatabase(): Promise<void> {
        if (!this.trusted()) { return; }
        const selection = ++this.selection;
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false,
            canSelectFolders: false, title: 'Select an existing mcpstat 0.3.0 statistics database',
            filters: { 'SQLite databases': ['sqlite', 'sqlite3', 'db'], 'All files': ['*'] } });
        const uri = picked?.[0];
        if (!uri || !this.trusted() || selection !== this.selection) { return; }
        const generation = this.generation;
        try {
            const listing = await this.database(uri.fsPath) as { servers?: unknown };
            if (this.disposed || this.generation !== generation || selection !== this.selection) { return; }
            if (!Array.isArray(listing.servers) || listing.servers.length > 100 ||
                !listing.servers.every(name => typeof name === 'string' && name.length <= 2048)) {
                throw new Error('The database reader returned invalid server identities.');
            }
            const servers = listing.servers as string[];
            if (!servers.length) { throw new Error('This database has no recorded or registered handlers yet.'); }
            const choices = servers.map(name => ({ label: name || '(unnamed server)', name }));
            const selected = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, { title: 'Select the server to monitor' });
            if (!selected || this.generation !== generation || this.disposed || selection !== this.selection) { return; }
            const previous = this.replace({ kind: 'database', path: uri.fsPath, server: selected.name });
            await this.remember(previous);
            await this.show();
            await this.refresh();
        } catch (error) { this.report(error); }
    }

    private async remember(previous?: Source): Promise<void> {
        await this.context.workspaceState.update(PROFILE_KEY, this.source);
        if (previous?.kind === 'http' && previous.credentialId) {
            await this.context.secrets.delete(secretKey(previous.credentialId));
        }
    }

    private replace(source?: Source): Source | undefined {
        const previous = this.source;
        this.generation++;
        this.stop();
        this.source = source;
        this.automatic = !!source && source.kind !== 'editor';
        this.pollingPaused = false;
        this.snapshot = undefined;
        this.lastRead = undefined;
        this.error = undefined;
        this.connectionIssue = undefined;
        this.incompatible = false;
        this.approvalHelp = false;
        this.busy = false;
        this.history.clear();
        void vscode.commands.executeCommand('setContext', 'mcpstat.hasStatistics', false);
        return previous;
    }

    async refresh(): Promise<void> {
        if (!this.source || !this.trusted() || this.busy || this.disposed) { return; }
        const source = this.source;
        const generation = this.generation;
        this.stopTimer();
        this.busy = true;
        this.send();
        const controller = new AbortController();
        this.requests.add(controller);
        const timeout = source.kind === 'editor' ? undefined : setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
        try {
            let snapshot: Snapshot;
            if (source.kind === 'database') {
                snapshot = parseSnapshot(await this.database(source.path, source.server));
            } else if (source.kind === 'editor') {
                snapshot = await readEditor(source.tool, controller.signal);
            } else {
                if (!this.http) {
                    // Legacy endpoint-wide secrets cannot be attributed to this workspace.
                    if (!source.credentialId) { throw new Error('Reconnect this HTTP source to select credentials for this workspace.'); }
                    const token = await this.context.secrets.get(secretKey(source.credentialId));
                    if (generation !== this.generation || this.disposed || controller.signal.aborted) { return; }
                    this.http = new HttpStatistics(source.url, token);
                }
                snapshot = await this.http.read(source.tool, controller.signal);
            }
            if (this.disposed || generation !== this.generation) { return; }
            this.snapshot = snapshot;
            this.lastRead = Date.now();
            this.error = undefined;
            this.incompatible = false;
            this.pollingPaused = false;
            this.history.observe(snapshot, this.lastRead, this.interval());
            void vscode.commands.executeCommand('setContext', 'mcpstat.hasStatistics', true);
        } catch (error) {
            if (generation === this.generation && !this.disposed) {
                this.error = error instanceof Error ? error.message : 'Statistics are temporarily unavailable.';
                this.incompatible = error instanceof IncompatibleSourceError;
                if (this.snapshot) { this.error += ' Previous values may be stale.'; }
                if (this.automatic) { this.error += ' Automatic refresh paused. Use Refresh to retry.'; }
                this.pollingPaused = true;
                if (this.http) { void this.http.close(); this.http = undefined; }
            }
        } finally {
            if (timeout) { clearTimeout(timeout); }
            this.requests.delete(controller);
            if (generation === this.generation && !this.disposed) {
                this.busy = false;
                this.send();
                this.schedule();
            }
        }
    }

    async disconnect(): Promise<void> {
        const previous = this.source;
        this.selection++; this.replace(); this.send();
        await this.remember(previous);
    }
    clearHistory(): void { this.history.clear(); this.send(); }
    async toggleAutomatic(): Promise<void> {
        if (!this.source || !this.trusted() || this.disposed) { return; }
        if (!this.automatic && this.source.kind === 'editor') { await this.showApprovalHelp(); return; }
        this.automatic = !this.automatic;
        this.approvalHelp = false;
        if (this.automatic) { this.pollingPaused = false; }
        this.send(); this.schedule();
    }
    private async showApprovalHelp(): Promise<void> {
        if (this.source?.kind !== 'editor' || this.disposed) { return; }
        const generation = this.generation;
        this.approvalHelp = true;
        this.approvalManagerAvailable = undefined;
        this.send();
        // Saved grants are not exposed by the public API. Check only whether
        // the editor provides its approval-management command.
        const commands = await vscode.commands.getCommands(true);
        if (this.disposed || generation !== this.generation || !this.approvalHelp) { return; }
        this.approvalManagerAvailable = commands.includes(APPROVAL_COMMAND);
        this.send();
    }
    private startAutomatic(): void {
        if (!this.approvalHelp || this.source?.kind !== 'editor' || !this.trusted() || this.disposed) { return; }
        this.approvalHelp = false;
        this.automatic = true;
        this.pollingPaused = false;
        this.send(); this.schedule();
    }
    configurationChanged(): void { this.stopTimer(); this.schedule(); }
    private interval(): number {
        const value = vscode.workspace.getConfiguration('mcpstat').get<number>('refreshSeconds', 15);
        return Math.max(5, Math.min(300, Number.isFinite(value) ? value : 15)) * 1000;
    }
    private schedule(): void {
        this.stopTimer();
        if (this.panel?.visible && this.source && this.automatic && !this.pollingPaused && !this.disposed) {
            this.timer = setTimeout(() => { void this.refresh(); }, this.interval());
        }
    }
    private stopTimer(): void { if (this.timer) { clearTimeout(this.timer); this.timer = undefined; } }
    private stop(): void {
        this.stopTimer(); for (const request of this.requests) { request.abort(); }
        if (this.http) { void this.http.close(); this.http = undefined; }
    }
    private report(error: unknown): void {
        const message = error instanceof Error ? error.message : 'Cannot access this statistics source.';
        void vscode.window.showErrorMessage(message);
    }
    private send(): void {
        if (this.disposed) { return; }
        this.treeChanges.fire();
        if (!this.panel) { return; }
        void this.panel.webview.postMessage({
            type: 'state', snapshot: this.snapshot, points: this.history.points,
            source: this.source ? { kind: this.source.kind,
                name: this.source.kind === 'database' ? basename(this.source.path) :
                    this.source.kind === 'http' ? new URL(this.source.url).host : this.source.tool,
                server: this.source.kind === 'database' ? this.source.server : undefined } : undefined,
            lastRead: this.lastRead, error: this.error, busy: this.busy,
            connectionIssue: this.connectionIssue, needsMcpstat: !!this.connectionIssue || this.incompatible,
            approvalHelp: this.approvalHelp, approvalManagerAvailable: this.approvalManagerAvailable,
            automatic: this.automatic, pollingPaused: this.pollingPaused,
            interval: this.interval(), remote: vscode.env.remoteName !== undefined,
        });
    }
    private async message(value: unknown): Promise<void> {
        if (!value || typeof value !== 'object') { return; }
        const { action } = value as { action?: unknown };
        switch (action) {
            case 'ready':
                this.send();
                if (this.source && !this.pollingPaused && (!this.lastRead || (this.automatic && Date.now() - this.lastRead >= this.interval()))) { await this.refresh(); }
                else { this.schedule(); }
                break;
            case 'connect': await this.connect(); break;
            case 'database': await this.connectDatabase(); break;
            case 'refresh': await this.refresh(); break;
            case 'automatic': await this.toggleAutomatic(); break;
            case 'approval-help': await this.showApprovalHelp(); break;
            case 'approval-manage':
                if (this.approvalHelp && this.approvalManagerAvailable && this.source?.kind === 'editor') {
                    await vscode.commands.executeCommand(APPROVAL_COMMAND);
                }
                break;
            case 'automatic-start': this.startAutomatic(); break;
            case 'approval-dismiss': this.approvalHelp = false; this.send(); break;
            case 'disconnect': await this.disconnect(); break;
            case 'clear': this.clearHistory(); break;
            default:
                if (typeof action === 'string' && action.startsWith('link:')) {
                    const name = action.slice(5);
                    const url = Object.hasOwn(links, name) ? links[name] : undefined;
                    if (url) { await vscode.env.openExternal(vscode.Uri.parse(url)); }
                }
        }
    }
    dispose(): void { this.disposed = true; this.generation++; this.stop(); this.panel?.dispose(); this.treeChanges.dispose(); }
}

export function activate(context: vscode.ExtensionContext): void {
    const dashboard = new Dashboard(context);
    context.subscriptions.push(dashboard,
        vscode.window.registerTreeDataProvider('mcpstat.connection', dashboard),
        vscode.commands.registerCommand('mcpstat.openWalkthrough', () => vscode.commands.executeCommand(
            'workbench.action.openWalkthrough', `${context.extension.id}#mcpstat.setup`, false)),
        vscode.commands.registerCommand('mcpstat.openIntegration', () => vscode.env.openExternal(vscode.Uri.parse(links.integration!))),
        vscode.commands.registerCommand('mcpstat.openDashboard', () => dashboard.show()),
        vscode.commands.registerCommand('mcpstat.connectServer', () => dashboard.connect()),
        vscode.commands.registerCommand('mcpstat.checkDiscovery', () => showDiscoveryInfo()),
        vscode.commands.registerCommand('mcpstat.connectDatabase', () => dashboard.connectDatabase()),
        vscode.commands.registerCommand('mcpstat.refresh', () => dashboard.refresh()),
        vscode.commands.registerCommand('mcpstat.disconnect', () => dashboard.disconnect()),
        vscode.commands.registerCommand('mcpstat.clearHistory', () => dashboard.clearHistory()),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('mcpstat')) { dashboard.configurationChanged(); }
        }));
}
