// 从 cookie 读取当前 Notion 用户 ID

import { getNotionPageUserId } from '../notion/page-context.js';
import { getNotionTab, getTabOrigin, NOTION_ORIGINS } from '../notion/session.js';

export async function getCurrentUserId() {
    let tab = null;
    try {
        tab = await getNotionTab();
        const tabUserId = await getNotionPageUserId(tab);
        if (tabUserId) return tabUserId;
    } catch (e) {
        console.warn("[link2notion] 无法从 Notion 页面读取用户 ID:", e);
    }

    const tabOrigin = getTabOrigin(tab);
    const origins = [
        ...(tabOrigin ? [tabOrigin] : []),
        ...NOTION_ORIGINS.filter(origin => origin !== tabOrigin)
    ];
    for (const origin of origins) {
        try {
            const cookie = await chrome.cookies.get({ url: origin, name: "notion_user_id" });
            if (cookie?.value) return cookie.value;
        } catch (e) {
            console.warn("[link2notion] 读取 Notion Cookie 失败:", origin, e);
        }
    }

    return null;
}
