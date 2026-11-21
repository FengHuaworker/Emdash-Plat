import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { isOpsAuthed } from "../../../lib/ops-auth";
import { deleteSite, ensurePlatformTables, getSite, setSitePassword, setSiteStatus, db, logEvent, clientIp } from "../../../lib/platform";

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
	if (!isOpsAuthed(cookies, env as any)) return redirect("/ops");
	await ensurePlatformTables();

	const form = await request.formData();
	const action = String(form.get("action") || "");
	const id = String(form.get("id") || "").trim().toLowerCase();
	const back = String(form.get("back") || "/ops/sites");
	if (!action || !id) return redirect(back);

	const site = await getSite(id);
	if (!site) return redirect(back);

	if (action === "disable") await setSiteStatus(id, 0);
	else if (action === "enable") await setSiteStatus(id, 1);
	else if (action === "delete") await deleteSite(id);
	else if (action === "reset") {
		const pwd = String(form.get("password") || "");
		if (pwd.length >= 8) await setSitePassword(id, pwd);
	} else if (action === "rename") {
		const title = String(form.get("title") || "").trim().slice(0, 60);
		if (title) await db().prepare("UPDATE platform_site SET title=?1 WHERE id=?2").bind(title, id).run();
	}

	await logEvent(`ops.site.${action}`, id, action === "reset" ? "" : action, clientIp(request));
	return redirect(back);
};
