// Notion 内部 API 请求。
// 用户阻止第三方 Cookie 时，扩展 popup 直接 fetch 不会带上 Notion 会话；
// 改在已打开的 Notion 标签页中执行同站点请求。

import { getNotionTab, getTabOrigin } from './session.js';
import { requestFromNotionPage } from './page-context.js';

function getActiveUserId(options) {
    const headers = options.headers || {};
    return headers["x-notion-active-user-header"] || headers["X-Notion-Active-User-Header"] || null;
}

function normalizeRequestOptions(options) {
    const requestOptions = { ...options };
    const headers = { ...(requestOptions.headers || {}) };

    for (const key of ["x-notion-active-user-header", "X-Notion-Active-User-Header"]) {
        if (!headers[key]) delete headers[key];
    }

    requestOptions.headers = headers;
    return requestOptions;
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

    const requestOptions = normalizeRequestOptions(options);

    const result = await requestFromNotionPage(
        tab,
        `${origin}/api/v3/${path}`,
        requestOptions
    );
    if (!result) {
        throw new Error("无法通过 Notion 页面发送请求，请刷新 Notion 页面后重试");
    }

    return new Response(result.body, {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers
    });
}
