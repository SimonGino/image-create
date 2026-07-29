# image-create — 设计规格 (Design Spec)

> 单用户个人**图像生成 Web 应用**:多提供商(OpenAI gpt-image 系列 + Google Gemini / Nano Banana),支持**文生图**与**参考图生图**。
> 状态:**设计定稿,可开工**(2026-07-16)。本文是七个决策的可交付汇总;逐条依据见决策地图 [.scratch/image-app-design/map.md](.scratch/image-app-design/map.md) 及各 ticket / assets。
> 性质:设计规格,不含生产代码。落地实现是**下一个 effort**。

---

## 1. 概述与范围

**目标**:一个自己用的 Web 应用,用主流大模型生成图片,能调参、看历史、算花费、存常用提示词。

**v1 范围(纳入)**:文生图、参考图生图、OpenAI ↔ Gemini 切换、参数控制、生成历史 / 图库、成本与用量统计、提示词模板 / 收藏。

**Out of scope**:多用户 / 登录 / 账户、mask / inpainting 等高级编辑、批量 / 队列生成、视频生成、图片后处理编辑器。多用户与整个应用的编码实现均另开 effort。

**关键约束**:单用户、无登录、本地运行;各家 API Key 必须由服务端保管(不能浏览器直连)。

---

## 2. 技术栈 · [ticket 02](.scratch/image-app-design/issues/02-tech-stack.md)

- **Next.js(App Router)全栈一体** + Route Handlers,单进程。API Key 只在 Route Handler(服务端)读,绝不进前端 bundle。
- **TypeScript**(前后端共享第 3 节的抽象类型)。
- **UI**:React + Tailwind + shadcn/ui。
- **持久化**:SQLite + **Drizzle** ORM。
- **运行**:本地 `localhost` 单命令(`next dev` / `next start`);日后可升级单容器个人部署。

---

## 3. 提供商 / 模型抽象(核心) · [ticket 03](.scratch/image-app-design/issues/03-provider-abstraction.md)

**术语**:Provider(供应方)· Model(具体模型)· Generation(一次请求+结果)· Mode(t2i / reference)· Parameter Set · Gallery · Prompt Template · Usage-Cost Record。

**设计取向:能力元数据 + 适配器**。每个 `Model` 声明 `capabilities` 与 `pricing`,同一份元数据**同时驱动 UI 参数面板(第 7 节)、前置校验、成本估算(第 6 节)**。`SizeSpec` 用判别联合,分别忠实映射两家的尺寸模型。

```ts
type ProviderId = 'openai' | 'google';          // 加第三家 = 并集加一个字面量
type Mode = 't2i' | 'reference';

type SizeSpec =
  | { kind: 'pixels'; width: number; height: number }                        // OpenAI → size "1024x1536"
  | { kind: 'ratio'; aspectRatio: AspectRatio; imageSize: ImageSizeTier };    // Gemini → aspect_ratio + image_size

interface ModelCapabilities {
  modes: Mode[];
  maxRefImages: number;   supportsMask: boolean;   // OpenAI: 多张+mask(mask 限第一张); Gemini: 多张、无 mask
  supportsN: boolean;     maxN: number;            // OpenAI n>1; Gemini 恒为 1(多图=调用层并发 N 次)
  sizeSpecKind: 'pixels' | 'ratio';
  pixelSizes?: string[];  aspectRatios?: AspectRatio[]; imageSizeTiers?: ImageSizeTier[];
  outputFormats: ('png'|'jpeg'|'webp')[];
  extraParams?: ParamSchema[];                     // provider 私有参数的声明式 schema,供 UI 动态渲染+校验
}
interface ModelPricing { unit:'token'; imageOutputPerMTok:number; textInputPerMTok?:number; imageInputPerMTok?:number; perImageTable?:Record<string,number>; }
interface ModelDescriptor { id:string; providerId:ProviderId; label:string; capabilities:ModelCapabilities; pricing:ModelPricing; }

interface GenerateRequest {
  providerId:ProviderId; modelId:string; mode:Mode; prompt:string;
  refImages?: { data:string; mimeType:string; role?:'image'|'mask' }[];
  sizeSpec:SizeSpec; n?:number; quality?:'low'|'medium'|'high'|'auto';
  outputFormat?:'png'|'jpeg'|'webp'; providerParams?:Record<string,unknown>;
}
interface GenerateResult {
  images:{ data:string; mimeType:string; width?:number; height?:number }[];
  usage:{ textInputTokens?:number; imageInputTokens?:number; imageOutputTokens?:number };
  costEstimateUSD?:number; timingMs:number; raw?:unknown;
}
interface ImageProviderAdapter {
  readonly providerId:ProviderId;
  listModels():ModelDescriptor[];
  validate(req:GenerateRequest):ValidationResult;   // 用 capabilities 前置校验
  generate(req:GenerateRequest):Promise<GenerateResult>;
}
```

**加第三家** = 实现一个 `ImageProviderAdapter` + 往注册表加它的 `ModelDescriptor[]`。

**调用 / 错误语义**:同步请求-响应(OpenAI 流式 partial v1 暂不接)。错误统一为 `AuthError`(含无效 key、403 无权限)/ `ValidationError`(能力前置拦截)/ `RateLimit` / `ProviderError` / `Timeout`;**参考图生图默认不自动重试**(可能已扣费)。Gemini 要「一次 N 张」由调用层并发 N 次 `generate()`。

**Gemini 协议路径**:adapter 短期用 `generate_content`(SDK 支持好),预留切 Interactions API(新特性 / 新模型只在后者开)。详见 [api-facts-followup.md §1](.scratch/image-app-design/assets/api-facts-followup.md)。

---

## 4. 数据模型与持久化 · [ticket 04](.scratch/image-app-design/issues/04-data-model.md)

SQLite 关系表(图库检索 + 成本聚合是主场);图片走**文件系统** `data/images/{generationId}/{idx}.png`,DB 只存相对路径 + 缩略图路径;缩略图用 **sharp** 出 256–512px webp。`size_spec` / `provider_params` 用 **JSON 列**(对齐第 3 节判别联合)。

```
generations(id, created_at, provider_id, model_id, mode, prompt, size_spec(json),
            quality, output_format, n_requested, provider_params(json), status, error_code,
            timing_ms, text_input_tokens, image_input_tokens, image_output_tokens, cost_usd)  -- usage 内联
generation_images(id, generation_id, idx, file_path, thumb_path, width, height, mime_type)
generation_ref_images(id, generation_id, idx, file_path, role('image'|'mask'))
prompt_templates(id, title, body, favorite, variables(json), default_provider_id, default_model_id,
                 cover_image_path, created_at)  -- cover 指向某张生成图,该生成被删后悬空 → 卡片退化为纯文字
```

usage v1 内联进 `generations`;要更细分析再拆 `usage_records`(带 `cost_source ∈ {estimated, actual}`)。

---

## 5. 密钥管理 · [ticket 05](.scratch/image-app-design/issues/05-api-key-management.md)

- **混合来源**:`.env` 默认 / CI 友好 + 应用内 Settings 写本地 `config.json`(如 `~/.image-create/config.json`)可覆盖。
- **存储**:明文本地文件(**0600 权限、git-ignored**)为基线;加密 v1 不做,OS keychain 列可选增强。Key 仅服务端读。
- **多 Provider**:`ProviderCredentials{ openai?:{apiKey}, google?:{apiKey} }`;Model 选择器按「该 provider 是否有有效 key」启停。
- **错误处理**:保存时轻校验;运行时 provider 错误 → `AuthError`,UI 标「未配置 / 无效」+「去设置」;**任何 `403` 一律归入 `AuthError`**(不特殊处理 OpenAI 组织验证 —— 按用户要求不纳入设计)。

---

## 6. 成本与用量 · [ticket 07](.scratch/image-app-design/issues/07-cost-usage.md)

- **预估 + 据实并存**:生成前用 `pricing` 元数据给「≈$」预估(标「≈」);生成后把返回 usage 折算的**实际花费**写进 usage 记录,作为**统计口径的 single source of truth**。
- **算法**:预估 = `imageOutputTokens(size,quality) × imageOutputPerMTok/1e6 × n`(参考图模式加 `imageInputTokens`)。
- **口径**:每条 usage 记 `cost_source ∈ {estimated,actual}`,汇总优先 actual;货币 USD、精度 $0.001。
- **维度**:v1 做 provider / model / 月(SQLite `GROUP BY`)。
- **呈现**:生成前在参数胶囊摘要与其 popover 内预估、结果区实际、图库 / Usage 页累计。

---

## 7. UI · 单列提示词优先控制台 · [ticket 06](.scratch/image-app-design/issues/06-ui-prototype.md)

> 原 Layout 1 为双栏控制台(左栏参数面板 / 右栏预览),2026-07-28 改为下述单列形态。首页始终是**唯一的生成工作台**,不是转发到别处的入口页。

- **顶栏**:`image-create` + 「生成 / 对比 / 图库 / 记录」tab + 累计用量 chip + 设置。
- **Hero**:一句标题 + 一句副标题。
- **输入卡片(居中单列)**:提示词 → 「+」加参考图(整卡支持拖拽)→ Model 胶囊 → 参数胶囊 → 提交箭头(⌘↵)。
- **参数胶囊**:常显「尺寸 · 张数 · ≈成本」摘要,点开 popover = **动态参数面板** + 能力提示 + 成本预估「≈$」。
- **Mode 是派生的,不是选择的**:参考图托盘非空 → `reference`,空 → `t2i`。无显式切换控件(见 CONTEXT.md「Mode」)。
- **结果区**:插在输入卡片与模板卡片网格之间(网格下推,不被替换)。大图预览 + 本批缩略条 + 结果元信息(模型 · 尺寸 · 耗时 · 实际 $)+ 操作(下载 / 用作参考图 / 存为模板 / 重生 / 删除)。
- **「开始使用」卡片网格**:渲染 Prompt Templates(收藏优先、新的在前),卡片 = 标题 + 正文截断 + 封面图(无封面则纯文字)。点卡片填入提示词并切默认模型。
- **图库 / 记录**:顶栏 tab 切独立视图(缩略网格,按 provider / model / mode / 时间过滤;详情 = 原图 + 参数 + 用量 + 操作)。
- **动态参数面板**:OpenAI → 尺寸 / 质量 / n;Gemini → 宽高比 / 分辨率、n=1。全由第 3 节 `capabilities` 驱动。

---

## 8. 模型速查(2026-07,落地前以官方为准) · [调研](.scratch/image-app-design/assets/model-api-research.md)

| Provider | Model | 尺寸表达 | 参考图 | mask | 一次多图 | 每图价(约) |
|---|---|---|---|---|---|---|
| OpenAI | `gpt-image-2` / `1.5` / `1-mini` | 像素 `size`(≤3840×2160) | edits 多张 | ✅ | ✅ `n` | 1.5: $0.009/$0.034/$0.133(低/中/高 1024²);2 走 calculator |
| Google | `gemini-3-pro-image` / `3.1-flash-image` / `3.1-flash-lite-image` | `aspect_ratio` + `image_size`(0.5K–4K) | ≤14 张 | ❌ | ❌(=并发) | $0.034–$0.24 |

端点:OpenAI `/v1/images/generations` + `/v1/images/edits`;Gemini `generate_content`(或 Interactions API)。两家返回 base64;Gemini 必带 SynthID 水印;均无免费额度。

---

## 9. 开工前置 & 首个任务(交给落地实现 effort)

1. **固化 gpt-image-2 精确分档价** —— 用官方 calculator 跑常用 size×quality,写进 `pricing` 元数据([api-facts-followup.md §4d](.scratch/image-app-design/assets/api-facts-followup.md))。
2. **确认 Gemini 协议路径** —— 先 `generate_content`,预留 Interactions API。
3. **第一步实现**:Next.js 项目脚手架 + Drizzle schema(第 4 节)+ provider 抽象骨架(第 3 节)+ 一个 adapter 打通端到端。

---

## 依据

决策地图 [map.md](.scratch/image-app-design/map.md) · 调研 [model-api-research.md](.scratch/image-app-design/assets/model-api-research.md) · 事实核实 [api-facts-followup.md](.scratch/image-app-design/assets/api-facts-followup.md) · 决策简报 [decision-prep-briefs.md](.scratch/image-app-design/assets/decision-prep-briefs.md) · 原型 [ui-prototype.md](.scratch/image-app-design/assets/ui-prototype.md)。
