// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT
const vscode = require('vscode');
const { writeFile } = require('node:fs/promises');

exports.activate = context => {
    context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider('mcpstat.syntheticWeather', {
        provideMcpServerDefinitions: () => [new vscode.McpStdioServerDefinition('synthetic-weather',
            process.env.MCPSTAT_TEST_PYTHON, [process.env.MCPSTAT_TEST_FIXTURE, '--stdio', '--database', process.env.MCPSTAT_TEST_DATABASE],
            { OTEL_SDK_DISABLED: 'true', OTEL_PROPAGATORS: 'none',
                MCPSTAT_TEST_APPROVAL: process.env.MCPSTAT_TEST_APPROVAL || '0' })],
    }));
    if (process.env.MCPSTAT_TEST_APPROVAL === '1') {
        setTimeout(() => { void (async () => {
            let passed = false;
            try { await require('../vscode.integration.cjs').run(); passed = true; }
            catch (error) { console.error(error); }
            finally {
                await writeFile(process.env.MCPSTAT_TEST_RESULT, JSON.stringify({ passed }));
                await vscode.commands.executeCommand('workbench.action.quit');
            }
        })(); }, 0);
    }
};
