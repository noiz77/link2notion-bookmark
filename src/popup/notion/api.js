// Notion 内部 API 请求。
// 用户阻止第三方 Cookie 时，扩展 popup 直接 fetch 不会带上 Notion 会话；
// 改在已打开的 Notion 标签页中执行同站点请求。

const NOTION_TAB_PATTERNS = [
    "https://www.notion.so/*",
    "https://app.notion.com/*"
];

const NOTION_ORIGINS = [
    "https://www.notion.so",
    "https://app.notion.com"
];

function waitForTabComplete(tabId, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            callback(value);
        };

        const timeoutId = setTimeout(() => {
            finish(reject, new Error("Notion 页面加载超时，请打开 Notion 页面后重试"));
        }, timeoutMs);

        const onUpdated = (updatedTabId, changeInfo, tab) => {
            if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
            finish(resolve, tab);
        };

        chrome.tabs.onUpdated.addListener(onUpdated);
        chrome.tabs.get(tabId).then(tab => {
            if (tab.status === "complete") finish(resolve, tab);
        }).catch(error => finish(reject, error));
    });
}

function getActiveUserId(options) {
    const headers = options.headers || {};
    return headers["x-notion-active-user-header"] || headers["X-Notion-Active-User-Header"] || null;
}

async function getPreferredOrigins(userId) {
    if (!userId) return [];

    const matches = [];
    for (const origin of NOTION_ORIGINS) {
        const cookie = await chrome.cookies.get({ url: origin, name: "notion_user_id" });
        if (cookie?.value === userId) matches.push(origin);
    }
    return matches;
}

function getTabOrigin(tab) {
    try {
        return tab.url ? new URL(tab.url).origin : null;
    } catch (e) {
        return null;
    }
}

async function getNotionTab(userId) {
    const preferredOrigins = await getPreferredOrigins(userId);
    const tabs = await chrome.tabs.query({ url: NOTION_TAB_PATTERNS });
    const orderedTabs = [
        ...tabs.filter(tab => preferredOrigins.includes(getTabOrigin(tab))),
        ...tabs.filter(tab => !preferredOrigins.includes(getTabOrigin(tab)))
    ];

    const readyTab = orderedTabs.find(tab => tab.id && tab.status === "complete");
    if (readyTab) return readyTab;

    const loadingTab = orderedTabs.find(tab => tab.id);
    if (loadingTab) return waitForTabComplete(loadingTab.id);

    const createdTab = await chrome.tabs.create({ url: preferredOrigins[0] || NOTION_ORIGINS[0], active: false });
    if (!createdTab.id) throw new Error("无法打开 Notion 页面");
    if (createdTab.status === "complete") return createdTab;
    return waitForTabComplete(createdTab.id);
}

export async function notionFetch(path, options = {}) {
    if (!/^[a-zA-Z0-9]+$/.test(path)) {
        throw new Error("Notion API 路径无效");
    }

    const tab = await getNotionTab(getActiveUserId(options));
    if (!tab) {
        throw new Error("请先打开并登录一个 Notion 页面，再重试");
    }

    const origin = getTabOrigin(tab);
    if (!origin) {
        throw new Error("无法识别 Notion 页面地址，请刷新 Notion 页面后重试");
    }

    const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (url, requestOptions) => {
            const response = await fetch(url, {
                ...requestOptions,
                credentials: "include"
            });
            return {
                status: response.status,
                statusText: response.statusText,
                headers: Array.from(response.headers.entries()),
                body: await response.text()
            };
        },
        args: [`${origin}/api/v3/${path}`, options]
    });

    const result = results[0]?.result;
    if (!result) {
        throw new Error("无法通过 Notion 页面发送请求，请刷新 Notion 页面后重试");
    }

    return new Response(result.body, {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers
    });
}
