// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT
const { chromium } = require('playwright-core');
const { readFile } = require('node:fs/promises');

async function main() {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
        headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    try {
        const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
        const source = await readFile('media/icons/logo.svg', 'utf8');
        const gradient = '<defs><linearGradient id="brand-gradient" x1="0" y1="0" x2="1" y2="0.176"><stop stop-color="#a78bfa"/><stop offset="0.33" stop-color="#a78bfa"/><stop offset="1" stop-color="#54d8d0"/></linearGradient></defs>';
        const svg = source.replace('fill="currentColor"', 'fill="url(#brand-gradient)"').replace(/(<svg[^>]*>)/, `$1${gradient}`);
        await page.setContent('<style>body{margin:0;display:grid;place-items:center;height:512px}svg{width:384px;height:384px}</style>' + svg);
        await page.screenshot({ path: 'media/icon.png', omitBackground: true });
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
