# 技术栈选型

Type: grilling
Status: resolved
Blocked by: 无

## Question

为这个单用户 Web 应用定技术栈:

- **整体形态**:全栈框架(如 Next.js)一体,还是前端 + 独立后端分离?(需要服务端保管各家 API Key,不能纯浏览器直连)
- **语言**:TypeScript?
- **前端 UI 方案**:框架 / 组件库 / 样式方案。
- **服务端**:运行时、如何组织 API route / handler。
- **本地持久化技术**:SQLite / 文件系统 / JSON?(具体数据模型在另一 ticket,这里只定「用什么技术存」)
- **运行方式**:本地 localhost 起服务即可,还是要考虑个人部署?

这是多处决策的地基(数据模型、Key 管理、脚手架都会引用),用 `/grilling` 逐项定。

## Answer

**决策(2026-07-15 拍板):Next.js 全栈一体。**

- **框架 / 形态**:Next.js(App Router)+ Route Handlers,**单进程**。API Key 只在 Route Handler(服务端)读,绝不进前端 bundle。
- **语言**:TypeScript(前后端共享 03 的 provider 抽象类型、能力 / 定价元数据强类型化)。
- **UI**:React + Tailwind + shadcn/ui。
- **持久化技术**:SQLite;具体 ORM(Prisma vs Drizzle)与表结构留到 [数据模型](04-data-model.md) 一起定。
- **运行姿态**:v1 本地 `localhost` 单命令起(`next dev` / `next start`);日后可平滑升级到单容器个人小部署。

依据 [decision-prep-briefs.md · 02](../assets/decision-prep-briefs.md)(选项 A)。**解锁**:密钥管理(05)转入 frontier;数据模型(04)仍等提供商抽象(03)。
