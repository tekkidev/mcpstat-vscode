// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT

import { Point, Row, Snapshot, summarize } from './model.js';

declare function acquireVsCodeApi(): {
    postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void;
};
const vscode = acquireVsCodeApi();
interface State {
    type: 'state'; snapshot?: Snapshot; points: Point[];
    source?: { kind: 'database' | 'editor' | 'http'; name: string; server?: string };
    lastRead?: number; error?: string; busy: boolean; interval: number; remote: boolean;
    automatic?: boolean; pollingPaused?: boolean;
    connectionIssue?: string; needsMcpstat?: boolean;
    approvalHelp?: boolean; approvalManagerAvailable?: boolean;
}
let state: State = { type: 'state', points: [], busy: false, interval: 15000, remote: false };
let descending = true;
let selectedTag = '';
function element<T extends HTMLElement = HTMLElement>(id: string): T {
    const value = document.getElementById(id);
    if (!value) { throw new Error('Missing dashboard element.'); }
    return value as T;
}
function set(id: string, value: string): void { element(id).textContent = value; }
function savePreferences(): void {
    vscode.setState({ search: element<HTMLInputElement>('search').value,
        primitive: element<HTMLSelectElement>('primitive').value, tag: selectedTag, descending });
}
function restorePreferences(): void {
    const saved = vscode.getState();
    if (!saved || typeof saved !== 'object') { return; }
    const preferences = saved as Record<string, unknown>;
    if (typeof preferences.search === 'string' && preferences.search.length <= 200) {
        element<HTMLInputElement>('search').value = preferences.search;
    }
    if (typeof preferences.primitive === 'string' && ['all', 'tool', 'prompt', 'resource'].includes(preferences.primitive)) {
        element<HTMLSelectElement>('primitive').value = preferences.primitive;
    }
    if (typeof preferences.tag === 'string' && preferences.tag.length <= 100) { selectedTag = preferences.tag; }
    if (typeof preferences.descending === 'boolean') { descending = preferences.descending; }
    set('sort-calls', `Calls ${descending ? '↓' : '↑'}`);
}
const number = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 1 });
const ms = (value: number | null) => value === null ? 'n/a' : number(value);
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string>): SVGElementTagNameMap[K] {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) { node.setAttribute(name, value); }
    return node;
}

function renderTimeline(): void {
    const chart = document.getElementById('timeline') as SVGSVGElement | null;
    if (!chart) { return; }
    chart.replaceChildren();
    const points = state.points;
    const measured = points.filter(point => point.calls !== null);
    const first = points[0];
    const last = points[points.length - 1];
    const max = Math.max(1, ...measured.map(point => point.calls ?? 0));
    const start = first?.at ?? 0;
    const span = Math.max(1, (last?.at ?? start) - start);
    for (const fraction of [0, .5, 1]) {
        const y = 138 - fraction * 124;
        chart.append(svg('line', { x1: '40', x2: '632', y1: String(y), y2: String(y), class: 'grid-line' }));
        const label = svg('text', { x: '0', y: String(y + 3), class: 'axis-label' });
        label.textContent = number(max * fraction);
        chart.append(label);
    }
    for (const [field, className] of [['calls', 'calls-line'], ['errors', 'errors-line']] as const) {
        let path = '';
        let drawing = false;
        for (const point of points) {
            const value = point[field];
            if (value === null || point.gap) { drawing = false; continue; }
            const x = 40 + (point.at - start) / span * 592;
            const y = 138 - value / max * 124;
            path += `${drawing ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `;
            drawing = true;
            chart.append(svg('circle', { cx: String(x), cy: String(y), r: '2', class: className }));
        }
        chart.append(svg('path', { d: path, class: className }));
    }
    set('history-caption', first && last && measured.length ? `Whole source · ${new Date(first.at).toLocaleTimeString()} - ${new Date(last.at).toLocaleTimeString()} · ${measured.length} measured intervals` :
            'Waiting for a second observation. Collection gaps and resets remain gaps.');
}

function renderRanking(rows: Row[]): void {
    const container = element('ranking');
    container.replaceChildren();
    const ranked = [...rows].sort((a, b) => b.call_count - a.call_count).slice(0, 5);
    const max = Math.max(1, ...ranked.map(row => row.call_count));
    for (const row of ranked) {
        const item = document.createElement('div'); item.className = 'rank';
        const label = document.createElement('div'); label.className = 'rank-label';
        const name = document.createElement('span'); name.textContent = row.name; name.title = row.name;
        const count = document.createElement('b'); count.textContent = number(row.call_count);
        label.append(name, count);
        const bar = svg('svg', { viewBox: '0 0 100 5', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
        bar.append(svg('rect', { width: '100', height: '5', class: 'rank-track' }),
            svg('rect', { width: String(row.call_count / max * 100), height: '5', class: 'rank-fill' }));
        item.append(label, bar); container.append(item);
    }
    if (!ranked.length) { container.textContent = 'No matching handlers.'; }
}

function renderTable(rows: Row[]): void {
    const body = element('rows'); body.replaceChildren();
    const sorted = [...rows].sort((a, b) => (descending ? b.call_count - a.call_count : a.call_count - b.call_count) || a.name.localeCompare(b.name));
    for (const row of sorted.slice(0, 200)) {
        const tr = document.createElement('tr');
        const identity = document.createElement('td');
        const name = document.createElement('div'); name.className = 'handler-name'; name.textContent = row.name;
        name.title = row.short_description;
        const tags = document.createElement('div'); tags.className = 'tags'; tags.textContent = row.tags.join(' · ');
        identity.append(name, tags); tr.append(identity);
        const avg = row.latency_complete && row.duration_sample_count ? row.total_duration_ms / row.duration_sample_count : null;
        const cells = [row.type, number(row.call_count), number(row.error_count),
            `${ms(avg)} / ${ms(row.min_duration_ms)} / ${ms(row.max_duration_ms)}`,
            `${number(row.duration_sample_count)} / ${number(row.call_count)}`,
            row.last_accessed ? new Date(row.last_accessed).toLocaleString() : 'Never recorded'];
        for (const value of cells) { const td = document.createElement('td'); td.textContent = value; tr.append(td); }
        body.append(tr);
    }
    set('table-caption', `${Math.min(200, rows.length)} of ${rows.length} matching handlers${rows.length > 200 ? ' · filter to narrow results' : ''}`);
    if (!rows.length) {
        const tr = document.createElement('tr'), td = document.createElement('td');
        td.colSpan = 7; td.textContent = 'No handlers match these filters.'; tr.append(td); body.append(tr);
    }
}

function render(): void {
    const snapshot = state.snapshot;
    element('empty').hidden = !!snapshot;
    element('dashboard').hidden = !snapshot;
    element<HTMLButtonElement>('refresh').disabled = !state.source || state.busy;
    element<HTMLButtonElement>('disconnect').disabled = !state.source;
    const automatic = element<HTMLButtonElement>('automatic');
    automatic.disabled = !state.source;
    automatic.textContent = state.automatic ? 'Pause auto-refresh' : 'Start auto-refresh';
    automatic.setAttribute('aria-pressed', String(!!state.automatic));
    const sourceLabels = { database: 'DATABASE', editor: 'VS CODE', http: 'MCP SERVER' };
    set('source', state.source ? `${sourceLabels[state.source.kind]} / ${state.source.name}${state.source.server !== undefined ? ` / ${state.source.server || '(unnamed server)'}` : ''}` : 'GET STARTED');
    const refreshMode = state.automatic ? `every ${state.interval / 1000}s while visible` : 'manual refresh';
    set('status', state.busy ? (state.source?.kind === 'editor' ? 'Waiting for VS Code approval or statistics…' : 'Reading statistics…') :
        state.error ? (snapshot ? 'STALE / refresh failed' : 'Statistics unavailable / use Refresh to retry') : state.lastRead ?
        `Last observed ${new Date(state.lastRead).toLocaleTimeString()} · ${refreshMode}${state.remote ? ' · remote extension host' : ''}` : 'Choose an MCP server to begin.');
    const notices = [state.connectionIssue, state.error, snapshot?.truncated ? 'Partial inventory: the source has more than 1000 handlers. Cards and rankings cover returned rows only; interval graphs are disabled.' : undefined].filter(Boolean);
    element('notice').hidden = !notices.length;
    set('notice-message', notices.join(' '));
    element('notice-integration').hidden = !state.needsMcpstat;
    element('notice-approval').hidden = state.source?.kind !== 'editor' || !state.error;
    const approvalHelp = element('approval-help');
    const wasShowingApproval = !approvalHelp.hidden;
    approvalHelp.hidden = !state.approvalHelp || state.source?.kind !== 'editor';
    automatic.setAttribute('aria-expanded', String(!approvalHelp.hidden));
    element('approval-manage').hidden = !state.approvalManagerAvailable;
    element('approval-unavailable').hidden = state.approvalManagerAvailable !== false;
    set('approval-tool', state.source?.kind === 'editor' ? state.source.name : '');
    if (!approvalHelp.hidden && !wasShowingApproval) { element('approval-heading').focus(); }
    else if (approvalHelp.hidden && wasShowingApproval && !automatic.disabled) { automatic.focus(); }
    if (!snapshot) { return; }
    const tagSelect = element<HTMLSelectElement>('tag');
    const tags = [...new Set(snapshot.stats.flatMap(row => row.tags))].sort();
    tagSelect.replaceChildren(new Option('All tags', ''), ...tags.map(tag => new Option(tag, tag)));
    if (tags.includes(selectedTag)) { tagSelect.value = selectedTag; }
    else if (selectedTag) { selectedTag = ''; savePreferences(); }
    const query = element<HTMLInputElement>('search').value.toLocaleLowerCase();
    const primitive = element<HTMLSelectElement>('primitive').value;
    const rows = snapshot.stats.filter(row => (primitive === 'all' || row.type === primitive) &&
        (!tagSelect.value || row.tags.includes(tagSelect.value)) &&
        `${row.name} ${row.short_description} ${row.tags.join(' ')}`.toLocaleLowerCase().includes(query));
    const summary = summarize(rows);
    set('coverage', `${rows.length} / ${snapshot.stats.length} returned handlers`);
    set('calls', number(summary.calls));
    set('success', summary.successRate === null ? 'n/a' : `${number(summary.successRate)}%`);
    set('outcome-coverage', `${number(summary.unknown)} calls with unknown outcome`);
    set('latency', summary.avgLatency === null ? 'n/a' : `${number(summary.avgLatency)} ms`);
    set('samples', `${number(summary.samples)} measured samples / ${number(summary.calls)} calls`);
    set('used', `${summary.used} / ${summary.registered}`);
    set('unused', `${summary.registered - summary.used} handlers with no recorded calls`);
    set('success-count', number(summary.successes)); set('error-count', number(summary.errors));
    set('cancelled-count', number(summary.cancelled)); set('incomplete-count', number(summary.incomplete));
    set('unknown-count', number(summary.unknown));
    const tokens = [];
    if (summary.inputTokens || summary.outputTokens) { tokens.push(`Reported tokens: ${number(summary.inputTokens)} in / ${number(summary.outputTokens)} out`); }
    if (summary.estimatedTokens) { tokens.push(`Estimated tokens: ${number(summary.estimatedTokens)}`); }
    set('tokens', tokens.join(' · ') || 'No token measurements');
    renderTimeline(); renderRanking(rows); renderTable(rows);
}

document.querySelectorAll<HTMLElement>('[data-action]').forEach(control => {
    control.addEventListener('click', event => {
        event.preventDefault();
        vscode.postMessage({ action: control.dataset.action });
    });
});
element('about-toggle').addEventListener('click', () => {
    const about = element('about'); about.hidden = !about.hidden;
    element('about-toggle').setAttribute('aria-expanded', String(!about.hidden));
});
for (const id of ['search', 'primitive', 'tag']) {
    element(id).addEventListener(id === 'search' ? 'input' : 'change', () => {
        selectedTag = element<HTMLSelectElement>('tag').value;
        savePreferences(); render();
    });
}
element('sort-calls').addEventListener('click', () => {
    descending = !descending; set('sort-calls', `Calls ${descending ? '↓' : '↑'}`); savePreferences(); render();
});
window.addEventListener('message', (event: MessageEvent<State>) => {
    if (event.data?.type !== 'state') { return; }
    state = event.data;
    render();
});
restorePreferences();
vscode.postMessage({ action: 'ready' });
