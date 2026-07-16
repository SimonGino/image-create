# API Key 管理与配置

Type: grilling
Status: resolved
Blocked by: 02

## Question

单用户场景下,各 Provider 的 API Key 怎么提供、保存、修改:

- **来源**:环境变量 / 配置文件 / 应用内「设置」界面填写?
- **存储**:明文本地文件、还是本地加密?(单用户、个人机器,权衡便利与安全)
- **多 Provider**:每家一个 Key,如何组织与切换。
- **缺失 / 无效 Key 的处理**:UI 如何提示、如何禁用对应 Provider。

依赖技术栈(前后端形态决定 Key 放哪、怎么读)。用 `/grilling` 定。

## Answer

**决策(2026-07-15 拍板):混合来源 —— `.env` 默认 + 应用内 Settings 覆盖;明文本地文件为基线。**

采纳 [decision-prep-briefs.md · 05](../assets/decision-prep-briefs.md) 选项 C:

- **来源**:`.env`(默认 / CI 友好)+ Settings UI 写本地 `config.json`(如 `~/.image-create/config.json`)可覆盖 —— 既照顾命令行开发者、又能在应用里改 key。
- **存储**:明文本地文件(**0600 权限、git-ignored**)为合理基线;**加密 v1 不做**,OS keychain(macOS Keychain / `keytar`)列可选增强。Key **只在服务端(Route Handler)读**,绝不进前端 bundle / localStorage / URL。
- **多 Provider**:按 provider 索引的凭据表 `ProviderCredentials{ openai?:{apiKey}, google?:{apiKey} }`;加第三家 = 加一个键。Model 选择器按「该 provider 是否有有效 key」启用 / 禁用。
- **缺失 / 无效处理**:保存时轻校验(格式 + 一次最小探活);运行时 provider 错误映射成 `AuthError`(见 03),UI 在 Model 选择器旁标「未配置 / key 无效」+「去设置」入口。**任何 `403` 一律归入 `AuthError`**,不做特殊态。

> **更新(2026-07-16):按用户要求,OpenAI 组织验证不纳入设计考量。** 不做专门的「验证未完成」态;组织验证是 OpenAI 侧账号手续,不在本应用范围内。(客观事实仍记录在 [api-facts-followup.md §3](../assets/api-facts-followup.md),但**不作为前置**。)
