// HTML → Notion 块转换（文章模式主解析器）

export function htmlToNotionBlocks(html, baseUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const blocks = [];
    const unsupportedVideoPlaceholder = '[ ▶️ 此处视频无法获取 ]';

    function normalizeUnsupportedVideoText(text) {
        let output = text || '';
        output = output.replace(/\[\s*▶️\s*此处为(?:[0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?|00:00)视频\s*\]/g, unsupportedVideoPlaceholder);
        return output;
    }

    function isLikelyCitationMarker(node) {
        if (!node || node.nodeType !== 1) return false;
        const text = (node.textContent || '').replace(/\s+/g, '');
        if (!text || text.length > 8) return false;

        const tag = node.nodeName;
        const classAndId = `${node.className || ''} ${node.id || ''}`.toLowerCase();
        const style = (node.getAttribute('style') || '').toLowerCase();
        const href = node.getAttribute('href') || '';
        const markerTextRe = /^(?:\[\d{1,3}\]|\(\d{1,3}\)|[［【（]?\d{1,3}[］】）]?|[¹²³⁴⁵⁶⁷⁸⁹⁰]+)$/;
        const markerNode = tag === 'SUP'
            || /\b(citation|reference|ref|footnote|noteref|endnote)\b/.test(classAndId)
            || style.includes('vertical-align: super')
            || style.includes('vertical-align:super')
            || style.includes('super');

        return markerNode && markerTextRe.test(text) && (!href || href.startsWith('#') || href.startsWith('javascript:'));
    }

    function stripCitationMarkers(root) {
        const clone = root.cloneNode(true);
        clone.querySelectorAll('sup, a, span').forEach(el => {
            if (isLikelyCitationMarker(el)) el.remove();
        });
        return clone;
    }

    function replaceUnsupportedVideos(root) {
        root.querySelectorAll('video, iframe, embed, object').forEach(el => {
            const placeholder = doc.createElement('span');
            placeholder.textContent = unsupportedVideoPlaceholder;
            el.replaceWith(placeholder);
        });
    }

    replaceUnsupportedVideos(doc.body);

    const hardFlowTags = new Set([
        'P',
        'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
        'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'TABLE', 'HR',
        'IMG', 'VIDEO', 'IFRAME', 'EMBED', 'OBJECT'
    ]);

    function hasHardFlowDescendant(node) {
        return Array.from(node.querySelectorAll('*')).some(child => (
            !isLikelyCitationMarker(child) && hardFlowTags.has(child.nodeName)
        ));
    }

    function hasDirectInlineSignal(node) {
        return Array.from(node.childNodes).some(child => {
            if (child.nodeType === 3) return child.textContent.trim().length > 0;
            if (child.nodeType !== 1 || isLikelyCitationMarker(child)) return false;
            return !['DIV', 'SECTION', 'ARTICLE'].includes(child.nodeName)
                && !hardFlowTags.has(child.nodeName)
                && child.textContent.trim().length > 0;
        });
    }

    function countDirectStyleFlowChildren(node) {
        return Array.from(node.children).filter(child => (
            ['DIV', 'SECTION', 'ARTICLE'].includes(child.nodeName)
            && !hasHardFlowDescendant(child)
            && stripCitationMarkers(child).textContent.trim().length > 0
        )).length;
    }

    function hasNestedStyleParagraphGroups(node) {
        return Array.from(node.querySelectorAll('div, section, article')).some(child => (
            !hasDirectInlineSignal(child) && countDirectStyleFlowChildren(child) > 1
        ));
    }

    function shouldMergeInlineContainer(node) {
        const tag = node.nodeName;
        if (!['DIV', 'SECTION', 'SPAN', 'FONT'].includes(tag)) return false;
        if (['DIV', 'SECTION'].includes(tag)) {
            if (hasHardFlowDescendant(node)) return false;
            if (!hasDirectInlineSignal(node) && countDirectStyleFlowChildren(node) > 1) return false;
            if (!hasDirectInlineSignal(node) && hasNestedStyleParagraphGroups(node)) return false;
        }
        return stripCitationMarkers(node).textContent.trim().length > 0;
    }

    // 提取内联富文本（保留加粗、斜体、链接、行内代码）
    function extractInlineRT(el) {
        const segments = [];
        function walk(node, bold, italic) {
            if (node.nodeType === 3) {
                const t = normalizeUnsupportedVideoText(node.textContent);
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
                if (isLikelyCitationMarker(node)) return;
                const isBold = bold || ['STRONG', 'B'].includes(node.nodeName);
                const isItalic = italic || ['EM', 'I'].includes(node.nodeName);
                for (const child of node.childNodes) walk(child, isBold, isItalic);
            }
        }
        for (const child of el.childNodes) walk(child, false, false);
        return segments.length ? segments : [[stripCitationMarkers(el).textContent || '']];
    }

    // 解析图片 URL（处理相对路径）
    function resolveImgSrc(node) {
        let src = node.getAttribute('src')
            || node.getAttribute('data-src')
            || node.getAttribute('data-original')
            || node.getAttribute('data-backsrc')
            || '';
        if (src && !src.startsWith('http') && !src.startsWith('data:') && baseUrl) {
            try { src = new URL(src, baseUrl).href; } catch (e) {}
        }
        return src.startsWith('http') ? src : null;
    }

    function pushParagraphParts(node) {
        const clone = stripCitationMarkers(node);
        clone.querySelectorAll('img').forEach(img => img.remove());
        const textContent = clone.textContent.trim();
        if (textContent) {
            blocks.push({ type: 'text', richText: extractInlineRT(clone) });
        }
        for (const img of node.querySelectorAll('img')) {
            const src = resolveImgSrc(img);
            if (src) blocks.push({ type: 'image', url: src });
        }
    }

    function processNode(node) {
        if (node.nodeType !== 1) return;
        if (isLikelyCitationMarker(node)) return;
        const tag = node.nodeName;

        if (shouldMergeInlineContainer(node)) {
            if (node.querySelector('img')) {
                pushParagraphParts(node);
            } else {
                blocks.push({ type: 'text', richText: extractInlineRT(node) });
            }
            return;
        }

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
                } else if (imgs.length > 0) {
                    pushParagraphParts(node);
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
            case 'VIDEO':
            case 'IFRAME':
            case 'EMBED':
            case 'OBJECT':
                blocks.push({ type: 'text', richText: [[unsupportedVideoPlaceholder]] });
                break;
            case 'HR':
                blocks.push({ type: 'divider' });
                break;
            case 'TABLE': {
                // 表格简化为文本
                const text = stripCitationMarkers(node).textContent.trim();
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
        if (b.richText) {
            b.richText = b.richText
                .map(([text, anns]) => {
                    const normalized = normalizeUnsupportedVideoText(text);
                    return anns ? [normalized, anns] : [normalized];
                })
                .filter(s => s[0].trim().length > 0);
            const plainText = b.richText.map(s => s[0]).join('');
            return plainText.trim().length > 0;
        }
        return false;
    });
}
