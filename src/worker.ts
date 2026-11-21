import handler, {
	createScheduledHandler,
	EmDashRoom,
	EmDashRoomSite,
	PluginBridge,
} from "@emdash-cms/cloudflare/worker";
import { EmDashDB } from "@emdash-cms/cloudflare/db/do-sql";
import { isReadOnly } from "./lib/platform";
import { lookupSite } from "./lib/sites";
import { findSiteByDomain } from "./lib/platform";
import { MAIN_SLUG, runWithSite, slugFromHost } from "./lib/site-context";
import { OWNER_COOKIE } from "./lib/platform";
import { ensureSiteAdmin, issueSession, SESSION_COOKIE } from "./lib/site-auth";
// emdash 把 database.config 序列化进 virtual module，name 在构建期被固化成
// "emdash-main"。这是与 emdash middleware 共享的同一个模块实例，运行时按
// Host 改写它，才能让每个租户站命中自己的 DO。
import emdashConfig from "virtual:emdash/config";

export { EmDashRoom, EmDashRoomSite, PluginBridge, EmDashDB };

const scheduled = createScheduledHandler();

function ownerFromRequest(request: Request): string {
	const cookie = request.headers.get("cookie") || "";
	const hit = cookie
		.split(";")
		.map((c) => c.trim())
		.find((c) => c.startsWith(`${OWNER_COOKIE}=`));
	return hit ? hit.slice(OWNER_COOKIE.length + 1) : "";
}

function text(body: string, status: number): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
	});
}

/** 后台登录页：把 EmDash 原生 Passkey 页替换成统一密码登录 */
function passwordLoginPage(isMain: boolean, error: string): Response {
	const err = error === "1" ? "密码不正确" : error === "nouser" ? "还没有管理员账号" : error === "nosession" ? "会话创建失败，请重试" : "";
	const label = isMain ? "主站管理后台" : "博客管理后台";
	const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · ${label}</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf9f7;color:#1b1b1b;font:15px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif}
.box{width:min(420px,calc(100% - 40px));padding:36px 32px;background:#fff;border:1px solid rgba(0,0,0,.1);border-radius:16px}
h1{font-size:24px;margin:0 0 6px;font-weight:600}p.sub{color:#666;font-size:13px;margin:0 0 24px}
label{display:block;font-size:13px;color:#555;margin-bottom:8px}
input{width:100%;padding:12px 14px;border:1px solid rgba(0,0,0,.16);border-radius:9px;font-size:15px;margin-bottom:16px}
button{width:100%;padding:13px;border:0;border-radius:9px;background:#1b1b1b;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.err{border:1px solid #f3c2c2;background:#fdf0f0;color:#a33;border-radius:8px;padding:10px 12px;margin-bottom:16px;font-size:13px}
a{color:#0a58ca;font-size:13px}
</style>
<div class="box"><h1>登录${label}</h1><p class="sub">${isMain ? "用平台管理员密码进入。" : "用注册博客时填的密码进入。"}</p>
${err ? `<div class="err">${err}</div>` : ""}
<form method="post" action="/api/admin-login">
<label for="password">密码</label>
<input id="password" name="password" type="password" required autofocus autocomplete="current-password" />
<button type="submit">进入后台</button>
</form>
<p style="margin:18px 0 0;text-align:center"><a href="https://yerinblog.cc.cd/">返回主站</a></p>
</div></html>`;
	return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

const NOT_FOUND = `<!doctype html><meta charset="utf-8"><title>站点不存在</title>
<style>body{font:16px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#faf9f7;color:#1b1b1b}
.box{max-width:460px;padding:32px;text-align:center}a{color:#0a58ca}</style>
<div class="box"><h1 style="font-size:22px;margin:0 0 12px">这个站点还没有开通</h1>
<p style="color:#666;margin:0 0 20px">地址可能拼错了，或者站点已被注销。</p>
<a href="https://yerinblog.cc.cd/create">去注册一个</a></div>`;

const FORBIDDEN = `<!doctype html><meta charset="utf-8"><title>需要站主身份</title>
<style>body{font:16px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#faf9f7;color:#1b1b1b}
.box{max-width:460px;padding:32px;text-align:center}a{color:#0a58ca}</style>
<div class="box"><h1 style="font-size:22px;margin:0 0 12px">这是别人的后台</h1>
<p style="color:#666;margin:0 0 20px">只有站主登录后才能进入管理后台。</p>
<a href="https://yerinblog.cc.cd/login">用站主账号登录</a></div>`;

/**
 * 一个 Worker 服务所有站点：
 * 先按 Host 找到站点，再把请求放进该站点的上下文里交给 EmDash。
 * 数据库层（astro.config.mjs 里的 durableObjects）会按上下文选择对应的 DO。
 */
export default {
	async fetch(request: Request, env: any, ctx: ExecutionContext) {
		const url = new URL(request.url);
		const method = request.method.toUpperCase();
		const isWrite = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
		const isAdmin = url.pathname.startsWith("/_emdash");
		// 登录/登出必须放行，否则额度耗尽时运维被锁在后台外面，无法查看状态。
		const isAuth = url.pathname === "/api/ops/login" || url.pathname === "/api/ops/logout";
		if (isWrite && isAdmin && !isAuth && (await isReadOnly())) {
			return new Response(
				JSON.stringify({ error: true, message: "今日额度已用完，当前为只读模式，北京时间 8 点恢复" }),
				{ status: 503, headers: { "Content-Type": "application/json; charset=utf-8" } }
			);
		}

		let slug = slugFromHost(url.host) || MAIN_SLUG;
		// 自定义域名：非平台域名先查注册表，命中则当作对应站点处理
		const hostname = url.host.split(":")[0].toLowerCase();
		let customDomain = false;
		if (slug === MAIN_SLUG && !hostname.endsWith(".yerinblog.cc.cd") && hostname !== "yerinblog.cc.cd") {
			const byDomain = await findSiteByDomain(hostname);
			if (byDomain) {
				slug = byDomain.id;
				customDomain = true;
			} else {
				return text(NOT_FOUND, 404);
			}
		}
		const multiTenant = !!env.DB_DO;
		// 把 EmDash 原生 Passkey 登录页替换成统一密码登录
		if (url.pathname === "/_emdash/admin/login" && method === "GET") {
			return passwordLoginPage(slug === MAIN_SLUG, url.searchParams.get("error") || "");
		}
		// 让 emdash 的 DO dialect 在本次请求里指向该站自己的数据库。
		// 必须在调用 handler.fetch 之前设置，且每个请求都重设（isolate 复用）。
		if (multiTenant && emdashConfig?.database?.config) {
			(emdashConfig.database.config as any).name = slug === MAIN_SLUG ? "emdash-main" : `site-${slug}`;
		}

		let tenantSite: Awaited<ReturnType<typeof lookupSite>> = null;
		if (multiTenant && slug !== MAIN_SLUG) {
			const site = await lookupSite(slug);
			tenantSite = site;
			if (!site || site.status !== 1) return text(NOT_FOUND, 404);
			// 后台只给站主：主站注册时发的 owner cookie 必须对得上
			// 登录页本身放行，否则未登录用户连密码输入框都看不到
			const isLoginPage = url.pathname === "/_emdash/admin/login";
			if (isAdmin && !isLoginPage && site.owner && ownerFromRequest(request) !== site.owner) {
				return text(FORBIDDEN, 403);
			}
		}

		// 平台账号挂钩：yb-link 请求先在该站 DO 里准备好原生站主 + setup 标记，
		// 否则 EmDash 的 setup 中间件会先一步把请求重定向到安装向导。
		const isYbLink = isAdmin && url.pathname.startsWith("/_emdash/admin/login/yb-link");
		let ybSession: string | null = null;

		let response = await runWithSite(slug, () => (handler as any).fetch(request, env, ctx));
		// 平台账号挂钩：在 emdash 完成 DO 迁移之后再建原生站主 + setup 标记，
		// 并直接写原生 session cookie（API 路由里的 session.set 不保证下发）。
		if (isYbLink) {
			const userId = await ensureSiteAdmin(env, slug);
			if (userId) ybSession = await issueSession(env, userId);
			// 老站点从未同步过标题，登录时补写一次，前台不再显示 "My Blog"。
			if (tenantSite?.title) {
				try {
					const stub = env.DB_DO.get(env.DB_DO.idFromName(`site-${slug}`));
					await stub.query(
						`INSERT INTO options (name,value,revision) VALUES ('site:title',?1,?2)
						 ON CONFLICT(name) DO UPDATE SET value=excluded.value, revision=excluded.revision`,
						[JSON.stringify(tenantSite.title), crypto.randomUUID()]
					);
				} catch { /* 表未就绪时下次登录再补 */ }
			}
		}
		if (ybSession) {
			const location = response.headers.get("Location") || "";
			// 首次挂钩时 setup 中间件会先重定向到安装向导；用户和 setup 标记已在
			// handler 之后写好，这里让它回到 yb-link 再走一次即可直接进入后台。
			const redo = isYbLink && location.includes("/_emdash/admin/setup");
			response = new Response(response.body, response);
			response.headers.append(
				"Set-Cookie",
				`${SESSION_COOKIE}=${ybSession}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
			);
			if (redo) response.headers.set("Location", url.pathname + url.search);
		}
		return response;
	},
	scheduled,
} satisfies ExportedHandler;
