// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT

export const MAX_ROWS = 1000;
export const MAX_HISTORY = 240;
export const MAX_BYTES = 4 * 1024 * 1024;
export class IncompatibleSourceError extends Error {
    constructor() {
        super('No supported mcpstat statistics were found. The MCP server needs mcpstat installed, tracking configured and a get_tool_usage_stats tool registered. If already configured, start the server and reconnect.');
    }
}
const outcomes = ['success_count', 'error_count', 'cancelled_count', 'incomplete_count'] as const;
const counters = ['call_count', ...outcomes, 'total_duration_ms', 'duration_sample_count',
    'total_input_tokens', 'total_output_tokens', 'estimated_tokens'] as const;
type Counter = typeof counters[number];

export type Row = Record<Counter, number> & {
    name: string; type: 'tool' | 'prompt' | 'resource'; tags: string[];
    short_description: string; last_accessed: string | null;
    min_duration_ms: number | null; max_duration_ms: number | null;
    latency_complete: boolean;
};
export interface Snapshot {
    stats: Row[];
    trackedCount: number;
    truncated: boolean;
}
export interface Point {
    at: number; calls: number | null; errors: number | null;
    latency: number | null; gap: boolean;
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Expected a statistics object.');
    }
    return value as Record<string, unknown>;
}
function count(value: unknown, fallback = 0): number {
    if (value === undefined || value === null) { return fallback; }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error('Statistics contain an invalid counter.');
    }
    return value;
}
function text(value: unknown, max: number, codePoints = true): string {
    if (typeof value !== 'string' || value.length > max * (codePoints ? 2 : 1) ||
        (codePoints && value.length > max && [...value].length > max)) {
        throw new Error('Statistics contain an invalid text field.');
    }
    return value;
}
function duration(value: unknown): number | null {
    if (value === undefined || value === null) { return null; }
    return count(value);
}
function date(value: unknown): string | null {
    if (value === undefined || value === null) { return null; }
    const result = text(value, 64);
    if (!Number.isFinite(Date.parse(result))) { throw new Error('Invalid statistics timestamp.'); }
    return result;
}
export function key(row: Row): string { return `${row.type}\0${row.name}`; }

/** Accept the get_tool_usage_stats payload or an MCP tool-result envelope. */
export function parseSnapshot(value: unknown): Snapshot {
    let input = object(value);
    if (input.isError === true || input.is_error === true) { throw new Error('The statistics tool returned an error.'); }
    if (input.structuredContent || input.structured_content) {
        input = object(input.structuredContent || input.structured_content);
    } else if (!Array.isArray(input.stats) && Array.isArray(input.content)) {
        const parts = input.content.map(object).filter(part => part.type === 'text');
        if (parts.length !== 1) { throw new Error('Expected one JSON statistics result.'); }
        input = object(JSON.parse(text(parts[0]?.text, MAX_BYTES, false)));
    }
    if (!Array.isArray(input.stats) || input.stats.length > MAX_ROWS) {
        throw new Error('Expected a statistics response containing at most 1000 rows.');
    }
    const identities = new Set<string>();
    const stats = input.stats.map(value => {
        const source = object(value);
        const name = text(source.name, 2048);
        if (!name || !['tool', 'prompt', 'resource'].includes(String(source.type))) {
            throw new Error('Invalid statistics identity.');
        }
        const measured = Object.fromEntries(counters.map(field => [field, count(source[field])])) as Record<Counter, number>;
        if (outcomes.reduce((sum, field) => sum + measured[field], 0) > measured.call_count ||
            measured.duration_sample_count > measured.call_count) {
            throw new Error('Statistics counters are inconsistent.');
        }
        const tags = source.tags ?? [];
        if (!Array.isArray(tags) || tags.length > 50) { throw new Error('Invalid statistics tags.'); }
        const row: Row = {
            ...measured, name, type: source.type as Row['type'],
            tags: tags.map(tag => text(tag, 100)),
            short_description: text(source.short_description ?? '', 4096),
            last_accessed: date(source.last_accessed),
            min_duration_ms: duration(source.min_duration_ms), max_duration_ms: duration(source.max_duration_ms),
            latency_complete: source.latency_complete !== 0 && source.latency_complete !== false && source.avg_latency_ms !== null,
        };
        const id = key(row);
        if (identities.has(id)) { throw new Error('Duplicate statistics identities. Select one server at a time.'); }
        identities.add(id);
        return row;
    });
    for (const field of counters) {
        if (!Number.isSafeInteger(stats.reduce((sum, row) => sum + row[field], 0))) {
            throw new Error('Aggregated statistics exceed the supported integer range.');
        }
    }
    const trackedCount = count(input.tracked_count, stats.length);
    if (trackedCount < stats.length) { throw new Error('Invalid tracked item count.'); }
    return { stats, trackedCount, truncated: trackedCount > stats.length };
}

export function summarize(rows: Row[]) {
    const total = (field: Counter) => rows.reduce((sum, row) => sum + row[field], 0);
    const calls = total('call_count');
    const classified = outcomes.reduce((sum, field) => sum + total(field), 0);
    const samples = total('duration_sample_count');
    return {
        calls, successes: total('success_count'), errors: total('error_count'),
        cancelled: total('cancelled_count'), incomplete: total('incomplete_count'),
        unknown: Math.max(0, calls - classified),
        successRate: classified ? total('success_count') / classified * 100 : null,
        samples, avgLatency: samples && rows.every(row => row.latency_complete) ? total('total_duration_ms') / samples : null,
        used: rows.filter(row => row.call_count > 0).length, registered: rows.length,
        inputTokens: total('total_input_tokens'), outputTokens: total('total_output_tokens'), estimatedTokens: total('estimated_tokens'),
    };
}

/** Store observations, not invented historical requests. Gaps and resets break lines. */
export class History {
    readonly points: Point[] = [];
    private previous?: { at: number; snapshot: Snapshot };
    clear(): void { this.points.length = 0; this.previous = undefined; }
    observe(snapshot: Snapshot, at: number, intervalMs: number): void {
        const previous = this.previous;
        let point: Point = { at, calls: null, errors: null, latency: null, gap: true };
        if (previous && at > previous.at && at - previous.at <= intervalMs * 2.5 &&
            !snapshot.truncated && !previous.snapshot.truncated) {
            const before = new Map(previous.snapshot.stats.map(row => [key(row), row]));
            let calls = 0, errors = 0, duration = 0, samples = 0;
            let valid = snapshot.stats.length === before.size;
            for (const row of snapshot.stats) {
                const old = before.get(key(row));
                if (!old || counters.some(field => row[field] < old[field]) ||
                    (old.last_accessed && row.last_accessed && row.last_accessed < old.last_accessed)) {
                    valid = false; break;
                }
                calls += row.call_count - old.call_count;
                errors += row.error_count - old.error_count;
                duration += row.total_duration_ms - old.total_duration_ms;
                samples += row.duration_sample_count - old.duration_sample_count;
            }
            if (valid) { point = { at, calls: calls * 60000 / (at - previous.at), errors: errors * 60000 / (at - previous.at), latency: samples ? duration / samples : null, gap: false }; }
        }
        this.points.push(point);
        if (this.points.length > MAX_HISTORY) { this.points.shift(); }
        this.previous = { at, snapshot };
    }
}
