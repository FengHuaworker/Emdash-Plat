import type { APIRoute } from "astro";
import {
	countByIp,
	countByOwner,
	db,
	ensurePlatformTables,
	ownerId,
	OWNER_COOKIE,
	validateName,
	clientIp,
} from "../../lib/platform";
import { md5 } from "../../lib/md5";
import { getSettings } from "../../lib/settings";
import { logEvent } from "../../lib/platform";
import { env } from "cloudflare:workers";
import { linkSecret, makeLinkToken } from "../../lib/site-auth";

export const POST: APIRoute = async ({ request, cookies, redirect }) => {
	await ensurePlatformTables();
	const settings = await getSettings();
	if (settings.registration !== 1) return redirect(`/create?error=${encodeURIComponent("注册暂时关闭，稍后再来看看")}`);
	const form = await request.formData();
	const name = String(form.get("name") || "");
	const title = String(form.get("title") || "").trim();
	const password = String(form.get("password") || "");

	const check = validateName(name);
	if (!check.ok) return redirect(`/create?error=${encodeURIComponent(check.message)}&name=${encodeURIComponent(name)}`);
	if (!title) return redirect(`/create?error=${encodeURIComponent("博客名称不能为空")}&name=${encodeURIComponent(name)}`);
	if (password.length < 8) return redirect(`/create?error=${encodeURIComponent("密码至少 8 位")}&name=${encodeURIComponent(name)}`);

	const exists = await db().prepare("SELECT 1 FROM platform_site WHERE id = ?1").bind(check.value).first();
	if (exists) return redirect(`/create?error=${encodeURIComponent("这个地址已经被占用了")}&name=${encodeURIComponent(check.value)}`);

	// 一个浏览器（Cookie）只能有一个博客
	let owner = ownerId(request) || cookies.get(OWNER_COOKIE)?.value || "";
	if (owner && (await countByOwner(owner)) > 0) {
		return redirect(`/create?error=${encodeURIComponent("这个浏览器已经创建过博客了")}`);
	}

	// 同一 IP 24 小时只能创建一个
	const ip = clientIp(request);
	const dayAgo = Math.floor(Date.now() / 1000) - settings.ipHours * 3600;
	if ((await countByIp(ip, dayAgo)) > 0) {
		return redirect(`/create?error=${encodeURIComponent(`同一个 IP ${settings.ipHours} 小时内只能创建一个博客`)}`);
	}

	if (!owner) {
		owner = crypto.randomUUID();
		cookies.set(OWNER_COOKIE, owner, { path: "/", domain: ".yerinblog.cc.cd", httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
	}

	// 站点直接开通：第一次访问子域时，EmDash 会在该站自己的 DO 里建库
	const status = 1;
	await db()
		.prepare("INSERT INTO platform_site (id,title,password,ip,owner,status,created) VALUES (?1,?2,?3,?4,?5,?6,?7)")
		.bind(check.value, title, md5(password), ip, owner, status, Math.floor(Date.now() / 1000))
		.run();

	// 在主站后台用户页登记这个站点账号（role=10 订阅者，无管理权限）。
	await db()
		.prepare("INSERT INTO users (id,email,name,role,email_verified,disabled,created_at,updated_at) VALUES (?1,?2,?3,10,1,0,datetime('now'),datetime('now')) ON CONFLICT(email) DO UPDATE SET name=excluded.name, updated_at=datetime('now')")
		.bind(crypto.randomUUID(), `${check.value}@site.yerinblog.local`, `${title}（站点）`)
		.run();

	await logEvent("site.create", check.value, title, ip);

	// 注册即挂钩：签一个短期 token，目标站用它创建原生站主用户并写入原生会话。
	// 首次访问会先让 EmDash 迁移该站 DO，yb-link 在库就绪后完成用户创建。
	const token = await makeLinkToken(linkSecret(env as unknown as Record<string, unknown>), check.value, owner);
	return redirect(`https://${check.value}.yerinblog.cc.cd/_emdash/admin/login/yb-link?token=${encodeURIComponent(token)}`);
};
