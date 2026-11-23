// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT

import { execFile } from 'node:child_process';
import { MAX_BYTES } from './model';

const readerErrors: Record<string, string> = {
    unsupported_python: 'Python 3.10+ is required. Set mcpstat: Python Path to a supported interpreter.',
    missing_sqlite: 'This Python installation lacks SQLite support. Set mcpstat: Python Path to an interpreter with sqlite3.',
    invalid_database: 'Select an existing mcpstat SQLite database, or use Connect MCP server to read its statistics tool.',
    unsupported_schema: 'The selected database is not mcpstat schema 4. The dashboard requires statistics written by mcpstat 0.3.0 or newer and does not migrate databases.',
    invalid_servers: 'The database contains too many or invalid server identities.',
    missing_server: 'The selected server is no longer present in this database. Reconnect and choose a server.',
    too_large: 'Statistics exceed the dashboard limit of 4 MiB.',
    missing_database: 'The selected database no longer exists. Reconnect to an existing statistics file.',
    permission_denied: 'Python cannot read this database. Check access permissions on the extension host.',
    invalid_data: 'The selected database contains invalid statistics data.',
    unavailable_database: 'Cannot query this database. Check that it is an accessible mcpstat schema-4 database with its WAL files available.',
};

export function readDatabase(python: string, reader: string, database: string,
    signal: AbortSignal, server?: string): Promise<unknown> {
    const args = ['-I', '-S', reader, database];
    if (server !== undefined) { args.push(`--server=${server}`); }
    return new Promise((resolve, reject) => {
        execFile(python, args, {
            shell: false, windowsHide: true, timeout: 5000, maxBuffer: MAX_BYTES,
            signal, killSignal: 'SIGKILL', encoding: 'utf8',
        }, (error, stdout) => {
            if (error) {
                let message: string | undefined;
                try {
                    const result: unknown = JSON.parse(stdout);
                    if (result && typeof result === 'object') {
                        const code = (result as { error_code?: unknown }).error_code;
                        if (typeof code === 'string' && Object.hasOwn(readerErrors, code)) { message = readerErrors[code]; }
                    }
                } catch { /* Interpreter diagnostics are never forwarded verbatim. */ }
                const code: unknown = (error as NodeJS.ErrnoException).code;
                message ??= code === 'ENOENT' ? 'Python was not found. Set mcpstat: Python Path to your Python 3.10+ executable.' :
                    error.killed ? 'The database reader exceeded its time or output limit. Check database availability and size.' :
                        'The database reader could not start. Check mcpstat: Python Path and that this Python installation supports sqlite3.';
                reject(new Error(message));
                return;
            }
            try { resolve(JSON.parse(stdout)); }
            catch { reject(new Error('The database reader returned invalid statistics.')); }
        });
    });
}
