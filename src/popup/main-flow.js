// 主导入流程：btnImport 点击处理，分发到书签/文章/推特/批量四种模式

import { extractUUID, formatUUID } from './utils/ids.js';
import { getNotionUrl, isTwitterUrl } from './utils/url.js';
import { getCurrentUserId } from './utils/user.js';
import { htmlToNotionBlocks } from './parsers/html-blocks.js';
import { fetchRemoteMetadata } from './extractors/remote.js';
import { extractCurrentTabMetadata } from './extractors/current-tab.js';
import { extractArticle, extractArticleFromSelection } from './extractors/article.js';
import { extractXThread } from './extractors/tweet.js';
import { getPageInfo } from './notion/page-info.js';
import { createFullBookmark, createImageBlock } from './notion/bookmark.js';
import { createDatabasePageFromThread, createNotionPageFromThread } from './notion/tweet-writer.js';
import { createDatabasePageFromArticle, createNotionPageFromArticle } from './notion/article-writer.js';
import { showProgress, updateProgressText, hideProgress, completeProgress } from './ui/progress.js';

// ESM 模块顶层执行时 DOM 已就绪
const _btnImport = document.getElementById('btnImport');
const _importForm = document.getElementById('importForm');
const _status = document.getElementById('status');
let _pendingDismiss = null;

document.getElementById('btnImport').addEventListener('click', async () => {
    const rawInput = document.getElementById('pageId').value.trim();
    const urlsText = document.getElementById('urls').value;
    const manualCaption = document.getElementById('caption').value.trim();

    const selectedStyle = document.querySelector('input[name="importStyle"]:checked').value;
    const isBookmarkMode = selectedStyle === 'bookmark';
    const isTweetMode = selectedStyle === 'tweet';
    const isArticleMode = selectedStyle === 'article';
    // 「批量」是书签模式下的子开关，由 toggleBatch 决定（v5.2.3 起从 radio 抽出）
    const isBatchMode = isBookmarkMode && document.getElementById('toggleBatch').checked;
    // 封面图在书签模式下生效；批量子模式按"每条 URL 能抓到 og:image 就加，没有就跳过"
    const importCoverEnabled = isBookmarkMode && document.getElementById('toggleCover').checked;

    if (_pendingDismiss) { _pendingDismiss(); _pendingDismiss = null; }
    _status.innerText = "";
    _status.style.color = "";

    const cleanId = extractUUID(rawInput);
    if (!cleanId) { _status.innerText = "❌ ID 格式错误"; return; }
    const pageId = formatUUID(cleanId);

    // === 文章模式 ===
    if (isArticleMode) {
        _btnImport.disabled = true;

        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const tab = tabs[0];
            if (!tab) throw new Error("无法获取当前页面");

            // 优先使用页面上的文字框选，没有则自动提取
            showProgress("🔍 提取文章内容...");
            let articleData = await extractArticleFromSelection(tab.id);
            if (articleData) {
                updateProgressText("📋 使用已框选内容...");
            } else {
                articleData = await extractArticle(tab.id);
            }

            if (!articleData || !articleData.content) {
                throw new Error("未能提取到文章内容，请尝试开启手动选择");
            }

            // 转换 HTML 为 Notion 块
            const blocks = htmlToNotionBlocks(articleData.content, articleData.url);
            if (!blocks.length) throw new Error("文章内容为空，请尝试开启手动选择");

            articleData.blocks = blocks;
            articleData.authorName = articleData.byline || '';

            // 解析日期
            if (articleData.date) {
                try {
                    const d = new Date(articleData.date);
                    if (!isNaN(d)) articleData.dateISO = d.toISOString().split('T')[0];
                } catch (e) {}
            }

            // 显示提取摘要
            const textCount = blocks.filter(b => ['text', 'header', 'sub_header', 'sub_sub_header', 'quote', 'bulleted_list', 'numbered_list'].includes(b.type)).length;
            const imgCount = blocks.filter(b => b.type === 'image').length;
            updateProgressText(`${textCount} 个段落 | ${imgCount} 张图片`);
            await new Promise(r => setTimeout(r, 2000));

            updateProgressText("📝 创建 Notion 页面...");
            const userId = await getCurrentUserId();
            if (!userId) throw new Error("请先登录 www.notion.so");

            const pageInfo = await getPageInfo(pageId, userId);
            const { spaceId, isDatabase, collectionId, schema } = pageInfo;

            const newPageId = (isDatabase && collectionId)
                ? await createDatabasePageFromArticle(spaceId, collectionId, schema, articleData, userId, manualCaption)
                : await createNotionPageFromArticle(spaceId, pageId, articleData, userId, manualCaption);

            // 写入成功后立即清备注：completeProgress 的 3s 倒计时 +「在 Notion 中查看」
            // 跳转会关闭 popup，清理必须在 await 之前
            document.getElementById('caption').value = "";
            chrome.storage.local.remove('pending_caption');

            await completeProgress(
                (isDatabase && collectionId) ? `✅ 已导入文章至 Database` : `✅ 已导入文章`,
                getNotionUrl(newPageId)
            );
        } catch (err) {
            console.error(err);
            hideProgress();
            _status.innerText = "❌ " + err.message;
            _status.style.color = "red";
        } finally {
            _btnImport.disabled = false;
        }
        return;
    }

    // === 推文页面模式 ===
    if (isTweetMode) {
        _btnImport.disabled = true;
        showProgress("🔍 提取推文内容...");
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const tab = tabs[0];
            if (!tab || !isTwitterUrl(tab.url)) {
                throw new Error("请先打开一个 X / Twitter 推文页面");
            }

            const threadData = await extractXThread(tab.id);
            if (!threadData || !threadData.tweets.length) {
                throw new Error("未找到推文内容，请确认页面已完整加载");
            }

            // 显示提取摘要
            const blocks0 = threadData.tweets[0]?.blocks || [];
            const richTypes = new Set(['text', 'header', 'sub_header', 'sub_sub_header', 'quote', 'bulleted_list', 'numbered_list']);
            const textBlocks = blocks0.filter(b => richTypes.has(b.type)).length;
            const imgBlocks = blocks0.filter(b => b.type === 'image').length;
            const preview = blocks0.find(b => richTypes.has(b.type))?.plainText?.slice(0, 25) || '(空)';
            updateProgressText(`${threadData.tweets.length}条 | 段落:${textBlocks} 图:${imgBlocks} | "${preview}"`);
            await new Promise(r => setTimeout(r, 3000));

            updateProgressText("📝 创建 Notion 页面...");
            const userId = await getCurrentUserId();
            if (!userId) throw new Error("请先登录 www.notion.so");

            const pageInfo = await getPageInfo(pageId, userId);
            const { spaceId, isDatabase, collectionId, schema } = pageInfo;

            const newPageId = (isDatabase && collectionId)
                ? await createDatabasePageFromThread(spaceId, collectionId, schema, threadData, userId, manualCaption)
                : await createNotionPageFromThread(spaceId, pageId, threadData, userId, manualCaption);

            // 同文章模式：在 completeProgress 跳转可能关闭 popup 之前先清备注
            document.getElementById('caption').value = "";
            chrome.storage.local.remove('pending_caption');

            await completeProgress(
                (isDatabase && collectionId)
                    ? `✅ 已导入至 Database（${threadData.tweets.length} 条推文）`
                    : `✅ 已导入 ${threadData.tweets.length} 条推文`,
                getNotionUrl(newPageId)
            );
        } catch (err) {
            console.error(err);
            hideProgress();
            _status.innerText = "❌ " + err.message;
            _status.style.color = "red";
        } finally {
            _btnImport.disabled = false;
        }
        return;
    }

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

    showProgress("🚀 连接中...");
    document.getElementById('urls').readOnly = true;

    try {
        const userId = await getCurrentUserId();
        if (!userId) throw new Error("请先登录 www.notion.so");
        const { spaceId, isDatabase } = await getPageInfo(pageId, userId);

        if (isDatabase) {
            const styleLabel = isBatchMode ? "批量书签" : "书签";
            hideProgress();
            _status.innerText = `⚠️ ${styleLabel}样式与Database不兼容，导入无效`;
            _status.style.color = "orange";
            const dismissWarning = () => {
                _status.innerText = "";
                _status.style.color = "";
                _importForm.removeEventListener('input',  dismissWarning);
                _importForm.removeEventListener('change', dismissWarning);
                _importForm.removeEventListener('click',  dismissWarning);
                _pendingDismiss = null;
            };
            _pendingDismiss = dismissWarning;
            _importForm.addEventListener('input',  dismissWarning);
            _importForm.addEventListener('change', dismissWarning);
            _importForm.addEventListener('click',  dismissWarning);
            return;
        }

        let successCount = 0;
        let failedUrls = [];

        // 根据模式决定显示文案
        const buildProgressLabel = (step) => {
            if (targets.length === 1) {
                return step;
            } else {
                return `[${successCount + failedUrls.length + 1}/${targets.length}] ${step}`;
            }
        };

        // 把待办 URL 实时回写 storage —— 仅当用户当前仍处在「书签 + 批量」时
        // （循环中允许中途切换 radio 或关掉批量 toggle 来取消持久化，
        //  与 REFACTOR_LOG R8 一致：实时读 DOM 而非用顶部锁定值）
        const persistRemainingIfBatch = (content) => {
            const styleNow = document.querySelector('input[name="importStyle"]:checked').value;
            const batchOn = document.getElementById('toggleBatch').checked;
            if (styleNow === 'bookmark' && batchOn) {
                chrome.storage.local.set({ 'pending_urls': content });
            }
        };

        // 遍历处理链接列表
        for (let i = 0; i < targets.length; i++) {
            const url = targets[i];
            updateProgressText(buildProgressLabel("🔍 分析网页..."));

            let meta;
            // 判断是否为当前标签页
            const isCurrentTab = currentTabUrl && (url === currentTabUrl || url === currentTabUrl + '/');

            if (isCurrentTab) {
                meta = await extractCurrentTabMetadata(currentTab.id, url);
            } else {
                meta = await fetchRemoteMetadata(url);
            }

            updateProgressText(buildProgressLabel("📝 写入中..."));

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
                persistRemainingIfBatch(newContent);

            } catch (e) {
                console.error(e);
                updateProgressText("⚠️ 写入失败，保留链接...");

                // 记录失败链接，确保它留在 UI 上
                failedUrls.push(url);

                // 更新 UI：保留失败链接
                const remaining = targets.slice(i + 1);
                const newContent = [...failedUrls, ...remaining].join('\n');

                document.getElementById('urls').value = newContent;
                persistRemainingIfBatch(newContent);
            }

            await new Promise(r => setTimeout(r, 800));
        }

        // 最终清理：如果全部成功（即没有失败的），清空
        // 提到 await completeProgress 之前，避免「在 Notion 中查看」跳转关闭 popup 导致清理跑不到
        if (failedUrls.length === 0) {
            document.getElementById('urls').value = "";
            chrome.storage.local.remove('pending_urls');

            // 同时清空备注输入框
            document.getElementById('caption').value = "";
            chrome.storage.local.remove('pending_caption');
        }

        await completeProgress(targets.length === 1 ? "✅ 导入完成" : `✅ 完成！导入 ${successCount} 个`, getNotionUrl(pageId));

    } catch (err) {
        console.error(err);
        hideProgress();
        _status.innerText = "❌ " + err.message;
        _status.style.color = "red";
    } finally {
        _btnImport.disabled = false;
        document.getElementById('urls').readOnly = false;
    }
});
