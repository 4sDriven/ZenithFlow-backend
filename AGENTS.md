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
- `src/routes/`：路由
- `src/lib/`：外部服务与业务逻辑（AI、媒体、B站、知识库等）
- `src/db/`：Drizzle schema / client / seed

## 路由

| 前缀 | 文件 | 说明 |
| --- | --- | --- |
| `/api/health` | `routes/health.ts` | 健康检查 |
| `/api/auth` | `routes/auth.ts` | 登录、当前用户、修改自己的密码 |
| `/api/users` | `routes/users.ts` | 用户 CRUD（admin） |
| `/api/video` | `routes/video.ts` | 短视频项目、分镜、配音、成片 |
| `/api/qwen` | `routes/qwen.ts` | 千问余额 |
| `/api/kb` | `routes/kb.ts` | 知识库 |
| `/api/english` | `routes/english.ts` | 英语口语 |
| `/api/bili` | `routes/bili.ts` | B站视频搜索、UP 主搜索 / 投稿、评论、子评论、讨论关系、点赞 / 回复、扫码登录绑定 |
| `/api/newspaper` | `routes/newspaper.ts` | 每日报纸：今日一期、管理员手动重新生成 |

## 环境变量

以 `src/config.ts` 为准：`NODE_ENV`、`HOST`、`PORT`、`DATABASE_URL`、`JWT_SECRET`、`BILI_TOKEN_SECRET`、`DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL`、`MEDIA_DIR`、`PUBLIC_BASE_URL`、`FFMPEG_PATH`、`FFPROBE_PATH`、`QIANWEN_CLI_PATH`。

- 密钥只放 `.env`（600）或环境变量，禁止入库 / 提交
- 媒体目录默认 `/var/lib/zenithflow/media`

## 数据库

PostgreSQL 12 + Drizzle ORM，连接在 `src/db/client.ts`，表定义在 `src/db/schema.ts`：

- `users`：账号、角色（`admin` / `user`）、密码哈希
- `video_projects` / `video_shots`：短视频项目与分镜
- `knowledge_items` / `knowledge_chunks`：知识库条目与向量分块
- `english_series` / `english_episodes` / `english_assignments`：英语素材与每日作业
- `bili_accounts`：站点账号绑定的 B 站登录态（`user_id` 唯一），Cookie / refresh_token 用 AES-256-GCM 加密
- `newspaper_editions`：每日报纸（`edition_date` 唯一、状态、六个版块 JSON、来源统计），只保留最新一期

迁移与种子见 `src/db/`、`src/scripts/`。

## B站模块（`lib/bilibili.ts`）

- 主评论：`/x/v2/reply/wbi/main`（WBI 签名）；`/x/v2/reply/main` 对本机 IP 会 412
- 无限滚动批量：`fetchCommentBatch()` 用 `cursor=<page>:<offset>` 聚合多页（B 站单页 30 条），不假设每页都满 30 条，返回 `nextCursor`；`limit` 上限 200；前端首屏 100、之后每次 50
- 子评论：`/x/v2/reply/reply`（10 条/页）；`normalizeComment()` 会解析 `parent !== root` 的回复关系，返回 `replyTo: { mid, uname }` 并剥离正文前缀
- 讨论关系：`fetchThread()` 用 `/x/v2/reply/reply` 按 20 条/页翻完一个主评论下的子评论，补 `parentRpid/rootRpid`，返回主评论 + 子评论；默认 200 条、最多 800 条，内存缓存 2 分钟；同一 root 并发请求用 `withThreadLock()` 排队，重复打开可增量补页
- 关系图节点按 `mid` 在前端生成稳定用户色，仅图内使用；后端不返回颜色
- 视频信息：`/x/web-interface/view`，必须带 `buvid3/buvid4`
- UP 主搜索：`search_type=bili_user`（`searchUps()`），WBI 签名，20 条/页，最多 50 页
- UP 主投稿：`app.bilibili.com/x/v2/space/archive`（`fetchUpVideos()`），公开 appkey + md5 签名，20 条/页；网页版 `/x/space/wbi/arc/search` 对本机 IP 会 -352，不要用
- **App 投稿接口游客最多翻到第 10 页（200 条）**，第 11 页起返回 `-412 request was banned`，`fetchUpVideos()` 把 page 限制在 1~10
- UP 主信息：`app.bilibili.com/x/v2/space`，缓存 10 分钟；投稿缓存 60 秒
- **评论接口不能带 buvid Cookie**（否则降级为 3 条）
- 出站请求统一走 `scheduleRequest()`：串行 + 200ms 间隔
- 缓存：视频 10 分钟、主评论 60 秒、子评论 2 分钟、搜索 60 秒、页数 6 小时
- `all_count` 含楼中楼，`resolveTotalPages()` 用热门 offset 二分探测真实页数
- 「最新」排序只能顺序翻页（`fetchLatestOffset`，单次最多补走 20 页）
- 热度字段 `heatScore/heatLevel/heatLabel/likeRate` 由 `computeHeat()` 统一计算
- 412 / -352 视为临时限流：退避重试一次后返回 503 中文提示
- 扫码登录：`generateBiliQrCode()` / `pollBiliQrCode()` 调 `passport.bilibili.com/x/passport-login/web/qrcode/*`；成功时优先从 `Set-Cookie` 取 `SESSDATA/bili_jct/DedeUserID`（保留 `%2C` 编码），再用 `fetchBiliNav()` 校验并取 `mid/uname`
- `bili_accounts` 的 Cookie 与 refresh_token 由 `lib/secret-box.ts`（AES-256-GCM，密钥 `BILI_TOKEN_SECRET`）加密；任何接口都不返回 Cookie，也不写日志
- 二维码 key 只存进程内存、绑定当前站点用户、3 分钟失效；生成接口每用户 3 秒冷却
- 写操作（点赞/回复）走 `requestFormJson()`：`application/x-www-form-urlencoded`、带账号 Cookie + `csrf`（取 Cookie 里的 `bili_jct`）、`Origin/Referer`；仍走 `scheduleRequest()` 串行
- 点赞：`POST /x/v2/reply/action`（`oid=aid`、`type=1`、`rpid`、`action=1|0`）；回复/发评论：`POST /x/v2/reply/add`（`root/parent` 为 0 时省略）
- 写操作只在 412 / -412 / -352（请求未执行）时退避重试一次；网络超时等不确定结果**不重试**，避免重复发评论
- `writeCodeToMessage()` 统一把 B 站错误码（-101/-111/12002/12015/12025/12051 等）翻译成中文；回复成功后 `invalidateBiliCommentCache(aid)` 清掉该视频的评论/子评论/页数/关系图缓存
- 写接口只使用当前站点账号自己绑定的 B 站登录态，不接受前端传账号；未绑定返回 409，登录过期/凭据损坏返回 401

## 日报模块（`lib/newspaper/`）

- 入口：`scripts/newspaper-daily.ts`；定时 `zenithflow-newspaper-daily.timer` 每天 00:00（Asia/Shanghai）生成，成功后再删除旧日期，失败保留上一期
- 版块固定顺序：杭州、辽宁本溪、B站吃瓜、Steam、中国、世界；采集器按版块输出 `RawItem`，AI 只能通过 `rawIds` 引用素材，链接/来源/时间从素材回填，避免编造 URL
- 采集源：
  - 民间热搜：百度、知乎、抖音、贴吧直连；微博走 NewsNow 公共聚合
  - B站：热搜词、热门列表、争议关键词搜索（塌房/争议/回应/道歉/翻车/辟谣等）、候选视频评论区
  - Steam：`featuredcategories`（热销/新品/特惠）、`appdetails`、`ISteamNews/GetNewsForApp`
  - 新闻：360 资讯（按时间排序）、Bing News RSS、中国新闻网 RSS、BBC World RSS、NewsNow（澎湃/财联社/华尔街见闻/IT之家）
  - 杭州本地：19楼首页与帮帮团版块热帖（GB18030）
- 所有出站请求统一走 `http.ts` 的串行队列（220ms 间隔），单源失败只记入 `errors`，不阻塞整期
- AI 编排：`qwen-plus`，每个版块一次调用；单版失败用原始素材降级（`degraded=true`）；摘要中素材没有的数字会被替换，整段英文会被替换为中文提示
- `getNewspaperView()` 返回今日状态：优先今日 ready；今日失败/生成中时回退到最近一期 ready，并带 `stale/error` 标记
- 生成并发：进程内 `running` 锁 + 数据库状态；`generating` 超过 30 分钟视为中断
- 接口：`GET /api/newspaper/today`（登录）、`POST /api/newspaper/generate`（管理员，异步）
- 调试：`node dist/scripts/newspaper-daily.js --dry-run` 只采集不调用 AI；`--no-ai` 直接用原始素材出一期

## 约定

- 路由统一 Zod 校验入参，错误返回 `{ ok: false, error: '中文提示' }`
- 需要登录的接口加 `preHandler: [app.requireAuth]`，管理员用 `app.requireAdmin`
- 外部请求必须设置超时（`AbortSignal.timeout`），失败要有降级或明确报错
- 改动后 `npm run build` 必须通过
