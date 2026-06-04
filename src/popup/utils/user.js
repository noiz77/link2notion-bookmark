// 从 cookie 读取当前 Notion 用户 ID

import { getNotionTab } from '../notion/session.js';

export async function getCurrentUserId() {
    const urls = ["https://www.notion.so", "https://app.notion.com"];
    for (const url of urls) {
        try {
            const cookie = await chrome.cookies.get({ url, name: "notion_user_id" });
            if (cookie?.value) return cookie.value;
        } catch (e) {
            console.warn("[link2notion] 读取 Notion Cookie 失败:", url, e);
        }
    }

    try {
        const tab = await getNotionTab();
        if (!tab?.id) return null;

        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async () => {
                const cookieMatch = document.cookie.match(/(?:^|;\s*)notion_user_id=([^;]+)/);
                if (cookieMatch?.[1]) return decodeURIComponent(cookieMatch[1]);

                try {
                    const res = await fetch(`${location.origin}/api/v3/getSpaces`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        credentials: "include",
                        body: "{}"
                    });
                    const data = await res.json();
                    const notionUsers = data.notion_user || data.recordMap?.notion_user || {};
                    const firstUserId = Object.keys(notionUsers)[0];
                    if (firstUserId) return firstUserId;
                } catch (e) {}

                return null;
            }
        });

        return results?.[0]?.result || null;
    } catch (e) {
        console.warn("[link2notion] 读取 Notion 用户 ID 失败:", e);
    }
    return null;
}
