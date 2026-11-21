import type { APIRoute } from "astro";
import { db, ensurePlatformTables, OWNER_COOKIE } from "../../lib/platform";
import { md5 } from "../../lib/md5";
import { logEvent, clientIp } from "../../lib/platform";
import { env } from "cloudflare:workers";
import { linkSecret, makeLinkToken } from "../../lib/site-auth";

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
	await ensurePlatformTables();
	const form = await request.formData();
	const name = String(form.get("name") || "").trim().toLowerCase();
	const password = String(form.get("password") || "");

	if (!name || !password) {
		return redirect(`/login?error=${encodeURIComponent("请填写博客地址和密码")}`);
	}

	const row = await db()
		.prepare("SELECT id,password,owner FROM platform_site WHERE id = ?1")
		.bind(name)
		.first<{ id: string; password: string; owner: string }>();

	if (!row || row.password !== md5(password)) {
		return redirect(`/login?error=${encodeURIComponent("地址或密码不对")}&name=${encodeURIComponent(name)}`);
	}

	if (!row.owner) {
		const owner = crypto.randomUUID();
		await db().prepare("UPDATE platform_site SET owner=?1 WHERE id=?2").bind(owner, name).run();
		row.owner = owner;
	}

	cookies.set(OWNER_COOKIE, row.owner, {
		path: "/",
		domain: ".yerinblog.cc.cd",
		httpOnly: true,
		sameSite: "lax",
		maxAge: 60 * 60 * 24 * 365,
	});

	await logEvent("site.login", name, "", clientIp(request));

	// 用同一套账号密码换 EmDash 原生会话：目标站建/取原生站主用户并登录。
	const token = await makeLinkToken(linkSecret(env as unknown as Record<string, unknown>), name, row.owner);
	return redirect(`https://${name}.yerinblog.cc.cd/_emdash/admin/login/yb-link?token=${encodeURIComponent(token)}`);
};
