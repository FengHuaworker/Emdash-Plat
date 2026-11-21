import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { OPS_COOKIE, OPS_COOKIE_OPTIONS, opsPassword, opsToken } from "../../../lib/ops-auth";
import { logEvent, clientIp, ensurePlatformTables } from "../../../lib/platform";

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
	const form = await request.formData();
	const posted = String(form.get("password") || "");
	const expected = opsPassword(env as any);
	// 未配置 OPS_PASSWORD 时禁止登录，避免空密码直接通过
	if (!expected || posted !== expected) return redirect("/ops?error=1");
	cookies.set(OPS_COOKIE, opsToken(env as any), OPS_COOKIE_OPTIONS);
	await ensurePlatformTables();
	await logEvent("ops.login", "", "", clientIp(request));
	return redirect("/ops");
};
