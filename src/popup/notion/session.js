export const NOTION_TAB_PATTERNS = [
    "https://www.notion.so/*",
    "https://app.notion.com/*"
];

export const NOTION_ORIGINS = [
    "https://www.notion.so",
    "https://app.notion.com"
];

export function getTabOrigin(tab) {
    try {
        return tab.url ? new URL(tab.url).origin : null;
    } catch (e) {
        return null;
    }
}

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

export async function getPreferredNotionOrigins(userId) {
    if (!userId) return [];

    const matches = [];
    for (const origin of NOTION_ORIGINS) {
        try {
            const cookie = await chrome.cookies.get({ url: origin, name: "notion_user_id" });
            if (cookie?.value === userId) matches.push(origin);
        } catch (e) {
            console.warn("[link2notion] 读取 Notion Cookie 失败:", origin, e);
        }
    }
    return matches;
}

export async function getNotionTab(userId = null) {
    const preferredOrigins = await getPreferredNotionOrigins(userId);
    const tabs = await chrome.tabs.query({ url: NOTION_TAB_PATTERNS });
    const orderedTabs = [
        ...tabs.filter(tab => preferredOrigins.includes(getTabOrigin(tab)) && tab.active),
        ...tabs.filter(tab => preferredOrigins.includes(getTabOrigin(tab)) && !tab.active),
        ...tabs.filter(tab => !preferredOrigins.includes(getTabOrigin(tab)) && tab.active),
        ...tabs.filter(tab => !preferredOrigins.includes(getTabOrigin(tab)) && !tab.active)
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
