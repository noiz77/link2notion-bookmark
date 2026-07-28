import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("session validation failures open a persistent recovery guide", async () => {
    const [mainFlow, errorUi, pageInfo, helpPage] = await Promise.all([
        fs.readFile("src/popup/main-flow.js", "utf8"),
        fs.readFile("src/popup/ui/notion-error.js", "utf8"),
        fs.readFile("src/popup/notion/page-info.js", "utf8"),
        fs.readFile("src/help/notion-session.html", "utf8")
    ]);

    assert.match(pageInfo, /NOTION_SESSION_VALIDATION_FAILED/);
    assert.match(mainFlow, /import \{ showErrorWithDiagnostics \} from '\.\/ui\/notion-error\.js'/);
    assert.doesNotMatch(mainFlow, /notion-session-card/);
    assert.match(errorUi, /Notion 登录信息可能已失效/);
    assert.match(errorUi, /help\/notion-session\.html/);
    assert.match(errorUi, /chrome\.tabs\.create/);
    assert.match(helpPage, /notion\.so/);
    assert.match(helpPage, /app\.notion\.com/);
    assert.match(helpPage, /网站数据/);
    assert.match(helpPage, /无需清除全部浏览记录/);
    assert.match(helpPage, /Cookie 和其他网站数据/);
});
