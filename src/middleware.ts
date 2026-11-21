import { defineMiddleware } from "astro:middleware";
import { getQuota, isReadOnly } from "./lib/platform";
import { env } from "cloudflare:workers";

/**
 * 全局中间件：
 * 1. 计算额度状态，注入 locals，供布局显示横幅
 * 2. 额度耗尽时阻断写操作（后台、注册、评论），页面仍然可读
 * 3. 演示站后台守卫：设置 DEMO_ADMIN_KEY 后，未解锁访问 /_emdash/admin 返回 404
 */
export const onRequest = defineMiddleware(async (context, next) => {
	const url = context.url;
	const method = context.request.method.toUpperCase();
	const path = url.pathname;

	const [quota, readOnly] = await Promise.all([getQuota(), isReadOnly()]);
	(context.locals as any).quota = quota;
	(context.locals as any).readOnly = readOnly;

	// 演示站：后台需 ?demo=KEY 解锁
	const demoKey = (env as any).DEMO_ADMIN_KEY as string | undefined;
	if (demoKey && (path.startsWith("/_emdash/admin") || path.startsWith("/ops"))) {
		const given = url.searchParams.get("demo");
		if (given === demoKey) {
			context.cookies.set("yb_demo", demoKey, { path: "/", httpOnly: true, sameSite: "lax", maxAge: 86400 });
		} else if (context.cookies.get("yb_demo")?.value !== demoKey) {
			return new Response("<!doctype html><meta charset=\"utf-8\"><title>404</title><p style=\"font:16px system-ui;padding:80px;text-align:center;color:#666\">404 Not Found</p>", {
				status: 404,
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		}
	}

	// 额度耗尽：只读，但页面照常渲染
	if (readOnly && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
		// 登录/登出必须放行，否则额度耗尽时运维被锁在后台外面。
		const isAuth = path === "/api/ops/login" || path === "/api/ops/logout" || path === "/api/admin-login";
		const blocked = !isAuth && (path.startsWith("/api/") || path.startsWith("/_emdash/") || path.startsWith("/create"));
		if (blocked) {
			if (path.startsWith("/api/")) {
				return new Response(
					JSON.stringify({ ok: false, error: "QUOTA_EXCEEDED", message: "今日额度已用完，当前为只读模式，北京时间 8 点恢复" }),
					{ status: 503, headers: { "Content-Type": "application/json; charset=utf-8" } }
				);
			}
			return new Response(
				`<!doctype html><meta charset="utf-8"><title>只读模式</title><div style="font:16px/1.8 system-ui;max-width:640px;margin:120px auto;padding:0 24px;color:#333"><h1 style="font-size:28px">今日额度已用完</h1><p>站点当前为只读模式：文章与评论可以正常浏览，编辑、注册与评论将在北京时间早上 8 点恢复。</p><p><a href="/" style="color:#2563eb">返回首页</a></p></div>`,
				{ status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
			);
		}
	}

	const res = await next();
	if (readOnly && res.headers.get("content-type")?.includes("text/html")) {
		res.headers.set("X-Yerin-Readonly", "1");
	}
	return res;
});
