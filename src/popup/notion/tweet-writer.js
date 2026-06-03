// 推文线程 → Notion（Database 页面 / 独立页面 两套入口 + 单条 block 写入辅助）

import { uuidv4 } from '../utils/ids.js';
import { findSchemaKey } from './schema.js';
import { buildTagsForDatabase } from './tags.js';
import { parseTextBlockToNotionBlocks } from '../parsers/markdown.js';
import { notionFetch } from './api.js';

// 将单个推文 block 写入 Notion 页面（统一 Database / 普通页面两处写入）
export function writeTweetBlockToNotion(block, addBlock) {
    const richBlockTypes = ['header', 'sub_header', 'sub_sub_header', 'quote', 'bulleted_list', 'numbered_list'];
    if (block.type === 'text') {
        const notionBlocks = parseTextBlockToNotionBlocks(block);
        for (const nb of notionBlocks) {
            addBlock(nb.notionType, { properties: { title: nb.richText } });
        }
    } else if (richBlockTypes.includes(block.type)) {
        addBlock(block.type, { properties: { title: block.richText || [[block.plainText || '']] } });
    } else if (block.type === 'image') {
        addBlock("image", {
            properties: { source: [[block.url]] },
            format: { display_source: block.url }
        });
    } else if (block.type === 'code') {
        addBlock("code", { properties: { title: [[block.text]], language: [[block.language || 'Plain Text']] } });
    } else if (block.type === 'video') {
        addBlock("text", { properties: { title: [["📹 [视频内容，请前往原链接查看]", [["i"]]]] } });
    }
}

export async function createDatabasePageFromThread(spaceId, collectionId, schema, threadData, userId, tags) {
    const pageId = uuidv4();
    const operations = [];

    // 只写入已存在的属性，缺失的字段跳过（不再自动新建 schema 属性）
    const authorKey = findSchemaKey(schema, ['Author', '作者'], 'text');
    const urlKey    = findSchemaKey(schema, ['URL', '链接', 'Link'], 'url');
    const dateKey   = findSchemaKey(schema, ['Date', '日期', '发布日期', '创建时间'], 'date');
    const tagsKey   = findSchemaKey(schema, ['Tags', '标签', 'Tag', 'Labels'], 'multi_select');

    // 处理 tags：仅在 tags 属性存在时写入，新增选项需更新 options
    const { finalTagsStr, schemaUpdateOp } = buildTagsForDatabase(tags, tagsKey, schema, collectionId);
    if (schemaUpdateOp) operations.push(schemaUpdateOp);

    // 构建 properties（只写命中的属性）
    const properties = { title: [[threadData.title || "推文"]] };
    if (authorKey && threadData.authorName) properties[authorKey.key] = [[threadData.authorName]];
    if (urlKey && threadData.url)           properties[urlKey.key]   = [[threadData.url]];
    if (dateKey && threadData.dateISO)      properties[dateKey.key]  = [['‣', [['d', { type: 'date', start_date: threadData.dateISO }]]]];
    if (tagsKey && finalTagsStr)            properties[tagsKey.key]  = [[finalTagsStr]];

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
            writeTweetBlockToNotion(block, addBlock);
        }
        if (i < threadData.tweets.length - 1) addBlock("divider", {});
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

export async function createNotionPageFromThread(spaceId, parentId, threadData, userId, tags) {
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
            writeTweetBlockToNotion(block, addBlock);
        }
        if (i < threadData.tweets.length - 1) {
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
