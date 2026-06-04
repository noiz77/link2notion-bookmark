// 文章正文提取：Readability 自动模式 + 用户框选模式

// 使用 Mozilla Readability 自动提取正文
export async function extractArticle(tabId) {
    // 第一步：注入 Readability.js 库
    await chrome.scripting.executeScript({
        target: { tabId },
        files: ['lib/Readability.js']
    });

    // 第二步：运行提取
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
            const isWeChatArticle = () => {
                const host = window.location.hostname.toLowerCase();
                return host === 'mp.weixin.qq.com' || host.endsWith('.mp.weixin.qq.com');
            };

            const replaceVideosWithPlaceholders = (container) => {
                container.querySelectorAll('video, iframe, embed, object').forEach(el => {
                    const placeholder = document.createElement('p');
                    placeholder.textContent = '[ ▶️ 此处视频无法获取 ]';
                    el.replaceWith(placeholder);
                });
            };

            const normalizeWeChatArticle = () => {
                const contentEl = document.querySelector('#js_content');
                if (!contentEl) return null;

                const container = contentEl.cloneNode(true);
                replaceVideosWithPlaceholders(container);
                container.querySelectorAll('script, style, noscript, svg').forEach(el => el.remove());
                container.querySelectorAll('[style*="display:none"], [style*="display: none"], [hidden]').forEach(el => el.remove());

                container.querySelectorAll('img').forEach(img => {
                    const dataSrc = img.getAttribute('data-src')
                        || img.getAttribute('data-original')
                        || img.getAttribute('data-backsrc')
                        || img.getAttribute('src');
                    if (dataSrc) img.setAttribute('src', dataSrc);
                    if (!img.getAttribute('alt')) img.setAttribute('alt', '');
                });

                const title = document.querySelector('#activity-name')?.textContent
                    || document.querySelector('meta[property="og:title"]')?.content
                    || document.title
                    || '';
                const author = document.querySelector('#js_name')?.textContent
                    || document.querySelector('#profileBt a')?.textContent
                    || document.querySelector('meta[name="author"]')?.content
                    || '';
                const date = document.querySelector('#publish_time')?.textContent
                    || document.querySelector('#js_publish_time')?.textContent
                    || document.querySelector('meta[property="article:published_time"]')?.content
                    || '';
                const dateISO = (() => {
                    const text = date.trim();
                    const match = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
                    if (!match) return '';
                    const [, y, m, d] = match;
                    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
                })();
                const account = document.querySelector('#js_name')?.textContent
                    || document.querySelector('meta[property="og:site_name"]')?.content
                    || '微信公众号';

                return {
                    title: title.trim(),
                    content: container.innerHTML,
                    byline: author.trim(),
                    date: date.trim(),
                    dateISO,
                    siteName: account.trim(),
                    url: window.location.href,
                    textLength: container.textContent.trim().length,
                    paragraphCount: container.querySelectorAll('p, section').length,
                    sourceType: 'wechat_article'
                };
            };

            if (isWeChatArticle()) {
                const weChatArticle = normalizeWeChatArticle();
                if (weChatArticle?.content && weChatArticle.textLength >= 20) return weChatArticle;
            }

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

// 读取用户在页面上的框选内容
export async function extractArticleFromSelection(tabId) {
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
            container.querySelectorAll('video, iframe, embed, object').forEach(el => {
                const placeholder = document.createElement('p');
                placeholder.textContent = '[ ▶️ 此处视频无法获取 ]';
                el.replaceWith(placeholder);
            });
            container.querySelectorAll('script, style, noscript, svg, nav, footer, aside, header').forEach(el => el.remove());
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
            const host = window.location.hostname.toLowerCase();
            const isWeChatArticle = host === 'mp.weixin.qq.com' || host.endsWith('.mp.weixin.qq.com');
            const weChatTitle = isWeChatArticle ? document.querySelector('#activity-name')?.textContent : '';
            const weChatAuthor = isWeChatArticle ? document.querySelector('#js_name')?.textContent : '';
            const weChatDate = isWeChatArticle ? document.querySelector('#publish_time')?.textContent : '';
            const weChatDateISO = (() => {
                const match = (weChatDate || '').trim().match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
                if (!match) return '';
                const [, y, m, d] = match;
                return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
            })();

            return {
                title: (weChatTitle || getMeta('og:title') || document.title || '').trim(),
                content: container.innerHTML,
                byline: (weChatAuthor || getName('author') || document.querySelector('[rel="author"]')?.textContent || getMeta('article:author') || '').trim(),
                date: (weChatDate || getMeta('article:published_time') || document.querySelector('time[datetime]')?.getAttribute('datetime') || '').trim(),
                dateISO: weChatDateISO,
                siteName: (weChatAuthor || getMeta('og:site_name') || '').trim(),
                url: window.location.href
            };
        }
    });
    return results?.[0]?.result;
}
