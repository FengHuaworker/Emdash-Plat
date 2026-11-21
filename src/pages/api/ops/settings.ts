import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { isOpsAuthed } from "../../../lib/ops-auth";
import { saveSettings } from "../../../lib/settings";
import { logEvent, clientIp } from "../../../lib/platform";

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
	if (!isOpsAuthed(cookies, env as any)) return redirect("/ops");
	const form = await request.formData();
	await saveSettings({
		registration: String(form.get("registration") || "") === "1" ? 1 : 0,
		announcement: String(form.get("announcement") || "").slice(0, 300),
		ipHours: Math.min(720, Math.max(1, Number(form.get("ipHours") || 24))),
	});
	await logEvent("ops.settings", "", "更新平台设置", clientIp(request));
	return redirect("/ops/settings?saved=1");
};
