import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const APP_ORIGIN = "https://app.notion.com";
const WWW_ORIGIN = "https://www.notion.so";
const APP_USER_ID = "app-user";
const WWW_USER_ID = "www-user";

async function loadModules(moduleNames) {
    const context = vm.createContext({
        URL,
        Response,
        console,
        setTimeout,
        clearTimeout,
        document: { cookie: `notion_user_id=${APP_USER_ID}` },
        location: { origin: APP_ORIGIN }
    });

    let capturedRequest = null;
    let executeScriptCount = 0;
    context.fetch = async (url, options) => {
        capturedRequest = { url, options };
        return new Response(JSON.stringify({
            recordMap: {
                block: {
                    target: { value: { id: "target" } }
                }
            }
        }), {
            status: 200,
            headers: { "content-type": "application/json" }
        });
    };

    context.chrome = {
        cookies: {
            get: async ({ url }) => ({
                value: url === WWW_ORIGIN ? WWW_USER_ID : APP_USER_ID
            })
        },
        tabs: {
            query: async () => [{
                id: 17,
                active: true,
                status: "complete",
                url: `${APP_ORIGIN}/p/example`
            }],
            onUpdated: {
                addListener() {},
                removeListener() {}
            },
            get: async () => {
                throw new Error("unexpected tabs.get");
            },
            create: async () => {
                throw new Error("unexpected tabs.create");
            }
        },
        scripting: {
            executeScript: async ({ func, args = [] }) => {
                executeScriptCount += 1;
                return [{
                    result: await func(...args)
                }];
            }
        }
    };

    const modules = new Map();
    for (const name of moduleNames) {
        const source = await fs.readFile(`src/popup/${name}`, "utf8");
        modules.set(name, new vm.SourceTextModule(source, {
            context,
            identifier: name
        }));
    }

    const resolveSpecifier = (specifier, referencingModule) => {
        const baseParts = referencingModule.identifier.split("/");
        baseParts.pop();
        for (const part of specifier.split("/")) {
            if (!part || part === ".") continue;
            if (part === "..") baseParts.pop();
            else baseParts.push(part);
        }
        return baseParts.join("/");
    };

    for (const module of modules.values()) {
        await module.link((specifier, referencingModule) => {
            const resolved = resolveSpecifier(specifier, referencingModule);
            const dependency = modules.get(resolved);
            if (!dependency) throw new Error(`Missing test module: ${resolved}`);
            return dependency;
        });
    }
    for (const module of modules.values()) {
        if (module.status === "linked") await module.evaluate();
    }

    return {
        modules,
        getCapturedRequest: () => capturedRequest,
        getExecuteScriptCount: () => executeScriptCount
    };
}

test("getCurrentUserId follows the selected Notion tab instead of a stale cross-origin cookie", async () => {
    const { modules } = await loadModules([
        "notion/session.js",
        "utils/user.js"
    ]);

    const userId = await modules.get("utils/user.js").namespace.getCurrentUserId();
    assert.equal(userId, APP_USER_ID);
});

test("notionFetch aligns the active-user header in the same page-script round trip", async () => {
    const { modules, getCapturedRequest, getExecuteScriptCount } = await loadModules([
        "notion/session.js",
        "notion/api.js"
    ]);

    await modules.get("notion/api.js").namespace.notionFetch("loadPageChunk", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-notion-active-user-header": WWW_USER_ID
        },
        body: JSON.stringify({ pageId: "target" })
    });

    const request = getCapturedRequest();
    assert.equal(new URL(request.url).origin, APP_ORIGIN);
    assert.equal(
        request.options.headers["x-notion-active-user-header"],
        APP_USER_ID
    );
    assert.equal(getExecuteScriptCount(), 1);
});
