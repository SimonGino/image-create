# 提供商 / 模型抽象设计

Type: grilling
Status: resolved
Blocked by: 01

## Question

设计把 gpt-image 与 Gemini(及未来第三家)统一到一层接口之下的抽象:

- **统一请求模型**:mode(文生图 / 参考图生图)、prompt、参考图(几张?)、通用参数 vs 提供商私有参数如何表达。
- **统一响应模型**:一次 Generation 返回什么(图、元数据、耗时、用量)。
- **能力声明**:每个 Provider / Model 声明自己支持哪些 mode、哪些参数、参数取值范围——供 UI 动态渲染参数面板、供校验。
- **调用流程与延迟**:同步 / 异步、错误与重试语义(与「生成延迟」迷雾收拢)。
- **可扩展性**:新增一个 Provider 需要实现什么、改动面多大。

依赖「图像生成模型与 API 现状调研」的事实结论。用 `/grilling` + `/domain-modeling` 定,并沉淀术语。

## Answer

**决策(2026-07-15 拍板):Shape A —— 能力元数据 + 适配器,`SizeSpec` 用判别联合。**

采纳 [decision-prep-briefs.md · 03](../assets/decision-prep-briefs.md) 的 Shape A 接口设计(定型术语,喂给 04/06/07):

- **`SizeSpec` 判别联合**:`{kind:'pixels',width,height}`(OpenAI)/ `{kind:'ratio',aspectRatio,imageSize}`(Gemini)—— 两家尺寸各表各的、无损。
- **统一请求 / 响应**:`GenerateRequest{ providerId, modelId, mode, prompt, refImages[], sizeSpec, n?, quality?, outputFormat?, providerParams? }` → `GenerateResult{ images[], usage, costEstimateUSD?, timingMs, raw? }`。
- **能力 / 定价元数据**:`ModelDescriptor{ capabilities, pricing }`。`capabilities`(modes、maxRefImages、supportsMask、supportsN、maxN、sizeSpecKind、sizes/ratios、outputFormats、`extraParams` 声明式 schema)**同时驱动 06 参数面板 + 前置校验**;`pricing`(imageOutputPerMTok、text/imageInput、可选 perImageTable)**喂给 07 估算**。
- **适配器**:`ImageProviderAdapter{ providerId, listModels(), validate(req), generate(req) }`。加第三家 = 写一个 adapter + 往注册表加它的 `ModelDescriptor[]`。
- **调用 / 错误语义**:同步请求-响应(OpenAI 流式 partial v1 暂不接);错误统一为 `AuthError`(含无效 key、403 无权限)/ `ValidationError`(能力前置拦截)/ `RateLimit` / `ProviderError` / `Timeout`;**参考图生图默认不自动重试**(可能已扣费)。
- **Gemini 多图**:`supportsN=false`;UI 要「一次 N 张」由**调用层并发 N 次** `generate()`,对上层仍是一个逻辑 Generation 的多结果。
- **Gemini 协议路径**:adapter 短期用 `generate_content`,**预留切 Interactions API**。

**解锁**:数据模型(04)与界面原型(06)转入 frontier。
