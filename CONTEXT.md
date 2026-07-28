# image-create

单用户本地图像生成应用：多提供商（OpenAI / Google）文生图与参考图生图，带历史、成本与提示词管理。

## Language

**Generation（生成）**:
一次用户发起的生成请求及其全部结果——n 张图、汇总的 usage 与费用、单一状态（pending/success/error）。是历史记录、成本统计的最小粒度单位。一次 Generation 底层可能对应多次 provider API 调用（Gemini 多图并发），但 API 调用不是领域概念。
_Avoid_: 调用记录、API 调用（作为记录单位）、任务

**Provider（提供商）**:
一家图像模型供应方（OpenAI、Google），各自有独立的密钥、base URL 与适配器。

**Model（模型）**:
某 Provider 下的一个具体模型，由能力元数据（capabilities）与价格（pricing）描述。

**Mode（模式）**:
Generation 的两种形态之一：文生图（t2i）或参考图生图（reference）。

**Gallery（图库）**:
以图片为中心的 Generation 浏览视图——缩略网格 + 详情。回答"我生成过哪些图"。

**History（记录）**:
以流水为中心的 Generation 列表视图——全状态表格（时间、模型、状态、耗时、费用），回答"我发起过哪些生成、成败与花费"。与 Gallery 是同一实体的两种投影。
_Avoid_: 日志、调用列表、审计

**Prompt Template（提示词模板）**:
可收藏、可复用的提示词，附默认模型。
