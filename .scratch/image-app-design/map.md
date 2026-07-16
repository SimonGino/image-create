# image-create 设计地图 (Design Map)

`wayfinder:map`

## Destination

一份可直接开工的**设计规格**:面向单用户的个人 Web 应用 **image-create**,通过多家提供商(OpenAI gpt-image 系列 + Google Gemini 生图模型)生成图片,支持**文生图**与**参考图生图**两种模式,并涵盖参数控制、生成历史 / 图库、成本与用量统计、提示词模板 / 收藏。

终点是「设计文档 + 一组已定决策」,足以让人照着实现——**本 effort 只规划,不写生产代码**(原型除外,且原型是一次性的)。

> ✅ **地图完成(2026-07-16)**:七个决策 ticket 全部 resolved,通往目的地的路已清晰。可交付规格 → [SPEC.md](../../SPEC.md)。落地实现另开 effort。

## Notes

- **领域**:个人自用(单用户)的多提供商图像生成 Web 应用。无登录 / 账户 / 多租户。
- **性质**:规划(plan),不落地。每个 ticket 解决一个决策;产出决策,不产出应用代码。
- **每个 session 应参考的 skills**:`/grilling`、`/domain-modeling`(决策类 ticket);`/research`(调研类);`/prototype`(原型类)。
- **术语(ubiquitous language)**:
  - **Provider 提供商** — OpenAI / Google 等模型供应方。
  - **Model 模型** — 某 Provider 下的具体生图模型(如 gpt-image-1、Gemini 生图模型)。
  - **Generation 生成** — 一次「请求 + 结果」:提示词 + 模式 + 参数 + 参考图 → 一或多张图。
  - **Mode 模式** — text-to-image(文生图)/ reference-image(参考图生图)。
  - **Parameter Set 参数集** — 某模型的可调参数(尺寸 / 质量 / 宽高比 / 数量…)。
  - **Gallery / History 图库 / 历史** — 已保存的 Generation 集合。
  - **Prompt Template 提示词模板** — 可复用的提示词。
  - **Usage / Cost Record 用量 / 成本记录** — 每次 Generation 的花费与累计用量。
- **技术栈已定**:Next.js 全栈 + TypeScript + Tailwind/shadcn + SQLite/Drizzle(见 [技术栈选型](issues/02-tech-stack.md));数据模型、Key 管理等都建在其上。

## Decisions so far

<!-- 每个已关闭 ticket 一行 gist + 链接;详情在各 ticket 内。地图只索引,不复述。 -->

- [模型 API 调研](issues/01-model-api-research.md) — 摸清 gpt-image(`1/1.5/2`,`/generations`+`/edits`,**支持 mask**)与 Gemini Nano Banana(`3-pro`/`3.1-flash`,最多 14 参考图、**无 mask**、新 Interactions API)的模型 / 能力 / 参数 / 价格;共同底座=文本+base64 参考图→base64 图,差异在协议 / 尺寸 / mask / 一次多图。详见 [assets/model-api-research.md](assets/model-api-research.md)。
- [技术栈选型](issues/02-tech-stack.md) — **Next.js 全栈(App Router + Route Handlers)+ TypeScript + Tailwind/shadcn/ui + SQLite**;单进程、API Key 锁服务端、`localhost` 起;ORM 与表结构留给 04。
- [提供商抽象](issues/03-provider-abstraction.md) — **Shape A**:判别联合 `SizeSpec`(OpenAI 像素 / Gemini 比例+档位)、声明式 `capabilities`+`pricing` 元数据(驱动 06 面板 + 07 估算)、`ImageProviderAdapter`(加一家=一个 adapter+注册);Gemini `supportsN=false`(多图=并发 N 次)、无 mask;错误统一分类、参考图不自动重试。
- [数据模型](issues/04-data-model.md) — **SQLite 关系表 + 图走文件系统(`data/images/…`)+ sharp 缩略图,ORM Drizzle**;`generations`(usage 内联、`size_spec`/`provider_params` 走 JSON 列)+ `generation_images` + `generation_ref_images` + `prompt_templates`,镜像 03 的请求/响应。
- [密钥管理](issues/05-api-key-management.md) — **混合:`.env` 默认 + 应用内 Settings 覆盖**,明文本地文件(0600、git-ignored)为基线、加密可选;Key 仅服务端读;`ProviderCredentials` 按 provider 索引、按有效性启停 Model;任何 `403` 归入通用 `AuthError`(组织验证不纳入设计,2026-07-16)。
- [成本与用量](issues/07-cost-usage.md) — **预估 + 据实并存**:生成前按 pricing 元数据给「≈$」,生成后据返回 usage 记实际花费(统计的 single source of truth、`cost_source` 标注);维度 provider/model/月、USD 精度 $0.001;gpt-image-2 精确价待 calculator 固化。
- [界面原型](issues/06-ui-prototype.md) — **Layout 1 双栏控制台**(左栏参数控制 + 右栏大图预览 + 顶栏「生成/图库」tab);动态参数面板由 03 的 `capabilities`/`pricing` 驱动,验证「一份元数据即可驱动 UI + 校验 + 估算」。详见 [assets/ui-prototype.md](assets/ui-prototype.md)。

## Not yet specified

<!-- 迷雾随边界推进已全部结算,无剩余可毕业项。 -->

_全部吸收 / 交付,无剩余:_

- 生成延迟 / 异步与错误重试 → 已在 [提供商抽象](issues/03-provider-abstraction.md)(同步、错误分类、参考图不自动重试)+ [界面原型](issues/06-ui-prototype.md)(loading 态)收拢。
- 项目脚手架 / 目录结构 → 属落地实现,列为 [SPEC.md](../../SPEC.md) §9 首个任务(执行 effort)。
- 运行 / 部署方式 → 已在 [技术栈选型](issues/02-tech-stack.md) 定(`localhost` 单命令)。
- 汇总设计规格文档 → 已交付为 [SPEC.md](../../SPEC.md)。

## Out of scope

<!-- 有意排除出本 effort 的工作;已排除,不会毕业。重画目的地才会以「新 effort」形式回来。 -->

- **多用户 / 登录 / 账户 / 数据隔离** — 已选单用户自用;多用户如需,另开 effort。
- **局部重绘 / mask / inpainting 等高级图像编辑** — 超出 v1「参考图生图」的范围。
- **批量 / 队列生成** — v1 不做。
- **视频生成、图片后处理编辑器(裁剪 / 滤镜等)** — 不在本 effort。
- **整个应用的编码落地实现** — 本 effort 只到设计规格;真正实现另开 effort。
