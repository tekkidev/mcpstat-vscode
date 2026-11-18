// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { History, MAX_HISTORY, parseSnapshot, summarize } = require('../out/model');

function payload(calls = 2, extra = {}) {
    return { tracked_count: 1, stats: [{ name: 'weather', type: 'tool', call_count: calls,
        success_count: calls, duration_sample_count: calls, total_duration_ms: calls * 10,
        min_duration_ms: 10, max_duration_ms: 10, tags: ['weather'], ...extra }] };
}

test('accepts actual MCP envelopes, preserves unknown migrated outcomes and missing latency', () => {
    for (const wrapper of [value => value, value => ({ structuredContent: value }),
        value => ({ structured_content: value }), value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })]) {
        const snapshot = parseSnapshot(wrapper(payload(10, { success_count: 2, duration_sample_count: 2, total_duration_ms: 20, avg_latency_ms: null })));
        const summary = summarize(snapshot.stats);
        assert.equal(summary.unknown, 8);
        assert.equal(summary.avgLatency, null);
        assert.equal(summary.successRate, 100);
    }
});

test('computes latency from sample counts, not invocation counts or averages of averages', () => {
    const snapshot = parseSnapshot({ stats: [payload(10, { duration_sample_count: 2, total_duration_ms: 40 }).stats[0],
        { ...payload(1, { total_duration_ms: 80 }).stats[0], name: 'slow' }] });
    assert.equal(summarize(snapshot.stats).avgLatency, 40);
});

test('rejects malformed, negative, oversized, duplicate and inconsistent snapshots', () => {
    const invalid = [null, [], {}, { stats: Array(1001).fill({}) }, payload(-1),
        payload(2, { success_count: 3 }), payload(2, { duration_sample_count: 3 }),
        payload(2, { call_count: Number.MAX_SAFE_INTEGER + 1 }), payload(2, { tags: ['a'.repeat(101)] }),
        payload(2, { name: 'a'.repeat(2049) }), payload(2, { last_accessed: 'invalid' }),
        { stats: [payload().stats[0], payload().stats[0]] },
        { isError: true, structuredContent: payload() }, { tracked_count: 0, stats: payload().stats }];
    for (const value of invalid) { assert.throws(() => parseSnapshot(value)); }
});

test('untrusted tool names stay data and tool/resource identities remain distinct', () => {
    const name = '<img src=x onerror=alert(1)>';
    const snapshot = parseSnapshot({ stats: [payload(1, { name }).stats[0], payload(1, { name, type: 'resource' }).stats[0]] });
    assert.equal(snapshot.stats[0].name, name);
    assert.equal(snapshot.stats.length, 2);
});

test('rejects aggregates exceeding JavaScript integer precision', () => {
    assert.throws(() => parseSnapshot({ stats: [
        payload(Number.MAX_SAFE_INTEGER, { duration_sample_count: 0, total_duration_ms: 0 }).stats[0],
        { ...payload(1).stats[0], name: 'another' },
    ] }), /integer range/);
});

test('history derives interval rates and weighted interval latency', () => {
    const history = new History();
    history.observe(parseSnapshot(payload(2)), 1000, 15000);
    history.observe(parseSnapshot(payload(5)), 16000, 15000);
    assert.deepEqual(history.points.map(point => point.calls), [null, 12]);
    assert.equal(history.points[1].latency, 10);
});

test('gaps, resets, changed inventories and incomplete pages do not fabricate activity', () => {
    for (const next of [parseSnapshot(payload(1)), parseSnapshot({ stats: [] }),
        parseSnapshot({ ...payload(3), tracked_count: 1001 }), parseSnapshot(payload(3, { name: 'different' }))]) {
        const history = new History();
        history.observe(parseSnapshot(payload(2)), 1000, 15000);
        history.observe(next, 16000, 15000);
        assert.equal(history.points[1].calls, null);
    }
    const history = new History();
    history.observe(parseSnapshot(payload(2)), 1000, 15000);
    history.observe(parseSnapshot(payload(3)), 100000, 15000);
    assert.equal(history.points[1].gap, true);
});

test('history stays bounded and clears its baseline', () => {
    const history = new History();
    for (let index = 0; index < MAX_HISTORY + 10; index++) {
        history.observe(parseSnapshot(payload(index)), index * 15000, 15000);
    }
    assert.equal(history.points.length, MAX_HISTORY);
    history.clear();
    history.observe(parseSnapshot(payload(999)), 9999999, 15000);
    assert.equal(history.points[0].calls, null);
});
