// Notion 书签块 + 图片块写入

import { uuidv4 } from '../utils/ids.js';
import { notionFetch } from './api.js';

export async function createFullBookmark(spaceId, parentId, meta, url, userId, caption) {
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

    const res = await notionFetch("saveTransactions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-notion-active-user-header": userId },
        body: JSON.stringify({ "requestId": uuidv4(), "transactions": [{ "id": uuidv4(), "spaceId": spaceId, "operations": operations }] })
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`写入失败 (HTTP ${res.status})${detail ? ': ' + detail.slice(0, 200) : ''}`);
    }
}

export async function createImageBlock(spaceId, parentId, imageUrl, userId) {
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

    const res = await notionFetch("saveTransactions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-notion-active-user-header": userId },
        body: JSON.stringify({ "requestId": uuidv4(), "transactions": [{ "id": uuidv4(), "spaceId": spaceId, "operations": operations }] })
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`图片导入失败 (HTTP ${res.status})${detail ? ': ' + detail.slice(0, 200) : ''}`);
    }
}
