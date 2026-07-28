// 读取 Notion 页面元信息：spaceId / 是否为 Database / collection 信息 / schema

import { notionFetch } from './api.js';

// 获取页面信息：spaceId + 是否为 Database + collection 信息
export async function getPageInfo(pageId, userId) {
    const res = await notionFetch("loadPageChunk", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-notion-active-user-header": userId },
        body: JSON.stringify({
            "pageId": pageId, "limit": 50, "cursor": { "stack": [] }, "chunkNumber": 0, "verticalColumns": false
        })
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`无法读取页面信息 (HTTP ${res.status})${text ? ': ' + text.slice(0, 200) : ''}`);
    }

    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        throw new Error(`无法读取页面信息：Notion 返回了无效响应${text ? ' (' + text.slice(0, 100) + ')' : ''}`);
    }

    const blockData = data.recordMap?.block?.[pageId];
    if (!blockData?.value) {
        const detail = data.message || data.error || data.name;
        const blockCount = Object.keys(data.recordMap?.block || {}).length;
        const collectionCount = Object.keys(data.recordMap?.collection || {}).length;
        const isEmptyRecordMap = blockCount === 0 && collectionCount === 0;
        const emptyHint = isEmptyRecordMap
            ? 'Notion 返回了空页面数据，通常是浏览器没有把 Notion 登录会话传给扩展，或当前账号没有该页面权限'
            : `Notion 返回了 ${blockCount} 个 block，但不包含目标页面`;
        const error = new Error(`无法读取页面信息：${emptyHint}。请确认页面链接、访问权限和 Notion 登录状态${detail ? ': ' + detail : ''}`);
        if (isEmptyRecordMap) error.code = 'NOTION_SESSION_VALIDATION_FAILED';
        throw error;
    }

    // Notion 的 block 记录存在两种结构：
    // { value: block } 与 { value: { value: block, role } }
    const nestedValue = blockData.value?.value;
    const val = nestedValue && typeof nestedValue === 'object' && nestedValue.type
        ? nestedValue
        : blockData.value;

    // spaceId 兜底：当前块可能缺失，从 recordMap 中其他块或 space 获取
    let spaceId = val.space_id;
    if (!spaceId) {
        const blocks = data.recordMap?.block || {};
        for (const bid of Object.keys(blocks)) {
            if (blocks[bid]?.value?.space_id) { spaceId = blocks[bid].value.space_id; break; }
        }
    }
    if (!spaceId) {
        const spaces = data.recordMap?.space || {};
        const firstSpace = Object.keys(spaces)[0];
        if (firstSpace) spaceId = firstSpace;
    }

    // Database 检测：block 自身类型 或 parent_table 为 collection（数据库行）
    const blockType = val.type;
    const parentTable = val.parent_table;
    const canAcceptChildBlocks = blockType === 'page';
    let isDatabase = ['collection_view_page', 'collection_view'].includes(blockType);
    let collectionId = val.collection_id || null;

    // 数据库行（page 类型但 parent_table 是 collection）也视为 Database
    if (!isDatabase && blockType === 'page' && parentTable === 'collection') {
        isDatabase = true;
        collectionId = val.parent_id || null;
    }

    // 最后兜底：如果 recordMap 中有 collection 数据，说明这就是个 Database
    if (!isDatabase && !collectionId) {
        const collections = data.recordMap?.collection || {};
        const firstColl = Object.keys(collections)[0];
        if (firstColl) {
            isDatabase = true;
            collectionId = firstColl;
        }
    }

    let schema = null;
    if (collectionId && data.recordMap?.collection?.[collectionId]) {
        const entry = data.recordMap.collection[collectionId];
        schema = entry.value?.value?.schema || entry.value?.schema || null;
    }
    // loadPageChunk 在新版 Notion 常不返回 collection 记录；兜底单独请求一次
    if (collectionId && !schema) {
        schema = await loadCollectionSchema(collectionId, spaceId, userId);
    }

    if (isDatabase) {
        const fields = schema ? Object.entries(schema).map(([k, v]) => `${v.name}(${v.type})`) : [];
        console.log("[link2notion] Database schema 字段:", fields.length ? fields : "(未读取到 schema)");
    }

    return { spaceId, isDatabase, collectionId, schema, canAcceptChildBlocks };
}

export async function loadCollectionSchema(collectionId, spaceId, userId) {
    try {
        const res = await notionFetch("syncRecordValues", {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-notion-active-user-header": userId },
            body: JSON.stringify({
                requests: [{ pointer: { table: "collection", id: collectionId }, version: -1 }]
            })
        });
        const data = await res.json();
        const entry = data.recordMap?.collection?.[collectionId];
        // 新版 Notion 响应多包一层 { value, role }，兼容两种结构
        return entry?.value?.value?.schema || entry?.value?.schema || null;
    } catch (e) {
        console.warn("[link2notion] loadCollectionSchema 失败:", e);
        return null;
    }
}
