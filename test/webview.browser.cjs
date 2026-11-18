// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const { chromium } = require('playwright-core');
const { parseSnapshot } = require('../out/model');
const { links } = require('../out/links');

async function main() {
    const media = resolve(__dirname, '../media');
    const server = createServer(async (request, response) => {
        try {
            const path = request.url === '/' ? 'dashboard.html' : request.url.slice(1);
            if (!['dashboard.html', 'dashboard.css', 'generated/webview.js', 'generated/model.js',
                'generated/icons.css', 'generated/fonts/bootstrap-icons.woff2', 'icons/logo.svg'].includes(path)) {
                response.writeHead(404).end(); return;
            }
            let body = await readFile(join(media, path));
            if (path.endsWith('.html')) {
                const origin = `http://127.0.0.1:${server.address().port}`;
                const replacements = { ...Object.fromEntries(Object.entries(links).map(([name, url]) => [`{{link_${name}}}`, url])),
                    '{{cspSource}}': origin, '{{nonce}}': 'synthetic-test-nonce', '{{css}}': `${origin}/dashboard.css`, '{{icons}}': `${origin}/generated/icons.css`, '{{script}}': `${origin}/generated/webview.js` };
                body = body.toString('utf8').replace(/\{\{\w+\}\}/g, token => replacements[token]);
            }
            response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' :
                path.endsWith('.woff2') ? 'font/woff2' : path.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
            response.end(body);
        } catch { response.writeHead(500).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
            headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (/Content Security Policy|Refused to/.test(message.text())) { errors.push(message.text()); } });
        await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:') ? route.continue() : route.abort());
        await page.addInitScript(() => {
            window.actions = [];
            window.acquireVsCodeApi = () => ({ postMessage: message => window.actions.push(message.action),
                getState: () => JSON.parse(sessionStorage.getItem('webview-state') || 'null'),
                setState: value => sessionStorage.setItem('webview-state', JSON.stringify(value)) });
        });
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.waitForFunction(() => window.actions.includes('ready'));
        assert.match(await page.locator('h1 .accent').evaluate(node => getComputedStyle(node).backgroundImage), /linear-gradient/);
        await page.emulateMedia({ forcedColors: 'active' });
        assert.notEqual(await page.locator('h1 .accent').evaluate(node => getComputedStyle(node).color), 'rgba(0, 0, 0, 0)');
        await page.emulateMedia({ forcedColors: 'none' });
        assert.equal(await page.locator('#empty').isVisible(), true);
        assert.equal(await page.locator('[data-action="import"]').count(), 0);
        assert.equal(await page.locator('.brand p').textContent(), 'Usage tracking and analytics for MCP servers');
        assert.equal((await page.locator('footer').textContent()).includes('Local-first'), false);
        assert.equal((await page.locator('footer').textContent()).includes('No telemetry'), false);
        const names = ['get_weather', 'search_documents', 'fetch_account', 'list_projects', 'unused_tool'];
        const counts = [240, 180, 95, 42, 0];
        const snapshot = parseSnapshot({ stats: names.map((name, i) => ({ name, type: 'tool', tags: [i === 0 ? 'weather' : 'api'],
            call_count: counts[i], success_count: counts[i] - (i < 2 ? 4 : 0), error_count: i < 2 ? 4 : 0,
            duration_sample_count: counts[i], total_duration_ms: counts[i] * (i + 1) * 12,
            min_duration_ms: counts[i] ? 5 : null, max_duration_ms: counts[i] ? 110 : null,
            last_accessed: counts[i] ? '2026-01-01T12:00:00Z' : null })) });
        const now = Date.parse('2026-01-01T12:10:00Z');
        const points = Array.from({ length: 40 }, (_, i) => ({ at: now - (39 - i) * 15000,
            calls: 8 + (i * 7 % 17), errors: i % 9 === 0 ? 2 : 0, latency: 20, gap: false }));
        await page.evaluate(data => window.postMessage(data, '*'), { type: 'state', snapshot, points,
            source: { kind: 'editor', name: 'weather_get_tool_usage_stats' },
            lastRead: now, interval: 15000, busy: false, remote: false });
        await page.waitForFunction(() => document.getElementById('calls').textContent === '557');
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.evaluate(() => document.fonts.check('16px bootstrap-icons')), true);
        for (const [id, label] of [['search', 'Search'], ['primitive', 'Primitive'], ['tag', 'Tag']]) {
            assert.equal(await page.locator(`#${id}`).getAttribute('title'), label);
        }
        const heights = await page.locator('.filters input, .filters select').evaluateAll(fields => fields.map(field => field.getBoundingClientRect().height));
        assert.equal(new Set(heights).size, 1);
        assert.equal(await page.getByRole('searchbox', { name: 'Search', exact: true }).count(), 1);
        assert.equal(await page.getByRole('combobox', { name: 'Primitive', exact: true }).count(), 1);
        assert.equal(await page.getByRole('combobox', { name: 'Tag', exact: true }).count(), 1);
        assert.match(await page.locator('#status').textContent(), /manual refresh/);
        assert.equal(await page.locator('#automatic').textContent(), 'Start auto-refresh');
        await page.locator('#automatic').click();
        assert.equal(await page.evaluate(() => window.actions.includes('automatic')), true);
        assert.equal(await page.locator('#rows tr').count(), 5);
        assert.equal(await page.locator('#timeline path').count(), 2);
        await page.locator('#search').fill('get_weather');
        assert.equal(await page.locator('#rows tr').count(), 1);
        assert.equal(await page.locator('#calls').textContent(), '240');
        await page.locator('#search').fill('');
        await page.locator('#tag').selectOption('weather');
        assert.equal(await page.locator('#calls').textContent(), '240');
        await page.locator('#tag').selectOption('');
        await page.locator('#about-toggle').click();
        assert.equal(await page.locator('#about').isVisible(), true);
        assert.match(await page.locator('#about').textContent(), /Python library/);
        assert.match(await page.locator('#about').textContent(), /MCP server with mcpstat installed and tracking configured/);
        assert.equal(await page.locator('#about button').count(), 0);
        assert.equal(await page.locator('.about-links li').count(), 8);
        const library = page.locator('#about .project-link').first();
        assert.equal(await library.getAttribute('href'), links.library);
        assert.equal(await library.locator('strong').textContent(), 'mcpstat');
        await library.focus();
        await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(() => window.actions.at(-1)), 'link:library');
        await page.locator('.about-links a[data-action="link:source"]').click();
        assert.equal(await page.evaluate(() => window.actions.at(-1)), 'link:source');
        assert.equal(new URL(page.url()).hostname, '127.0.0.1');
        for (const link of await page.locator('#about a').all()) {
            const action = await link.getAttribute('data-action');
            assert.equal(await link.getAttribute('href'), links[action.slice(5)]);
        }
        await page.emulateMedia({ forcedColors: 'active' });
        assert.notEqual(await library.evaluate(node => getComputedStyle(node).color), 'rgba(0, 0, 0, 0)');
        await page.emulateMedia({ forcedColors: 'none' });
        assert.match(await library.evaluate(node => getComputedStyle(node).backgroundImage), /linear-gradient/);
        if (process.env.MCPSTAT_SCREENSHOT) {
            await page.screenshot({ path: process.env.MCPSTAT_SCREENSHOT.replace(/\.png$/, '-about.png'), fullPage: true });
        }
        await page.locator('#about-toggle').click();
        await page.locator('[data-action="refresh"]').click();
        assert.equal(await page.evaluate(() => window.actions.includes('refresh')), true);
        if (process.env.MCPSTAT_SCREENSHOT) {
            await page.screenshot({ path: process.env.MCPSTAT_SCREENSHOT, fullPage: true });
            await page.evaluate(() => {
                document.body.classList.add('vscode-light');
                const theme = { '--vscode-foreground': '#333333', '--vscode-editor-background': '#ffffff',
                    '--vscode-sideBar-background': '#f5f5f5', '--vscode-descriptionForeground': '#616161',
                    '--vscode-input-background': '#ffffff', '--vscode-panel-border': '#d4d4d4',
                    '--vscode-list-hoverBackground': '#e8e8e8' };
                for (const [name, value] of Object.entries(theme)) { document.documentElement.style.setProperty(name, value); }
            });
            await page.screenshot({ path: process.env.MCPSTAT_SCREENSHOT.replace(/\.png$/, '-light.png'), fullPage: true });
            await page.evaluate(() => { document.body.classList.remove('vscode-light'); document.documentElement.removeAttribute('style'); });
        }
        const malicious = parseSnapshot({ stats: [{ name: '<img src=x onerror="window.injected=true">', type: 'tool', call_count: 0 }] });
        const editorState = { type: 'state', snapshot, points, source: { kind: 'editor', name: 'weather_get_tool_usage_stats' },
            lastRead: now, interval: 15000, busy: false, remote: false, automatic: false };
        await page.locator('#search').fill('get_weather');
        await page.locator('#primitive').selectOption('tool');
        await page.locator('#tag').selectOption('weather');
        await page.locator('#sort-calls').click();
        // Recreate the document while retaining only the VS Code state API's data.
        await page.reload();
        await page.waitForFunction(() => window.actions.includes('ready'));
        await page.evaluate(data => window.postMessage(data, '*'), { type: 'state', points: [], busy: true });
        await page.evaluate(data => window.postMessage(data, '*'), editorState);
        await page.waitForFunction(() => document.getElementById('calls').textContent === '240');
        assert.equal(await page.locator('#search').inputValue(), 'get_weather');
        assert.equal(await page.locator('#primitive').inputValue(), 'tool');
        assert.equal(await page.locator('#tag').inputValue(), 'weather');
        assert.equal(await page.locator('#sort-calls').textContent(), 'Calls ↑');
        assert.equal(await page.locator('#rows tr').count(), 1);
        await page.locator('#search').fill('');
        await page.locator('#primitive').selectOption('all');
        await page.locator('#tag').selectOption('');
        await page.locator('#sort-calls').click();
        await page.evaluate(data => window.postMessage(data, '*'), { ...editorState, approvalHelp: true, approvalManagerAvailable: true });
        await page.locator('#approval-help').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#approval-heading').textContent(), 'Chat: Manage Tool Approval');
        assert.equal(await page.locator('#approval-heading').evaluate(node => node === document.activeElement), true);
        assert.equal(await page.locator('#approval-tool').textContent(), 'weather_get_tool_usage_stats');
        assert.match(await page.locator('#approval-help').textContent(), /avoid repeated confirmation dialogs/);
        assert.equal(await page.locator('#automatic').getAttribute('aria-pressed'), 'false');
        await page.locator('#approval-manage').click();
        assert.equal(await page.evaluate(() => window.actions.at(-1)), 'approval-manage');
        if (process.env.MCPSTAT_SCREENSHOT) {
            await page.screenshot({ path: process.env.MCPSTAT_SCREENSHOT.replace(/\.png$/, '-approval.png'), fullPage: true });
        }
        await page.evaluate(data => window.postMessage(data, '*'), { ...editorState, approvalHelp: true, approvalManagerAvailable: false });
        await page.locator('#approval-manage').waitFor({ state: 'hidden' });
        assert.equal(await page.locator('#approval-unavailable').isVisible(), true);
        await page.locator('[data-action="automatic-start"]').click();
        assert.equal(await page.evaluate(() => window.actions.at(-1)), 'automatic-start');
        await page.evaluate(data => window.postMessage(data, '*'), { type: 'state', points: [], busy: false, interval: 15000,
            connectionIssue: 'This server needs mcpstat installed and tracking configured.', needsMcpstat: true });
        await page.locator('#notice-integration').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#notice').isVisible(), true);
        assert.equal(await page.locator('#approval-help').isVisible(), false);
        assert.match(await page.locator('#notice').textContent(), /mcpstat installed/);
        await page.locator('#notice-integration').click();
        assert.equal(await page.evaluate(() => window.actions.at(-1)), 'link:integration');
        await page.evaluate(snapshot => window.postMessage({ type: 'state', snapshot, points: [],
            source: { kind: 'http', name: '<script>unsafe</script>' }, interval: 15000, busy: false }, '*'), malicious);
        await page.waitForFunction(() => document.querySelector('.handler-name').textContent.includes('<img'));
        assert.equal(await page.locator('img').count(), 0);
        assert.equal(await page.evaluate(() => window.injected), undefined);
        await page.setViewportSize({ width: 640, height: 1000 });
        assert.equal(await page.locator('#dashboard').isVisible(), true);
        await page.locator('#about-toggle').click();
        await page.setViewportSize({ width: 375, height: 1000 });
        assert.equal(await page.locator('.about-links a').first().isVisible(), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        await page.locator('#about-toggle').click();
        await page.evaluate(() => window.postMessage({ type: 'state', points: [],
            source: { kind: 'editor', name: 'synthetic_get_tool_usage_stats' },
            error: 'Approve the request, then use Refresh to retry.', interval: 15000, busy: false }, '*'));
        await page.waitForFunction(() => document.getElementById('status').textContent.includes('Statistics unavailable'));
        assert.equal((await page.locator('#status').textContent()).includes('STALE'), false);
        assert.equal(await page.locator('#notice').isVisible(), true);
        assert.deepEqual(errors, []);
        console.log('PASS: actual browser rendering, CSP/module loading, charts, filters, actions, narrow layout and injection handling.');
    } finally {
        await browser?.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
