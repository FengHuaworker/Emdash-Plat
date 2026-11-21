import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { linkSecret, verifyLinkToken } from "../../../../lib/site-auth";

/**
 * 平台注册/登录 → EmDash 原生后台的挂钩点。
 *
 * 放在 /_emdash/admin/login/* 下有两个好处：
 * 1) EmDash 中间件把它当公开后台路由放行，且注入完整的 locals.emdash.db（当前租户 DO）；
 * 2) 它天然在当前站点的 ALS 上下文里，db 指向该站独立数据库。
 *
 * 主站 /api/create、/api/login 校验平台密码后签一个 10 分钟有效的 token，
 * 浏览器带着 token 跳到这里，我们用它在该站 users 表建 role=50 站主，
 * 再写原生 Astro session，最后跳进真正的后台。
 */
export const GET: APIRoute = async ({ url, locals, redirect, session }) => {
	const token = url.searchParams.get("token") || "";
	const next = url.searchParams.get("next") || "/_emdash/admin";
	const info = await verifyLinkToken(linkSecret(env as unknown as Record<string, unknown>), token);
	if (!info) return new Response("链接无效或已过期", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });

	const db = (locals as any).emdash?.db;
	if (!db) return new Response("站点数据库未就绪，请稍后重试", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });

	const email = `${info.slug}@site.yerinblog.local`;
	let user: { id: string } | undefined;
	try {
		user = await db.selectFrom("users").select("id").where("email", "=", email).executeTakeFirst();
		if (!user) {
			const now = new Date().toISOString();
			const id = crypto.randomUUID();
			await db.insertInto("users").values({
				id,
				email,
				name: `${info.slug} 站主`,
				role: 50,
				email_verified: 1,
				disabled: 0,
				created_at: now,
				updated_at: now,
			}).execute();
			user = { id };
		}
	} catch (e) {
		return new Response(`创建原生用户失败：${e instanceof Error ? e.message : String(e)}`, {
			status: 500,
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		});
	}

	// 显式写原生 session（cookie 由 Astro session 驱动下发）
	session?.set("user", { id: user.id });

	return redirect(next.startsWith("/_emdash") ? next : "/_emdash/admin");
};
