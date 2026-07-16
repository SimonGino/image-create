# 成本估算与用量统计设计

Type: grilling
Status: resolved
Blocked by: 01, 04

## Question

设计「每次生成大概花多少钱 + 累计用量」:

- **单次成本估算**:依据模型定价 × 参数(尺寸 / 质量 / 数量)算出预估花费;生成前预估,还是生成后据实?
- **用量统计**:累计张数、累计花费,按 Provider / Model / 时间维度?
- **数据来源**:定价事实来自「图像生成模型与 API 现状调研」;记录落在「数据模型」定义的用量记录上。
- **呈现**:数字口径与展示位置(与 UX 原型呼应)。

依赖调研(定价)与数据模型(用量记录结构)。用 `/grilling` 定。

## Answer

**决策(2026-07-15 拍板):C —— 预估 + 据实并存。**

采纳 [decision-prep-briefs.md · 07](../assets/decision-prep-briefs.md) 选项 C:

- **生成前预估**:用 03 的 `pricing` 元数据算「≈$」(纯 UX 提示、明确标「≈」),参数一变就更新。算法:`imageOutputTokens(size,quality) × imageOutputPerMTok/1e6 × n`(参考图模式加 `imageInputTokens`);OpenAI 1.5 查 `perImageTable`、gpt-image-2 / 大尺寸走 token×费率、Gemini 用每图档位表。
- **生成后据实**:把返回 usage 折算的**实际花费**写进 04 的 usage 记录,作为**统计口径的 single source of truth**;gpt-image-2 任意分辨率预估不精确 → 靠据实纠偏。
- **口径标注**:每条 usage 记 `cost_source ∈ {estimated, actual}`;汇总优先 actual,缺 usage 的老记录用 estimated 兜底。货币 USD、精度 $0.001。
- **用量维度**:v1 先做 **provider / model / 月**(SQLite `GROUP BY`);更多按需再加。
- **呈现**(与 06 呼应):生成前 Generate 按钮旁「≈$」;生成后 / 详情显示实际 token + 花费;一个 Usage 卡 / 小页显示累计(总花费、总张数、按 model 分组、按月趋势)。
- **待固化**:gpt-image-2 精确分档价用官方 calculator 跑常用 size×quality 后写进 pricing 元数据(见 [api-facts-followup.md](../assets/api-facts-followup.md) §4d,当前为推导值)。
