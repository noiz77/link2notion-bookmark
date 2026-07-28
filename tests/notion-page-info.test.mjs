import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function getPageInfoFor(targetValue, collections = {}, nestedRecordValue = false) {
    const pageId = targetValue.id;
    const context = vm.createContext({
        console,
        Response
    });
    const source = await fs.readFile("src/popup/notion/page-info.js", "utf8");
    const pageInfoModule = new vm.SourceTextModule(source, {
        context,
        identifier: "notion/page-info.js"
    });
    const apiModule = new vm.SyntheticModule(["notionFetch"], function () {
        this.setExport("notionFetch", async (path) => {
            assert.equal(path, "loadPageChunk");
            return new Response(JSON.stringify({
                recordMap: {
                    block: {
                        [pageId]: nestedRecordValue
                            ? { value: { value: targetValue, role: "editor" } }
                            : { value: targetValue }
                    },
                    collection: collections
                }
            }), {
                status: 200,
                headers: { "content-type": "application/json" }
            });
        });
    }, {
        context,
        identifier: "notion/api.js"
    });

    await pageInfoModule.link((specifier) => {
        assert.equal(specifier, "./api.js");
        return apiModule;
    });
    await pageInfoModule.evaluate();

    return pageInfoModule.namespace.getPageInfo(pageId, "active-user");
}

test("a database row remains a database item but can accept child bookmark blocks", async () => {
    const result = await getPageInfoFor({
        id: "database-row",
        type: "page",
        parent_table: "collection",
        parent_id: "database",
        space_id: "space"
    }, {
        database: {
            value: {
                schema: {}
            }
        }
    });

    assert.equal(result.isDatabase, true);
    assert.equal(result.collectionId, "database");
    assert.equal(result.canAcceptChildBlocks, true);
});

test("a database view is still rejected as a child-block target", async () => {
    const result = await getPageInfoFor({
        id: "database-view",
        type: "collection_view_page",
        collection_id: "database",
        parent_table: "block",
        space_id: "space"
    }, {
        database: {
            value: {
                schema: {}
            }
        }
    });

    assert.equal(result.isDatabase, true);
    assert.equal(result.canAcceptChildBlocks, false);
});

test("a database row accepts child blocks when Notion wraps block values twice", async () => {
    const result = await getPageInfoFor({
        id: "628a324e-4556-47fa-8b09-8c99affaf7a8",
        type: "page",
        parent_table: "collection",
        parent_id: "database",
        space_id: "space"
    }, {
        database: {
            value: {
                schema: {}
            }
        }
    }, true);

    assert.equal(result.isDatabase, true);
    assert.equal(result.collectionId, "database");
    assert.equal(result.canAcceptChildBlocks, true);
});

test("bookmark flow checks child-block capability instead of database identity", async () => {
    const mainFlow = await fs.readFile("src/popup/main-flow.js", "utf8");

    assert.match(
        mainFlow,
        /const \{ spaceId, canAcceptChildBlocks \} = await getPageInfo\(pageId, userId\)/
    );
    assert.match(mainFlow, /if \(!canAcceptChildBlocks\)/);
});
