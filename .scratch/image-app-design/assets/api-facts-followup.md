# API 事实补充核实 (Part A · Follow-up)

> 资产 for tickets 03 / 05 / 07(承接 [`model-api-research.md`](model-api-research.md) 的「待核实 / 风险点」)
> 核实日期:**2026-07-15** · 来源:OpenAI / Google 官方文档 + `googleapis/python-genai` 官方仓库(逐条附 URL)
> 性质:**事实核实,不做决策**。价格 / 接口迭代快,落地前仍以官方页面为准。

---

## 结论速览

| # | 待核实项 | 结论(一句话) | 可信度 |
|---|---|---|---|
| 1 | Gemini `generateContent` vs Interactions API | `generateContent`+`responseModalities` **今天仍可出图**,但其文档页已标 **Legacy**;官方 GA 主推 **Interactions API**;SDK 示例目前仍以 `generate_content` 为主 | 高(官方文档) |
| 2 | Gemini 一次能否多图(n>1) | **实测不能可靠多图**:`candidateCount` / `number_of_images` / `sampleCount` 均被拒(INVALID_ARGUMENT / extra_forbidden)。要 N 张 → **发 N 次并行请求** | 高(官方仓库 issue) |
| 3 | OpenAI 组织实名验证流程 / 耗时 | 控制台内第三方身份核验(政府证件 + 自拍活体);活跃步骤数分钟,处理传播约 **15–30 分钟**(偶有更久);**一证 90 天只验一组织、失败不可重试、通过≠必然有权限(还看 tier)** | 高(官方 guide 确认「需验证」;流程细节来自官方 Help Center 文章) |
| 4 | gpt-image-2 / 1.5 分档价 | 按 **token** 计:输出图 **gpt-image-2 = $30 / 1M**、**gpt-image-1.5 = $32 / 1M**。1.5 有官方每图价表;2 因**尺寸任意**改用官方 calculator 折算(无固定每图表) | 高(官方 pricing 页);gpt-image-2 每图美元数为**推导值,需以 calculator 为准** |

---

## 1. Gemini 出图接口:`generateContent` 还能用吗?

**结论:两条路今天都能出图。** `generateContent` + `responseModalities:["IMAGE"]`(或 `["TEXT","IMAGE"]`)**未被移除、仍支持图像输出**,但官方已把它降级为 **Legacy**;新的 **Interactions API**(`POST /v1beta/interactions`)已 GA 且为官方推荐主路径。

- **Legacy 页横幅原文(generateContent 页)**:"The Interactions API is now generally available. We recommend using this API for access to all the latest features and models."
- 两条路**指向同一批模型**:`gemini-3-pro-image`(Nano Banana Pro)、`gemini-3.1-flash-image`(Nano Banana 2)、`gemini-3.1-flash-lite-image`(仅 1K)、`gemini-2.5-flash-image`(legacy)。
- **尺寸参数**:`aspect_ratio` ∈ {1:1, 3:2, 2:3, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9};`image_size` ∈ {512/0.5K, 1K, 2K, 4K}。Interactions 里在 `response_format` 下;generateContent 里在 `imageConfig`(`aspectRatio` / `imageSize`)下。
- **SDK 现状**:`google-genai`(Python / JS)当前**规范示例仍走 `generate_content` / `generateContent`**(`client.models.generate_content(model=..., config=GenerateContentConfig(response_modalities=["IMAGE"], image_config=ImageConfig(aspect_ratio=...)))`)。Interactions API 是新面,但 SDK 未强制迁移。

**对 ticket 03 的影响**:抽象层的 Gemini adapter **短期可继续用 `generate_content`**(SDK 支持好、示例多),但应把「协议路径」设计成可切到 Interactions API(未来新特性 / 新模型只在 Interactions 上开)。不是二选一的强制迁移,是**优先级**问题。

来源:
- Google · [Nano Banana image generation — Interactions API](https://ai.google.dev/gemini-api/docs/image-generation)
- Google · [Generate Content API (Legacy) — image generation](https://ai.google.dev/gemini-api/docs/generate-content/image-generation)(页面横幅标 Legacy)
- Google · [Gen AI SDK (python-genai) 文档](https://googleapis.github.io/python-genai/)
- Google · [Interactions API overview](https://ai.google.dev/gemini-api/docs/interactions-overview)

---

## 2. Gemini 一次能否返回多图(n>1)?

**结论:不能可靠地一次多图。** Gemini 原生图模型**实际每次稳定产出 1 张**;没有可用的 `n` 语义:

- `candidateCount=N` → `INVALID_ARGUMENT`(该模型不支持)。
- `number_of_images=N`(`GenerateImagesConfig`)→ `google-genai` 直接校验报错:`Extra inputs are not permitted [type=extra_forbidden]`。
- Vertex 模型卡虽写 "Maximum number of output images per prompt: 10",但这是**模型在图文交错里可能产出的上限**,不是可控参数;**用 prompt 要「N 张独立图」结果不稳定**(有时 1/2/3 张、有时把多个概念合成一张)。
- **官方口径**:文档把「图片数量」定义在**输入侧**(2.5-flash 建议输入 ≤3 张、3-pro 建议输入 ≤14 张),而非保证输出张数;"The model might not create the exact number of images you ask for."
- **可靠拿 N 张的唯一办法 = 发 N 次并行请求**(每次 1 张)。相关 issue 被标 `p3`(可选增强),短期无修复排期。

**对 ticket 03 / 06 / 07 的影响**:统一抽象里 `supportsN` 对 **Gemini = false**(或 maxN=1);UI 的「张数」控件对 Gemini 灰掉或改成「客户端并发 N 次」;成本估算 Gemini 张数 = 请求次数。OpenAI 侧 `n` 原生支持(见 §4)。

来源:
- googleapis/python-genai · [Issue #1534 — 请求多图报 extra_forbidden](https://github.com/googleapis/python-genai/issues/1534)
- googleapis/python-genai · [Issue #2347 — 无法可靠控制单次输出图数量](https://github.com/googleapis/python-genai/issues/2347)
- Google · [Interactions API 页](https://ai.google.dev/gemini-api/docs/image-generation)(未列多图参数)

---

## 3. OpenAI 组织实名验证(Organization Verification)

**结论:需先在控制台完成**,官方 image-gen guide 明确要求;流程为控制台内第三方身份核验,处理约 15–30 分钟。

- **是否必需(官方原文)**:"To ensure these models are used responsibly, you may need to complete the API Organization Verification from your developer console before using GPT Image models." —— 适用 `gpt-image-2` / `gpt-image-1.5` / `gpt-image-1` / `gpt-image-1-mini`。
- **在哪做**:控制台 **Settings → Organization → General → Verifications**。
- **怎么做**:第三方核验流程 —— 上传**实体政府签发证件**照片 + 用手机摄像头做**活体自拍匹配**;不接受电子 / 数字证件。支持 200+ 国家证件。
- **耗时**:活跃操作约几分钟;之后处理 / 传播 **约 15–30 分钟**("up to 15 minutes" 旧提示 / 官方现行指引可到 30 分钟);**偶有数小时甚至更久**的社区报告。
- **限制 / 坑**:
  - **一张证件每 90 天只能验证一个组织**;并非所有组织都符合资格。
  - **失败当前不支持重试**(证件过期 / 模糊 / 信息缺失 / 自拍不匹配等都会失败)。
  - **验证通过 ≠ 一定拿到模型权限**:部分能力仍与 usage tier 挂钩;通过后建议看 Limits 页 / Playground 确认。
  - 命中 `403` 时官方建议:确认在正确组织下验证 → 等最多 30 分钟 → 在正确 project 新建 key → Playground 测一次 → 再重试 API。

**对 ticket 05 的影响**:这是**一次性人工前置**,应用**无法自动化**。密钥管理设计应:(a)在 onboarding / Settings 里放「先完成组织验证」的指引链接;(b)运行时捕获 `403 / not verified` 错误 → 给出明确指引而非静默失败(详见 briefs · 05)。**建议在真正开工前,由人先跑一遍验证**(个人开发者亦可,但需本人证件 + 活体)。

来源:
- OpenAI · [Image generation guide](https://developers.openai.com/api/docs/guides/image-generation)(「需完成组织验证」原文 + 适用模型)
- OpenAI Help Center · [API Organization Verification(文章 10910291)](https://help.openai.com/en/articles/10910291-api-organization-verification)(流程 / 证件 / 90 天 / 不可重试等细节)*
- OpenAI Developer Community · [gpt-image-1 403 排查串](https://community.openai.com/t/gpt-images-1-403-what-are-the-conditions-for-requesting-this-model-gpt-image-1/1245846)(403 处置顺序)

> \* Help Center 文章直连返回 403(反爬),细节经官方文章的搜索摘要核对;**「需验证」这一硬事实由官方 guide 直取确认**。

---

## 4. gpt-image-2 / gpt-image-1.5 分档价

**结论:两者都按 token 计费。** 官方 pricing 页给的是 **每 1M token 费率**;`gpt-image-1.5` 另有官方**每图价表**;`gpt-image-2` 因**支持任意分辨率**,官方不给固定每图表,改用 image-gen guide 里的 **calculator** 折算。

### 4a. 每 1M token 费率(官方 pricing 页,标准价)

| 模型 | 文本输入 | 图像输入 | 图像输出 | Batch(5 折) |
|---|---|---|---|---|
| `gpt-image-2`(snapshot `gpt-image-2-2026-04-21`) | $5.00 | $8.00 | **$30.00** | $2.50 / $4.00 / $15.00 |
| `gpt-image-1.5` | $5.00 | $8.00 | **$32.00** | $2.50 / $4.00 / $16.00 |
| `gpt-image-1-mini` | $2.00 | $2.50 | **$8.00** | $1.00 / $1.25 / $4.00 |

### 4b. 输出图像 token 数(方形 1024×1024,官方公布档位)

| quality | 输出 token(1024²) |
|---|---|
| low | 272 |
| medium | 1,056 |
| high | 4,160 |

> 每图成本 = `输出 token 数 × 图像输出费率`。非方形 / 更大尺寸 token 数更多;`gpt-image-2` 任意分辨率下 token 数由 calculator 给。

### 4c. `gpt-image-1.5` 官方每图价(实测取自模型页)

| quality | 1024×1024 | 1024×1536 / 1536×1024 |
|---|---|---|
| low | **$0.009** | $0.013 |
| medium | **$0.034** | $0.05 |
| high | **$0.133** | $0.20 |

> 校验:1024² high = 4,160 tok × $32/1M = $0.133 ✓;medium 1,056 × $32 = $0.034 ✓;low 272 × $32 = $0.009 ✓ —— 即 1.5 沿用 272/1056/4160 档位。

### 4d. `gpt-image-2` 每图价 —— ⚠️ 推导值,以 calculator 为准

官方**未发布 gpt-image-2 的固定每图美元表**(因分辨率任意)。若沿用同样的 1024² token 档位 × $30/1M:

| quality | 1024² 推导每图价(≈) |
|---|---|
| low | ≈ **$0.008** |
| medium | ≈ **$0.032** |
| high | ≈ **$0.125** |

> ⚠️ **仅为推导**(假设 token 档位与 1.x 一致)。gpt-image-2 支持任意分辨率(单边 ≤3840、16 的倍数、比例 ≤3:1、像素 655,360–8,294,400),**精确成本必须用官方 image-gen calculator 或据实读返回 usage token**(见 briefs · 07)。

### 4e. 关键提醒

- **每图价只覆盖「输出图像」**;总成本还含文本输入 + **图像输入 token**(参考图 / edit 流尤其明显,单次可加数千 token)。
- `gpt-image-1`(原代)每图官方价 = $0.011 / $0.042 / $0.167(low/med/high 1024²),**将于 2026-10-23 退役**;`model-api-research.md` 里 $0.02/$0.07/$0.19 为早期近似,以此表为准。新项目直接用 1.5 / 2。
- OpenAI 原生支持 `n`(单请求多图,默认 1;guide 未标明确上限,历史上限 10);Gemini 无(见 §2)。

来源:
- OpenAI · [Pricing 页](https://developers.openai.com/api/docs/pricing)(每 1M token 费率表)
- OpenAI · [gpt-image-2 模型页](https://developers.openai.com/api/docs/models/gpt-image-2)(存在性 / snapshot / 任意尺寸 / 指向 calculator)
- OpenAI · [gpt-image-1.5 模型页](https://developers.openai.com/api/docs/models/gpt-image-1.5)(每图价表)
- OpenAI · [Image generation guide](https://developers.openai.com/api/docs/guides/image-generation)(`n` 参数、尺寸约束、calculator、token 档位)

---

## 待办 / 仍需人工确认(交回给对应 ticket)

1. **gpt-image-2 精确分档价**:用官方 image-gen calculator 跑几个常用 size×quality,把结果固化进 07 的定价元数据(§4d 目前是推导值)。
2. **OpenAI 组织验证**:开工前由**人先完成一遍**(§3)——个人开发者可做,但需本人证件 + 活体,且失败不可重试、90 天锁定,属硬前置。
3. **Gemini 协议路径**:03 抽象定型时决定 Gemini adapter 用 `generate_content`(现状省事)还是直接上 Interactions API(面向未来),二者非强制迁移(§1)。
