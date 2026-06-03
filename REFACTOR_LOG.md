# 模块化重构日志

本文档记录将 `src/popup/popup.js`（原 2088 行单文件）拆分为模块化结构的全过程。

## 目的

- 每一步改动有完整记录
- 出 bug 时可逆推到具体阶段和具体函数
- 每个阶段的风险、验证点、回滚方式都写明

## 原始状态

- **起点 commit**：`0bc48de chore: 发布 v5.2.0 并同步 README`
- **popup.js 行数**：2088
- **结构**：单文件，顶层 37 个函数 + 2 个顶层事件监听器（`DOMContentLoaded` + `btnImport click`）
- **模块机制**：普通 `<script>`（无 ESM）

## 最终目录结构

```
src/popup/
├── popup.html               # 改为 <script type="module">
├── popup.css                # 不动
├── popup.js                 # 入口：仅 import 其他模块
├── main-flow.js             # btnImport click handler + _pendingDismiss
├── utils/
│   ├── ids.js               # extractUUID, formatUUID, uuidv4
│   ├── url.js               # filterCover, cleanTitle, getNotionUrl
│   └── user.js              # getCurrentUserId
├── extractors/
│   ├── remote.js            # fetchRemoteMetadata
│   ├── current-tab.js       # extractCurrentTabMetadata
│   ├── article.js           # extractArticle, extractArticleFromSelection
│   └── tweet.js             # extractXThread
├── parsers/
│   ├── html-blocks.js       # htmlToNotionBlocks
│   ├── rich-text.js         # stripRichTextPrefix, splitRichTextByLines
│   └── markdown.js          # parseLineToNotionBlock, parseTextBlockToNotionBlocks
├── notion/
│   ├── schema.js            # findSchemaKey
│   ├── page-info.js         # getPageInfo, loadCollectionSchema
│   ├── bookmark.js          # createFullBookmark, createImageBlock
│   ├── tweet-writer.js      # writeTweetBlockToNotion + 2 个推文创建函数
│   └── article-writer.js    # 2 个文章创建函数
└── ui/
    ├── progress.js          # showProgress/updateProgressText/hideProgress/completeProgress
    ├── tags.js              # 5 个标签函数
    └── init.js              # DOMContentLoaded handler（含闭包局部函数）
```

## 已识别的高风险点

| 编号 | 风险 | 位置 | 处理 |
|---|---|---|---|
| R1 | 顶层 DOM 访问 `document.getElementById(...)` | popup.js L1105-1110 | ESM defer 时 DOM 已就绪，但阶段 5 把它们挪到函数内部，更稳 |
| R2 | 顶层事件绑定 `btnImport.addEventListener` | popup.js L1174 | 放入 main-flow.js 顶层，同样靠 ESM defer 保证 DOM 就绪 |
| R3 | 模块内可变状态 `_pendingDismiss` | popup.js L1111 | 只在 btnImport handler 使用，放入 main-flow.js 作为模块内 `let` |
| R4 | 函数 hoisting 跨调用 | DOMContentLoaded 内调用后定义的 tag 函数 | 改为 ESM import，等效且显式 |
| R5 | 死代码 `getSpaceIdViaLoadChunk` | popup.js L1545 | 阶段 4 单独删除 |
| R6 | DOMContentLoaded 内局部函数有大量闭包依赖 | L790-916 | **不抽出来**，整块保留在 init.js 内 |
| R7 | chrome.scripting.executeScript 的 func 是序列化执行 | 4 个 extractor | func 整块保留，内部函数不动 |
| R8 | 同名变量 `isBatchMode` 多处声明 | L1180/1405/1423 | 不同作用域，拆分时不合并 |

## 阶段清单

- [x] 阶段 1：ESM 切换
- [x] 阶段 2：抽纯函数（popup.js 2088 → 1808）
- [x] 阶段 3：抽 extractors（1808 → 1264）
- [x] 阶段 4：抽 notion/ 写入层（1264 → 700，删除死代码 `getSpaceIdViaLoadChunk`）
- [x] 阶段 5：抽 UI 子模块（700 → 564）
- [x] 阶段 6：抽 init + main-flow（564 → 5）
- [x] 静态一致性检查通过
- [ ] 用户端冒烟测试（待你验证）

## 最终产物

| 文件 | 行数 | 职责 |
|---|---|---|
| popup.js | 5 | 入口，仅两个 import |
| main-flow.js | 302 | btnImport click handler + `_btnImport`/`_importForm`/`_status`/`_pendingDismiss` |
| ui/init.js | 267 | DOMContentLoaded handler（含 4 个闭包局部函数） |
| ui/progress.js | 63 | 4 个进度函数，DOM 引用懒加载 |
| ui/tags.js | 81 | 5 个标签函数 |
| extractors/remote.js | 42 | fetchRemoteMetadata |
| extractors/current-tab.js | 73 | extractCurrentTabMetadata |
| extractors/article.js | 98 | Readability + 框选 |
| extractors/tweet.js | 338 | extractXThread（含注入页面脚本） |
| parsers/html-blocks.js | 165 | htmlToNotionBlocks |
| parsers/markdown.js | 29 | Markdown → Notion 块 |
| parsers/rich-text.js | 29 | richText 数组操作 |
| notion/schema.js | 12 | findSchemaKey |
| notion/page-info.js | 89 | getPageInfo + loadCollectionSchema |
| notion/bookmark.js | 81 | createFullBookmark + createImageBlock |
| notion/tweet-writer.js | 203 | writeTweetBlockToNotion + 2 创建函数 |
| notion/article-writer.js | 187 | 2 文章创建函数 |
| utils/ids.js | 21 | 3 个 UUID 函数 |
| utils/url.js | 26 | filterCover + cleanTitle + getNotionUrl |
| utils/user.js | 9 | getCurrentUserId |

**总计**：20 个文件，2120 行（vs 原 2088 行，增加 32 行主要是 import 语句 + 说明注释）。

## 后续维护新增模块

初次模块化完成后，按功能演进继续新增以下模块；截至 v5.2.5，`src/popup` 共 24 个 JavaScript 模块：

- `utils/fetch.js` — 外部抓取统一超时处理
- `extractors/tweet-syndication.js` — 推文 syndication 元数据抓取
- `notion/tags.js` — Database 标签写入辅助
- `notion/api.js` — Notion 内部 API 同站点请求代理

## 静态检查结果

- ✅ 25 个 import 全部对应存在的 export
- ✅ 无残留的 `_importProgress` / `_progressBar` / `_progressText` / `getSpaceIdViaLoadChunk`
- ✅ `_btnImport` / `_importForm` / `_status` / `_pendingDismiss` 均为 `main-flow.js` 模块内 `const/let`，不会外泄到全局作用域（ESM 隔离 + 文件内独占引用）
- ✅ `popup.html` 仍是 `<script type="module" src="popup.js">`
- ✅ 无重复的 export 名称（每个函数仅在一处定义）

---

## 阶段 1：ESM 切换 ✅

**时间**：2026-04-20

**改动**：
- `src/popup/popup.html`：`<script src="popup.js">` → `<script type="module" src="popup.js">`

**理由**：
- 后续所有拆分都依赖 ESM `import/export`
- `type="module"` 自带 defer，脚本在 DOM 解析完后执行（DOMContentLoaded 前），原有顶层 DOM 访问仍安全
- 模块作用域隔离：`function foo` 不再挂 `window`，但本项目没有通过 `window.foo` 调用自身函数（已 grep 验证）

**风险**：
- ESM 模块作用域不同于 script，如果代码中有 `function foo(){}` 被外部 inline script 调用会失效。✅ 已验证无此情况。

**回滚**：
```bash
git diff src/popup/popup.html
# 把 type="module" 删掉即可
```

---

## 阶段 2：抽纯函数

**时间**：待填

**新增文件**：
- `src/popup/utils/ids.js` — `extractUUID`, `formatUUID`, `uuidv4`（3 个纯函数）
- `src/popup/utils/url.js` — `filterCover`, `cleanTitle`, `getNotionUrl`（3 个纯函数）
- `src/popup/utils/user.js` — `getCurrentUserId`（依赖 `chrome.cookies`）
- `src/popup/parsers/rich-text.js` — `stripRichTextPrefix`, `splitRichTextByLines`
- `src/popup/parsers/markdown.js` — `parseLineToNotionBlock`, `parseTextBlockToNotionBlocks`（依赖 rich-text）
- `src/popup/parsers/html-blocks.js` — `htmlToNotionBlocks`
- `src/popup/notion/schema.js` — `findSchemaKey`

**popup.js 改动**：
- 头部加 import 语句
- 删除上述函数的原定义

**风险**：
- 纯函数无副作用，几乎零风险
- 唯一需要留意：`getCurrentUserId` 使用 `chrome.cookies`，要确保扩展权限已授予（原来就授予了，不变）

**回滚**：删除新建的 utils/ parsers/ notion/ 三个目录，恢复 popup.js 的函数定义。

---

## 阶段 3：抽 extractors

**时间**：待填

**新增文件**：
- `src/popup/extractors/remote.js` — `fetchRemoteMetadata`，依赖 utils/url
- `src/popup/extractors/current-tab.js` — `extractCurrentTabMetadata`，依赖 utils/url + remote
- `src/popup/extractors/article.js` — `extractArticle`, `extractArticleFromSelection`
- `src/popup/extractors/tweet.js` — `extractXThread`

**关键风险**：
- **R7 再确认**：`chrome.scripting.executeScript({ func: () => {...} })` 里的 `func` 会被序列化到目标页面执行，**不能访问 extractor 模块里的任何外部函数**。所以 func 内部的 `getPlainText`/`extractRichText`/`findTextContainer` 等辅助函数必须保留在 func 内部。

**回滚**：删除 extractors/ 目录，恢复 popup.js 的函数定义。

---

## 阶段 4：抽 notion/ 写入层

**时间**：待填

**新增文件**：
- `src/popup/notion/page-info.js` — `getPageInfo`, `loadCollectionSchema`
- `src/popup/notion/bookmark.js` — `createFullBookmark`, `createImageBlock`
- `src/popup/notion/tweet-writer.js` — `writeTweetBlockToNotion`, `createDatabasePageFromThread`, `createNotionPageFromThread`
- `src/popup/notion/article-writer.js` — `createDatabasePageFromArticle`, `createNotionPageFromArticle`

**顺带清理**：
- 删除 `getSpaceIdViaLoadChunk`（死代码，无调用者）

**依赖链**：
- bookmark → utils/ids
- tweet-writer → utils/ids, notion/schema, parsers/markdown
- article-writer → utils/ids, notion/schema

**回滚**：删除 notion/page-info.js 等文件，恢复 popup.js 的函数定义。

---

## 阶段 5：抽 UI 子模块

**时间**：待填

**新增文件**：
- `src/popup/ui/progress.js` — 进度条相关 4 个函数 + DOM 引用**改为函数内 getElementById**
- `src/popup/ui/tags.js` — 5 个标签函数

**关键改动**：
- 原 `const _importProgress = document.getElementById(...)` 顶层求值改为函数内懒加载（避免模块顶层依赖 DOM 就绪）

**回滚**：删除 ui/progress.js 和 ui/tags.js，恢复 popup.js。

---

## 阶段 6：抽 init + main-flow

**时间**：待填

**新增文件**：
- `src/popup/ui/init.js` — 完整的 `DOMContentLoaded` handler，含 4 个闭包局部函数
- `src/popup/main-flow.js` — 完整的 `btnImport` click handler + `_pendingDismiss`

**popup.js 最终形态**：仅保留 imports：
```js
import './ui/init.js';
import './main-flow.js';
```

**回滚**：删除这两个文件，恢复 popup.js 的完整事件绑定代码。

---

## 冒烟测试清单（全部完成后用户验证）

| # | 场景 | 期望 | 结果 |
|---|---|---|---|
| 1 | 书签模式 + 普通页面 + 封面开 | 封面 + bookmark 卡片 | ⬜ |
| 2 | 书签模式 + 封面关 | 仅 bookmark | ⬜ |
| 3 | 书签模式 + Database 页面 | 显示"与 Database 不兼容"警告 | ⬜ |
| 4 | 文章模式 + 普通页面（Readability 自动）| 段落/图片/作者 | ⬜ |
| 5 | 文章模式 + 框选文本 | "使用已框选内容" + 仅框选部分 | ⬜ |
| 6 | 推特模式 + 普通推文 + Database | Author/URL/Date/Tags 写入 schema | ⬜ |
| 7 | 推特模式 + X Article 长文 | 原生长文标题 | ⬜ |
| 8 | 批量模式 + 3 个链接其中一个失败 | 失败留输入框，成功移除 | ⬜ |

## 出 bug 时的排查路径

1. 打开 Chrome `chrome://extensions` → 点插件的"错误"按钮，或在 popup 上右键检查 → Console 看报错
2. 根据报错信息定位：
   - `Uncaught SyntaxError` / `Cannot find module` → 检查 import 路径（最可能是阶段 2 的相对路径写错）
   - `X is not defined` → 检查是否漏了 import 某个函数（阶段 2-6 都可能）
   - `Cannot read properties of null (reading 'addEventListener')` → DOM 未就绪（阶段 5/6，模块顶层求值时序问题）
   - 功能性 bug（按钮点了没反应、数据错误）→ 对照"冒烟测试清单"先定位哪个场景挂，再看对应阶段
3. 回滚顺序：阶段 6 → 5 → 4 → 3 → 2 → 1，每回一步再测
