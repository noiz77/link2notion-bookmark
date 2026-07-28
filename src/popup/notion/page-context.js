// 在已打开的 Notion 页面上下文中读取当前用户或发送同站点请求。
// 注入函数必须自包含，统一放在此处避免会话推断逻辑散落在多个模块。

async function executeInNotionPage(tab, request = null) {
    if (!tab?.id) return null;

    const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (request) => {
            async function inferActiveUserId() {
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
                    return Object.keys(notionUsers)[0] || null;
                } catch (e) {
                    return null;
                }
            }

            const activeUserId = await inferActiveUserId();
            if (!request) return { activeUserId };

            const headers = { ...(request.options.headers || {}) };
            if (activeUserId) {
                headers["x-notion-active-user-header"] = activeUserId;
                delete headers["X-Notion-Active-User-Header"];
            }

            const response = await fetch(request.url, {
                ...request.options,
                headers,
                credentials: "include"
            });
            return {
                response: {
                    status: response.status,
                    statusText: response.statusText,
                    headers: Array.from(response.headers.entries()),
                    body: await response.text()
                }
            };
        },
        args: [request]
    });

    return results?.[0]?.result || null;
}

export async function getNotionPageUserId(tab) {
    const result = await executeInNotionPage(tab);
    return result?.activeUserId || null;
}

export async function requestFromNotionPage(tab, url, options) {
    const result = await executeInNotionPage(tab, { url, options });
    return result?.response || null;
}
