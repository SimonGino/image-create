# 图像生成模型与 API 现状调研

Type: research
Status: resolved
Blocked by: 无

## Question

调研当前(2026-07)可用于本应用的图像生成模型与 API,产出一份 markdown 汇总(作为链接资产),覆盖:

- **OpenAI gpt-image 系列**:具体模型 ID、生图端点、支持的参数(尺寸 / 质量 / 数量 / 格式等)、是否支持文生图与参考图(edits / variations、mask)、返回形式(URL / base64)、同步还是异步、按图计费的价格。
- **Google Gemini 生图模型**:具体模型 ID、API 形态、如何传入参考图(多模态输入)、可调参数与能力、返回形式、价格。
- **两家在「文生图」与「参考图生图」上的能力差异**:参考图数量、是否支持 mask、宽高比 / 尺寸的表达方式、生成数量上限、延迟量级。
- **可扩展性观察**:两家 API 形态的共性与差异,为后续「提供商抽象」提供事实依据。

产出 `.scratch/image-app-design/assets/model-api-research.md`,并从本 ticket 链接。**这是事实调研,不做决策。**

## Answer

已完成,产出 [`assets/model-api-research.md`](../assets/model-api-research.md)(含来源与价格表)。要点:

- **OpenAI**:`gpt-image-2` / `gpt-image-1.5` / `gpt-image-1` / `gpt-image-1-mini`(DALL·E 已弃用)。`/v1/images/generations`(文生图)+ `/v1/images/edits`(参考图,**支持 alpha mask 局部重绘**,多图时 mask 作用于第一张)+ Responses API 工具(多轮编辑)。像素 `size`(≤3840×2160)、`quality` low/med/high、`n` 一次多图、png/jpeg/webp;返回 base64,可流式 partial;同步。token 计费(图像输出 $30–32/1M;`gpt-image-1` 每图约 $0.02/$0.07/$0.19)。**需完成组织实名验证**才能用。
- **Google**:Nano Banana 家族 `gemini-3-pro-image` / `gemini-3.1-flash-image` / `gemini-3.1-flash-lite-image` / `gemini-2.5-flash-image`(legacy);Imagen 4 将于 2026-08-17 关停。当前文档走 **Interactions API**(非旧版 `generateContent`,待核实);参考图**最多 14 张、无 mask**(自然语言定向编辑);`aspect_ratio` + `image_size`(0.5K–4K);返回 base64;**始终带 SynthID 水印、无免费额度**;每图约 $0.034–$0.24。
- **对抽象的启示**:共同底座 = 文本 prompt + base64 参考图 → base64 图 + token usage;差异集中在协议形态、尺寸表达、mask、一次多图 → 抽象层的 `Model` 需携带 `capabilities` + `pricing` 元数据。
- **待核实**:Gemini `generateContent` 是否仍支持图像输出、Gemini 能否 n>1、OpenAI 组织验证的具体流程、`gpt-image-2` 分档价。

**解锁 / 影响**:ticket 03「提供商抽象」的事实前置已就位(03 由 blocked → frontier);并为 05(密钥管理需处理 OpenAI 组织验证)、07(成本估算的定价数据)供料。**无新增 ticket、无 fog 毕业**——调研成果直接喂给既有的被阻塞 ticket。
