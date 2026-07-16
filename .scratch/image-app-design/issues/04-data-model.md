# 数据模型与本地持久化

Type: grilling
Status: resolved
Blocked by: 02, 03

## Question

设计需要落地保存的数据及其存储方式:

- **Generation 记录**:提示词、模式、模型、参数、参考图引用、结果图、耗时、时间戳——字段结构(镜像「提供商抽象」定义的请求 / 响应)。
- **图片本身存哪**:文件系统路径 vs 内嵌?缩略图?
- **提示词模板 / 收藏**的数据结构。
- **用量 / 成本记录**的数据结构(供「成本估算」ticket 使用)。
- **存储载体**:落到技术栈已选的持久化方案上(SQLite 表结构 / 文件布局 / …)。

依赖技术栈(存储技术)与提供商抽象(Generation 的形状)。用 `/grilling` 定。

## Answer

**决策(2026-07-15 拍板):SQLite(关系表)+ 图片走文件系统 + sharp 缩略图;ORM = Drizzle。**

采纳 [decision-prep-briefs.md · 04](../assets/decision-prep-briefs.md) 选项 A:

- **存储载体**:SQLite 关系表(本应用核心 = 图库检索 + 成本聚合,正是关系库主场:分页、按 provider·model·月 `GROUP BY`)。**ORM = Drizzle**(轻、贴 SQL)。
- **图片**:API 返回 base64 → 写文件系统 `data/images/{generationId}/{idx}.png`,DB 只存**相对路径 + 缩略图路径**(不入 DB blob)。缩略图用 **sharp** 出 256–512px webp 供 Gallery 网格。
- **表结构**(镜像 03 的请求 / 响应):`generations`(provider_id、model_id、mode、prompt、`size_spec` json、quality、output_format、n_requested、`provider_params` json、status、error_code、timing_ms、**usage 内联**:text/image_input_tokens、image_output_tokens、cost_usd)、`generation_images`(generation_id、idx、file_path、thumb_path、w/h、mime)、`generation_ref_images`(参考图 / mask 输入,role)、`prompt_templates`(title、body、favorite、variables json、default_provider/model)。
- **usage**:v1 **内联进 `generations`**(单用户、一次生成一条够用);要更细分析再拆 `usage_records`(带 `cost_source ∈ {estimated,actual}`,见 07)。
- `size_spec` / `provider_params` 用 **JSON 列**,天然对齐 03 的判别联合。

**解锁**:成本与用量(07)转入 frontier。
