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

        const tagTitle = doc.querySelector('title')?.textContent?.trim();
        const ogTitle = doc.querySelector('meta[property="og:title"]')?.content;
        result.title = cleanTitle(url, tagTitle || ogTitle || url);

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

// === X/Twitter 推文线程内容提取 ===
async function extractXThread(tabId) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
            function getPlainText(el) {
                return (el?.textContent || '').replace(/\s+/g, ' ').trim();
            }

            function extractRichText(el) {
                const segments = [];
                function walk(node, bold, italic) {
                    if (node.nodeType === 3) {
                        const t = node.textContent || '';
                        if (!t) return;
                        const anns = [];
                        if (bold) anns.push(['b']);
                        if (italic) anns.push(['i']);
                        segments.push(anns.length ? [t, anns] : [t]);
                    } else if (node.nodeName === 'BR') {
                        segments.push(['\n']);
                    } else if (node.nodeName === 'A') {
                        const text = (node.textContent || '').trim();
                        const href = node.href || '';
                        if (!text) return;
                        const anns = [];
                        if (bold) anns.push(['b']);
                        if (italic) anns.push(['i']);
                        if (href.startsWith('http')) anns.push(['a', href]);
                        segments.push(anns.length ? [text, anns] : [text]);
                    } else if (node.nodeName === 'IMG') {
                        const alt = node.getAttribute('alt') || '';
                        if (alt) segments.push([alt]);
                    } else if (node.nodeType === 1) {
                        const isBold = bold || ['STRONG', 'B'].includes(node.nodeName) ||
                            parseInt(getComputedStyle(node).fontWeight || '400') >= 700;
                        const isItalic = italic || ['EM', 'I'].includes(node.nodeName) ||
                            getComputedStyle(node).fontStyle === 'italic';
                        for (const child of node.childNodes) walk(child, isBold, isItalic);
                    }
                }
                for (const child of el.childNodes) walk(child, false, false);
                return segments;
            }

            // 找包含所有 span[data-text="true"] 的最近祖先容器
            function findTextContainer(article) {
                const allSpans = article.querySelectorAll('span[data-text="true"]');
                if (!allSpans.length) return null;
                const total = allSpans.length;
                let candidate = allSpans[0].parentElement;
                while (candidate && candidate !== article) {
                    if (candidate.querySelectorAll('span[data-text="true"]').length === total) return candidate;
                    candidate = candidate.parentElement;
                }
                return allSpans[0].parentElement;
            }

            // 将一条推文解析为有序 blocks（text / image / video）
            function extractTweetBlocks(article) {
                const blocks = [];
                const seenImgSrcs = new Set();

                function addImage(img) {
                    if (!img) return;
                    let src = (img.src || '').replace(/([?&]name=)\w+/, '$1large');
                    if (src.startsWith('http') && !seenImgSrcs.has(src)) {
                        seenImgSrcs.add(src);
                        blocks.push({ type: 'image', url: src });
                    }
                }
                function addImagesFromEl(el) {
                    if (el.getAttribute('data-testid') === 'tweetPhoto') {
                        addImage(el.querySelector('img'));
                    } else {
                        el.querySelectorAll('[data-testid="tweetPhoto"] img').forEach(addImage);
                    }
                }

                const textContainer = findTextContainer(article) ||
                    article.querySelector('[data-testid="tweetText"]');

                if (textContainer) {
                    // 遍历文本容器的直接子节点，按 DOM 顺序生成 text/image blocks
                    for (const child of textContainer.childNodes) {
                        if (child.nodeType === 3) {
                            const pt = (child.textContent || '').trim();
                            if (pt) blocks.push({ type: 'text', richText: [[pt]], plainText: pt });
                        } else if (child.nodeType === 1) {
                            const hasText = !!child.querySelector('span[data-text="true"]');
                            const hasPhoto = child.getAttribute('data-testid') === 'tweetPhoto' ||
                                !!child.querySelector('[data-testid="tweetPhoto"]');

                            if (hasText) {
                                const pt = getPlainText(child);
                                const rt = extractRichText(child);
                                if (pt.trim()) blocks.push({ type: 'text', richText: rt.length ? rt : [[pt]], plainText: pt });
                            }
                            if (hasPhoto) addImagesFromEl(child);
                            // 既无 data-text 也无 tweetPhoto → UI 元素，跳过
                        }
                    }

                    // 文本容器之后的兄弟节点中也可能有图片（X 常见布局）
                    let sibling = textContainer.nextElementSibling;
                    while (sibling) {
                        addImagesFromEl(sibling);
                        sibling = sibling.nextElementSibling;
                    }
                } else {
                    addImagesFromEl(article);
                }

                // 视频
                if (article.querySelector('[data-testid="videoPlayer"], [data-testid="videoComponent"]')) {
                    blocks.push({ type: 'video' });
                }

                return blocks;
            }

            const debug = {};

            const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
            debug.articleCount = articles.length;
            if (!articles.length) return { debug, tweets: [], title: '', authorName: '', date: '', url: window.location.href };

            const firstArticle = articles[0];
            const userNameEl = firstArticle.querySelector('[data-testid="User-Name"]');
            const authorName = getPlainText(userNameEl?.querySelector('span')) ||
                getPlainText(userNameEl).split('\n')[0] || 'Unknown';
            const authorHandleHref = userNameEl?.querySelector('a[href*="/"]')?.getAttribute('href') || '';

            const timeEl = firstArticle.querySelector('time');
            const dateStr = timeEl?.getAttribute('datetime') || '';
            const dateShort = dateStr ? new Date(dateStr).toLocaleDateString('zh-CN') : '';
            const dateISO = dateStr ? new Date(dateStr).toISOString().split('T')[0] : '';

            const firstSpan = firstArticle.querySelector('span[data-text="true"]');
            debug.hasDataText = !!firstSpan;
            debug.sampleDataText = firstSpan ? (firstSpan.textContent || '').slice(0, 50) : '(无)';

            // 从推文链接卡片中提取文章标题
            function findCardTitle(article) {
                const cardWrapper = article.querySelector('[data-testid="card.wrapper"]');
                if (!cardWrapper) return null;
                const cardLink = cardWrapper.querySelector('a');
                if (!cardLink) return null;
                // 卡片标题通常是卡片内第一个字符数足够多的 span
                const spans = cardLink.querySelectorAll('span');
                for (const span of spans) {
                    const text = (span.textContent || '').trim();
                    // 跳过太短的（域名/装饰文本），只取像文章标题的
                    if (text.length > 8 && !text.match(/^https?:\/\//) && !text.match(/^\w+\.\w{2,}$/)) {
                        return text;
                    }
                }
                return null;
            }

            // 清理 markdown 风格字符（去掉开头 # / * 等）
            function cleanMarkdownTitle(text) {
                if (!text) return text;
                return text.replace(/^[#*>\s]+/, '').trim();
            }

            const tweets = [];
            for (const article of articles) {
                const handleHref = article.querySelector('[data-testid="User-Name"] a[href*="/"]')?.getAttribute('href') || '';
                if (tweets.length > 0 && handleHref && authorHandleHref && handleHref !== authorHandleHref) break;

                const blocks = extractTweetBlocks(article);

                // 兜底：og:description
                if (!blocks.some(b => b.type === 'text') && tweets.length === 0) {
                    const ogDesc = document.querySelector('meta[property="og:description"]')?.content ||
                                   document.querySelector('meta[name="twitter:description"]')?.content || '';
                    if (ogDesc) {
                        blocks.unshift({ type: 'text', richText: [[ogDesc]], plainText: ogDesc });
                        debug.usedMeta = true;
                    }
                }

                tweets.push({ blocks });
            }

            // 使用浏览器 tab 实际标题（去除未读消息数前缀），与网页头部展示一致
            const pageTitle = document.title.replace(/^\(\d+\)\s*/, '').trim();

            // 兜底：若 document.title 为空，则用作者名 + 推文首句
            const cardTitle = findCardTitle(firstArticle);
            const firstText = tweets[0]?.blocks?.find(b => b.type === 'text')?.plainText || '';
            const rawTitle = cardTitle || firstText.slice(0, 60) + (firstText.length > 60 ? '…' : '');
            const fallbackTitle = `${authorName}: ${cleanMarkdownTitle(rawTitle)}`;

            const title = pageTitle || fallbackTitle;

            return { title, authorName, date: dateShort, dateISO, url: window.location.href, tweets, debug };
        }
    });

    if (results && results[0]?.error) {
        console.error('[extractXThread] 脚本错误:', results[0].error);
        throw new Error('页面脚本执行失败: ' + (results[0].error.message || '未知错误'));
    }
    if (results && results[0] && results[0].result) return results[0].result;
    return null;
}

// === 文章提取：自动模式（使用 Mozilla Readability） ===
async function extractArticle(tabId) {
    // 第一步：注入 Readability.js 库
    await chrome.scripting.executeScript({
        target: { tabId },
        files: ['lib/Readability.js']
    });

    // 第二步：运行提取
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
            // 使用 Readability 提取正文
            const doc = document.cloneNode(true);
            const reader = new Readability(doc);
            const article = reader.parse();

            // 提取元数据（从原始文档）
            const getMeta = (prop) => document.querySelector(`meta[property="${prop}"]`)?.content;
            const getName = (name) => document.querySelector(`meta[name="${name}"]`)?.content;

            const title = article?.title || getMeta('og:title') || document.title || '';
            const byline = article?.byline
                || getName('author')
                || document.querySelector('[rel="author"]')?.textContent
                || getMeta('article:author') || '';
            const dateStr = getMeta('article:published_time')
                || document.querySelector('time[datetime]')?.getAttribute('datetime')
                || getName('date') || '';
            const siteName = article?.siteName || getMeta('og:site_name') || '';

            return {
                title: title.trim(),
                content: article?.content || '',
                byline: (byline || '').trim(),
                date: dateStr,
                siteName: siteName.trim(),
                url: window.location.href,
                textLength: (article?.textContent || '').trim().length,
                paragraphCount: article?.content ? (article.content.match(/<p[\s>]/g) || []).length : 0
            };
        }
    });

    if (results?.[0]?.error) throw new Error('提取失败: ' + (results[0].error.message || '未知错误'));
    return results?.[0]?.result;
}

// === 文章提取：读取页面上的文字框选内容 ===
async function extractArticleFromSelection(tabId) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
            const selection = window.getSelection();
            if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

            // 将框选内容转为 HTML
            const range = selection.getRangeAt(0);
            const fragment = range.cloneContents();
            const container = document.createElement('div');
            container.appendChild(fragment);

            // 如果选中内容太短（<50字），视为无效
            if (container.textContent.trim().length < 50) return null;

            // 对框选结果也进行噪音清理（多列布局下框选容易选到侧边栏）
            const noiseHintRe = /\b(sidebar|side-bar|widget|recommend|featured|related|comment|share|social|newsletter|subscribe|ad-|ads-|advert|toc|breadcrumb|footer|menu)\b/i;
            container.querySelectorAll('script, style, noscript, iframe, svg, nav, footer, aside, header').forEach(el => el.remove());
            container.querySelectorAll('div, section, ul, ol').forEach(el => {
                const hint = ((el.className || '') + ' ' + (el.id || '')).toLowerCase();
                if (noiseHintRe.test(hint)) { el.remove(); return; }
                const text = el.textContent.trim();
                const links = el.querySelectorAll('a');
                if (links.length > 5 && text.length < links.length * 50 && text.length < 500) {
                    el.remove();
                }
            });

            // 清理后再检查一次长度
            if (container.textContent.trim().length < 50) return null;

            const getMeta = (prop) => document.querySelector(`meta[property="${prop}"]`)?.content;
            const getName = (name) => document.querySelector(`meta[name="${name}"]`)?.content;

            return {
                title: (getMeta('og:title') || document.title || '').trim(),
                content: container.innerHTML,
                byline: (getName('author') || document.querySelector('[rel="author"]')?.textContent || getMeta('article:author') || '').trim(),
                date: getMeta('article:published_time') || document.querySelector('time[datetime]')?.getAttribute('datetime') || '',
                siteName: (getMeta('og:site_name') || '').trim(),
                url: window.location.href
            };
        }
    });
    return results?.[0]?.result;
}

// === HTML → Notion 块转换 ===
function htmlToNotionBlocks(html, baseUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const blocks = [];

    // 提取内联富文本（保留加粗、斜体、链接、行内代码）
    function extractInlineRT(el) {
        const segments = [];
        function walk(node, bold, italic) {
            if (node.nodeType === 3) {
                const t = node.textContent;
                if (!t) return;
                const anns = [];
                if (bold) anns.push(['b']);
                if (italic) anns.push(['i']);
                segments.push(anns.length ? [t, anns] : [t]);
            } else if (node.nodeName === 'BR') {
                segments.push(['\n']);
            } else if (node.nodeName === 'A') {
                const text = node.textContent || '';
                if (!text.trim()) return;
                let href = node.getAttribute('href') || '';
                if (href && !href.startsWith('http') && !href.startsWith('#') && baseUrl) {
                    try { href = new URL(href, baseUrl).href; } catch (e) {}
                }
                const anns = [];
                if (bold) anns.push(['b']);
                if (italic) anns.push(['i']);
                if (href.startsWith('http')) anns.push(['a', href]);
                segments.push(anns.length ? [text, anns] : [text]);
            } else if (node.nodeName === 'CODE') {
                const text = node.textContent || '';
                if (text) segments.push([text, [['c']]]);
            } else if (node.nodeType === 1) {
                const isBold = bold || ['STRONG', 'B'].includes(node.nodeName);
                const isItalic = italic || ['EM', 'I'].includes(node.nodeName);
                for (const child of node.childNodes) walk(child, isBold, isItalic);
            }
        }
        for (const child of el.childNodes) walk(child, false, false);
        return segments.length ? segments : [[el.textContent || '']];
    }

    // 解析图片 URL（处理相对路径）
    function resolveImgSrc(node) {
        let src = node.getAttribute('src') || '';
        if (src && !src.startsWith('http') && !src.startsWith('data:') && baseUrl) {
            try { src = new URL(src, baseUrl).href; } catch (e) {}
        }
        return src.startsWith('http') ? src : null;
    }

    function processNode(node) {
        if (node.nodeType !== 1) return;
        const tag = node.nodeName;

        switch (tag) {
            case 'H1':
                blocks.push({ type: 'header', richText: extractInlineRT(node) });
                break;
            case 'H2':
                blocks.push({ type: 'sub_header', richText: extractInlineRT(node) });
                break;
            case 'H3': case 'H4': case 'H5': case 'H6':
                blocks.push({ type: 'sub_sub_header', richText: extractInlineRT(node) });
                break;
            case 'P': {
                const imgs = node.querySelectorAll('img');
                const textContent = node.textContent.trim();
                // 纯图片段落
                if (imgs.length > 0 && !textContent) {
                    for (const img of imgs) {
                        const src = resolveImgSrc(img);
                        if (src) blocks.push({ type: 'image', url: src });
                    }
                } else if (textContent) {
                    blocks.push({ type: 'text', richText: extractInlineRT(node) });
                }
                break;
            }
            case 'UL':
                for (const li of node.children) {
                    if (li.nodeName === 'LI') {
                        blocks.push({ type: 'bulleted_list', richText: extractInlineRT(li) });
                    }
                }
                break;
            case 'OL':
                for (const li of node.children) {
                    if (li.nodeName === 'LI') {
                        blocks.push({ type: 'numbered_list', richText: extractInlineRT(li) });
                    }
                }
                break;
            case 'BLOCKQUOTE':
                // 引用块可能包含多个 <p>，逐一处理
                if (node.querySelector('p')) {
                    for (const child of node.children) {
                        if (child.nodeName === 'P') {
                            blocks.push({ type: 'quote', richText: extractInlineRT(child) });
                        }
                    }
                } else {
                    blocks.push({ type: 'quote', richText: extractInlineRT(node) });
                }
                break;
            case 'PRE': {
                const codeEl = node.querySelector('code');
                const text = (codeEl || node).textContent || '';
                const langClass = codeEl?.className?.match(/language-(\w+)/)?.[1] || '';
                blocks.push({ type: 'code', text, language: langClass || 'Plain Text' });
                break;
            }
            case 'IMG': {
                const src = resolveImgSrc(node);
                if (src) blocks.push({ type: 'image', url: src });
                break;
            }
            case 'FIGURE': {
                const img = node.querySelector('img');
                if (img) {
                    const src = resolveImgSrc(img);
                    if (src) blocks.push({ type: 'image', url: src });
                    const caption = node.querySelector('figcaption');
                    if (caption?.textContent?.trim()) {
                        blocks.push({ type: 'text', richText: [[caption.textContent.trim(), [['i']]]] });
                    }
                }
                break;
            }
            case 'HR':
                blocks.push({ type: 'divider' });
                break;
            case 'TABLE': {
                // 表格简化为文本
                const text = node.textContent.trim();
                if (text) blocks.push({ type: 'text', richText: [[text]] });
                break;
            }
            default:
                // 容器元素递归处理子节点
                for (const child of node.childNodes) {
                    if (child.nodeType === 1) {
                        processNode(child);
                    } else if (child.nodeType === 3 && child.textContent.trim()) {
                        blocks.push({ type: 'text', richText: [[child.textContent.trim()]] });
                    }
                }
        }
    }

    for (const child of doc.body.childNodes) {
        if (child.nodeType === 1) processNode(child);
    }

    // 过滤空块
    return blocks.filter(b => {
        if (['divider', 'image'].includes(b.type)) return true;
        if (b.type === 'code') return (b.text || '').trim().length > 0;
        if (b.richText) return b.richText.map(s => s[0]).join('').trim().length > 0;
        return false;
    });
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
                    title: document.title || getMeta('og:title'),
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
    const storageData = await chrome.storage.local.get(['notion_page_id', 'pending_urls', 'pending_caption', 'import_style', 'cover_enabled']);

    if (storageData.notion_page_id) document.getElementById('pageId').value = storageData.notion_page_id;
    if (storageData.pending_caption) document.getElementById('caption').value = storageData.pending_caption;

    const urlsInput = document.getElementById('urls');
    const urlSection = document.getElementById('urlSection');
    const coverControl = document.getElementById('coverControl');
    const toggleCover = document.getElementById('toggleCover');
    const noCoverTip = document.getElementById('noCoverTip');
    const coverText = document.getElementById('coverText');
    const batchUrlTip = document.getElementById('batchUrlTip');
    const batchTools = document.getElementById('batchTools');
    const articleTip = document.getElementById('articleTip');

    const captionSection = document.getElementById('captionSection');
    const captionLabel = document.getElementById('captionLabel');
    const captionTip = document.getElementById('captionTip');
    
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
            if (currentStyle === 'bookmark') {
                updateCoverUI();
            }
        }
    };

    // === 辅助函数：更新 UI 状态 ===
    const updateUIState = async (style) => {
        // 先隐藏所有条件区域
        coverControl.classList.add('hidden');
        articleTip.classList.add('hidden');
        batchUrlTip.classList.add('hidden');
        batchTools.classList.add('hidden');

        if (style === 'article') {
            // 文章模式
            urlSection.classList.remove('hidden');
            captionSection.classList.remove('hidden');
            articleTip.classList.remove('hidden');
            captionLabel.innerText = "标签（选填）";
            captionTip.classList.add('hidden');

            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs && tabs[0]) {
                urlsInput.value = tabs[0].url;
            }
            urlsInput.readOnly = true;
        } else if (style === 'tweet') {
            // 推文页面模式
            urlSection.classList.remove('hidden');
            captionSection.classList.remove('hidden');
            captionLabel.innerText = "标签（选填）";
            captionTip.classList.add('hidden');

            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs && tabs[0]) {
                urlsInput.value = tabs[0].url;
            }
            urlsInput.readOnly = true;
        } else if (style === 'batch') {
            // 批量模式
            urlSection.classList.remove('hidden');
            captionSection.classList.remove('hidden');
            batchUrlTip.classList.remove('hidden');
            batchTools.classList.remove('hidden');
            captionLabel.innerText = "备注（选填）";
            captionTip.innerText = "*多个链接的情况下，备注会被覆盖";
            captionTip.classList.remove('hidden');

            chrome.storage.local.get(['pending_urls'], (res) => {
                urlsInput.value = res.pending_urls || "";
            });
            urlsInput.readOnly = false;
        } else {
            // 默认模式（书签）
            urlSection.classList.remove('hidden');
            captionSection.classList.remove('hidden');
            coverControl.classList.remove('hidden');
            coverControl.style.display = 'flex'; // override hidden properly
            captionLabel.innerText = "备注（选填）";
            captionTip.innerText = "*填写后会显示在bookmark卡片下方";
            captionTip.classList.remove('hidden');

            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tabs && tabs[0]) {
                urlsInput.value = tabs[0].url;
            }
            urlsInput.readOnly = false;

            await checkCurrentPageCover();
            updateCoverUI();
        }
    };

    // 2. 恢复状态并检查是否允许推文模式
    const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const isTwitterPage = activeTabs[0] && (activeTabs[0].url.includes('x.com') || activeTabs[0].url.includes('twitter.com'));
    
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
        const saved = storageData.import_style;
        initialStyle = (saved && saved !== 'tweet') ? saved : 'article';
    }

    let targetRadio = Array.from(styleRadios).find(r => r.value === initialStyle);
    if (!targetRadio) targetRadio = styleRadios[0];
    targetRadio.checked = true;

    // 恢复封面图开关状态（默认关闭）
    toggleCover.checked = !!storageData.cover_enabled;

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


    // 输入同步 Storage
    const ids = ['urls', 'pageId', 'caption'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', (e) => {
            if (id === 'urls') {
                const currentStyle = document.querySelector('input[name="importStyle"]:checked').value;
                if (currentStyle === 'batch') {
                    chrome.storage.local.set({ 'pending_urls': e.target.value });
                }
            } else {
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

// === 进度条辅助函数 ===
const _importProgress = document.getElementById('importProgress');
const _progressBar = document.getElementById('progressBar');
const _progressText = document.getElementById('progressText');
const _btnImport = document.getElementById('btnImport');
const _importForm = document.getElementById('importForm');
const _status = document.getElementById('status');
let _pendingDismiss = null;

function showProgress(text) {
    _btnImport.classList.add('hidden');
    _importProgress.classList.remove('hidden');
    _progressBar.classList.remove('done');
    _progressText.classList.remove('done');
    _progressText.textContent = text;
}

function updateProgressText(text) {
    _progressText.textContent = text;
}

function hideProgress() {
    _importProgress.classList.add('hidden');
    _btnImport.classList.remove('hidden');
    _progressBar.classList.remove('done');
    _progressText.classList.remove('done');
}

async function completeProgress(text) {
    _progressBar.classList.add('done');
    _progressText.classList.add('done');
    _progressText.textContent = text;
    await new Promise(r => setTimeout(r, 2000));
    hideProgress();
}

// === 主流程 ===
document.getElementById('btnImport').addEventListener('click', async () => {
    const rawInput = document.getElementById('pageId').value.trim();
    const urlsText = document.getElementById('urls').value;
    const manualCaption = document.getElementById('caption').value.trim();

    const selectedStyle = document.querySelector('input[name="importStyle"]:checked').value;
    const isBatchMode = selectedStyle === 'batch';
    const isTweetMode = selectedStyle === 'tweet';
    const isArticleMode = selectedStyle === 'article';
    const importCoverEnabled = !isBatchMode && !isTweetMode && !isArticleMode && document.getElementById('toggleCover').checked;

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

            if (isDatabase && collectionId) {
                await createDatabasePageFromArticle(spaceId, collectionId, schema, articleData, userId, manualCaption);
                await completeProgress(`✅ 已导入文章至 Database`);
            } else {
                await createNotionPageFromArticle(spaceId, pageId, articleData, userId, manualCaption);
                await completeProgress(`✅ 已导入文章`);
            }
            document.getElementById('caption').value = "";
            chrome.storage.local.remove('pending_caption');
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
            if (!tab || (!tab.url.includes('x.com') && !tab.url.includes('twitter.com'))) {
                throw new Error("请先打开一个 X / Twitter 推文页面");
            }

            const threadData = await extractXThread(tab.id);
            if (!threadData || !threadData.tweets.length) {
                throw new Error("未找到推文内容，请确认页面已完整加载");
            }

            // 显示提取摘要
            const blocks0 = threadData.tweets[0]?.blocks || [];
            const textBlocks = blocks0.filter(b => b.type === 'text').length;
            const imgBlocks = blocks0.filter(b => b.type === 'image').length;
            const preview = blocks0.find(b => b.type === 'text')?.plainText?.slice(0, 25) || '(空)';
            updateProgressText(`${threadData.tweets.length}条 | 段落:${textBlocks} 图:${imgBlocks} | "${preview}"`);
            await new Promise(r => setTimeout(r, 3000));

            updateProgressText("📝 创建 Notion 页面...");
            const userId = await getCurrentUserId();
            if (!userId) throw new Error("请先登录 www.notion.so");

            const pageInfo = await getPageInfo(pageId, userId);
            const { spaceId, isDatabase, collectionId, schema } = pageInfo;

            if (isDatabase && collectionId) {
                await createDatabasePageFromThread(spaceId, collectionId, schema, threadData, userId, manualCaption);
                await completeProgress(`✅ 已导入至 Database（${threadData.tweets.length} 条推文）`);
            } else {
                await createNotionPageFromThread(spaceId, pageId, threadData, userId, manualCaption);
                await completeProgress(`✅ 已导入 ${threadData.tweets.length} 条推文`);
            }
            document.getElementById('caption').value = "";
            chrome.storage.local.remove('pending_caption');
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
            const styleLabel = isBatchMode ? "批量链接" : "书签";
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

                const isBatchMode = document.querySelector('input[name="importStyle"]:checked').value === 'batch';
                if (isBatchMode) {
                    chrome.storage.local.set({ 'pending_urls': newContent });
                }

            } catch (e) {
                console.error(e);
                updateProgressText("⚠️ 写入失败，保留链接...");

                // 记录失败链接，确保它留在 UI 上
                failedUrls.push(url);

                // 更新 UI：保留失败链接
                const remaining = targets.slice(i + 1);
                const newContent = [...failedUrls, ...remaining].join('\n');

                document.getElementById('urls').value = newContent;

                const isBatchMode = document.querySelector('input[name="importStyle"]:checked').value === 'batch';
                if (isBatchMode) {
                    chrome.storage.local.set({ 'pending_urls': newContent });
                }
            }

            await new Promise(r => setTimeout(r, 800));
        }

        await completeProgress(targets.length === 1 ? "✅ 导入完成" : `✅ 完成！导入 ${successCount} 个`);

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
        hideProgress();
        _status.innerText = "❌ " + err.message;
        _status.style.color = "red";
    } finally {
        _btnImport.disabled = false;
        document.getElementById('urls').readOnly = false;
    }
});

// === Notion API ===

// 获取页面信息：spaceId + 是否为 Database + collection 信息
async function getPageInfo(pageId, userId) {
    const res = await fetch("https://www.notion.so/api/v3/loadPageChunk", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-notion-active-user-header": userId },
        body: JSON.stringify({
            "pageId": pageId, "limit": 50, "cursor": { "stack": [] }, "chunkNumber": 0, "verticalColumns": false
        })
    });
    const data = await res.json();
    const blockData = data.recordMap?.block?.[pageId];
    if (!blockData?.value) throw new Error("无法读取页面信息，请检查 ID");

    const spaceId = blockData.value.space_id;
    const isDatabase = ['collection_view_page', 'collection_view'].includes(blockData.value.type);
    const collectionId = blockData.value.collection_id || null;

    let schema = null;
    if (collectionId && data.recordMap?.collection?.[collectionId]) {
        schema = data.recordMap.collection[collectionId].value?.schema || null;
    }

    return { spaceId, isDatabase, collectionId, schema };
}

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

// === Markdown → Notion 块类型解析 ===
function stripRichTextPrefix(richText, prefixLen) {
    if (!richText || !richText.length) return richText;
    const result = richText.map(s => [...s]);
    if (result[0] && typeof result[0][0] === 'string') {
        result[0][0] = result[0][0].slice(prefixLen);
        if (!result[0][0] && result.length > 1) result.shift();
    }
    return result.filter(s => s[0]);
}

// 按换行符将 richText 切分为多行，每行保留原有格式标注
function splitRichTextByLines(richText) {
    const lines = [];
    let current = [];
    for (const seg of (richText || [])) {
        const text = seg[0] || '';
        const anns = seg[1] || null;
        const parts = text.split('\n');
        for (let i = 0; i < parts.length; i++) {
            if (parts[i]) current.push(anns ? [parts[i], anns] : [parts[i]]);
            if (i < parts.length - 1) { lines.push(current); current = []; }
        }
    }
    if (current.length) lines.push(current);
    return lines;
}


function parseLineToNotionBlock(text, richText) {
    let m;
    m = text.match(/^(### )(.+)/);  if (m) return { notionType: 'sub_sub_header', richText: stripRichTextPrefix(richText, m[1].length) };
    m = text.match(/^(## )(.+)/);   if (m) return { notionType: 'sub_header',     richText: stripRichTextPrefix(richText, m[1].length) };
    m = text.match(/^(# )(.+)/);    if (m) return { notionType: 'header',          richText: stripRichTextPrefix(richText, m[1].length) };
    m = text.match(/^([-*•] )(.+)/);if (m) return { notionType: 'bulleted_list',   richText: stripRichTextPrefix(richText, m[1].length) };
    m = text.match(/^(\d+[.)]\s+)(.+)/); if (m) return { notionType: 'text', richText };
    m = text.match(/^(> )(.+)/);    if (m) return { notionType: 'quote',           richText: stripRichTextPrefix(richText, m[1].length) };
    return { notionType: 'text', richText };
}

// 将一个 text block 展开为一到多个 Notion 块（处理换行 + markdown）
function parseTextBlockToNotionBlocks(block) {
    const text = block.plainText || '';
    const lines = text.split('\n');
    if (lines.length <= 1) {
        return [parseLineToNotionBlock(text.trim(), block.richText || [[text]])];
    }
    // 多行时：按行切分，同时保留每行的 richText 格式标注
    const richTextLines = splitRichTextByLines(block.richText || [[text]]);
    return lines
        .map((l, i) => ({ text: l.trim(), rt: richTextLines[i] || [[l.trim()]] }))
        .filter(({ text }) => text)
        .map(({ text, rt }) => parseLineToNotionBlock(text, rt));
}

// === 辅助：在 Database schema 中查找匹配属性，找不到则规划新建 ===
function findOrPlanSchemaKey(schema, names, type) {
    if (schema) {
        for (const [key, prop] of Object.entries(schema)) {
            if (key === 'title') continue;
            if (names.some(n => prop.name?.toLowerCase() === n.toLowerCase()) && prop.type === type) {
                return { key, create: false, name: prop.name, type: prop.type };
            }
        }
    }
    // Notion schema key 惯用 4 位随机串
    let key;
    do { key = Math.random().toString(36).slice(2, 6); } while (schema && schema[key]);
    return { key, create: true, name: names[0], type };
}

// === 推文线程 → Notion Database 页面 ===
async function createDatabasePageFromThread(spaceId, collectionId, schema, threadData, userId, tags) {
    const pageId = uuidv4();
    const operations = [];

    // 查找或规划属性的 schema key
    const authorProp = findOrPlanSchemaKey(schema, ['Author', '作者'], 'text');
    const urlProp    = findOrPlanSchemaKey(schema, ['URL', '链接', 'Link'], 'url');
    const dateProp   = findOrPlanSchemaKey(schema, ['Date', '日期', '发布日期', '创建时间'], 'date');
    const tagsProp   = findOrPlanSchemaKey(schema, ['Tags', '标签', 'Tag', 'Labels'], 'multi_select');

    // 处理 tags 的 schema 属性
    let finalTagsStr = null;
    if (tags && tags.trim()) {
        const inputTags = tags.split(/[,，]/).map(t => t.trim()).filter(Boolean);
        const existingOptions = (!tagsProp.create && schema && schema[tagsProp.key] && schema[tagsProp.key].options) ? schema[tagsProp.key].options : [];
        const existingValues = existingOptions.map(o => o.value);
        let newOptions = [...existingOptions];
        let hasNew = false;
        
        for (const t of inputTags) {
            if (!existingValues.includes(t)) {
                newOptions.push({
                    id: uuidv4(),
                    value: t,
                    color: ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'][Math.floor(Math.random() * 10)]
                });
                hasNew = true;
            }
        }
        
        if (hasNew) {
            tagsProp.create = true;
            tagsProp.updatedOptions = newOptions;
        } else if (tagsProp.create) {
            tagsProp.updatedOptions = [];
        }
        
        if (inputTags.length > 0) {
            finalTagsStr = inputTags.join(',');
        }
    } else if (tagsProp.create) {
        tagsProp.updatedOptions = [];
    }

    // 如需新建属性，先写入 collection schema
    for (const prop of [authorProp, urlProp, dateProp, tagsProp]) {
        if (prop.create) {
            const args = { name: prop.name, type: prop.type };
            if (prop.type === 'multi_select' && prop.updatedOptions) {
                args.options = prop.updatedOptions;
            }
            operations.push({
                id: collectionId, table: "collection",
                path: ["schema", prop.key], command: "update",
                args: args
            });
        }
    }

    // 构建 properties
    const properties = { title: [[threadData.title || "推文"]] };
    if (threadData.authorName) properties[authorProp.key] = [[threadData.authorName]];
    if (threadData.url)        properties[urlProp.key]    = [[threadData.url]];
    if (threadData.dateISO)    properties[dateProp.key]   = [['‣', [['d', { type: 'date', start_date: threadData.dateISO }]]]];
    if (finalTagsStr)          properties[tagsProp.key]   = [[finalTagsStr]];

    const format = {};

    // 创建 Database 页（parent_table 为 "collection"）
    operations.push({
        id: pageId, table: "block", path: [], command: "set",
        args: {
            id: pageId, type: "page", version: 1, alive: true,
            parent_id: collectionId, parent_table: "collection", space_id: spaceId,
            created_time: Date.now(), last_edited_time: Date.now(),
            properties, format
        }
    });

    // 写入推文内容块（与普通页面逻辑相同）
    let lastBlockId = null;
    const addBlock = (type, blockArgs) => {
        const blockId = uuidv4();
        operations.push({
            id: blockId, table: "block", path: [], command: "set",
            args: {
                id: blockId, type, version: 1, alive: true,
                parent_id: pageId, parent_table: "block", space_id: spaceId,
                created_time: Date.now(), last_edited_time: Date.now(),
                ...blockArgs
            }
        });
        operations.push({
            id: pageId, table: "block", path: ["content"], command: "listAfter",
            args: { after: lastBlockId || uuidv4(), id: blockId }
        });
        lastBlockId = blockId;
    };

    for (let i = 0; i < threadData.tweets.length; i++) {
        const tweet = threadData.tweets[i];
        for (const block of (tweet.blocks || [])) {
            if (block.type === 'text') {
                const notionBlocks = parseTextBlockToNotionBlocks(block);
                for (const nb of notionBlocks) {
                    addBlock(nb.notionType, { properties: { title: nb.richText } });
                }
            } else if (block.type === 'image') {
                addBlock("image", {
                    properties: { source: [[block.url]] },
                    format: { display_source: block.url }
                });
            } else if (block.type === 'video') {
                addBlock("text", { properties: { title: [["📹 [视频内容，请前往原链接查看]", [["i"]]]] } });
            }
        }
        if (i < threadData.tweets.length - 1) addBlock("divider", {});
    }

    const res = await fetch("https://www.notion.so/api/v3/saveTransactions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-notion-active-user-header": userId },
        body: JSON.stringify({ requestId: uuidv4(), transactions: [{ id: uuidv4(), spaceId, operations }] })
    });
    const resText = await res.text();
    if (!res.ok) throw new Error("创建 Database 页面失败: " + resText.slice(0, 100));
    return pageId;
}

// === 推文线程 → 独立 Notion 页面 ===
async function createNotionPageFromThread(spaceId, parentId, threadData, userId, tags) {
    const pageId = uuidv4();
    const operations = [];
    let lastBlockId = null;

    // 创建子页面
    operations.push({
        id: pageId, table: "block", path: [], command: "set",
        args: {
            id: pageId, type: "page", version: 1, alive: true,
            parent_id: parentId, parent_table: "block", space_id: spaceId,
            created_time: Date.now(), last_edited_time: Date.now(),
            properties: { title: [[threadData.title || "推文"]] }
        }
    });
    operations.push({
        id: parentId, table: "block", path: ["content"], command: "listAfter",
        args: { after: uuidv4(), id: pageId }
    });

    // 向页面内追加块的辅助函数
    const addBlock = (type, blockArgs) => {
        const blockId = uuidv4();
        operations.push({
            id: blockId, table: "block", path: [], command: "set",
            args: {
                id: blockId, type, version: 1, alive: true,
                parent_id: pageId, parent_table: "block", space_id: spaceId,
                created_time: Date.now(), last_edited_time: Date.now(),
                ...blockArgs
            }
        });
        operations.push({
            id: pageId, table: "block", path: ["content"], command: "listAfter",
            args: { after: lastBlockId || uuidv4(), id: blockId }
        });
        lastBlockId = blockId;
    };

    // 插入外部网页信息（仅限普通页面，不影响 Database）
    if (threadData.authorName) {
        addBlock("text", { properties: { title: [["👤 作者："], [threadData.authorName, [["b"]]]] } });
    }
    if (threadData.dateISO || threadData.date) {
        addBlock("text", { properties: { title: [["🗓️ 日期："], [threadData.dateISO || threadData.date]] } });
    }
    if (threadData.url) {
        addBlock("text", { properties: { title: [["🔗 链接："], [threadData.url, [["a", threadData.url]]]] } });
    }
    if (tags && tags.trim()) {
        addBlock("text", { properties: { title: [["🏷️ 标签："], [tags.trim()]] } });
    }
    // 加入分割线区分正文
    if (threadData.authorName || threadData.dateISO || threadData.url || (tags && tags.trim())) {
        addBlock("divider", {});
    }

    // 逐条推文写入
    for (let i = 0; i < threadData.tweets.length; i++) {
        const tweet = threadData.tweets[i];
        for (const block of (tweet.blocks || [])) {
            if (block.type === 'text') {
                const notionBlocks = parseTextBlockToNotionBlocks(block);
                for (const nb of notionBlocks) {
                    addBlock(nb.notionType, { properties: { title: nb.richText } });
                }
            } else if (block.type === 'image') {
                addBlock("image", {
                    properties: { source: [[block.url]] },
                    format: { display_source: block.url }
                });
            } else if (block.type === 'video') {
                addBlock("text", { properties: { title: [["📹 [视频内容，请前往原链接查看]", [["i"]]]] } });
            }
        }
        if (i < threadData.tweets.length - 1) {
            addBlock("divider", {});
        }
    }

    const res = await fetch("https://www.notion.so/api/v3/saveTransactions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-notion-active-user-header": userId },
        body: JSON.stringify({ requestId: uuidv4(), transactions: [{ id: uuidv4(), spaceId, operations }] })
    });
    const resText = await res.text();
    if (!res.ok) throw new Error("创建页面失败: " + resText.slice(0, 100));
    return pageId;
}

// === 文章 → Notion Database 页面 ===
async function createDatabasePageFromArticle(spaceId, collectionId, schema, articleData, userId, tags) {
    const pageId = uuidv4();
    const operations = [];

    // 查找或规划属性的 schema key（复用推文的逻辑）
    const authorProp = findOrPlanSchemaKey(schema, ['Author', '作者', '来源'], 'text');
    const urlProp    = findOrPlanSchemaKey(schema, ['URL', '链接', 'Link'], 'url');
    const dateProp   = findOrPlanSchemaKey(schema, ['Date', '日期', '发布日期', '创建时间'], 'date');
    const tagsProp   = findOrPlanSchemaKey(schema, ['Tags', '标签', 'Tag', 'Labels'], 'multi_select');

    // 处理 tags 的 schema 属性（与推文模式相同）
    let finalTagsStr = null;
    if (tags && tags.trim()) {
        const inputTags = tags.split(/[,，]/).map(t => t.trim()).filter(Boolean);
        const existingOptions = (!tagsProp.create && schema && schema[tagsProp.key] && schema[tagsProp.key].options) ? schema[tagsProp.key].options : [];
        const existingValues = existingOptions.map(o => o.value);
        let newOptions = [...existingOptions];
        let hasNew = false;

        for (const t of inputTags) {
            if (!existingValues.includes(t)) {
                newOptions.push({
                    id: uuidv4(),
                    value: t,
                    color: ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'][Math.floor(Math.random() * 10)]
                });
                hasNew = true;
            }
        }

        if (hasNew) {
            tagsProp.create = true;
            tagsProp.updatedOptions = newOptions;
        } else if (tagsProp.create) {
            tagsProp.updatedOptions = [];
        }

        if (inputTags.length > 0) finalTagsStr = inputTags.join(',');
    } else if (tagsProp.create) {
        tagsProp.updatedOptions = [];
    }

    // 新建属性写入 collection schema
    for (const prop of [authorProp, urlProp, dateProp, tagsProp]) {
        if (prop.create) {
            const args = { name: prop.name, type: prop.type };
            if (prop.type === 'multi_select' && prop.updatedOptions) args.options = prop.updatedOptions;
            operations.push({
                id: collectionId, table: "collection",
                path: ["schema", prop.key], command: "update",
                args
            });
        }
    }

    // 构建 properties
    const authorLabel = articleData.authorName || articleData.siteName || '';
    const properties = { title: [[articleData.title || "文章"]] };
    if (authorLabel)         properties[authorProp.key] = [[authorLabel]];
    if (articleData.url)     properties[urlProp.key]    = [[articleData.url]];
    if (articleData.dateISO) properties[dateProp.key]   = [['‣', [['d', { type: 'date', start_date: articleData.dateISO }]]]];
    if (finalTagsStr)        properties[tagsProp.key]   = [[finalTagsStr]];

    // 创建 Database 页
    operations.push({
        id: pageId, table: "block", path: [], command: "set",
        args: {
            id: pageId, type: "page", version: 1, alive: true,
            parent_id: collectionId, parent_table: "collection", space_id: spaceId,
            created_time: Date.now(), last_edited_time: Date.now(),
            properties, format: {}
        }
    });

    // 写入文章内容块
    let lastBlockId = null;
    const addBlock = (type, blockArgs) => {
        const blockId = uuidv4();
        operations.push({
            id: blockId, table: "block", path: [], command: "set",
            args: {
                id: blockId, type, version: 1, alive: true,
                parent_id: pageId, parent_table: "block", space_id: spaceId,
                created_time: Date.now(), last_edited_time: Date.now(),
                ...blockArgs
            }
        });
        operations.push({
            id: pageId, table: "block", path: ["content"], command: "listAfter",
            args: { after: lastBlockId || uuidv4(), id: blockId }
        });
        lastBlockId = blockId;
    };

    for (const block of (articleData.blocks || [])) {
        if (['header', 'sub_header', 'sub_sub_header', 'text', 'bulleted_list', 'numbered_list', 'quote'].includes(block.type)) {
            addBlock(block.type, { properties: { title: block.richText } });
        } else if (block.type === 'image') {
            addBlock("image", { properties: { source: [[block.url]] }, format: { display_source: block.url } });
        } else if (block.type === 'code') {
            addBlock("code", { properties: { title: [[block.text]], language: [[block.language || 'Plain Text']] } });
        } else if (block.type === 'divider') {
            addBlock("divider", {});
        }
    }

    const res = await fetch("https://www.notion.so/api/v3/saveTransactions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-notion-active-user-header": userId },
        body: JSON.stringify({ requestId: uuidv4(), transactions: [{ id: uuidv4(), spaceId, operations }] })
    });
    const resText = await res.text();
    if (!res.ok) throw new Error("创建 Database 页面失败: " + resText.slice(0, 100));
    return pageId;
}

// === 文章 → 独立 Notion 页面 ===
async function createNotionPageFromArticle(spaceId, parentId, articleData, userId, tags) {
    const pageId = uuidv4();
    const operations = [];
    let lastBlockId = null;

    // 创建子页面
    operations.push({
        id: pageId, table: "block", path: [], command: "set",
        args: {
            id: pageId, type: "page", version: 1, alive: true,
            parent_id: parentId, parent_table: "block", space_id: spaceId,
            created_time: Date.now(), last_edited_time: Date.now(),
            properties: { title: [[articleData.title || "文章"]] }
        }
    });
    operations.push({
        id: parentId, table: "block", path: ["content"], command: "listAfter",
        args: { after: uuidv4(), id: pageId }
    });

    const addBlock = (type, blockArgs) => {
        const blockId = uuidv4();
        operations.push({
            id: blockId, table: "block", path: [], command: "set",
            args: {
                id: blockId, type, version: 1, alive: true,
                parent_id: pageId, parent_table: "block", space_id: spaceId,
                created_time: Date.now(), last_edited_time: Date.now(),
                ...blockArgs
            }
        });
        operations.push({
            id: pageId, table: "block", path: ["content"], command: "listAfter",
            args: { after: lastBlockId || uuidv4(), id: blockId }
        });
        lastBlockId = blockId;
    };

    // 元信息头
    const authorLabel = articleData.authorName || '';
    if (authorLabel) {
        addBlock("text", { properties: { title: [["👤 作者："], [authorLabel, [["b"]]]] } });
    }
    if (articleData.siteName) {
        addBlock("text", { properties: { title: [["📰 来源："], [articleData.siteName]] } });
    }
    if (articleData.dateISO || articleData.date) {
        addBlock("text", { properties: { title: [["🗓️ 日期："], [articleData.dateISO || articleData.date]] } });
    }
    if (articleData.url) {
        addBlock("text", { properties: { title: [["🔗 链接："], [articleData.url, [["a", articleData.url]]]] } });
    }
    if (tags && tags.trim()) {
        addBlock("text", { properties: { title: [["🏷️ 标签："], [tags.trim()]] } });
    }
    if (authorLabel || articleData.siteName || articleData.dateISO || articleData.url || (tags && tags.trim())) {
        addBlock("divider", {});
    }

    // 写入文章内容块
    for (const block of (articleData.blocks || [])) {
        if (['header', 'sub_header', 'sub_sub_header', 'text', 'bulleted_list', 'numbered_list', 'quote'].includes(block.type)) {
            addBlock(block.type, { properties: { title: block.richText } });
        } else if (block.type === 'image') {
            addBlock("image", { properties: { source: [[block.url]] }, format: { display_source: block.url } });
        } else if (block.type === 'code') {
            addBlock("code", { properties: { title: [[block.text]], language: [[block.language || 'Plain Text']] } });
        } else if (block.type === 'divider') {
            addBlock("divider", {});
        }
    }

    const res = await fetch("https://www.notion.so/api/v3/saveTransactions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-notion-active-user-header": userId },
        body: JSON.stringify({ requestId: uuidv4(), transactions: [{ id: uuidv4(), spaceId, operations }] })
    });
    const resText = await res.text();
    if (!res.ok) throw new Error("创建页面失败: " + resText.slice(0, 100));
    return pageId;
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
