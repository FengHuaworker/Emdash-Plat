import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { db, OWNER_COOKIE } from "../../lib/platform";
import { md5 } from "../../lib/md5";
import { ensureSiteAdmin, issueSession, SESSION_COOKIE } from "../../lib/site-auth";
import { isPlatformHost } from "../../lib/host";

/**
 * EmDash 原生后台的密码登录：
 * - 主站：用 ADMIN_PASSWORD / OPS_PASSWORD
 * - 租户站：用注册时填的站点密码（platform_site.password，md5）
 * 校验通过后在该站数据库准备 role=50 的原生用户，写原生 Astro session，
 * 直接进 /_emdash/admin。Passkey 流程仍可通过 /_emdash/admin/signup 等使用。
 */
const WEEK = 60 * 60 * 24 * 7;

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
	const form = await request.formData();
	const posted = String(form.get("password") || "");
	const host = new URL(request.url).host;
	const isMain = isPlatformHost(host);

	let userId: string | null = null;
	let siteOwner = "";

	if (isMain) {
		const expected = String((env as any).ADMIN_PASSWORD || (env as any).OPS_PASSWORD || "");
		if (!expected || posted !== expected) return redirect("/_emdash/admin/login?error=1");
		const admin = await db().prepare("SELECT id FROM users WHERE role >= 50 LIMIT 1").first<{ id: string }>();
		userId = admin?.id ?? null;
	} else {
		const slug = host.split(".")[0].toLowerCase();
		const site = await db().prepare("SELECT id,password,status,owner FROM platform_site WHERE id=?1").bind(slug).first<{ id: string; password: string; status: number; owner: string }>();
		if (!site || site.status !== 1 || site.password !== md5(posted)) {
			return redirect("/_emdash/admin/login?error=1");
		}
		siteOwner = site.owner || "";
		userId = await ensureSiteAdmin(env as any, slug);
	}

	if (!userId) return redirect("/_emdash/admin/login?error=nouser");

	const sid = await issueSession(env as { SESSION?: KVNamespace }, userId);
	if (!sid) return redirect("/_emdash/admin/login?error=nosession");
	cookies.set(SESSION_COOKIE, sid, { path: "/", httpOnly: true, sameSite: "lax", maxAge: WEEK });
	if (siteOwner) {
		cookies.set(OWNER_COOKIE, siteOwner, { path: "/", domain: ".yerinblog.cc.cd", httpOnly: true, sameSite: "lax", maxAge: WEEK });
	}
	return redirect("/_emdash/admin");
};

export const GET: APIRoute = async ({ redirect }) => redirect("/_emdash/admin/login");
