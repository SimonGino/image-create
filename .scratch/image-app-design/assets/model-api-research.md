# 图像生成模型与 API 现状调研

> 资产 for ticket 01(`.scratch/image-app-design/issues/01-model-api-research.md`)
> 调研日期:**2026-07-15** · 来源:OpenAI / Google 官方文档(见文末)
> 性质:**事实调研,不做决策**。价格/模型迭代很快,落地前请以官方页面为准。

---

## TL;DR

| | OpenAI(gpt-image) | Google(Gemini / Nano Banana) |
|---|---|---|
| 当前主力模型 | `gpt-image-2`(最新)、`gpt-image-1.5`、`gpt-image-1`、`gpt-image-1-mini` | `gemini-3-pro-image`、`gemini-3.1-flash-image`、`gemini-3.1-flash-lite-image`、`gemini-2.5-flash-image`(legacy) |
| 文生图 | ✅ `/v1/images/generations` | ✅ Interactions API |
| 参考图生图 | ✅ `/v1/images/edits`(**支持 mask 局部重绘**) | ✅ 同一次调用,**最多 14 张参考图**(无 mask,自然语言编辑) |
| 尺寸表达 | 显式像素 `size`(最大 3840×2160) | `aspect_ratio` 枚举 + `image_size` 档位(0.5K/1K/2K/4K) |
| 一次多图 | ✅ `n` 参数 | ⚠️ 通常一次一图(待核实) |
| 返回 | base64(默认)+ 流式 partial images | base64(inline data) |
| 同步/异步 | 同步(可流式,仍是请求-响应) | 同步 |
| 计费 | 按 token(文本/图像输入 + 图像输出) | 按 token(每图折算)。**无免费额度** |
| 鉴权 | Bearer key + **需组织实名验证** | `x-goog-api-key` |
| 水印 | C2PA 元数据(待核实) | **始终带 SynthID 隐形水印** |

两家都已收敛为「**文本 prompt + 可选参考图(base64)→ base64 图像**」的多模态形态,这为统一抽象提供了共同底座;主要差异在**尺寸表达、参考图/mask 语义、协议形态、一次多图**四处。

---

## 一、OpenAI —— gpt-image 系列

### 模型
- `gpt-image-2` —— 最新。(注:`background: transparent` 不支持)
- `gpt-image-1.5` —— 上一代主力,指令遵循好。
- `gpt-image-1` —— 原生多模态,接受文本+图像输入、产出图像。
- `gpt-image-1-mini` —— 低成本版,质量不敏感时用。
- ⚠️ `dall-e-2` / `dall-e-3` —— **已弃用**,官方计划 2026-05-12 停止支持(即已到期,勿再依赖)。

### 端点
- `POST /v1/images/generations` —— 纯文生图。
- `POST /v1/images/edits` —— 用参考图 + 新 prompt 编辑,支持整图或局部(mask)。
- **Responses API** 内置 image 工具 —— 支持多轮迭代编辑(会话式高保真编辑)。

### 请求参数
| 参数 | 取值 |
|---|---|
| `model` | `gpt-image-2` / `gpt-image-1.5` / `gpt-image-1` / `gpt-image-1-mini` |
| `size` | `1024x1024`、`1536x1024`、`1024x1536`、`2048x2048`、`2048x1152`、`3840x2160`、`2160x3840`、`auto`;约束:单边 ≤3840、16 的倍数、比例 ≤3:1、像素 655,360–8,294,400 |
| `quality` | `low` / `medium` / `high` / `auto` |
| `n` | 一次多张(默认 1) |
| `output_format` | `png`(默认)/ `jpeg` / `webp` |
| `background` | `opaque` / `automatic` / `transparent`(`gpt-image-2` 不支持 transparent) |
| `output_compression` | 0–100%(JPEG/WebP) |
| `moderation` | `auto`(默认)/ `low` |
| `partial_images` | 0–3(流式渐进图) |

### 参考图 / mask
- edits 端点可传**多张**输入图;**mask 只作用于第一张**。
- mask 需含 alpha 通道,格式/尺寸与原图一致 → **支持 inpainting 局部重绘**(这是相对 Gemini 的独有能力)。

### 返回 / 时序
- 默认 base64(`b64_json`)。
- `stream: true` + `partial_images` → 渐进图事件(`response.image_generation_call.partial_image`)。
- **同步**为主;流式仍是请求-响应,非 webhook 后台任务。

### 计费(标准价,每 1M token)
| 模型 | 文本输入 | 图像输入 | 图像输出 |
|---|---|---|---|
| `gpt-image-2` | $5.00 | $8.00 | $30.00 |
| `gpt-image-1.5` | $5.00 | $8.00 | $32.00 |
| `gpt-image-1-mini` | $2.00 | $2.50 | $8.00 |

- 每图近似(`gpt-image-1`,1024²):low ≈ **$0.02**、medium ≈ **$0.07**、high ≈ **$0.19**。
- 每图实际取决于 size×quality(输出图像 token 数不同);精确值用 OpenAI 官方 calculator。
- Batch 价约为标准价 5 折。
- 2026-03-05 起,数据驻留(regional processing)端点对合规模型加收 10%。

### 鉴权
- Bearer API key;**使用 GPT Image 系列需先在控制台完成组织实名验证(Organization Verification)** —— 这条会影响「密钥管理」ticket 的落地步骤。

---

## 二、Google —— Gemini / Nano Banana 系列

### 模型(均属 "Nano Banana" 家族)
| 模型 ID | 别名 | 定位 |
|---|---|---|
| `gemini-3-pro-image` | Nano Banana Pro | 最强,复杂视觉任务;可**图文交错**输出 |
| `gemini-3.1-flash-image` | Nano Banana 2 | 通用主力 |
| `gemini-3.1-flash-lite-image` | Nano Banana 2 Lite | 最快最便宜 |
| `gemini-2.5-flash-image` | 初代 Nano Banana | legacy,官方建议迁移 |
| **Imagen 4** | —— | 专用文生图;**已弃用,2026-08-17 关停** |
| **Veo** | —— | 视频生成(本 effort out of scope) |

### API 形态(⚠️ 与旧版不同)
- 当前文档用 **Interactions API**:`POST https://generativelanguage.googleapis.com/v1beta/interactions`,header `x-goog-api-key`。
- **注意**:这与我此前熟悉的 `generateContent` + `responseModalities:["IMAGE"]` 旧路子不同 —— 疑似 2026 年新统一接口。落地/抽象设计前需确认 `generateContent` 是否仍可用(很多 SDK 仍走它)。**已列入待核实**。

### 输入
- 文生图:`input` 里单条 `{"type":"text","text":"..."}`。
- 参考图/编辑:`input` 数组里加 `{"type":"image","data":<base64>,"mime_type":"image/png"}`,**最多混合 14 张参考图**(多图融合、角色一致性、自然语言定向编辑)。
- **无显式 mask** —— 局部修改靠自然语言描述(会话式),不是 alpha mask。

### 尺寸 / 宽高比
- `response_format` 内:`aspect_ratio`(`1:1`/`3:2`/`2:3`/`3:4`/`4:3`/`4:5`/`5:4`/`9:16`/`16:9`/`21:9`)、`image_size`(`0.5K`/`1K`/`2K`/`4K`,大写 K)、`mime_type`。

### 返回 / 交错
- 图像以 base64 inline 返回;便捷取值 `interaction.output_image.data`。
- `gemini-3-pro-image` 可在一次响应里**图文交错**(故事/图解);此时需手动遍历 `interaction.steps`,`output_image`/`output_text` 不能捕获完整序列。

### 计费(标准价;**无免费额度**)
| 模型 | 每 1M 输出 token | 每图折算 |
|---|---|---|
| `gemini-3-pro-image` | $120 | 1K–2K = 1120 tok ≈ **$0.134**;4K = 2000 tok ≈ **$0.24** |
| `gemini-3.1-flash-image` | $60 | 0.5K≈**$0.045** / 1K≈**$0.067** / 2K≈**$0.101** / 4K≈**$0.151** |
| `gemini-3.1-flash-lite-image` | $30 | 1K = 1120 tok ≈ **$0.034** |
| `gemini-2.5-flash-image` | $30 | 1024² = 1290 tok ≈ **$0.039** |
| Imagen 4(弃用) | 按图 | fast $0.02 / std $0.04 / ultra $0.06 |
- Batch 均 5 折。
- 所有 Gemini 生成/编辑图**必带 SynthID 隐形水印**。

---

## 三、能力对比:文生图 vs 参考图生图

| 维度 | OpenAI gpt-image | Gemini Nano Banana |
|---|---|---|
| 文生图 | `/v1/images/generations` | Interactions API,单 text 输入 |
| 参考图数量 | 多张(edits;mask 作用于第 1 张) | **最多 14 张** |
| Mask / inpainting | ✅ 支持(alpha mask) | ❌ 无 mask,自然语言定向编辑 |
| 尺寸/比例 | 显式像素 `size`(≤3840×2160) | `aspect_ratio` + `image_size` 档位 |
| 一次多图 | ✅ `n` | ⚠️ 通常 1 张(**待核实**) |
| 输出格式 | png/jpeg/webp | 由 `mime_type` 定 |
| 时延量级 | 数秒;high/大图更久 | Flash 系低时延(数秒);Pro 更久 |
| 水印 | C2PA 元数据(**待核实**) | 始终 SynthID |

---

## 四、可扩展性观察(喂给 ticket 03「提供商抽象」)

**共同底座(好抽象的部分)**
- 输入:文本 prompt +(可选)一组参考图,参考图统一走 base64 + mime_type。
- 输出:一/多张 base64 图 + usage(token)。
- 都同步、都 token 计费。

**主要差异(抽象要吸收/隔离的部分)**
1. **协议**:OpenAI = REST 双端点(generations / edits)+ 可选 Responses API 工具;Gemini = 单一 Interactions API(mode 靠 input 内容区分)。
2. **尺寸**:OpenAI 给像素 `size`;Gemini 给 `aspect_ratio` + `image_size` 档位。抽象层需要一个「尺寸规格」概念,能分别映射两边。
3. **参考图语义**:OpenAI 独立 edits 端点 + mask(可 inpainting);Gemini 同调用塞多图 + 自然语言编辑,无 mask。→ 统一「mode = 文生图 / 参考图」之外,`mask` 应作为**能力声明**(仅 OpenAI 支持)。
4. **一次多图**:OpenAI `n`;Gemini 需多次调用(待核实)。
5. **鉴权**:OpenAI Bearer + 组织验证;Gemini api-key header。
6. **模型选择**:每家内部还有多档(质量/成本梯度),抽象层的 Model 需带「支持的 mode / 尺寸 / 是否 mask / 价格」等**能力与定价元数据**,供 UI 动态渲染参数面板 + 成本估算。

→ **建议抽象雏形**(仅供 03 参考,非决策):`Provider` 下挂多个 `Model`,每个 `Model` 声明 `capabilities`(modes、sizes/ratios、maxRefImages、supportsMask、supportsN)与 `pricing`;统一 `GenerateRequest{ mode, prompt, refImages[], sizeSpec, n, providerParams }` → `GenerateResult{ images[], usage, timingMs }`。

---

## 五、待核实 / 风险点

1. **Gemini `generateContent` 是否仍支持图像输出**,还是必须走新 Interactions API —— 影响 SDK 选择与抽象。(ticket 03)
2. **Gemini 一次能否多图**(n>1)。
3. **OpenAI 组织实名验证**的具体流程与耗时 —— 是个人开发者能否顺利拿到 GPT Image 访问权的前置。(ticket 05,可能需要一个 `task` 型前置)
4. **gpt-image-2 的每图/每 token 分档价**(low/med/high × size)官方 pricing 页未直接给,需用 calculator 核算。(ticket 07)
5. 价格与模型每季度都变;Imagen 4(2026-08-17)、DALL·E(已到期)等弃用节点需在成本/选型时排除。

---

## 来源(2026-07-15 访问)

- [OpenAI · Image generation guide](https://developers.openai.com/api/docs/guides/image-generation)
- [OpenAI · Pricing](https://developers.openai.com/api/docs/pricing)
- [OpenAI · gpt-image-1 model](https://developers.openai.com/api/docs/models/gpt-image-1) · [gpt-image-1.5](https://developers.openai.com/api/docs/models/gpt-image-1.5) · [gpt-image-1-mini](https://developers.openai.com/api/docs/models/gpt-image-1-mini)
- [OpenAI · Introducing image generation in the API](https://openai.com/index/image-generation-api/)
- [Google · Gemini image generation (Nano Banana)](https://ai.google.dev/gemini-api/docs/image-generation)
- [Google · Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Google · Gemini 2.5 Flash Image model](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-image)
- [Google Cloud · Nano Banana 2 Lite & Gemini Omni Flash](https://cloud.google.com/blog/products/ai-machine-learning/nano-banana-2-lite-and-gemini-omni-flash-available)
