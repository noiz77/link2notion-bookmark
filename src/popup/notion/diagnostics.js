import { notionFetch } from './api.js';
import { getNotionTab, getTabOrigin, NOTION_ORIGINS } from './session.js';
import { getActiveTab } from '../utils/tabs.js';
import { getCurrentUserId } from '../utils/user.js';

function safeUrlSummary(url) {
    try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
    } catch (e) {
        return url ? '(invalid url)' : '(none)';
    }
}

async function inspectCookies(userId) {
    const results = [];
    for (const origin of NOTION_ORIGINS) {
        try {
            const cookie = await chrome.cookies.get({ url: origin, name: 'notion_user_id' });
            results.push({
                origin,
                readable: true,
                hasUserId: Boolean(cookie?.value),
                matchesActiveUser: Boolean(userId && cookie?.value === userId)
            });
        } catch (error) {
            results.push({
                origin,
                readable: false,
                error: error?.message || String(error)
            });
        }
    }
    return results;
}

async function inspectNotionPageContext(tab) {
    if (!tab?.id) return { canExecute: false, error: 'No Notion tab' };

    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async () => {
                const cookieMatch = document.cookie.match(/(?:^|;\s*)notion_user_id=([^;]+)/);
                const summary = {
                    canExecute: true,
                    origin: location.origin,
                    hasDocumentUserId: Boolean(cookieMatch?.[1]),
                    getSpaces: null
                };

                try {
                    const res = await fetch(`${location.origin}/api/v3/getSpaces`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: '{}'
                    });
                    const text = await res.text();
                    let data = null;
                    try { data = JSON.parse(text); } catch (e) {}
                    const notionUsers = data?.notion_user || data?.recordMap?.notion_user || {};
                    const spaces = data?.space || data?.recordMap?.space || {};
                    summary.getSpaces = {
                        status: res.status,
                        ok: res.ok,
                        parseOk: Boolean(data),
                        notionUserCount: Object.keys(notionUsers).length,
                        spaceCount: Object.keys(spaces).length,
                        firstUserIdPresent: Object.keys(notionUsers).length > 0,
                        bodyPrefix: data ? '' : text.slice(0, 120)
                    };
                } catch (error) {
                    summary.getSpaces = {
                        error: error?.message || String(error)
                    };
                }

                return summary;
            }
        });
        return results?.[0]?.result || { canExecute: false, error: 'No script result' };
    } catch (error) {
        return { canExecute: false, error: error?.message || String(error) };
    }
}

async function inspectPageChunk(pageId, userId) {
    try {
        const res = await notionFetch('loadPageChunk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-notion-active-user-header': userId },
            body: JSON.stringify({
                pageId,
                limit: 5,
                cursor: { stack: [] },
                chunkNumber: 0,
                verticalColumns: false
            })
        });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch (e) {}
        const blocks = data?.recordMap?.block || {};
        const collections = data?.recordMap?.collection || {};
        const spaces = data?.recordMap?.space || {};
        return {
            status: res.status,
            ok: res.ok,
            parseOk: Boolean(data),
            blockCount: Object.keys(blocks).length,
            collectionCount: Object.keys(collections).length,
            spaceCount: Object.keys(spaces).length,
            hasTargetBlock: Boolean(blocks[pageId]?.value),
            message: data?.message || data?.error || data?.name || '',
            bodyPrefix: data ? '' : text.slice(0, 160)
        };
    } catch (error) {
        return {
            error: error?.message || String(error)
        };
    }
}

export async function buildNotionDiagnostics(pageId) {
    const lines = [];
    const timestamp = new Date().toISOString();
    const manifest = chrome.runtime.getManifest();
    const activeTab = await getActiveTab().catch(() => null);
    const userId = await getCurrentUserId().catch(() => null);
    const notionTab = await getNotionTab(userId).catch(error => ({ error }));

    lines.push('Link2Notion Notion API Diagnostics');
    lines.push(`time: ${timestamp}`);
    lines.push(`extensionVersion: ${manifest.version}`);
    lines.push(`userAgent: ${navigator.userAgent}`);
    lines.push(`targetPageId: ${pageId || '(missing)'}`);
    lines.push(`activeTab: ${safeUrlSummary(activeTab?.url)}`);
    lines.push(`userIdDetected: ${Boolean(userId)}`);

    const cookies = await inspectCookies(userId);
    lines.push('cookies:');
    for (const item of cookies) {
        if (item.readable) {
            lines.push(`- ${item.origin}: readable=true hasUserId=${item.hasUserId} matchesDetectedUser=${item.matchesActiveUser}`);
        } else {
            lines.push(`- ${item.origin}: readable=false error=${item.error}`);
        }
    }

    if (notionTab?.error) {
        lines.push(`notionTab: error=${notionTab.error?.message || String(notionTab.error)}`);
    } else {
        lines.push(`notionTab: found=${Boolean(notionTab?.id)} origin=${getTabOrigin(notionTab) || '(none)'} status=${notionTab?.status || '(unknown)'}`);
        const context = await inspectNotionPageContext(notionTab);
        lines.push(`pageContext: canExecute=${context.canExecute} origin=${context.origin || '(none)'} hasDocumentUserId=${Boolean(context.hasDocumentUserId)} error=${context.error || ''}`);
        if (context.getSpaces) {
            const gs = context.getSpaces;
            lines.push(`getSpaces: status=${gs.status || '(none)'} ok=${Boolean(gs.ok)} parseOk=${Boolean(gs.parseOk)} notionUserCount=${gs.notionUserCount ?? '(unknown)'} spaceCount=${gs.spaceCount ?? '(unknown)'} firstUserIdPresent=${Boolean(gs.firstUserIdPresent)} error=${gs.error || ''}`);
            if (gs.bodyPrefix) lines.push(`getSpacesBodyPrefix: ${gs.bodyPrefix}`);
        }
    }

    if (pageId) {
        const pageChunk = await inspectPageChunk(pageId, userId);
        if (pageChunk.error) {
            lines.push(`loadPageChunk: error=${pageChunk.error}`);
        } else {
            lines.push(`loadPageChunk: status=${pageChunk.status} ok=${pageChunk.ok} parseOk=${pageChunk.parseOk} blockCount=${pageChunk.blockCount} collectionCount=${pageChunk.collectionCount} spaceCount=${pageChunk.spaceCount} hasTargetBlock=${pageChunk.hasTargetBlock} message=${pageChunk.message || ''}`);
            if (pageChunk.bodyPrefix) lines.push(`loadPageChunkBodyPrefix: ${pageChunk.bodyPrefix}`);
        }
    }

    return lines.join('\n');
}
