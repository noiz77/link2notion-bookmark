// popup DOMContentLoaded 初始化：恢复存储、模式 radio、封面检测、事件绑定
// 局部函数（isRestrictedUrl、updateCoverUI、checkCurrentPageCover、renderBookmarkMode、updateUIState）
// 依赖大量 DOM 和闭包状态（currentPageCover），保持在 handler 内部而不抽出去

import { extractCurrentTabMetadata } from '../extractors/current-tab.js';
import { isTwitterUrl } from '../utils/url.js';
import { showTagSuggestions, hideTagSuggestions, updateTagChipStates } from './tags.js';

document.addEventListener('DOMContentLoaded', async () => {
    // 1. 加载所有状态
    const storageData = await chrome.storage.local.get([
        'notion_page_id', 'pending_urls', 'pending_caption',
        'import_style', 'cover_enabled', 'batch_enabled'
    ]);

    // 一次性迁移：旧版 'batch' radio 模式 → 书签模式 + 批量开
    // （v5.2.2 之前 batch 是独立 radio，v5.2.3 起合并为「书签 + 批量 toggle」）
    let migratedImportStyle = storageData.import_style;
    let migratedBatchEnabled = storageData.batch_enabled;
    if (migratedImportStyle === 'batch') {
        migratedImportStyle = 'bookmark';
        migratedBatchEnabled = true;
        chrome.storage.local.set({ import_style: 'bookmark', batch_enabled: true });
    }

    if (storageData.notion_page_id) document.getElementById('pageId').value = storageData.notion_page_id;
    if (storageData.pending_caption) document.getElementById('caption').value = storageData.pending_caption;

    const urlsInput = document.getElementById('urls');
    const urlSection = document.getElementById('urlSection');
    const bookmarkToggles = document.getElementById('bookmarkToggles');
    const coverControl = document.getElementById('coverControl');
    const toggleCover = document.getElementById('toggleCover');
    const toggleBatch = document.getElementById('toggleBatch');
    const noCoverTip = document.getElementById('noCoverTip');
    const coverText = document.getElementById('coverText');
    const batchTools = document.getElementById('batchTools');
    const articleTip = document.getElementById('articleTip');

    const captionSection = document.getElementById('captionSection');
    const captionLabelText = document.getElementById('captionLabelText');
    const captionInfo = document.getElementById('captionInfo');

    // 在 label 文字旁边显示/隐藏「?」帮助 icon，hover 触发 tooltip（CSS 实现）
    const setCaptionInfo = (tip) => {
        if (tip) {
            captionInfo.dataset.tip = tip;
            captionInfo.classList.remove('hidden');
        } else {
            captionInfo.classList.add('hidden');
        }
    };

    // 导入样式 Radios
    const styleRadios = document.querySelectorAll('input[name="importStyle"]');

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

    const updateCoverUI = () => {
        if (toggleCover.disabled) {
            noCoverTip.innerText = "该网页无封面图";
            noCoverTip.classList.remove('hidden');
            coverText.classList.add('hidden');
        } else {
            noCoverTip.classList.add('hidden');
            coverText.innerText = "封面图:";
            coverText.classList.remove('hidden');
        }
    };

    // === 辅助函数：检测当前页面封面图 ===
    const checkCurrentPageCover = async () => {
        try {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tabs || !tabs[0]) return;

            const url = tabs[0].url;
            const tabId = tabs[0].id;

            if (isRestrictedUrl(url)) {
                toggleCover.disabled = true;
                toggleCover.checked = false;
                return;
            }

            const meta = await extractCurrentTabMetadata(tabId, url);
            currentPageCover = meta.cover;

            if (currentPageCover) {
                toggleCover.disabled = false;
            } else {
                toggleCover.disabled = true;
                toggleCover.checked = false;
            }
        } catch (e) {
            console.warn('检测封面图失败:', e);
            toggleCover.disabled = true;
        } finally {
            const currentStyle = document.querySelector('input[name="importStyle"]:checked').value;
            if (currentStyle === 'bookmark' && !toggleBatch.checked) {
                updateCoverUI();
            }
        }
    };

    // === 书签模式渲染：根据 toggleBatch 切换单/批量子状态 ===
    // 抽成独立函数，因为切换批量 toggle 时需要重新渲染（不重新选 radio）
    // 设计：右上 toggle 区（批量 + 封面）在两种子状态下结构一致，避免切换时跳动；
    //       仅 textarea 内容、批量工具栏、tooltip 文案随子状态切换。
    const renderBookmarkMode = async () => {
        const isBatch = toggleBatch.checked;

        urlSection.classList.remove('hidden');
        captionSection.classList.remove('hidden');
        bookmarkToggles.classList.remove('hidden');
        bookmarkToggles.style.display = 'flex';
        coverControl.classList.remove('hidden');
        coverControl.style.display = 'flex';

        if (isBatch) {
            // 批量子模式：textarea 多行可编辑；封面图按"能抓多少抓多少"，无需逐条预检
            batchTools.classList.remove('hidden');
            captionLabelText.innerText = "备注";
            setCaptionInfo("选填项，填写后会作为文字说明填充在 bookmark 的卡片下方");

            // 批量场景下封面 toggle 始终可用，去掉单链接的"该网页无封面图"提示
            toggleCover.disabled = false;
            noCoverTip.classList.add('hidden');
            coverText.classList.remove('hidden');

            const batchData = await chrome.storage.local.get(['pending_urls']);
            urlsInput.value = batchData.pending_urls || "";
            urlsInput.readOnly = false;
        } else {
            // 单链接子模式（与原 'bookmark' 行为一致）
            batchTools.classList.add('hidden');
            captionLabelText.innerText = "备注";
            setCaptionInfo("选填项，填写后会作为文字说明填充在 bookmark 的卡片下方");

            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs && tabs[0]) {
                urlsInput.value = tabs[0].url;
            }
            urlsInput.readOnly = false;

            await checkCurrentPageCover();
            updateCoverUI();
        }
    };

    // === 辅助函数：更新 UI 状态 ===
    const updateUIState = async (style) => {
        // 先隐藏所有条件区域
        bookmarkToggles.classList.add('hidden');
        coverControl.classList.add('hidden');
        articleTip.classList.add('hidden');
        batchTools.classList.add('hidden');
        hideTagSuggestions();

        if (style === 'article') {
            // 文章模式
            urlSection.classList.remove('hidden');
            captionSection.classList.remove('hidden');
            articleTip.classList.remove('hidden');
            captionLabelText.innerText = "标签";
            setCaptionInfo("选填项，多个用「,」分隔。写入 Database 时填入 Tags / 标签 多选列（自动新增缺失选项）；普通页面则前置在文章顶部信息栏");

            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs && tabs[0]) {
                urlsInput.value = tabs[0].url;
                showTagSuggestions(tabs[0].title);
            }
            urlsInput.readOnly = true;
        } else if (style === 'tweet') {
            // 推文页面模式
            urlSection.classList.remove('hidden');
            captionSection.classList.remove('hidden');
            captionLabelText.innerText = "标签";
            setCaptionInfo("选填项，多个用「,」分隔。写入 Database 时填入 Tags / 标签 多选列（自动新增缺失选项）；普通页面则前置在推文顶部信息栏");

            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs && tabs[0]) {
                urlsInput.value = tabs[0].url;
                showTagSuggestions(tabs[0].title);
            }
            urlsInput.readOnly = true;
        } else {
            // 书签模式（含批量子状态）
            await renderBookmarkMode();
        }
    };

    // 2. 恢复状态并检查是否允许推文模式
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const isTwitterPage = activeTabs[0] && isTwitterUrl(activeTabs[0].url);

    const tweetRadioNode = Array.from(styleRadios).find(r => r.value === 'tweet');
    if (!isTwitterPage && tweetRadioNode) {
        tweetRadioNode.disabled = true;
    }

    // 根据当前页面自动选择导入模式
    let initialStyle;
    if (isTwitterPage) {
        initialStyle = 'tweet';
    } else {
        // 非推特页面：尊重用户上次的选择（除了 tweet），默认文章模式
        initialStyle = (migratedImportStyle && migratedImportStyle !== 'tweet') ? migratedImportStyle : 'article';
    }

    let targetRadio = Array.from(styleRadios).find(r => r.value === initialStyle);
    if (!targetRadio) targetRadio = styleRadios[0];
    targetRadio.checked = true;

    // 恢复封面图开关状态（默认关闭）
    toggleCover.checked = !!storageData.cover_enabled;
    // 恢复批量开关状态（默认关闭）
    toggleBatch.checked = !!migratedBatchEnabled;

    await updateUIState(initialStyle);

    // === 事件监听 ===

    // Radio 切换监听
    styleRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.checked) {
                const style = e.target.value;
                chrome.storage.local.set({ 'import_style': style });
                updateUIState(style);
            }
        });
    });

    // 封面图开关监听
    toggleCover.addEventListener('change', (e) => {
        chrome.storage.local.set({ 'cover_enabled': e.target.checked });
        updateCoverUI();
    });

    // 批量开关监听：持久化 + 重新渲染书签模式
    toggleBatch.addEventListener('change', (e) => {
        chrome.storage.local.set({ 'batch_enabled': e.target.checked });
        renderBookmarkMode();
    });


    // 输入同步 Storage
    const ids = ['urls', 'pageId', 'caption'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', (e) => {
            if (id === 'urls') {
                const currentStyle = document.querySelector('input[name="importStyle"]:checked').value;
                // 仅在「书签 + 批量开」时持久化 URL 列表（其他模式 URL 来自当前 tab，无需保存）
                if (currentStyle === 'bookmark' && toggleBatch.checked) {
                    chrome.storage.local.set({ 'pending_urls': e.target.value });
                }
            } else {
                const key = id === 'caption' ? 'pending_caption' : 'notion_page_id';
                const obj = {}; obj[key] = e.target.value;
                chrome.storage.local.set(obj);
            }
            // 手动编辑标签时同步芯片选中状态
            if (id === 'caption') updateTagChipStates();
        });
    });

    // === 按钮功能：自动填充和清空 (仅在批量子模式可见) ===
    const btnAutoFill = document.getElementById('btnAutoFill');
    const btnClear = document.getElementById('btnClear');

    if (btnAutoFill) {
        btnAutoFill.addEventListener('click', async () => {
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs && tabs[0]) {
                const currentUrl = tabs[0].url;
                let val = urlsInput.value.trimEnd();

                if (val.length > 0) {
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
