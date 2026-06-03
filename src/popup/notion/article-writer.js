// 文章 → Notion（Database 页面 / 独立页面 两套入口）

import { uuidv4 } from '../utils/ids.js';
import { findSchemaKey } from './schema.js';
import { buildTagsForDatabase } from './tags.js';
import { notionFetch } from './api.js';

export async function createDatabasePageFromArticle(spaceId, collectionId, schema, articleData, userId, tags) {
    const pageId = uuidv4();
    const operations = [];

    // 只写入已存在的属性，缺失的字段跳过（不再自动新建 schema 属性）
    const authorKey = findSchemaKey(schema, ['Author', '作者', '来源'], 'text');
    const urlKey    = findSchemaKey(schema, ['URL', '链接', 'Link'], 'url');
    const dateKey   = findSchemaKey(schema, ['Date', '日期', '发布日期', '创建时间'], 'date');
    const tagsKey   = findSchemaKey(schema, ['Tags', '标签', 'Tag', 'Labels'], 'multi_select');

    // 处理 tags：仅在 tags 属性存在时写入，新增选项需更新 options
    const { finalTagsStr, schemaUpdateOp } = buildTagsForDatabase(tags, tagsKey, schema, collectionId);
    if (schemaUpdateOp) operations.push(schemaUpdateOp);

    // 构建 properties（只写命中的属性）
    const authorLabel = articleData.authorName || articleData.siteName || '';
    const properties = { title: [[articleData.title || "文章"]] };
    if (authorKey && authorLabel)           properties[authorKey.key] = [[authorLabel]];
    if (urlKey && articleData.url)          properties[urlKey.key]    = [[articleData.url]];
    if (dateKey && articleData.dateISO)     properties[dateKey.key]   = [['‣', [['d', { type: 'date', start_date: articleData.dateISO }]]]];
    if (tagsKey && finalTagsStr)            properties[tagsKey.key]   = [[finalTagsStr]];

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

    const res = await notionFetch("saveTransactions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-notion-active-user-header": userId },
        body: JSON.stringify({ requestId: uuidv4(), transactions: [{ id: uuidv4(), spaceId, operations }] })
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`创建 Database 页面失败 (HTTP ${res.status})${detail ? ': ' + detail.slice(0, 200) : ''}`);
    }
    return pageId;
}

export async function createNotionPageFromArticle(spaceId, parentId, articleData, userId, tags) {
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

    const res = await notionFetch("saveTransactions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-notion-active-user-header": userId },
        body: JSON.stringify({ requestId: uuidv4(), transactions: [{ id: uuidv4(), spaceId, operations }] })
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`创建页面失败 (HTTP ${res.status})${detail ? ': ' + detail.slice(0, 200) : ''}`);
    }
    return pageId;
}
