// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT
const { execFile } = require('node:child_process');
const { mkdtemp, mkdir, readFile, readdir, writeFile, rm } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const { createServer } = require('node:net');

async function main() {
    let passed = false;
    const directory = await mkdtemp(join(tmpdir(), 'mcpstat-editor-'));
    const root = process.env.MCPSTAT_TEST_EXTENSION || resolve(__dirname, '..');
    const workspace = join(directory, 'workspace');
    await mkdir(workspace);
    const profile = join(directory, 'profile');
    await mkdir(join(profile, 'User'), { recursive: true });
    await writeFile(join(profile, 'User', 'settings.json'), JSON.stringify({
        'chat.editor.preferCopilotHarness': false,
        'chat.mcp.discovery.enabled': false,
        'chat.mcp.autostart': 'never',
        'telemetry.telemetryLevel': 'off',
        'window.dialogStyle': 'custom',
    }));
    const args = ['--no-sandbox', '--disable-gpu', '--ozone-platform=headless',
        '--user-data-dir', profile, '--extensions-dir', join(directory, 'extensions'),
        `--extensionDevelopmentPath=${root}`, `--extensionDevelopmentPath=${join(__dirname, 'fixture-extension')}`,
        `--extensionTestsPath=${join(__dirname, 'vscode.integration.cjs')}`,
        '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', '--disable-updates', '--wait', workspace];
    const approval = process.env.MCPSTAT_TEST_APPROVAL === '1';
    const resultFile = join(directory, 'approval-result.json');
    let debugPort;
    if (approval) {
        // VS Code's extension test environment auto-confirms dialogs. Start the
        // synthetic fixture normally so this check exercises the actual dialog.
        args.splice(args.findIndex(value => value.startsWith('--extensionTestsPath=')), 1);
        const listener = createServer();
        await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
        debugPort = listener.address().port;
        await new Promise(resolve => listener.close(resolve));
        args.push(`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1');
    }
    try {
        let done = false;
        const editor = new Promise((resolve, reject) => execFile(process.env.VSCODE_EXECUTABLE || 'code', args,
            { timeout: approval ? 90000 : 60000, maxBuffer: 1024 * 1024, env: { ...process.env, MCPSTAT_TEST_LIVE: '1',
                MCPSTAT_TEST_RESULT: resultFile,
                MCPSTAT_TEST_PYTHON: process.env.MCPSTAT_TEST_PYTHON || 'python',
                MCPSTAT_TEST_FIXTURE: join(__dirname, 'fixtures/http_server.py'),
                MCPSTAT_TEST_DATABASE: join(directory, 'synthetic.sqlite') } },
            error => { done = true; error ? reject(error) : resolve(); }));
        await Promise.all([editor, ...(approval ? [require('./approval.browser.cjs').approveFixture(debugPort, () => done)] : [])]);
        if (approval) { assert.equal(JSON.parse(await readFile(resultFile, 'utf8')).passed, true); }
        if (!approval) {
            const logs = await readdir(join(profile, 'logs'), { recursive: true });
            let output = '';
            for (const file of logs.filter(file => file.endsWith('renderer.log'))) {
                output += await readFile(join(profile, 'logs', file), 'utf8');
            }
            assert.ok(output.includes('PASS: existing VS Code MCP stdio connection'),
                output.split('\n').filter(line => /Assertion|PASS:|FIXTURE|TOOLS:/.test(line)).slice(-15).join('\n'));
        }
        passed = true;
        console.log('PASS: VS Code discovers and queries the existing synthetic MCP connection through the public tool API.');
    } finally {
        if (passed) { await rm(directory, { recursive: true, force: true }); }
        else { console.error(`Synthetic test logs: ${directory}`); }
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
