import type { APIRoute } from "astro";
import { db, ensurePlatformTables, deleteSite, getSite, OWNER_COOKIE, setSitePassword, setSiteDomain, logEvent, clientIp } from "../../lib/platform";
import { env } from "cloudflare:workers";
import { siteDoName } from "../../lib/site-auth";

/** 把新标题写进该站 DO 的 site:title option（EmDash 前台读的就是它） */
async function syncSiteTitle(slug: string, title: string): Promise<void> {
	try {
		const ns = (env as any).DB_DO;
		if (!ns) return;
		const stub = ns.get(ns.idFromName(siteDoName(slug)));
		await stub.query(
			`INSERT INTO options (name,value,revision) VALUES ('site:title',?1,?2)
			 ON CONFLICT(name) DO UPDATE SET value=excluded.value, revision=excluded.revision`,
			[JSON.stringify(title), crypto.randomUUID()]
		);
	} catch {
		// DO 可能尚未迁移；下次改名或首次后台访问会补上
	}
}

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
	await ensurePlatformTables();
	const owner = cookies.get(OWNER_COOKIE)?.value || "";
	const form = await request.formData();
	const action = String(form.get("action") || "");
	const id = String(form.get("id") || "").trim().toLowerCase();

	if (action === "logout") {
		cookies.delete(OWNER_COOKIE, { path: "/", domain: ".yerinblog.cc.cd" });
		return redirect("/");
	}

	if (!owner) return redirect("/login");
	if (!id) return redirect("/dashboard");

	const site = await getSite(id);
	if (!site || site.owner !== owner) return redirect("/dashboard?error=nope");

	if (action === "password") {
		const pwd = String(form.get("password") || "");
		if (pwd.length < 8) return redirect("/dashboard?error=short");
		await setSitePassword(id, pwd);
		await logEvent("site.password", id, "站主修改密码", clientIp(request));
		return redirect("/dashboard?ok=password");
	}

	if (action === "domain") {
		const raw = String(form.get("domain") || "");
		const res = await setSiteDomain(id, raw);
		if (!res.ok) return redirect(`/dashboard?error=${encodeURIComponent(res.message)}`);
		await logEvent("site.domain", id, res.message ? `绑定域名 ${res.message}` : "解绑域名", clientIp(request));
		return redirect(`/dashboard?ok=domain${res.message ? `&domain=${encodeURIComponent(res.message)}` : ""}`);
	}

	if (action === "delete") {
		await deleteSite(id);
		await logEvent("site.delete", id, "站主自行删除", clientIp(request));
		return redirect("/dashboard?ok=deleted");
	}

	if (action === "rename") {
		const title = String(form.get("title") || "").trim().slice(0, 60);
		if (title) {
			await db().prepare("UPDATE platform_site SET title=?1 WHERE id=?2").bind(title, id).run();
			await db().prepare("UPDATE users SET name=?1 WHERE email=?2").bind(`${title}（站点）`, `${id}@site.yerinblog.local`).run();
			// 同步到该站 EmDash 的站点标题，否则前台一直显示默认的 "My Blog"。
			await syncSiteTitle(id, title);
			await logEvent("site.rename", id, `改名为 ${title}`, clientIp(request));
		}
		return redirect("/dashboard?ok=renamed");
	}

	return redirect("/dashboard");
};
