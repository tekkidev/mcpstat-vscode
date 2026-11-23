// Copyright (c) 2026 Vadim Bakhrenkov
// SPDX-License-Identifier: MIT

import { isAbsolute } from 'node:path';
import { endpoint, isStatisticsTool } from './connection';

export type Source = { kind: 'database'; path: string; server: string } |
    { kind: 'editor'; tool: string; approvalHelpAcknowledged?: boolean } |
    { kind: 'http'; url: string; tool: string; credentialId?: string };
export const PROFILE_KEY = 'mcpstat.connection.v1';

/** Credentials belong in SecretStorage, never in a connection profile. */
export function parseProfile(value: unknown): Source | undefined {
    if (!value || typeof value !== 'object') { return undefined; }
    const profile = value as Record<string, unknown>;
    if (profile.kind === 'database' && typeof profile.path === 'string' &&
        profile.path.length <= 4096 && isAbsolute(profile.path) &&
        typeof profile.server === 'string' && profile.server.length <= 2048) {
        return { kind: 'database', path: profile.path, server: profile.server };
    }
    if (typeof profile.tool !== 'string' || !isStatisticsTool(profile.tool)) { return undefined; }
    if (profile.kind === 'editor') {
        return { kind: 'editor', tool: profile.tool,
            ...(profile.approvalHelpAcknowledged === true ? { approvalHelpAcknowledged: true } : {}) };
    }
    if (profile.kind === 'http' && typeof profile.url === 'string') {
        if (profile.credentialId !== undefined && (typeof profile.credentialId !== 'string' ||
            !/^[a-f0-9]{64}$/.test(profile.credentialId))) { return undefined; }
        try { return { kind: 'http', url: endpoint(profile.url).href, tool: profile.tool,
            ...(profile.credentialId === undefined ? {} : { credentialId: profile.credentialId as string }) }; }
        catch { return undefined; }
    }
    return undefined;
}
