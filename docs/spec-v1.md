# paper-reader · v1 规格（重新整理版）

> 范围锁定为三件事：**① 导入 PDF + 元数据识别 + 管理　② 基础标注　③ DeepSeek AI 伴读**。
> 引用写作（CSL/Word 插件）、云同步、协作、移动端：**v1 明确不做**。
> 背景与路线讨论见 [brainstorm-01.md](brainstorm-01.md)。

---

## 一、功能 1：导入 PDF + 元数据识别 + 管理

### 1.1 抽取流水线（四级降级，逐级兜底）

```
拖入 PDF
  │
  ├─ L0 本地抽取     pdf.js getMetadata()（XMP / Info 字典）
  │                  + 首页文本 + 文件名模式匹配
  │
  ├─ L1 DOI 命中     首页文本正则 10\.\d{4,9}/[^\s,;)]+
  │                  → CrossRef /works/{doi}  ← 权威源，免费，加 mailto 进 polite pool
  │
  ├─ L2 无 DOI       deepseek-flash + JSON mode 从首页文本抽结构化字段
  │                  → 拿 title 去 CrossRef query.bibliographic / OpenAlex 反查
  │                  → 用反查结果二次校验（标题相似度 + 年份）
  │
  ├─ L3 arXiv        识别 arXiv:2401.12345 → arXiv API
  │
  └─ L4 全失败       入库为「待补全」，进人工确认队列（不阻塞导入）
```

**三个关键设计决策：**

1. **让 DeepSeek 直接输出 CSL-JSON**（JSON mode）。一次调用同时完成「抽取 + 字段归一化」，免去自己维护映射表，而且 CSL-JSON 是 Zotero / EndNote / Mendeley 的通用交换格式——**等于免费拿到互操作层**。
   - 注意：官方文档说明 JSON mode 有概率返回空 content，**必须写重试**；prompt 里必须出现 "json" 字样并给出输出样例。
2. **置信度 + 人工确认队列**，绝不静默写入错误元数据。
   - 高：CrossRef/arXiv 直接命中；中：模型抽取 + 反查一致；低：仅文件名。
   - UI 上用黄色角标标出「待确认」，一键进入批量核对界面。
3. **去重**：DOI 精确 → 归一化标题（小写、去标点、去空格）→ 标题相似度阈值。

**批量导入**：支持拖入整个文件夹 / 递归扫描。元数据抓取走并发队列（4~8 并发足够；DeepSeek 并发限额 flash 2500 用不完，真正的瓶颈是 CrossRef 的礼貌限速）。

### 1.2 数据模型（v1 所需，SQLite）

```sql
items(id, item_key, type, title, abstract, year, venue, volume, issue, pages,
      doi, arxiv_id, url, csl_json, meta_confidence, needs_review, date_added, date_modified)
creators(id, family, given, orcid)
item_creators(item_id, creator_id, role, ord)
collections(id, parent_id, name)
item_collections(item_id, collection_id)
tags(id, name, color); item_tags(item_id, tag_id)
attachments(id, item_id, path, mime, sha256, page_count, text_extracted_at)
annotations(id, attachment_id, item_id, page, kind, color, rects_json, text, comment, created, updated)
notes(id, item_id, source_annotation_ids, md, created, updated)
chat_sessions(id, item_id, model, warm_state, tokens_in, tokens_out,
              cache_hit_tokens, cache_miss_tokens, created)
messages(id, session_id, role, content, citations_json, created)
```

- `items.csl_json` 存完整 CSL-JSON，其余列是**冗余出来的可查询字段**（列表排序/筛选用），需要时能互相重建。
- v1 不需要 `citations` 表、不需要 `embeddings` 表。

### 1.3 管理界面

- **三栏**：左＝集合/标签树；中＝文献列表（标题 / 作者 / 年份 / 期刊，可排序）；右＝详情面板。
- **搜索**：SQLite **FTS5** 覆盖 title / abstract / 作者 / 标注文本 / 笔记（中文分词需要额外处理，见 §5 坑）。
- **筛选**：年份、期刊、标签、作者、有无 PDF、有无笔记、是否待确认。
- **批量操作**：打标签、移入集合、重新抓取元数据、导出 BibTeX / CSL-JSON。

---

## 二、功能 2：基础标注

### 2.1 交互范围（够用即止）

| 能力 | 说明 |
| --- | --- |
| 高亮 | 4~5 种颜色，**颜色可命名**（如「重点 / 疑问 / 方法 / 结论」），让标注自带语义 |
| 高亮 + 注释 | 高亮后弹出输入框写想法 |
| 区域截图标注 | 框选图表/公式 → 存成图片，**同时成为 AI 图文解读的输入** |
| 标注侧栏 | 按页 / 颜色 / 时间排序，点击跳回原文位置 |
| 快捷键 | 数字键切颜色、Esc 取消、Ctrl/Cmd+Z 撤销 |

v1 不做：下划线/波浪线/手绘墨迹、标注共享、标注导出 PDF（放 v1.1）。

### 2.2 锚点稳定性（这一块做错，用户会丢数据）

```sql
annotations(id, attachment_id, item_id, page,
            kind,            -- highlight | area | note
            color,           -- 语义化颜色名
            rects_json,      -- [{x,y,w,h}, ...] 归一化到 0~1，左上角为原点
            text,            -- 被标注的原文
            comment, created, updated)
```

- **坐标归一化到 0~1**：缩放、resize、重新渲染都不会漂移；高亮跨行时 `rects` 是数组。
- **同时存 `text` 原文**：PDF 被替换或重新下载后可以**重新定位（re-anchor）**，定位失败就在侧栏提示「有 N 条标注待确认」，而不是静默丢失。

### 2.3 技术选型（pdf.js 6.x）

pdf.js 自带 **Annotation Editor 系统**（`AnnotationEditorLayer` / `AnnotationEditorUIManager`，内置 highlight / freetext / ink / stamp，可 `serialize()`）。两条路线：

| | A. 用 pdf.js 自带编辑器 | B. 自绘 overlay 图层 |
| --- | --- | --- |
| 工作量 | 低 | 中 |
| 数据归属 | pdf.js 私有格式，需额外适配到自己的 DB | **与 DB 一对一** |
| 喂给 AI / 跨文档检索 | 要转一道 | 直接可用 |

**选 B（自绘）**。理由：你的核心卖点是「标注要能被 AI 使用、能跨文献检索、能和笔记双向链接」——数据所有权比省几天工作量重要得多。渲染和文本层仍然用 pdf.js。

**导出**：用 `pdf-lib` 把高亮画进 PDF 副本，产出「带标注的 PDF」；或导出 Markdown 笔记。

---

## 三、功能 3：DeepSeek AI 伴读

### 3.1 三个入口

1. **划词即问**：选中文字 → 浮动菜单（解释 / 翻译 / 推导 / 这是什么概念）→ 秒回。
2. **侧栏对话**：针对当前论文的连续会话；也支持选中多篇做对比。
3. **标注 → 笔记**：把高亮段落 + 上下文喂给模型，生成结构化笔记落回该文献。

### 3.2 上下文策略（本项目最关键、也最容易做错的部分）

**不做 RAG、不做向量库**——全文直塞。一篇 20 页论文 ≈ 1.5 万 token，1M 上下文装得下，而且比检索更准。

prompt 结构（**必须字节级稳定**）：

```
system    : 你是一位学术论文精读助手……（固定不变，一字不改）
user      : 【论文全文】
            <page 1>……</page>
            <page 2>……</page>
            ……
            请先通读，等待我的问题。
assistant : 好的，我已通读……
user      : 问题 1 ……
user      : 问题 2 ……（延续同一会话，不要重建 prompt）
```

根据官方[上下文硬盘缓存文档](https://api-docs.deepseek.com/zh-cn/guides/kv_cache)，有四个必须遵守的规则：

1. **缓存按「完整前缀单元」匹配**。落盘时机是「用户输入结束位置」和「模型输出结束位置」，另外系统会做公共前缀检测。
   → 官方例二就是这个场景：同一个 system + 同一份长文本 + 不同问题，**前两次请求不命中，第三次才开始命中**。所以每篇论文可以**先发 2 次极短的预热请求**，或者接受前两次按全价（也就几分钱）。
2. **前缀里绝对不能放**时间戳、随机 ID、变动顺序、动态拼接的上下文 → 否则永远不命中。把这做成代码里的硬约束并写测试。
3. **用连续的多轮会话**，不要每次重建 prompt。官方例一表明多轮对话天然复用前缀。
4. 会话过长要做压缩（保留论文全文 + 历史问答摘要），**压缩会使缓存失效、需要重新预热**；缓存本身是「尽力而为」，几小时到几天后清空，隔天再读要重新预热。

**强烈建议把 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 显示在 UI 上**（一个小成本条：本次花费 + 命中率）。这是整个项目最性感的工程细节，也能让你立刻发现缓存策略是否被破坏。

### 3.3 页码锚点（反幻觉底线）

- system prompt 要求模型每条引用原文的断言都输出 `[[p.12]]`；前端正则转成可点击 chip，点击滚动到对应页。
- 约束：只能依据给定原文回答，文中没有就说「文中未提及」，不得凭外部知识补充细节。
- v1 不引入 tool calls。全文直塞比 agent 检索更准，也更省钱。

### 3.4 模型路由

| 场景 | 模型 | 模式 |
| --- | --- | --- |
| 划词解释 / 翻译 / 快速问答 | `deepseek-flash` | 非思考（要秒回） |
| 图表、公式截图解读 | `deepseek-flash`（**唯一支持视觉**） | 非思考 |
| 全文精读 / 结构化笔记 / 多篇对比 | `deepseek-v4-pro` | 思考 |
| 元数据抽取（§1.1 L2） | `deepseek-flash` + JSON mode | 非思考 |

### 3.5 图片类输入：用 Files API 省钱

截图上传一次，拿到 `file_id`，后续追问都引用它，不必反复 base64 内联。
- 支持格式：JPEG / PNG / GIF / WebP（**不支持 PDF**，PDF 仍需本地抽文本）
- 单文件 64 MiB、账号 25 GiB / 10000 文件、有效期可设 1 小时 ~ 30 天（建议 7 天）
- 注意：`/anthropic` 端点引用文件需要额外 header `anthropic-beta: files-api-2025-04-14`

### 3.6 成本估算（结论：成本不是约束）

| 场景 | 用量 | 花费 |
| --- | --- | --- |
| 单次全文通读（flash，缓存未命中） | 15k in | ≈ ¥0.015 |
| 后续追问（flash，缓存命中） | 15k in | ≈ ¥0.0003 |
| 100 篇全文精读（v4-pro，未命中） | 1.5M in + 输出 | ≈ ¥7~14，**排空闲时段减半** |

一整天重度使用也就几毛到几块钱。**不要为了省钱牺牲体验**，该上 v4-pro 就上。

---

## 四、技术栈（v1 定稿建议）

| 层 | 选择 | 说明 |
| --- | --- | --- |
| 壳 | Electron（或先做本地 Web，见 §7） | macOS 需 Ventura+，详见 brainstorm §12 |
| UI | React + Vite + TypeScript + Tailwind | — |
| 状态 | zustand | 轻量够用 |
| PDF | **pdfjs-dist 6.x** | 渲染 + 文本层 + 自绘标注层；导入侧也在 Node 里跑它抽文本 |
| 存储 | **better-sqlite3** + FTS5 | 单文件、可备份；注意它是原生模块，跨平台要重编译 |
| AI | DeepSeek OpenAI 兼容 SDK | `base_url: https://api.deepseek.com` |
| 元数据 | CrossRef / OpenAlex / arXiv HTTP API | 免费，无需 key |

**v1 刻意不引入**：Python 侧车（MinerU/GROBID，避免 mac 打包地狱）、向量库、citeproc-js（引用写作不在范围，但 `items.csl_json` 留着，将来零成本接上）。

---

## 五、验收标准（v1 做完拿这个测）

- [ ] 拖 10 个 PDF 进去，≥8 个自动拿到正确元数据，其余进「待确认」队列而不报错
- [ ] 重复导入同一篇能被去重识别
- [ ] 能高亮（多色）、能写注释、能框选图表，刷新后位置不漂移
- [ ] 按颜色/标签筛选标注，点击跳回原文
- [ ] 选中一段文字能问 AI，回答里的页码锚点可点击跳转
- [ ] 关闭再打开，会话历史与缓存统计仍在
- [ ] UI 显示本次花费与缓存命中率
- [ ] 破坏性测试：把前缀改成带时间戳 → 命中率应该掉到 0（证明缓存策略生效）

---

## 六、里程碑（约 4 周，业余时间）

| 周 | 内容 | 产出 |
| --- | --- | --- |
| W1 | Electron/Web 壳 + SQLite schema + 导入流水线 + 文献列表 | 能导入、能看到元数据 |
| W2 | PDF 阅读器 + 标注（高亮/区域/注释）+ 标注侧栏 | 能读能标 |
| W3 | DeepSeek 会话 + 前缀缓存策略 + 页码锚点 + 划词即问 + 成本条 | 能陪读 |
| W4 | 标注→AI 笔记 + 多篇对比 + 打包 | 可自用 |

---

## 七、待定与已知坑

**待定**：① 形态走 Electron 还是先做本地 Web（我建议先 Web，Mac 侧零打包成本）；② 是否有 Mac 开发/使用需求。

**已知坑**：
1. **中文全文检索**：SQLite FTS5 默认分词器对中文按字切分效果一般，需要 `unicode61` + 自建 bigram，或换 `simple` 分词器方案。英文文献无此问题。
2. **首页 DOI 抽取失败**：很多 PDF 首页是图片或双栏排版错乱 → 必须保留 L2/L3/L4 兜底，不要指望正则。
3. **JSON mode 偶发空 content**（官方已声明）→ 重试 2 次 + 降级到非 JSON 解析。
4. **缓存致命失效**：任何往 system/user 前缀里塞动态内容的行为都会让成本涨 50 倍，建议写单元测试锁死 prompt 前缀。
5. **`better-sqlite3` 原生模块**：Electron 打包需要 `electron-rebuild`；跨平台/跨架构要分别构建。
6. **扫描版 PDF**：本地抽不出文本 → 走 `deepseek-flash` 视觉逐页转写（v1 可先只提示用户，v1.1 再做）。
