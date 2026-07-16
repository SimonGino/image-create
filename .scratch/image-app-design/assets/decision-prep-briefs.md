# 决策预备 · Option Briefs (Part B · tickets 02–07)

> 资产 for tickets 02–07(HITL 决策类) · 编制日期:**2026-07-15**
> 依据:[`model-api-research.md`](model-api-research.md) + [`api-facts-followup.md`](api-facts-followup.md)
> **性质:选项 + 推荐,供人拍板。不替人做决策。** 每节给 2–3 个具体选项、权衡、一个可接受 / 可推翻的推荐。
> 术语沿用 map.md:Provider / Model / Generation / Mode / Parameter Set / Gallery / Prompt Template / Usage-Cost Record。

前提贯穿全文:**单用户、无登录、本地跑、需服务端保管 API Key(不能浏览器直连)、TypeScript**。

---

## 02 · 技术栈选型 (grilling)

**要定**:整体形态(全栈一体 vs 前后端分离)、语言、UI 方案、服务端运行时 / route 组织、本地持久化技术、运行 / 部署姿态。

### 选项

| | A. Next.js 全栈一体 | B. Vite+React SPA + 独立 Node 后端 | C. TanStack Start / Remix 全栈 |
|---|---|---|---|
| 形态 | 单进程,App Router + Route Handlers | 双进程(前端 dev server + Fastify/Express) | 单进程,loader/action 一体 |
| Key 存放 | Route Handler(仅服务端)天然隔离 | 后端持有,前端经自家 API 代理 | server function / action 内 |
| UI / 样式 | React + Tailwind + shadcn/ui | React + Tailwind + shadcn/ui | React + Tailwind + shadcn/ui |
| 持久化 | SQLite(better-sqlite3 或 Prisma/Drizzle) | 同左,由后端持有 | 同左 |
| 运行 | `next dev` / `next start`,单端口 | 两个进程 + CORS/代理 | 单命令 dev/build |
| 心智负担 | 低(约定多、glue 少) | 中(前后端契约 / 两套启动) | 低–中(较新,生态小于 Next) |

### 权衡

- **A 最省 glue**:单进程、Route Handler 天然把 Key 关在服务端、`localhost` 一条命令起;缺点是「框架味重」、SSR/RSC 概念对纯本地小应用略过度。
- **B 最直白解耦**:前端就是 SPA,后端就是普通 REST;适合想把「provider 抽象」做成清晰独立服务、或日后换前端;代价是双进程 + CORS/代理 + 契约维护。
- **C 居中**:全栈单进程但比 Next 轻、loader/action 模型直观;代价是生态 / 招人 / 示例少于 Next,踩坑时资料少。
- 三者都能满足硬约束(服务端存 Key、本地持久化)。**语言维持 TypeScript** 无争议(两端共享 provider 抽象的类型、能力 / 定价元数据强类型化收益大)。
- **部署姿态**:v1 就 `localhost` 单机起服务即可(map.md 已把「部署」列为次要);A/C 天然可平滑升级到个人小部署(单容器),B 需打包两进程。

### 推荐(可推翻)

**A(Next.js 全栈)+ TypeScript + Tailwind + shadcn/ui + SQLite(Drizzle 或 better-sqlite3)。** 理由:单用户本地应用,最小化「前后端 glue / 双进程 / CORS」;Route Handler 保管 Key 最省心;生态最大、`/prototype`(06)也最容易照做。**若人更看重 provider 抽象作为独立可测服务** → 选 B。ORM 选择(Prisma 迁移友好 vs Drizzle 轻量贴近 SQL)留到 04 一起定。

---

## 03 · 提供商 / 模型抽象 (grilling + domain-modeling)

**要定**:统一请求 / 响应模型、能力声明(供 UI 动态渲染 + 校验)、调用 / 延迟 / 错误语义、加第三家的改动面。
**关键事实(来自 Part A)**:Gemini 每次稳定 1 张(`supportsN=false`);Gemini 无 mask;OpenAI 有 mask(仅 edits 第一张);尺寸两套表达(OpenAI 像素 `size` vs Gemini `aspect_ratio`+`image_size`);Gemini 现状 `generate_content` 可用、Interactions API 为未来主路径。

### 两种抽象形状

**Shape A —「能力元数据 + 适配器」(推荐雏形)**:`Provider` 挂多个 `Model`,每个 `Model` 声明 `capabilities` + `pricing`;统一 `generate(req) → result`,`SizeSpec` 用判别联合分别映射两家。

```ts
type ProviderId = 'openai' | 'google';           // 加第三家:并集里加一个字面量
type Mode = 't2i' | 'reference';                  // 文生图 / 参考图生图

// 尺寸规格:判别联合,分别映射 OpenAI 像素 与 Gemini 比例+档位
type SizeSpec =
  | { kind: 'pixels'; width: number; height: number }        // OpenAI: → size "1024x1536"
  | { kind: 'ratio'; aspectRatio: AspectRatio; imageSize: ImageSizeTier }; // Gemini: → aspect_ratio + image_size
type AspectRatio = '1:1'|'3:2'|'2:3'|'3:4'|'4:3'|'4:5'|'5:4'|'9:16'|'16:9'|'21:9';
type ImageSizeTier = '0.5K'|'1K'|'2K'|'4K';

interface ModelCapabilities {
  modes: Mode[];
  maxRefImages: number;        // OpenAI 多张(mask 限第一张); Gemini 3-pro=14 / 2.5=3
  supportsMask: boolean;       // OpenAI true / Gemini false
  supportsN: boolean;          // OpenAI true / Gemini false(见 Part A §2)
  maxN: number;                // Gemini=1
  sizeSpecKind: 'pixels' | 'ratio';
  pixelSizes?: string[];       // OpenAI 枚举 + 约束
  aspectRatios?: AspectRatio[]; imageSizeTiers?: ImageSizeTier[]; // Gemini
  outputFormats: ('png'|'jpeg'|'webp')[];
  extraParams?: ParamSchema[]; // provider 私有参数的声明式 schema,供 UI 动态渲染 + 校验
}

interface ModelPricing {        // 喂给 07 成本估算
  unit: 'token';
  imageOutputPerMTok: number;   // gpt-image-2=30 / 1.5=32 / gemini-3-pro=120 ...
  textInputPerMTok?: number; imageInputPerMTok?: number;
  perImageTable?: Record<string, number>; // 可选:size×quality→$ 静态表(1.5 有;2 走 calculator)
}

interface ModelDescriptor {
  id: string; providerId: ProviderId; label: string;
  capabilities: ModelCapabilities; pricing: ModelPricing;
}

interface GenerateRequest {
  providerId: ProviderId; modelId: string;
  mode: Mode; prompt: string;
  refImages?: RefImage[];       // { data: base64; mimeType: string; role?: 'image'|'mask' }
  sizeSpec: SizeSpec;
  n?: number;                   // Gemini 恒为 1
  quality?: 'low'|'medium'|'high'|'auto';   // 主要 OpenAI
  outputFormat?: 'png'|'jpeg'|'webp';
  providerParams?: Record<string, unknown>; // 私有逃生口,按 extraParams 校验
}

interface GeneratedImage { data: string; mimeType: string; width?: number; height?: number; }
interface GenerateResult {
  images: GeneratedImage[];
  usage: { textInputTokens?: number; imageInputTokens?: number; imageOutputTokens?: number };
  costEstimateUSD?: number;     // 据 usage × pricing 折算(07)
  timingMs: number;
  raw?: unknown;                // 保留原始响应,便于排错 / 图文交错(gemini-3-pro steps)
}

interface ImageProviderAdapter {
  readonly providerId: ProviderId;
  listModels(): ModelDescriptor[];
  validate(req: GenerateRequest): ValidationResult;   // 用 capabilities 前置校验
  generate(req: GenerateRequest): Promise<GenerateResult>;
}
```

**Shape B —「窄统一接口 + provider 私有 escape hatch 更薄」**:同样的 `GenerateRequest/Result`,但**不做 `SizeSpec` 判别联合**,统一只收 `{ width, height }` 像素,由各 adapter 内部把像素**近似映射**到最接近的 Gemini `aspect_ratio`+`image_size`。请求模型更简单、UI 只出一套尺寸控件;代价是 Gemini 侧有「像素→比例档位」的有损映射、且用户选不到 Gemini 特有的 21:9 等。

### 权衡

| 维度 | Shape A(判别联合 SizeSpec) | Shape B(统一像素 + 内部映射) |
|---|---|---|
| 忠实度 | 高(两家尺寸都原样表达) | 中(Gemini 尺寸有损近似) |
| UI 复杂度 | 参数面板随 `sizeSpecKind` 切换 | 单一尺寸控件,简单 |
| 校验 | `capabilities` 声明式,强 | 简单但会「静默纠偏」 |
| 加第三家 | 实现 `ImageProviderAdapter` + 注册 `ModelDescriptor[]`(改动面:一个新文件 + 注册表加一行) | 同左,但尺寸映射逻辑更绕 |

### 调用 / 延迟 / 错误语义

- **同步请求-响应**为主(两家都同步;OpenAI 可流式 partial,v1 可不接)。UI 侧 loading / 可取消。
- **错误分类**建议统一成:`AuthError`(缺 / 无效 key、OpenAI 未验证 403)、`ValidationError`(能力不匹配,前置拦截)、`RateLimit`、`ProviderError`、`Timeout`。重试仅对幂等的网络 / 5xx / RateLimit,且**参考图生图默认不自动重试**(可能已扣费 / 语义不确定)。
- **Gemini 多图**:`supportsN=false` → 若 UI 允许「一次 N 张」,由**调用层并发 N 次** `generate()`(见 Part A §2),对上层仍呈现为一个逻辑 Generation 的多结果。

### 推荐(可推翻)

**Shape A**。判别联合的 `SizeSpec` + 声明式 `capabilities`/`pricing` 元数据,恰好吃掉研究里点名的四处差异(协议 / 尺寸 / mask / 多图),且**同一份 `capabilities` 能同时驱动 UI 参数面板(06)与成本估算(07)**,一鱼多吃。加第三家 = 写一个 adapter + 往注册表加它的 `ModelDescriptor[]`。**若人更想要极简、可接受 Gemini 尺寸有损** → Shape B。Gemini adapter 内部协议先用 `generate_content`,预留切 Interactions API。

---

## 04 · 数据模型与本地持久化 (grilling)

**要定**:Generation 记录字段、图片存哪(FS vs blob / 缩略图)、Prompt Template 结构、Usage-Cost 记录结构、落到 02 选的持久化上。

### 选项(存储载体)

| | A. SQLite(关系表) + 图片走文件系统 | B. JSON 平面文件(每 Generation 一份 + index) |
|---|---|---|
| 图库 / 历史检索 | 强(索引、分页、过滤) | 弱(自己扫目录 / 维护 index) |
| 成本 / 用量聚合 | 强(`GROUP BY` provider/model/day) | 需应用层自己算 |
| 事务 / 一致性 | 强 | 弱(并发写易坏) |
| 上手 / 可读 | 中(需 ORM/迁移) | 高(直接看文件) |
| 依赖 | better-sqlite3 / Prisma / Drizzle | 无 |

**图片本身**两家 API 都返回 base64;两种放法:
- **FS 路径(推荐)**:图片写成 `data/images/{generationId}/{idx}.png`,DB 只存相对路径 + 缩略图路径。DB 小、图片可直接被浏览器 / 文件管理器看。
- **DB blob 内嵌**:单文件自包含、备份简单;但 SQLite 存大 blob 会让库膨胀、查询变慢。→ v1 不推荐,除非坚持「单文件可搬走」。
- **缩略图**:生成时用 sharp 出一张 256–512px webp,专供 Gallery 网格,避免每次加载原图。

### 建议 schema(以 A · SQLite 表达;字段名镜像 03 的请求 / 响应)

```
generations
  id (uuid, pk)            created_at (ts)
  provider_id  model_id
  mode ('t2i'|'reference') prompt (text)
  size_spec (json)         quality  output_format  n_requested
  provider_params (json)   status ('ok'|'error')  error_code
  timing_ms
  -- usage(可内联,或拆到 usage_records)
  text_input_tokens  image_input_tokens  image_output_tokens  cost_usd

generation_images
  id (pk)  generation_id (fk)  idx
  file_path  thumb_path  width  height  mime_type

generation_ref_images        -- 参考图生图的输入图(可选保存)
  id (pk)  generation_id (fk)  idx  file_path  role ('image'|'mask')

prompt_templates
  id (pk)  title  body (text)  created_at  favorite (bool)
  variables (json, 可选:{{name}} 占位符声明)  default_provider_id  default_model_id

usage_records                 -- 若不内联在 generations,则每次生成落一行
  id (pk)  generation_id (fk)  created_at
  provider_id  model_id
  text_input_tokens  image_input_tokens  image_output_tokens
  images_count  cost_usd  cost_source ('estimated'|'actual')
```

> 若选 B(JSON),同样字段落成:`data/generations/{id}.json`(记录)+ `data/images/{id}/*.png`(图)+ `data/index.json`(列表缓存)+ `data/templates.json`。用量聚合靠应用层遍历。

### 权衡与推荐(可推翻)

- 本应用核心就是**「历史 / 图库 + 成本用量聚合」**——这正是关系库的主场(分页、按 provider/model/时间过滤与 `GROUP BY`)。JSON 方案会很快在「按月汇总花费」「按模型筛图」上变吃力。
- **推荐 A:SQLite + 图片走文件系统 + sharp 缩略图**;`usage` 先**内联进 `generations`**(单用户、一次生成一条,够用),若日后要更细的用量分析再拆出 `usage_records`。`size_spec` / `provider_params` 用 JSON 列存,天然对齐 03 的判别联合。**若人极重视「零依赖 / 整个 data 目录可直接拷走」** → B。ORM:Prisma(schema + 迁移友好)vs Drizzle(轻、贴 SQL)二选一,跟 02 一起拍。

---

## 05 · API Key 管理与配置 (grilling)

**要定**:Key 来源(env / 配置文件 / 应用内设置)、存储(明文 vs 本地加密)、多 Provider 组织、缺失 / 无效处理。**含 OpenAI 组织验证前置**(Part A §3)。

### 选项

| | A. 环境变量 / `.env` | B. 应用内 Settings UI → 本地配置文件 | C. 混合(env 兜底 + Settings 覆盖) |
|---|---|---|---|
| 填写方式 | 手改 `.env`,重启读 | 应用里表单填 / 改,即时生效 | 有 env 用 env,UI 可覆盖 |
| 存储 | `.env`(明文,git-ignored) | `~/.image-create/config.json`(明文 or OS keychain) | 二者 |
| 换 Key 便利 | 低(改文件 + 重启) | 高 | 高 |
| 契合单用户本地 | 好(开发者友好) | 好(非命令行用户友好) | 最灵活 |
| 复杂度 | 最低 | 中(要做设置页 + 读写 + 校验) | 中–高 |

**多 Provider 组织**(三选项通用):存成一张按 provider 索引的表:

```ts
interface ProviderCredentials {
  openai?: { apiKey: string; orgVerified?: boolean; verifiedAt?: string };
  google?: { apiKey: string };
  // 第三家:加一个键即可
}
```
UI 的 Model 选择器按「该 provider 是否有有效 key」启用 / 禁用。

**存储:明文 vs 加密**——单用户个人机器,**明文本地文件(0600 权限、git-ignored)已是常见且够用**的基线;想再稳一点可用 OS keychain（macOS Keychain / `keytar`）或用一个本地口令派生密钥加密该文件。**别把 Key 塞进前端 bundle / localStorage / URL**——始终只在服务端读。

**缺失 / 无效 Key 处理**:
- **保存时**轻校验(格式 / 一次 `models.list` 或最小请求探活)。
- **运行时**把 provider 错误映射成 `AuthError`(见 03):UI 在 Model 选择器旁标「未配置 / key 无效」,禁用该 provider 并给「去设置」入口。
- **OpenAI 未验证**:捕获 `403 / organization must be verified` → 单独提示「需完成组织验证」+ 跳官方验证页链接(**不是普通 key 错误**)。

### OpenAI 组织验证(必须写进落地步骤)

- **一次性人工前置,应用无法自动化**(Part A §3):控制台 Settings→Organization→General→Verifications,证件 + 活体,处理约 15–30 分钟,**一证 90 天一组织、失败不可重试、通过≠必然有权限(还看 tier)**。
- 落地建议:(1) onboarding / Settings 里放静态指引 + 链接;(2) 运行时 403 → 专门的「验证未完成」态,而非静默失败;(3) **开工前先由人跑通验证**,再接 gpt-image。

### 推荐(可推翻)

**C 混合**:`.env` 作为默认 / CI 友好来源,**再加一个 Settings UI 写本地 `config.json`(明文、0600、git-ignored)可覆盖**——单用户既照顾命令行开发者又照顾「应用内改 key」。加密先不做(明文文件 + 文件权限是合理基线),把「OS keychain 加密」列为可选增强。**若想最快出活** → 纯 A(`.env`),Settings 页留到以后。无论选哪个,组织验证指引 + 403 专门处理都要有。

---

## 06 · 主界面与图库 UX 原型 (prototype —— 现场与人共建,勿预先搭)

> 本 ticket 是 `/prototype`,**要和人一起现场搭一次性原型,这里只 tee up 选项,不建原型**。参数面板须照 03 的 `capabilities` 动态渲染。

### 两种「生成主界面」布局

**Layout 1 —「双栏控制台」**(参数密集型,偏 Playground / ComfyUI 感)
- 左栏 = 控制区:prompt 输入、Mode 切换(t2i / reference)、Model 选择器、**动态参数面板**(随 Model.capabilities 变:OpenAI 出 `size`+`quality`+`n`;Gemini 出 `aspect_ratio`+`image_size`、隐藏 `n`)、参考图上传区(reference 模式才显)、**实时成本预估**、Generate 按钮。
- 右栏 = 结果区:大图预览 + loading / 进度态 + 结果操作(下载 / 存模板 / 重生 / 删)。
- Gallery = 顶部 tab / 侧栏路由切过去。

**Layout 2 —「居中单列 / 对话流」**(偏 ChatGPT / Midjourney web 感)
- 中间从上到下是结果流(每次 Generation 一张卡:prompt 摘要 + 结果图 + 用量 / 成本 + 操作)。
- 底部固定 prompt 输入条 + Mode 切换 + Model 选择;**参数收进「⚙ 参数」抽屉 / popover**(默认收起,进阶才展开)。
- 左侧常驻 History 侧栏(时间倒序缩略），点开回看 / 重生。

| | Layout 1 双栏 | Layout 2 对话流 |
|---|---|---|
| 参数可见性 | 全摊开,适合调参狂 | 收进抽屉,界面干净 |
| 首次上手 | 信息略多 | 更亲和 |
| 结果历史 | 靠 Gallery 页 | 天然内联在主流 |
| 与动态参数面板契合 | 很好(左栏专门给它) | 好(抽屉里渲染) |

### Gallery / History 视图(两布局通用)

- 缩略图**网格**(用 04 的 `thumb_path`),按时间倒序;过滤器:provider / model / mode / 时间。
- 点开 = 详情:原图 + 完整参数 + 用量 / 成本 + 操作(**重生**=把该 Generation 的 request 回填到主界面;下载;删除;**存为 Prompt Template**)。

### 其它元素落位

- **Prompt Template / 收藏**:prompt 输入框旁一个「模板」入口(下拉 / 抽屉)——插入模板、把当前 prompt 存为模板、收藏切换。
- **成本 / 用量**:两处——(a) 生成前在 Generate 按钮附近显示**单次预估**;(b) 一个 Usage 小页 / 卡展示**累计**(见 07)。

### 参考模式 / 现有产品

OpenAI Playground(images)、Google AI Studio、Midjourney web、Leonardo.ai、AUTOMATIC1111 / ComfyUI(动态参数面板范式)、Fal / Replicate playground。**建议现场原型用 Layout 2 起步**(上手友好、结果历史内联),但把「动态参数面板」当第一验证点——因为它直接吃 03 的 `capabilities`。**留给人现场定**。

---

## 07 · 成本估算与用量统计 (grilling)

**要定**:单次成本(生成前预估 vs 生成后据实)、用量维度(provider / model / 时间)、数据来源、呈现口径。**定价事实见 Part A §4;记录落 04 的 usage 结构。**

### 单次成本:三种口径

| | A. 生成前预估(pricing × 参数) | B. 生成后据实(返回 usage token) | C. 两者都要(预估 + 据实) |
|---|---|---|---|
| 时机 | 点 Generate 前实时显示 | 结果回来后计算 | 前给预估、后落实际 |
| 准确度 | 近似(t2i 较准;参考图含输入 token 难precise) | 准(读实际 token) | 最佳 |
| 数据源 | 03 的 `ModelPricing` 元数据 | 响应 usage / usageMetadata | 二者 |
| gpt-image-2 | 走 calculator / 推导(Part A §4d,任意分辨率不精确) | 精确 | 预估近似 + 据实纠正 |
| Gemini | 每图档位价较好估;张数=请求次数 | 读 usageMetadata | 同上 |

**算法**:预估 = `imageOutputTokens(size,quality) × imageOutputPerMTok / 1e6 × n`(+ 参考图模式加 `imageInputTokens`);据实 = 用返回的 `image_output_tokens` 等实测值 × 费率。OpenAI `perImageTable`(1.5 有)可直接查表;gpt-image-2 / 大尺寸走 token×费率;Gemini 用每图档位表。

### 用量统计维度

- **累计**:总张数、总花费(USD)。
- **分组**:按 **provider**、按 **model**、按**时间**(日 / 周 / 月)——SQLite `GROUP BY` 直出(04 选 A 的红利)。
- **口径标注**:每条 Usage-Cost 记 `cost_source ∈ {estimated, actual}`,汇总时优先用 actual;缺 usage 的老记录用 estimated 兜底。货币固定 USD,小数精度到 $0.001。

### 呈现(与 06 呼应)

- **生成前**:Generate 按钮旁「≈ $0.03」单次预估(参数一变就更新)。
- **生成后 / 详情**:该 Generation 的实际 token + 实际花费。
- **累计**:一个 Usage 卡 / 小页:总花费、总张数、按 model 的分组条 / 表、按月趋势。

### 推荐(可推翻)

**C —— 预估 + 据实并存**:生成前用 03 的 `pricing` 元数据给**预估**(纯 UX 提示、明确标「≈」);生成后把**返回 usage 折算的实际花费**写进 04 的 usage 记录,作为**统计口径的 single source of truth**。理由:预估让人生成前心里有数,据实保证累计统计准确;尤其 **gpt-image-2 任意分辨率下预估不精确(Part A §4d),必须靠据实纠偏**。用量维度先做 **provider / model / 月** 三个,够个人自用;更多维度按需再加。**若想极简** → 只做 B(据实),省掉预估 UI。

---

## 跨 ticket 的最关键待决(给人快速拍板用)

1. **02 整体形态**:Next.js 全栈一体(推荐)vs 前后端分离——**其它多处(04/05/脚手架)都引用它,建议先定**。
2. **04 图片存法 + 存储载体**:SQLite + 文件系统图片(推荐)vs 纯 JSON;以及图片 FS 路径 vs DB blob。
3. **05 Key 来源 / 是否加密**:`.env` vs 应用内 Settings vs 混合(推荐混合、明文基线);并确认**谁、何时去跑 OpenAI 组织验证**(硬人工前置)。
4. **03 SizeSpec 忠实度**:判别联合(推荐,两家尺寸各表各的)vs 统一像素有损映射——直接决定 06 参数面板与 07 估算的形状。
