// === 基础工具 ===
function extractUUID(input) {
    if (!input) return null;
    const match = input.match(/([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
    if (match) return match[0].replace(/-/g, '');
    return null;
}
function formatUUID(id) {
    if (!id) return null;
    if (id.includes('-')) return id;
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}
function getCurrentUserId() {
    return new Promise((resolve) => {
        chrome.cookies.get({ url: "https://www.notion.so", name: "notion_user_id" }, (cookie) => {
            resolve(cookie ? cookie.value : null);
        });
    });
}

// === 辅助函数：特定平台封面过滤器 ===
function filterCover(url, coverUrl) {
    if (url.includes('x.com') ||
        url.includes('twitter.com') ||
        url.includes('youtube.com') ||
        url.includes('youtu.be') ||
        url.includes('bilibili.com')) {
        return null;
    }
    return coverUrl;
}

// === 辅助函数：清理标题（移除 X/Twitter 未读消息数前缀）===
function cleanTitle(url, title) {
    if (!title) return title;

    // 针对 X/Twitter: 移除 "(数字) " 前缀，例如 "(3) Username on X" -> "Username on X"
    if (url.includes('x.com') || url.includes('twitter.com')) {
        return title.replace(/^\(\d+\)\s*/, '');
    }

    return title;
}

// === 方案A：远程爬虫 (用于批量链接) ===
async function fetchRemoteMetadata(url) {
    const result = { title: null, description: null, cover: null, icon: null };
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!res.ok) throw new Error("Fetch failed");

        const text = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(text, "text/html");

        const ogTitle = doc.querySelector('meta[property="og:title"]')?.content;
        const tagTitle = doc.querySelector('title')?.innerText;
        result.title = cleanTitle(url, ogTitle || tagTitle || url);

        const ogDesc = doc.querySelector('meta[property="og:description"]')?.content;
        const metaDesc = doc.querySelector('meta[name="description"]')?.content;
        result.description = ogDesc || metaDesc || "";

        const ogImage = doc.querySelector('meta[property="og:image"]')?.content;
        if (ogImage && ogImage.startsWith('http')) {
            result.cover = filterCover(url, ogImage);
        }

        try {
            const domain = new URL(url).hostname;
            result.icon = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
        } catch (e) { }

    } catch (e) {
        console.warn(`[${url}] 远程抓取失败:`, e);
        result.title = url;
    }
    return result;
}

// === 方案B：当前页直读 (专门解决 Twitter/SPA) ===
async function extractCurrentTabMetadata(tabId, url) {
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: () => {
                const getMeta = (prop) => document.querySelector(`meta[property="${prop}"]`)?.content;
                const getName = (name) => document.querySelector(`meta[name="${name}"]`)?.content;

                let data = {
                    title: getMeta('og:title') || document.title,
                    description: getMeta('og:description') || getName('description') || "",
                    cover: getMeta('og:image') || "",
                    twitterText: document.querySelector('article div[lang]')?.innerText
                };

                if (window.location.hostname.includes('youtube.com') || window.location.hostname.includes('youtu.be')) {
                    try {
                        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
                        for (let script of scripts) {
                            const json = JSON.parse(script.innerText);
                            const videoData = Array.isArray(json)
                                ? json.find(item => item['@type'] === 'VideoObject')
                                : (json['@type'] === 'VideoObject' ? json : null);

                            if (videoData && videoData.description) {
                                data.description = videoData.description;
                            }
                        }
                    } catch (e) { }
                }

                return data;
            }
        });

        if (results && results[0] && results[0].result) {
            const data = results[0].result;

            try {
                const domain = new URL(url).hostname;
                data.icon = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
            } catch (e) { }

            if (!data.description && data.twitterText) {
                data.description = data.twitterText.slice(0, 200);
            }

            data.cover = (() => {
                if (url.includes('x.com') ||
                    url.includes('twitter.com') ||
                    url.includes('youtube.com') ||
                    url.includes('youtu.be') ||
                    url.includes('bilibili.com')) {
                    return null;
                }
                return data.cover;
            })();

            // 清理标题（移除 X/Twitter 未读消息数前缀）
            data.title = cleanTitle(url, data.title);

            console.log("✅ 成功从当前页读取:", data);
            return data;
        }
    } catch (e) {
        console.error("❌ 直读失败，降级为远程抓取:", e);
    }
    return await fetchRemoteMetadata(url);
}

// === 初始化 ===
document.addEventListener('DOMContentLoaded', async () => {
    // 1. 加载所有状态
    const storageData = await chrome.storage.local.get(['notion_page_id', 'pending_urls', 'pending_caption', 'batch_mode_enabled', 'cover_enabled']);

    if (storageData.notion_page_id) document.getElementById('pageId').value = storageData.notion_page_id;
    if (storageData.pending_caption) document.getElementById('caption').value = storageData.pending_caption;

    const urlsInput = document.getElementById('urls');
    const toggleBatchMode = document.getElementById('toggleBatchMode');
    const batchTools = document.getElementById('batchTools');
    const urlTip = document.getElementById('urlTip');
    const captionTip = document.getElementById('captionTip');

    // 封面图相关元素
    const coverRow = document.getElementById('coverRow');
    const toggleCover = document.getElementById('toggleCover');
    const noCoverTip = document.getElementById('noCoverTip');

    // 当前页面封面图缓存
    let currentPageCover = null;

    // === 辅助函数：判断是否是特殊 URL（不可执行脚本）===
    const isRestrictedUrl = (url) => {
        if (!url) return true;
        return url.startsWith('chrome://') ||
            url.startsWith('chrome-extension://') ||
            url.startsWith('edge://') ||
            url.startsWith('about:') ||
            url.startsWith('file://') ||
            url.startsWith('devtools://');
    };

    // === 辅助函数：检测当前页面封面图 ===
    const checkCurrentPageCover = async () => {
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tabs || !tabs[0]) return;

            const url = tabs[0].url;
            const tabId = tabs[0].id;

            // 跳过特殊 URL，避免执行脚本报错
            if (isRestrictedUrl(url)) {
                noCoverTip.classList.remove('hidden');
                toggleCover.disabled = true;
                toggleCover.checked = false;
                return;
            }

            // 使用现有的 extractCurrentTabMetadata 获取 meta 信息
            const meta = await extractCurrentTabMetadata(tabId, url);
            currentPageCover = meta.cover;

            // 更新 UI 状态
            if (currentPageCover) {
                noCoverTip.classList.add('hidden');
                toggleCover.disabled = false;
            } else {
                noCoverTip.classList.remove('hidden');
                toggleCover.disabled = true;
                toggleCover.checked = false;
            }
        } catch (e) {
            console.warn('检测封面图失败:', e);
            noCoverTip.classList.remove('hidden');
            toggleCover.disabled = true;
        }
    };

    // === 辅助函数：更新 UI 状态 ===
    const updateUIState = async (isBatchMode) => {
        if (isBatchMode) {
            // 批量模式
            batchTools.classList.remove('hidden');
            coverRow.classList.add('hidden'); // 批量模式隐藏封面图开关
            urlTip.innerText = "*批量模式：支持填充多个链接";
            captionTip.innerText = "*多个链接的情况下，备注会被覆盖";

            // 恢复草稿（如果有），否则留空让用户自己填
            chrome.storage.local.get(['pending_urls'], (res) => {
                const draft = res.pending_urls;
                // 如果有草稿，恢复草稿；如果没草稿，显示空（不自动填当前页，除非用户点按钮）
                urlsInput.value = draft || "";
            });
            urlsInput.readOnly = false;
        } else {
            // 默认模式（单页）
            batchTools.classList.add('hidden');
            coverRow.classList.remove('hidden'); // 默认模式显示封面图开关
            urlTip.innerText = "*默认模式：自动填充当前页面";
            captionTip.innerText = "*填写后会显示在bookmark卡片下方";

            // 强制填充当前页
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs && tabs[0]) {
                urlsInput.value = tabs[0].url;
                // 默认模式下不保存草稿，清除 pending_urls
                chrome.storage.local.remove('pending_urls');
            }
            // 默认模式下也可以允许用户微调 URL，所以保持 readOnly = false
            urlsInput.readOnly = false;

            // 检测当前页面封面图
            await checkCurrentPageCover();
        }
    };

    // 2. 恢复开关状态
    const isBatchStart = !!storageData.batch_mode_enabled;
    toggleBatchMode.checked = isBatchStart;

    // 恢复封面图开关状态（默认关闭）
    toggleCover.checked = !!storageData.cover_enabled;

    await updateUIState(isBatchStart);

    // === 事件监听 ===

    // 批量模式开关监听
    toggleBatchMode.addEventListener('change', (e) => {
        const isBatch = e.target.checked;
        chrome.storage.local.set({ 'batch_mode_enabled': isBatch });
        updateUIState(isBatch);
    });

    // 封面图开关监听
    toggleCover.addEventListener('change', (e) => {
        chrome.storage.local.set({ 'cover_enabled': e.target.checked });
    });

    // 输入同步 Storage
    const ids = ['urls', 'pageId', 'caption'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', (e) => {
            if (id === 'urls') {
                if (toggleBatchMode.checked) {
                    chrome.storage.local.set({ 'pending_urls': e.target.value });
                }
            } else {
                // pageId 和 caption 还是正常保存
                const key = id === 'caption' ? 'pending_caption' : 'notion_page_id';
                const obj = {}; obj[key] = e.target.value;
                chrome.storage.local.set(obj);
            }
        });
    });

    // === 按钮功能：自动填充和清空 (仅在批量模式可见) ===
    const btnAutoFill = document.getElementById('btnAutoFill');
    const btnClear = document.getElementById('btnClear');

    if (btnAutoFill) {
        btnAutoFill.addEventListener('click', async () => {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs && tabs[0]) {
                const currentUrl = tabs[0].url;
                let val = urlsInput.value.trimEnd();

                if (val.length > 0) {
                    // 避免重复
                    if (!val.includes(currentUrl)) {
                        val += '\n' + currentUrl;
                    }
                } else {
                    val = currentUrl;
                }

                urlsInput.value = val;
                urlsInput.dispatchEvent(new Event('input')); // Save

                const originalText = btnAutoFill.innerText;
                btnAutoFill.innerText = "✅ 已填充";
                setTimeout(() => btnAutoFill.innerText = originalText, 800);
            }
        });
    }

    if (btnClear) {
        btnClear.addEventListener('click', () => {
            urlsInput.value = "";
            urlsInput.dispatchEvent(new Event('input')); // Clear Storage
        });
    }
});

// === 主流程 ===
document.getElementById('btnImport').addEventListener('click', async () => {
    const rawInput = document.getElementById('pageId').value.trim();
    const urlsText = document.getElementById('urls').value;
    const manualCaption = document.getElementById('caption').value.trim();

    // 获取封面图开关状态（仅默认模式有效）
    const isBatchMode = document.getElementById('toggleBatchMode').checked;
    const importCoverEnabled = !isBatchMode && document.getElementById('toggleCover').checked;

    const status = document.getElementById('status');
    const btn = document.getElementById('btnImport');

    const cleanId = extractUUID(rawInput);
    if (!cleanId) { status.innerText = "❌ ID 格式错误"; return; }
    const pageId = formatUUID(cleanId);

    // 1. 确定目标 URL 列表
    let targets = [];
    if (urlsText.trim()) {
        targets = urlsText.split('\n').map(u => u.trim()).filter(u => u.length > 0);
    }

    // 2. 获取当前 Tab 信息（用于比对和兜底）
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const currentTab = tabs[0];
    const currentTabUrl = currentTab ? currentTab.url : null;

    // 如果列表为空，默认导入当前页 (兜底逻辑，即便自动填充关闭，留空也应能工作)
    if (targets.length === 0 && currentTabUrl) {
        targets.push(currentTabUrl);
    }

    if (targets.length === 0) return;

    status.style.color = "blue";
    btn.disabled = true;
    const originalReadOnly = document.getElementById('urls').readOnly;
    document.getElementById('urls').readOnly = true;

    try {
        const userId = await getCurrentUserId();
        if (!userId) throw new Error("请先登录 www.notion.so");

        status.innerText = "🚀 连接中...";
        const spaceId = await getSpaceIdViaLoadChunk(pageId, userId);

        let successCount = 0;
        let failedUrls = [];

        // 根据模式决定显示文案
        const showProgress = (step) => {
            if (targets.length === 1) {
                // 单链接模式：简化文案
                return step;
            } else {
                // 批量模式：显示进度
                return `[${successCount + failedUrls.length + 1}/${targets.length}] ${step}`;
            }
        };

        // 遍历处理链接列表
        for (let i = 0; i < targets.length; i++) {
            const url = targets[i];
            status.innerText = showProgress("🔍 分析网页...");

            let meta;
            // 判断是否为当前标签页
            const isCurrentTab = currentTabUrl && (url === currentTabUrl || url === currentTabUrl + '/');

            if (isCurrentTab) {
                meta = await extractCurrentTabMetadata(currentTab.id, url);
            } else {
                meta = await fetchRemoteMetadata(url);
            }

            status.innerText = showProgress("📝 写入中...");

            try {
                // 如果开启了封面图导入且有封面图，先创建图片块
                if (importCoverEnabled && meta.cover) {
                    await createImageBlock(spaceId, pageId, meta.cover, userId);
                }

                await createFullBookmark(spaceId, pageId, meta, url, userId, manualCaption);
                successCount++;

                // 更新 UI：移除已完成的链接
                const remaining = targets.slice(i + 1);
                const newContent = [...failedUrls, ...remaining].join('\n');

                document.getElementById('urls').value = newContent;

                const isBatchMode = document.getElementById('toggleBatchMode').checked;
                if (isBatchMode) {
                    chrome.storage.local.set({ 'pending_urls': newContent });
                }

            } catch (e) {
                console.error(e);
                status.innerText = "⚠️ 写入失败，保留链接...";

                // 记录失败链接，确保它留在 UI 上
                failedUrls.push(url);

                // 更新 UI：保留失败链接
                const remaining = targets.slice(i + 1);
                const newContent = [...failedUrls, ...remaining].join('\n');

                document.getElementById('urls').value = newContent;

                const isBatchMode = document.getElementById('toggleBatchMode').checked;
                if (isBatchMode) {
                    chrome.storage.local.set({ 'pending_urls': newContent });
                }
            }

            await new Promise(r => setTimeout(r, 800));
        }

        status.innerText = targets.length === 1 ? "✅ 导入完成" : `✅ 完成！导入 ${successCount} 个`;
        status.style.color = "green";

        // 最终清理：如果全部成功（即没有失败的），清空
        if (failedUrls.length === 0) {
            document.getElementById('urls').value = "";
            chrome.storage.local.remove('pending_urls');

            // 同时清空备注输入框
            document.getElementById('caption').value = "";
            chrome.storage.local.remove('pending_caption');
        }

    } catch (err) {
        console.error(err);
        status.innerText = "❌ " + err.message;
        status.style.color = "red";
    } finally {
        btn.disabled = false;
        document.getElementById('urls').readOnly = false;
    }
});

// === Notion API ===
async function getSpaceIdViaLoadChunk(pageId, userId) {
    const res = await fetch("https://www.notion.so/api/v3/loadPageChunk", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-notion-active-user-header": userId },
        body: JSON.stringify({
            "pageId": pageId, "limit": 1, "cursor": { "stack": [] }, "chunkNumber": 0, "verticalColumns": false
        })
    });
    const data = await res.json();
    const blockData = data.recordMap?.block?.[pageId];
    if (!blockData?.value) throw new Error("无法读取页面信息，请检查 ID");
    return blockData.value.space_id;
}

async function createFullBookmark(spaceId, parentId, meta, url, userId, caption) {
    const newBlockId = uuidv4();
    const properties = {
        "link": [[url]],
        "title": [[meta.title || url]],
        "description": [[meta.description || ""]]
    };

    if (caption && caption.trim().length > 0) {
        properties.caption = [[caption]];
    }

    const format = { "block_color": "default", "bookmark_icon": meta.icon };

    if (meta.cover) {
        format.bookmark_cover = meta.cover;
    }

    const operations = [
        {
            "id": newBlockId, "table": "block", "path": [], "command": "set",
            "args": {
                "id": newBlockId, "type": "bookmark", "version": 1, "alive": true, "parent_id": parentId, "parent_table": "block", "created_time": Date.now(), "last_edited_time": Date.now(), "space_id": spaceId,
                "properties": properties, "format": format
            }
        },
        {
            "id": parentId, "table": "block", "path": ["content"], "command": "listAfter",
            "args": { "after": uuidv4(), "id": newBlockId }
        }
    ];

    const res = await fetch("https://www.notion.so/api/v3/saveTransactions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-notion-active-user-header": userId },
        body: JSON.stringify({ "requestId": uuidv4(), "transactions": [{ "id": uuidv4(), "spaceId": spaceId, "operations": operations }] })
    });
    if (!res.ok) throw new Error("写入失败");
}

// 创建图片块
async function createImageBlock(spaceId, parentId, imageUrl, userId) {
    const newBlockId = uuidv4();

    const operations = [
        {
            "id": newBlockId, "table": "block", "path": [], "command": "set",
            "args": {
                "id": newBlockId,
                "type": "image",
                "version": 1,
                "alive": true,
                "parent_id": parentId,
                "parent_table": "block",
                "created_time": Date.now(),
                "last_edited_time": Date.now(),
                "space_id": spaceId,
                "properties": {
                    "source": [[imageUrl]]
                },
                "format": {
                    "display_source": imageUrl
                }
            }
        },
        {
            "id": parentId, "table": "block", "path": ["content"], "command": "listAfter",
            "args": { "after": uuidv4(), "id": newBlockId }
        }
    ];

    const res = await fetch("https://www.notion.so/api/v3/saveTransactions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-notion-active-user-header": userId },
        body: JSON.stringify({ "requestId": uuidv4(), "transactions": [{ "id": uuidv4(), "spaceId": spaceId, "operations": operations }] })
    });
    if (!res.ok) throw new Error("图片导入失败");
}