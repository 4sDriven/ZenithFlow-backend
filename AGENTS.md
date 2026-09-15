# 后端规则（backend）

Node 20 + Fastify + TypeScript + Zod。

## 命令

- `npm run dev`：开发模式（tsx watch，热重载）
- `npm run build`：编译到 `dist/`
- `npm run start`：运行 `dist/`
- `npm run typecheck`：仅类型检查

## 结构

- `src/index.ts`：入口，启动监听
- `src/app.ts`：构建 Fastify 实例，注册插件与路由
- `src/config.ts`：环境变量（Zod 校验）
- `src/routes/`：路由（当前提供 `GET /api/health`）

## 环境变量

见 `.env.example`：`NODE_ENV`、`HOST`、`PORT`、`DATABASE_URL`（可选）。

## 数据库（预留，尚未接入）

- 目标：PostgreSQL
- 计划：Drizzle ORM + `pg`
- 接入步骤（待做）：
  1. `npm install drizzle-orm pg`，`npm install -D drizzle-kit @types/pg`
  2. 新增 `src/db/`（schema、client），并在 `src/app.ts` 注册
  3. 在 `.env` 配置 `DATABASE_URL`

当前未接库，`DATABASE_URL` 缺省不影响启动。
