# Changelog

All notable changes to the **Notion 导入助手 (Notion Import Assistant)** project will be documented in this file.

## [5.2.8] - 2026-07-28

### Fixed
- **Dia 中 Notion 跨域会话混用**：用户 ID 改为优先读取实际执行请求的 Notion 标签页会话；每次内部 API 请求发送前再次将 active user header 与该标签页对齐，避免 `www.notion.so` 的旧 Cookie 与 `app.notion.com` 当前账号混用后返回 HTTP 200 + 空 `recordMap`。
- **Notion 登录状态失败提示不可操作**：空页面数据错误改为简短恢复卡片，并提供「查看重新登录步骤」按钮。完整步骤在独立帮助标签页中展示，说明如何仅删除 `notion.so` / `app.notion.com` 网站数据，以及找不到设置时的备用清理方法，不会撑高扩展弹窗。

### Internal
- 新增跨域 Cookie 不一致的会话回归测试，以及恢复帮助页内容与入口检查。

## [5.2.7] - 2026-06-04

### Fixed
- **部分用户提示“无法获取当前页面”**：新增 `tabs` 权限，并统一当前标签页获取逻辑。文章、推特、书签和初始化预填会依次尝试当前窗口、最近聚焦窗口、所有活动标签页和普通窗口兜底，降低不同窗口焦点状态下拿不到当前页面的概率。
- **Notion 会话读取兼容**：Notion 用户 ID 读取不再只依赖 `chrome.cookies`，当 Cookie API 读不到 `notion_user_id` 时，会在已登录的 Notion 页面上下文中读取 `document.cookie`，并进一步调用 Notion 页面内的 `getSpaces` 推断当前用户；Notion API 请求内部也会在缺少 active user header 时自动补齐，减少返回空 `recordMap` 的概率。
- **Notion 权限/API 问题诊断**：遇到页面读取、权限、登录态或 Notion 内部 API 异常时，错误区会提供「复制诊断信息」按钮。诊断报告不包含 cookie/token，只记录浏览器环境、Notion 标签页状态、用户 ID 是否可推断、`getSpaces` 与 `loadPageChunk` 的 HTTP 状态和 `recordMap` 计数，便于快速定位问题。

## [5.2.6] - 2026-06-04

### Fixed
- **微信公众号文章正文抓取增强**：文章模式在 `mp.weixin.qq.com` 页面优先读取 `#js_content`，并从微信页面字段提取标题、公众号名和发布日期，避免通用 Readability 漏抓或误抓。
- **微信文章图片与视频占位**：支持 `data-src` / `data-original` / `data-backsrc` 懒加载图片；遇到不支持的视频、iframe、embed 或 object 时，用 `[ ▶️ 此处视频无法获取 ]` 文本块占位，保留微信页面自带的时长说明。
- **微信文章特殊样式导致折行**：对 `section` / `span` / `font` 等微信排版容器增加内联段落合并逻辑，避免特殊符号、装饰节点和正文被拆成多个 Notion 段落。
- **引用上标噪音清理**：跳过短数字型 `sup` / citation / footnote 引用标注，避免右上角研究引用被导入为孤立的 `123` 文本。

### Changed
- **文章解析更保守地保留结构**：图文混排段落会拆成正文与图片块；多段样式容器不会被粗暴合并成一个大段，降低微信复杂排版的回归风险。

## [5.2.5] - 2026-06-03

### Fixed
- **Notion 页面信息读取失败**：Chrome 阻止第三方 Cookie 时，扩展 Popup 直接请求 Notion 内部 API 会得到 `HTTP 200` 但空的 `recordMap.block`，误报为页面 ID 无效。新增统一 `notionFetch`，在已登录的 Notion 标签页中执行同站点请求，覆盖页面读取、Database schema 读取及全部写入操作。
- **Notion 新域名兼容**：同时识别 `www.notion.so` 与 `app.notion.com` 的登录 Cookie 和标签页，并优先选择与当前用户 ID 匹配的域名，避免迁移期或多账号场景误用其他会话。
- **页面读取错误诊断不足**：`loadPageChunk` 现在会显示 HTTP 状态、无效响应或页面链接、权限、登录状态提示，便于区分 ID 格式与会话问题。
- **导入成功态底部被截断**：进度区域从开始导入时预留成功结果、Notion 跳转按钮和倒计时所需高度，避免文章和推特导入成功后动态增高导致底部显示不完整。

---

## [5.2.4] - 2026-05-13

### Fixed
- **推特导入样式 URL 识别误判**：推特模式入口与导入前校验改为基于 `hostname` 精确识别 `x.com` / `twitter.com` 及其子域名，避免 `x.com.evil.com`、查询参数包含 `x.com` 等非推特网址误启用「推特」按钮。

---

## [5.2.3] - 2026-04-27

### Changed
- **「批量书签」radio 合并为「书签 + 批量 toggle」**：从 4 个 radio 简化为 3 个（书签/文章/推特）；书签模式下右上区新增「批量」开关，与「封面」开关并排显示。批量状态独立持久化（`batch_enabled`），开关切换不再造成右上区宽度抖动。**老用户无感迁移**：旧 `import_style: 'batch'` 自动转为 `bookmark + batch_enabled: true`，pending_urls 草稿不丢。
- **批量场景下封面图开关也可用**：原版本批量模式下封面 toggle 强制隐藏，本版按"每条 URL 抓到 og:image 就加封面图块、抓不到就跳过"处理（`importCoverEnabled` 不再依赖 `!isBatchMode`）。
- **主题色改为护眼蓝绿**：所有衍生绿色从 `#87BD09` 系（黄绿）整体迁移到 `#50A550` 系（蓝绿）；按钮 hover 由 `#76A903` → `#468C46`，浅背景 `#fdfef9` → `#f4faf4`，进度条扫光亮绿 `#a8d62a` → `#7ac57a`。
- **备注 / 标签 label 增加帮助 icon**：14×14 圆形 `?`，hover 显示 tooltip（CSS-only、可换行、最大 260px）。把"（选填）"等说明从永久可见的小字收纳进 tooltip，label 更干净。文章 / 推特模式 tooltip 文案如实反映写入规则（Database multi-select 自动新增缺失选项、普通页面前置在文章 / 推文顶部信息栏）。
- **网页链接 textarea 改为固定 90px + 内部滚动**：禁用拖拽（`resize: none`），批量粘贴大量 URL 不再撑开布局，备注 / 导入按钮位置稳定。
- **删除「*支持填充多个链接」批量提示文字**：批量模式下 textarea 高度增加 + 工具栏出现已是足够明显的视觉信号。

### Fixed
- **导入成功后备注未自动清空**：`completeProgress` 的 3 秒倒计时 +「在 Notion 中查看」按钮跳转会关闭 popup，导致 `await completeProgress(...)` 之后的 `caption.value = ""` / `chrome.storage.local.remove('pending_caption')` 永远跑不到，下次打开 popup 仍恢复旧备注。三处导入分支（文章 / 推特 / 书签批量）的清理时机都提前到 `await completeProgress` 之前。
- **Notion API 错误响应体未读取**：`bookmark.js` 的 `createFullBookmark` / `createImageBlock` 仅判 `res.ok` 不读响应体，出错时用户只看到干瘪的"写入失败"。统一为 `(HTTP {status}): {body 200 字符}` 格式，覆盖 `bookmark.js` / `article-writer.js` / `tweet-writer.js` 6 处 saveTransactions 调用。
- **`ui/tags.js` 用 `innerHTML = ''` 清空容器**：改为 `replaceChildren()`，避免 innerHTML 模式（即使当前赋值为空字符串相对安全，也属最佳实践改进）。
- **`ui/init.js` `chrome.storage.local.get` 仍用回调**：改为 `await chrome.storage.local.get(...)`，规避潜在异步竞态。

### Internal
- **抽 `utils/fetch.js` 公共 `fetchWithTimeout`**：原 `extractors/remote.js` 与 `extractors/tweet-syndication.js` 各自实现的 `AbortController` + 8s 超时合并为单一工具，整个项目仅留 1 处 `AbortController` 实例。
- **抽 `notion/tags.js` 公共 `buildTagsForDatabase`**：article-writer 与 tweet-writer 中近 30 行重复的「解析输入标签 → 比对 schema.options → 推送 schema 更新 op」逻辑合并到单函数。
- **抽 `main-flow.js` 内部 `persistRemainingIfBatch` helper**：批量循环中两处 `pending_urls` 回写代码段合并；判断条件改为「书签 + 批量 toggle 开」（与 REFACTOR_LOG R8 一致：实时读 DOM 而非顶部锁定值）。
- **`manifest.json` 增加 MV3 内容安全策略**：`"content_security_policy": { "extension_pages": "script-src 'self'; object-src 'self'" }`，为 popup / DOMParser 增加一层防御。
- **`src/lib/Readability.js` 头部加来源说明**：标注 Mozilla 上游链接与升级方式（整体替换 release 版），便于后续维护。
- **预览图（`screenshots/preview.png`）更新**：反映新版 UI（书签 + 批量/封面 toggle 并排、护眼蓝绿主题、? 帮助 icon）。

---

## [5.2.2] - 2026-04-24

### Internal
- **`popup.js` 全量 ESM 模块化重构**：将原 2100+ 行 monolithic `popup.js` 拆分为 20 个 ESM 模块（包含 v5.2.1 引入的 syndication 模块），按职责分组到 `extractors/` `notion/` `parsers/` `ui/` `utils/` 五个目录；入口 `popup.js` 仅保留两行 `import`。重构遵循"行为零变更、模块边界清晰"原则，详见 `REFACTOR_LOG.md`。
- **syndication 抽为独立模块**：v5.2.1 的推文 syndication 抓取逻辑（`TWEET_STATUS_RE` / `_tweetMetaCache` / `fetchTweetMeta`）抽离到 `extractors/tweet-syndication.js`，与 `extractors/remote.js`、`extractors/current-tab.js` 解耦；功能与 v5.2.1 等价，仅结构变化。

---

## [5.2.1] - 2026-04-24

### Added
- **推文 Bookmark 真实封面与完整数据**：书签 / 批量模式下导入 `x.com/*/status/*` 推文链接时，改走官方 syndication API（`cdn.syndication.twimg.com/tweet-result`）抓取，拿到真实推文媒体图（photo 首图 / video poster）作为 bookmark 封面，并同时取出"作者 on X: 正文摘要"标题和完整推文正文作为描述。此前 og:image 对所有推文都是同一张通用默认图（被黑名单过滤为无封面）、批量模式 `fetch(x.com)` 还会撞登录墙导致标题仅剩 "X"，现已根除。

### Changed
- **"在 Notion 中查看"按钮样式**：由实心绿色主按钮改为浅绿描边风格，与"导入样式"单选按钮选中态视觉一致，降低完成弹层的视觉重量。
- **Popup 底部间距收紧**：`body` 下内边距与 `#status` 外边距调整，空态下底部空白由 43px 减至 34px，避免视觉松散。

### Internal
- 会话级推文元数据缓存（`_tweetMetaCache`）：UI 预检与正式导入共用缓存，同一推文在 popup 存活期间只调用一次 syndication。
- 整理封面过滤逻辑中的重复实现，`extractCurrentTabMetadata` 内联黑名单统一回 `filterCover`；推文 URL 走 syndication 短路不再经过 `filterCover`，非推文 X URL（主页 / profile）仍由 `filterCover` 屏蔽 X 通用默认图。

---

## [5.1.0] - 2026-03-21

### Added
- **导入成功跳转按钮**：保存完成后显示「在 Notion 中查看」全宽按钮，点击直接跳转到 Notion 中新创建的页面，3 秒倒计时后自动关闭。
- **推文代码块导入**：支持提取 Twitter/X 推文中的 Markdown 代码块（`<pre><code>`），以 Notion Code Block 形式写入，保留语言标识。
- **标签智能建议**：文章/推文模式下，从当前网页标题自动提取关键词（英文术语、短标题段），以可点击芯片形式展示，点击即填入标签输入框，支持切换选中。

### Fixed
- 修复推文中 `data-testid="markdown-code-block"` 代码块和内嵌文字被跳过未导入的问题。

---

## [5.0.0] - 2026-03-13

### Changed
- **UI/UX 彻底重构**：将原有的零散复选框（批量开关、推文提取）重构为具有状态记忆的三阶“导入样式”单选控制栏 (`书签 / 推特长文 / 批量链接`)。
- **项目更名**：应用名称正式从“Notion 终极书签助手”化简定名为“Notion 导入助手”。
- **高级物理动画系统**：针对交互元素实现了具有拟物惯性的多层柔性缓动 (`cubic-bezier(0.25, 1, 0.5, 1)`) 反馈动效。当用户点击、悬停、进入时均提供高级界面反馈（按钮回弹、下潜隐藏）。
- **页面排版优化管理**：
  - 推文提取模式不仅可插入具备 `multi-select` 容错和颜色推算技术的 `Database` 表格。
  - 在把目标定为无表头的 `非数据库普通页面 (Page)` 的情场下，插件会智能地将源网页的 `Author`, `Date`, `Tags`, `URL` 以加粗及带 Emoji 点缀的新文本区块前置渲染在文章顶部，并插入自然的视觉分割线。

### Added
- **推特智能 URL 校验防护**：进入该助手时，会深度扫描和探测底层环境是否归属 `x.com` / `twitter.com` 网站组。如果不符，推特卡片将被以低可见性的灰色彻底防误触拉闸锁定，并优雅降低会话继承容错处理（默认回退到安全模式书签选项）。
- **推特长文实时读取**：现在选择推特模式时，原有的 URL 输入框重新暴露且被转为 `Read-only` 只读模式以防止意外损坏原始数据的来源一致性，在满足视觉锚定感的同时大幅缩短了默认的文本框高度至 64px 以求美观紧凑。
- **自定义属性补全与就地生成技术 (Tag Resolution)**：
  - 在检测推文输入标签（Tags）时，能够深入 Notion 远程服务端拉取并读取出当前的 `schema`.
  - 检测不存在该列字段时将就地在表格中新建多选属性定义列。
  - 遇到库内缺失的新自定义 Tag 词条时会自动构建一个带安全 UUID 的全随机颜色新选项并合并覆盖刷新表格架构，杜绝无法插入 Notion 隐藏词条及视觉掉色的旧日顽疾。

### Fixed
- 处理了批量链接操作工具组由于采用 `flex-end` 排列造成的页面右倾重心不稳问题，现已使用 `space-between` 对向定海神针式定位规整布局空间。
- 修复了因为使用全局覆盖手段移除 DOM 占位造成的 Toggle 按钮组件（封面图抓取开关）消失问题，退回了更原生有效的排布管理策略。

---

## [4.2.0] 及之前版本

### Added
- 核心功能：使用 v3 私有内部 API 抓取网络内容转化为原生 Bookmark 块。
- 功能扩展：封面智能提取和批量处理写入队列。
- 功能扩展：支持独立分析 Twitter 递归发文，以 Block 为单位连缀导出。
