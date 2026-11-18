// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright-core');

/** Click only synthetic-fixture approval dialogs in the isolated VS Code instance. */
exports.approveFixture = async (port, done) => {
    const address = `http://127.0.0.1:${port}`;
    let browser;
    const deadline = Date.now() + 90000;
    let approved = 0, observed = false, walkthrough = false;
    try {
        while (!done() && Date.now() < deadline) {
            try {
                const response = await fetch(`${address}/json/version`, { signal: AbortSignal.timeout(1000) });
                if (response.ok) { break; }
            } catch { /* The isolated editor is still starting. */ }
            await delay(100);
        }
        browser = await chromium.connectOverCDP(address);
        while (!done() && Date.now() < deadline) {
            for (const page of browser.contexts().flatMap(context => context.pages())) {
                if (await page.getByText('Add tracking to your MCP server', { exact: true }).isVisible().catch(() => false)) {
                    walkthrough = true;
                }
                if (approved === 3 && !observed) {
                    for (const frame of page.frames()) {
                        try {
                            const calls = frame.locator('#calls');
                            if (await calls.count() && await calls.textContent() === '1') {
                                assert.equal(await frame.locator('#notice').isVisible(), false);
                                assert.equal(await frame.locator('#automatic').textContent(), 'Start auto-refresh');
                                observed = true;
                            }
                        } catch (error) { if (!page.isClosed()) { throw error; } }
                    }
                }
                const dialog = page.locator('.monaco-dialog-box').filter({ hasText: 'Run get_tool_usage_stats' });
                if (!await dialog.isVisible().catch(() => false)) { continue; }
                assert.ok(approved < 3, 'Manual dashboard connections must not prompt periodically');
                if (approved === 0) {
                    await delay(16000);
                    assert.equal(await dialog.isVisible(), true, 'Approval remains available after 15 seconds');
                }
                await dialog.getByRole('button', { name: 'Yes', exact: true }).click();
                approved++;
                await dialog.waitFor({ state: 'hidden', timeout: 5000 });
            }
            await delay(100);
        }
        assert.equal(approved, 3, 'Two reader calls and one dashboard connection were approved');
        assert.equal(walkthrough, true, 'The native walkthrough displays this extension\'s setup content');
        assert.equal(observed, true, 'The real dashboard displays the recorded synthetic business call without a stale notice');
        console.log('PASS: delayed native approval succeeds and manual dashboard refresh does not repeat prompts.');
    } finally { await browser?.close(); }
};
