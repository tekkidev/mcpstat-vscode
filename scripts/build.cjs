// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT
const esbuild = require('esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');

async function build() {
    const result = await esbuild.build({ entryPoints: ['src/bootstrap.ts'], outfile: 'dist/extension.js',
        bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'],
        metafile: true, minify: true, keepNames: true, sourcemap: 'linked', legalComments: 'eof', logLevel: 'warning' });
    const packages = new Map();
    // The font and logo are shipped as assets rather than JavaScript imports.
    const icons = path.dirname(require.resolve('bootstrap-icons/package.json'));
    packages.set('bootstrap-icons', { directory: icons,
        metadata: JSON.parse(await fs.readFile(path.join(icons, 'package.json'), 'utf8')) });
    await fs.mkdir('media/generated/fonts', { recursive: true });
    await fs.copyFile(path.join(icons, 'font/fonts/bootstrap-icons.woff2'), 'media/generated/fonts/bootstrap-icons.woff2');
    const iconStyles = await fs.readFile(path.join(icons, 'font/bootstrap-icons.css'), 'utf8');
    const glyphs = ['search', 'tags', 'collection', 'book', 'plug', 'code-slash', 'chat-left-text',
        'box-seam', 'file-earmark-text', 'info-circle', 'shield-lock'].map(name => {
        const rule = iconStyles.match(new RegExp(`\\.bi-${name}::before \\{[^}]+\\}`));
        if (!rule) { throw new Error(`Missing Bootstrap icon: ${name}`); }
        return rule[0];
    });
    await fs.writeFile('media/generated/icons.css', [
        '/* Bootstrap Icons - MIT. See ThirdPartyNotices.md. */',
        '@font-face { font-family: bootstrap-icons; src: url("fonts/bootstrap-icons.woff2") format("woff2"); font-display: block; }',
        '.bi::before { display: inline-block; font-family: bootstrap-icons; font-style: normal; font-weight: normal; line-height: 1; }',
        ...glyphs, '',
    ].join('\n'));
    for (const file of Object.keys(result.metafile.inputs)) {
        if (!file.includes('node_modules/')) { continue; }
        let directory = path.dirname(path.resolve(file));
        while (directory !== path.dirname(directory)) {
            try {
                const metadata = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
                if (metadata.name && metadata.version) { packages.set(metadata.name, { directory, metadata }); break; }
            } catch { /* A compiled module can be below the package directory. */ }
            directory = path.dirname(directory);
        }
    }
    const notices = ['# Third-party notices', '', 'The extension bundle includes the following open-source software.', ''];
    for (const [name, { directory, metadata }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
        const licenses = (await fs.readdir(directory)).filter(name => /^(licen[cs]e|notice)(\..*)?$/i.test(name)).sort();
        if (!licenses.length) { throw new Error(`Missing license notice for ${name}`); }
        notices.push(`## ${name} ${metadata.version}`, '', `License: ${metadata.license}`, '');
        if (name === 'bootstrap-icons') {
            notices.push('Includes the bundled WOFF2 icon font, icon glyphs, CSS rules, SVG logo and its PNG rendering.', '');
        }
        for (const file of licenses) {
            const notice = await fs.readFile(path.join(directory, file), 'utf8');
            notices.push(notice.replace(/[\t ]+$/gm, ''), '');
        }
    }
    await fs.writeFile('ThirdPartyNotices.md', `${notices.join('\n').trim()}\n`);
}
build().catch(error => { console.error(error.message); process.exitCode = 1; });
