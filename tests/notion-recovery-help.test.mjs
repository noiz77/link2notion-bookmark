import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("session validation failures open a persistent recovery guide", async () => {
    const [mainFlow, pageInfo, helpPage] = await Promise.all([
        fs.readFile("src/popup/main-flow.js", "utf8"),
        fs.readFile("src/popup/notion/page-info.js", "utf8"),
        fs.readFile("src/help/notion-session.html", "utf8")
    ]);

    assert.match(pageInfo, /NOTION_SESSION_VALIDATION_FAILED/);
    assert.match(mainFlow, /Notion 登录信息可能已失效/);
    assert.match(mainFlow, /help\/notion-session\.html/);
    assert.match(helpPage, /notion\.so/);
    assert.match(helpPage, /app\.notion\.com/);
    assert.match(helpPage, /网站数据/);
    assert.match(helpPage, /无需清除全部浏览记录/);
    assert.match(helpPage, /Cookie 和其他网站数据/);
});
