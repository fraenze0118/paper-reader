# AI 文献工作台 · Brainstorm v1

> 目标：自制 Zotero 类工具，接入 DeepSeek，覆盖 文献管理 / 阅读 / 引用 / AI 伴读。
> 记录时间：2026-10-14

## 0. 环境侦察（结论先行）

| 项 | 状态 | 影响 |
| --- | --- | --- |
| `D:\study\frontend\paper-reader` | 空目录 | 全新项目，无历史包袱 |
| Node.js | v22.19.0 | Electron / Vite / pdf.js 全可用 |
| Python | 3.13.5 + `uv` | 可跑 MinerU / GROBID / Docling 侧车进程 |
| Rust | ❌ 未安装 | 选 Tauri 需先装 rustup；Electron 零门槛 |
| Zotero | ❌ 未安装 | 若走插件路线需先装 Zotero 7/8 |
| PowerShell | ⚠️ 禁止运行 `npm.ps1` / `pnpm.ps1` | 必须用 `npm.cmd` 或 `cmd /c npm ...` |

## 1. 三条路线（先定这个，再谈技术栈）

| | A. Zotero 插件 | B. 独立桌面 App | C. 本地 Web 服务 |
| --- | --- | --- | --- |
| 形态 | Zotero 7/8 XPI | Electron/Tauri 壳 + 本地 SQLite | `localhost:xxxx` + 浏览器 UI |
| 增量成本 | **最低**（Zotero 管元数据/同步/引用） | 最高（全都要自己写） | 中 |
| 可控性 | 低（受 Zotero 内核限制） | 完全 | 高 |
| 时间到「能用」 | 1~2 周 | 2~3 个月 | 3~4 周 |
| 官方扩展点 | `ItemPaneManager.registerSection()`、`ItemTreeManager.registerColumn()`、`PreferencePanes.register()` | — | — |
| 适合 | 验证 AI 伴读交互 | 想做产品 / 深度改数据结构 | 自用 + 跨设备 |

**建议：C 先做自用版，B 作为目标形态；A 只花 2~3 天做个原型验证交互。**
理由：Zotero 最大的护城河是**几百个站点抓取器（translators）**和 Word 插件，自研这两块是纯亏本买卖；而 AI 伴读需要「同时读写标注 + 笔记 + 对话历史 + 引用」的完整权限，插件形态做起来会很憋屈。先用插件验证「用户到底怎么和 AI 一起读论文」，再决定值不值得重造。

## 2. DeepSeek 能力的三个「反常识」事实

这三个事实直接决定架构，务必先吃透（数据来自官方文档）：

**① 1M 上下文 + 自动前缀缓存 ⇒ RAG 可以不是必需品**

| 模型 | 上下文 | 输入(缓存命中) | 输入(未命中) | 输出 | 视觉 |
| --- | --- | --- | --- | --- | --- |
| `deepseek-flash` | 1M | ¥0.02~0.04/M | ¥1~2/M | ¥4~8/M | ✅ |
| `deepseek-v4-pro` | 1M | ¥0.15~0.30/M | ¥4.5~9/M | ¥13.5~27/M | ❌ |

（空闲时段为高峰半价；高峰＝北京时间周一至周五 9:00-12:00、14:00-18:00，不含法定节假日）

一篇 20 页论文 ≈ 1.5 万 token。用 flash 裸塞全文、未命中缓存也就 **1.5 分钱**；命中缓存 ≈ **0.0003 元**。所以：
- 不要一上来建向量库。**全文直塞 + 缓存**又准又便宜。
- 把 PDF 全文放在 prompt **最前面且保持字节稳定**（前缀缓存按前缀匹配），把「问题」放最后。这样同一篇论文问 50 个问题，后 49 次几乎免费。
- 向量检索只在**跨库检索**（"我读过的所有论文里谁提过 X"）时才需要。而 DeepSeek **没有 embeddings 端点**（官方指南只有 vision / json_mode / tool_calls / responses / anthropic / prefix / fim / thinking，无 embedding），所以向量要走本地模型（bge-m3 ONNX）或第三方。

**② 视觉能力只有 flash 有** ⇒ 扫描版 PDF、图表、公式截图全部交给 flash；`v4-pro` 拿不到图，必须先用 flash 转写成文本再喂给它做深度推理。这天然形成一条流水线：**flash 看 → pro 想**。

**③ 高价值批量任务排到空闲时段跑** ⇒ 全文摘要、元数据补全、术语表生成、增量 arXiv 推荐这些「不着急」的任务做成队列，夜里跑，成本直接砍半。

其余可用特性：思考模式（默认开，可切非思考）、JSON Output、Tool Calls、Anthropic 格式兼容（`https://api.deepseek.com/anthropic`，意味着能直接复用 Claude 生态的 agent 框架）、FIM、对话前缀续写、并发 flash 2500 / pro 500、`user_id` 做 KVCache 与调度隔离。

## 3. 功能蓝图（五大块）

```
文献管理 ── 阅读 ── AI 伴读 ── 引用写作 ── 同步/沉淀
   │          │        │          │          │
 元数据      PDF渲染  对话/标注    CSL/导出   多设备
 去重/标签   标注     摘要/问答    引文插入   备份
 附件        OCR     跨文献综述   综述起草   分享
```

**元数据来源**（都免费）：DOI → CrossRef；`arXiv id` → arXiv API；补充 → OpenAlex / Semantic Scholar / PubMed(Europe PMC)；开放获取 PDF → Unpaywall。**不要重写站点抓取器**，DOI/arXiv 覆盖学术论文的 90%。

## 4. AI 伴读能力清单（真正的差异化）

按「爽感 ÷ 工作量」排序：

| # | 能力 | 说明 | 难度 |
| --- | --- | --- | --- |
| 1 | **划词即问** | 选中一句 → 悬浮解释/翻译/公式推导/背景补充，非思考模式秒回 | 低 |
| 2 | **结构化精读卡** | 一段话给出：问题/方法/贡献/局限/可复用点 | 低 |
| 3 | **图文解读** | 截图图表/公式 → flash 视觉解读 | 低 |
| 4 | **章节导读对话** | 按 section 逐段「讲给你听」，随时打断追问 | 中 |
| 5 | **带锚点的问答** | 每个答案附 `[论文, 页码, 原文引用]`，点击跳回 PDF 位置 | 中 |
| 6 | **自动卡片笔记** | 标注 → 自动生成 Anki 式问答卡 + 双向链接 | 中 |
| 7 | **跨文献对比矩阵** | "这 5 篇对 X 的处理差异" → 表格 + 每格溯源 | 中 |
| 8 | **Related Work 起草** | 生成综述段落，**只允许引用库内文献的 item key** | 中 |
| 9 | **苏格拉底检验** | 读完出 5 道题考你，答错回到原文段落 | 中 |
| 10 | **阅读画像 + 每日推荐** | 基于已读/标注生成兴趣向量，夜间拉 arXiv 增量 | 高 |
| 11 | **术语表自动累积** | 全书/全库术语归一化，长期沉淀 | 中 |
| 12 | **Agent 模式** | tool_calls 让它自己搜库、翻页、加标注、写笔记 | 高 |

### 反幻觉的硬约束（必须一开始就设计进去）
- 每个 AI 断言必须携带 `{item_id, page, quote}`，UI 可点击跳转。
- 引用数据**只从本地 CSL 记录取**，模型不得自造作者/年份。
- prompt 里显式给出「可引用清单」（当前库的 item key 列表），模型只能引用清单内 key，越界即判失败重试。
- 总结类输出要求模型先摘原文短句再下结论（quote-grounded）。

## 5. 数据模型草案（SQLite）

```sql
items(id, item_key, type, title, abstract, year, doi, arxiv_id, venue, csl_json, date_added)
creators(id, family, given, orcid)
item_creators(item_id, creator_id, role, order)
collections(id, parent_id, name)          -- 文件夹/智能集合
item_collections(item_id, collection_id)
tags(id, name, color, parent_id); item_tags(item_id, tag_id)
attachments(id, item_id, path, mime, sha256, page_count)
annotations(id, attachment_id, item_id, page, bbox, type, color, text, comment, created)
notes(id, item_id, parent_note_id, md, source_annotation_ids, created)
chunks(id, attachment_id, page, text, fts)        -- FTS5 全文索引
embeddings(chunk_id, vec BLOB)                    -- 可选，sqlite-vec
chat_sessions(id, item_id, collection_id, model, created)
messages(id, session_id, role, content, citations_json, tokens_in, tokens_out, cost)
citations(id, item_key, style, rendered, used_in) -- 写作侧引文实例
```

关键点：`items.csl_json` 直接存 CSL-JSON（Zotero 同款格式），**等于免费拿到一个完整的导入/导出互操作层**——Zotero、EndNote、Mendeley 都能进出。

## 6. 技术栈建议

| 层 | 选择 | 理由 |
| --- | --- | --- |
| 壳 | **Electron**（Rust 未装）；愿意装 rustup 则 Tauri 2 更轻 | 前端技能直接复用 |
| UI | React + Vite + Tailwind | 你已有前端栈 |
| PDF | **pdf.js**（渲染 + 文本层 + 标注图层） | 唯一成熟且能自绘标注的 Web 方案 |
| 版面/公式 | **MinerU** 或 **Docling**（uv 装），复杂引用结构用 **GROBID** | Python 侧车，`uv` 已就绪 |
| 元数据 | CrossRef / OpenAlex / S2 / arXiv HTTP API | 无需 API key |
| 引用 | **citeproc-js + CSL 样式库** | Zotero 同款引擎，1 万+ 期刊样式白嫖 |
| 存储 | SQLite（better-sqlite3）+ FTS5 | 单文件、可备份、全文检索 |
| AI | DeepSeek OpenAI 兼容 SDK + 本地 bge-m3（可选向量） | — |
| 同步 | 先 `git`/WebDAV 同步 SQLite + 附件；后端以后再说 | 别一开始做云 |

## 7. 引用与写作集成（最难，分层降级）

1. **L1（易）**：复制引用串 / 复制参考文献列表 / 导出 `.bib`、`.ris`、CSL-JSON。
2. **L2（中）**：生成 `.docx`，直接用域代码写入引文（Node/python-docx 都能做），用户刷新即可。
3. **L3（难）**：真正的 Word/LibreOffice 插件（Office.js），要处理引文字段、样式切换、编号更新——这是 Zotero 花了十年的事。
4. **L4（巧）**：与 Obsidian / VS Code / Typst / Quarto 做 bridge，学术写作圈这波人更吃这套。

**建议 v1 只做 L1 + L2。**

## 8. MVP 定义（v0.1，约 2~3 周）

> 一句话：**把我电脑里的 PDF 文件夹变成一个能和 AI 一起读的图书馆。**

必须有的 5 件事：
1. 拖入 PDF → 自动抽元数据（DOI/标题 → CrossRef）→ 入库
2. 列表 + 搜索（FTS5）+ 简单标签/文件夹
3. PDF 阅读器：翻页、高亮、批注、（可选）CJK 支持
4. 侧边 AI 面板：**全文直塞 + 前缀缓存**的问答，答案带页码锚点可跳转
5. 标注 → 一键生成 AI 笔记，落到 item 的 notes

明确**不做**：账号系统、云同步、Word 插件、翻译器、多人协作、移动端。

## 9. 里程碑

| 阶段 | 内容 | 产出 |
| --- | --- | --- |
| M0（2~3 天） | Zotero 插件原型：选中文字→DeepSeek 解释 | 验证交互吸引力 |
| M1（1~2 周） | Electron 壳 + SQLite + PDF 阅读器 + AI 面板 | 自用可用 |
| M2（1~2 周） | 元数据自动抓取 + 标注/笔记闭环 | 替代 Zotero 阅读场景 |
| M3（2 周） | 跨文献对比 + Related Work 起草（带锚点） | 真正的差异化 |
| M4（2 周） | CSL 导出 + docx 引文 + 空闲时段批处理队列 | 覆盖引用需求 |
| M5 | 同步 / 移动端 / 分享 / 插件市场 | 看是否要做产品 |

## 10. 坑与风险

- **PDF 文本层质量**：双栏、公式、扫描件是三大杀手。先做「文本层抽取 + 质量评分」，低于阈值才触发 MinerU/视觉 OCR。
- **token 用量失控**：全文直塞虽便宜，但如果每次都换 prompt 前缀（比如把时间戳、随机顺序塞前面），缓存全失效，成本涨 50 倍。前缀必须稳定。
- **幻觉引用**：见 §4 硬约束，这是学术工具的生命线。
- **许可**：Zotero 是 AGPL-3.0，参考/移植其 translators 或代码要谨慎；CSL 样式是 CC-BY-SA，可用但需署名。
- **Windows 打包/签名**：Electron 打包体积与杀软误报要预留时间。
- **本机 PowerShell 执行策略**会挡住 `npm`/`pnpm`，脚本里统一用 `npm.cmd`。

## 11. 可借鉴的开源项目

- [zotero/zotero](https://github.com/zotero/zotero)（数据模型 + CSL 处理，AGPL）
- [windingwind/zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)（Zotero 7/8 插件启动模板）
- [atomashevic/omabib](https://github.com/atomashevic/omabib)（Rust 原生 + 自带 AI agent + MCP 的参考）
- [deepseek-ai/awesome-deepseek-integration](https://github.com/deepseek-ai/awesome-deepseek-integration)（官方集成合集）
- MinerU / Docling / GROBID（PDF → 结构化）
- citeproc-js（CSL 渲染）

## 12. macOS 支持（Electron 能不能在 Mac 上跑）

**结论：Electron 本身完全支持 macOS，但"在 Mac 上能跑"分三个层次，成本差很远。**

| 层次 | 需要什么 | 难度 |
| --- | --- | --- |
| 源码在 Mac 上跑 | Mac 上装 Node，`npm i && npm start` | 低 |
| 打包 `.app` / `.dmg` | **必须在 macOS 上构建**（electron-builder 的交叉构建文档只覆盖 Windows-on-Linux/macOS 和 Linux-on-macOS，没有 macOS-on-Windows），或走 GitHub Actions `macos-latest` runner | 中 |
| 分发给别人的 Mac | Apple Developer 账号 $99/年 + 签名 + 公证（notarization），否则 Gatekeeper 拦截。自用可右键打开或 `xattr -cr` | 高 |

官方平台支持：**macOS Ventura(13) 及以上**，提供 x64(Intel) 与 arm64(Apple Silicon) 二进制，也可用 `--universal` 出胖二进制（体积约 ×2）。
注意：macOS 26 是 Apple 最后一个支持 Intel Mac 的版本，出一段时间后可只保留 arm64。

**真正的坑不是 Electron，而是三处非跨平台依赖：**

1. **`better-sqlite3` 是原生模块** → 每个平台/架构都要重编译；electron-builder 默认 `npmRebuild` 会处理，但 universal 包需要配 `mergeASARs` / `singleArchFiles`。
2. **Python 侧车（MinerU / GROBID / Docling）必须按平台分别打包**（PyInstaller 不能交叉构建，arm64 Mac 得在 Mac 上出包）→ **这是最容易翻车的地方**。
   *规避：v1 干脆不要 Python 侧车*，公式/图表/扫描件全部交给 `deepseek-flash` 的视觉能力，保持纯 JS 技术栈。
3. **macOS 原生体验细节**：应用菜单、关闭窗口不退出、Dock 行为、Cmd vs Ctrl 快捷键、`~/Library/Application Support` 数据目录约定。

**替代方案（若 Mac 是硬需求而手头只有 Windows）：**

| 方案 | Mac 上怎么跑 | 代价 |
| --- | --- | --- |
| Electron | 需 Mac 或 CI 出包 | 体积 ~150MB，签名麻烦 |
| Tauri 2 | 同样需 Mac 签名，体积 ~10MB | 要多学 Rust |
| **本地 Web（原方案 C）** | Mac 上 `git clone && npm i && npm run dev`，浏览器打开 | 最省事，**完全跳开交叉编译与签名** |

**建议**：Mac 是硬需求 + 只有 Windows 开发机 → **先做路线 C（本地 Web）**，Mac 侧零打包成本；形态稳定后再套 Electron 壳分发。

## 13. 下一步待定

1. 走哪条路线？（建议 C → B，A 做原型验证）
2. 自用工具 / 开源项目 / 商业产品？
3. 第一个杀手级功能选哪个？（建议：带页码锚点的全文问答）
