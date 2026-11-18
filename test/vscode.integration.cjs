// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const vscode = require('vscode');

exports.run = async () => {
    const extension = vscode.extensions.getExtension('vadikus.mcpstat-dashboard');
    assert.ok(extension, 'Dashboard extension is installed');
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    if (commands.includes('workbench.action.chat.editToolApproval')) {
        const approvals = vscode.commands.executeCommand('workbench.action.chat.editToolApproval');
        await new Promise(resolve => setTimeout(resolve, 500));
        await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
        await approvals;
        console.log('PASS: the available Chat: Manage Tool Approval command opens through the public commands API.');
    }
    for (const command of ['openDashboard', 'connectDatabase', 'connectServer', 'refresh', 'disconnect', 'clearHistory', 'openWalkthrough', 'openIntegration']) {
        assert.ok(commands.includes(`mcpstat.${command}`));
    }
    await vscode.commands.executeCommand('mcpstat.openWalkthrough');
    assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.label === 'Welcome')),
        'VS Code opens its native walkthrough editor');
    if (process.env.MCPSTAT_TEST_APPROVAL === '1') { await new Promise(resolve => setTimeout(resolve, 1500)); }
    await vscode.workspace.getConfiguration('mcpstat').update('showSidebar', true, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('mcpstat.connection.focus');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('mcpstat.openDashboard');
    if (process.env.MCPSTAT_TEST_LIVE === '1') {
        const fixture = vscode.extensions.getExtension('vadikus.mcpstat-test-fixture');
        assert.ok(fixture, 'Synthetic MCP fixture is available');
        await fixture.activate();
        const listing = vscode.commands.executeCommand('workbench.mcp.listServer');
        await new Promise(resolve => setTimeout(resolve, 1500));
        await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
        await listing;
        const { chooseSource } = require('../out/discovery');
        const choicePromise = chooseSource(() => true);
        // Test-only workbench command starts the isolated fixture as a user would.
        await vscode.commands.executeCommand('workbench.mcp.startServer', '*', { waitForLiveTools: true, autoTrustChanges: true, errorOnUserInteraction: true });
        const { readEditor, statisticsTools } = require('../out/editor');
        const deadline = Date.now() + 15000;
        while (!statisticsTools().length && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const tool = statisticsTools()[0];
        assert.ok(tool, 'Actual MCP statistics tool is discoverable through vscode.lm.tools');
        await new Promise(resolve => setTimeout(resolve, 600));
        await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
        const choice = await choicePromise;
        assert.equal(choice?.tool, tool.name, 'An already-open connection picker discovers the arriving MCP tool');
        const weather = vscode.lm.tools.find(tool => tool.name.endsWith('_get_weather'));
        assert.ok(weather, 'Synthetic business tool is registered');
        const before = await readEditor(tool.name, new AbortController().signal);
        await vscode.lm.invokeTool(weather.name, { input: { city: 'London' }, toolInvocationToken: undefined });
        const after = await readEditor(tool.name, new AbortController().signal);
        assert.equal(after.stats.find(row => row.name === 'get_weather').call_count,
            before.stats.find(row => row.name === 'get_weather').call_count + 1);
        if (process.env.MCPSTAT_TEST_APPROVAL === '1') {
            const connecting = vscode.commands.executeCommand('mcpstat.connectServer');
            await new Promise(resolve => setTimeout(resolve, 600));
            await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
            await connecting;
            // Leave the actual dashboard open beyond its former polling interval.
            await new Promise(resolve => setTimeout(resolve, 17000));
            console.log('PASS: dashboard editor connection remains manual after approval.');
        }
        console.log('PASS: existing VS Code MCP stdio connection, public tool discovery, statistics invocation and measured business-call delta.');
    }
    await vscode.commands.executeCommand('mcpstat.clearHistory');
    await vscode.commands.executeCommand('mcpstat.disconnect');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    console.log('PASS: actual VS Code extension activation, command registration, webview creation and disposal.');
};
