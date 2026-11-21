# Emdash Plat

一个跑在 Cloudflare Workers 上的多租户博客平台：用户注册一个子域，就得到一套完整独立的博客后台。

底层是 [EmDash](https://github.com/emdash-cms/emdash)（Astro + Durable Objects），主站负责注册、登录、额度与运维，每个租户站拥有自己的 SQLite 数据库。

## 特性

- **注册即建站**：填地址、名称、密码，几秒得到一个 `<slug>.yourdomain.com` 博客
- **每站独立数据库**：一个站点一个 Durable Object，内容互不可见
- **双后台登录**：平台密码直接进 EmDash 原生后台，Passkey 登录仍可用
- **原生用户体系**：注册时自动在该站创建 `role=50` 站主，权限模型完整
- **额度保护**：全平台共用免费 Worker 额度，用满 95% 自动切只读（站点仍可访问）
- **限流防滥用**：同一浏览器一站、同一 IP 按小时限注册
- **运维面板**：站点管理、操作日志、额度与流量看板
- **自定义域名**：站主可绑定自己的域名（需在 Cloudflare 配置 DNS 与 Worker Route）
- **零图片存储**：只允许外链图床，不消耗 R2 额度

## 架构

```
                    ┌───────────────────────────┐
  yourdomain.com →  │ emdash-main（主站 Worker） │
                    │ D1: platform_site / users  │
                    └──────────┬────────────────┘
                               │ 注册 / 登录 / 额度
                    ┌──────────▼────────────────┐
  *.yourdomain.com →│ emdash-sites（租户 Worker）│
                    │ DO: site-<slug> × N       │
                    └──────────┬────────────────┘
                               │
                    ┌──────────▼────────────────┐
                    │ SESSION（KV，共享会话）     │
                    └───────────────────────────┘
```

- **主站**：`src/pages` 下的注册、登录、看板、运维页面，数据在 D1
- **租户站**：同一份源码用 `YB_SITES=1` 构建，数据库切到 Durable Objects，按 Host 选择 `site-<slug>`
- **会话**：两边共用同一个 `SESSION` KV 和 `astro-session` Cookie

## 快速开始

```bash
npm install
cp .env.example .env      # 填入 EMDASH_ENCRYPTION_KEY
npm run dev
```

打开 `http://localhost:4321/_emdash/admin` 完成初始化。本地默认使用 D1 模拟。

## 配置

### 必填 secrets

```bash
npx wrangler secret put OPS_PASSWORD          # 运维面板 + 主站后台密码
npx wrangler secret put EMDASH_ENCRYPTION_KEY # EmDash 加密密钥，任意长随机串
```

### 可选 secrets（流量看板）

```bash
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put CF_ANALYTICS_TOKEN    # 需要 Zone Analytics Read 权限
npx wrangler secret put CF_ZONE_ID
```

未配置时看板显示"统计未接入"，不影响其他功能。

### 改成你自己的域名

1. 全局替换 `yerinblog.cc.cd` 为你的域名（`src/`、`wrangler*.jsonc`）
2. 在 `wrangler.jsonc` / `wrangler.sites.jsonc` 里替换成你自己的 D1 `database_id` 和 KV `id`
3. 创建资源：

```bash
npx wrangler d1 create emdash-main
npx wrangler kv namespace create SESSION
```

## 构建与部署

两套产物，必须分别构建部署：

```bash
# 主站（D1）
npx astro build
npx wrangler deploy -c dist/server/wrangler.json

# 租户站（Durable Objects）
YB_SITES=1 npx astro build
npx wrangler deploy -c wrangler.sites.jsonc
```

> 内存较小的机器上构建可能 OOM，建议 `env -u NODE_OPTIONS` 后执行。

## 注册流程

1. `/create` 提交地址、名称、密码
2. 写入 `platform_site`（D1），并在主站 `users` 表登记一个 `role=10` 占位账号
3. 签发 10 分钟有效的 HMAC token，跳转到 `https://<slug>.<domain>/_emdash/admin/login/yb-link`
4. 该站的 EmDash 完成数据库迁移后，创建 `role=50` 原生站主、写入 `emdash:setup_complete`
5. 下发 `astro-session`，直接进入后台

之后每次登录：`/login` 校验站点密码 → 同样的 yb-link 流程 → 原生后台。

## 目录结构

```
src/
├── pages/
│   ├── api/              # 注册、登录、账号、运维接口
│   ├── _emdash/          # 覆盖 EmDash 的后台登录入口
│   ├── dashboard.astro   # 站主看板
│   └── ops/              # 运维面板
├── lib/
│   ├── platform.ts       # 平台表、额度、域名
│   ├── site-auth.ts      # 原生用户挂钩、会话签发
│   ├── site-context.ts   # 按 Host 解析站点、选择 DO
│   └── stats.ts          # Cloudflare 流量统计
├── layouts/Base.astro
└── worker.ts             # Worker 入口：路由、隔离、登录页
```

## 说明

- 图片只支持外链，媒体库上传已禁用
- 自定义域名需要在 Cloudflare 侧把域名 CNAME 到 Worker 并配置 Route，平台只负责登记与匹配
- 免费额度下建议控制站点数量与请求量

## 许可证

MIT，见 [LICENSE](./LICENSE)。项目基于 Cloudflare 的 EmDash 博客模板。
