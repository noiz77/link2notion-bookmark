// URL 与标题工具

export function isTwitterUrl(url) {
    try {
        const hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
        return hostname === 'x.com' ||
            hostname.endsWith('.x.com') ||
            hostname === 'twitter.com' ||
            hostname.endsWith('.twitter.com');
    } catch (e) {
        return false;
    }
}

// 特定平台强制无封面（它们的 og:image 通常不适合 bookmark）
export function filterCover(url, coverUrl) {
    if (isTwitterUrl(url) ||
        url.includes('youtube.com') ||
        url.includes('youtu.be') ||
        url.includes('bilibili.com')) {
        return null;
    }
    return coverUrl;
}

// 清理标题（目前仅移除 X/Twitter 的 "(数字) " 未读消息数前缀）
export function cleanTitle(url, title) {
    if (!title) return title;
    if (isTwitterUrl(url)) {
        return title.replace(/^\(\d+\)\s*/, '');
    }
    return title;
}

export function getNotionUrl(id) {
    return `https://www.notion.so/${id.replace(/-/g, '')}`;
}
