// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright-core');

exports.approveDialog = async dialog => {
    // The next request can show an identical dialog before a locator polls again.
    const current = await dialog.elementHandle();
    assert.ok(current, 'The synthetic approval dialog is present');
    try {
        await dialog.getByRole('button', { name: 'Yes', exact: true }).click();
        await current.waitForElementState('hidden', { timeout: 5000 });
    } finally { await current.dispose(); }
};

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
                                const origin = await frame.evaluate(() => window.location.origin);
                                assert.ok(origin && origin !== 'null', 'The real webview has a distinct, non-opaque origin');
                                assert.equal(await frame.locator('#notice').isVisible(), false);
                                assert.equal(await frame.locator('#automatic').textContent(), 'Start auto-refresh');
                                // Earlier Marketplace releases predate the separate help control.
                                if (await frame.locator('#approval-help-toggle').count()) {
                                    await frame.locator('#approval-help-toggle').press('Enter');
                                    await frame.locator('#approval-help').waitFor({ state: 'visible' });
                                    await frame.locator('[data-action="approval-dismiss"]').press('Enter');
                                    await frame.locator('#approval-help').waitFor({ state: 'hidden' });
                                }
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
                await exports.approveDialog(dialog);
                approved++;
            }
            await delay(100);
        }
        assert.equal(approved, 3, 'Two reader calls and one dashboard connection were approved');
        assert.equal(walkthrough, true, 'The native walkthrough displays this extension\'s setup content');
        assert.equal(observed, true, 'The real dashboard displays the recorded synthetic business call without a stale notice');
        console.log('PASS: delayed native approval succeeds and manual dashboard refresh does not repeat prompts.');
    } finally { await browser?.close(); }
};
