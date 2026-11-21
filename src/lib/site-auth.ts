/**
 * 把平台注册/登录和 EmDash 原生用户体系挂在一起。
 *
 * 一个租户站 = 一个 Durable Object（site-<slug>），里面有自己的 users 表；
 * 主站用 D1。两边共用同一个 SESSION KV 和同一个 astro-session cookie。
 * 所以：注册/登录时在该站库里准备一个 role=50 的原生用户，再把它的 id
 * 写进 Astro 会话，就能直接用平台密码进入 EmDash 原生后台。
 */
import { MAIN_DO_NAME } from "./site-context";

export const SESSION_COOKIE = "astro-session";
export const OWNER_DOMAIN = ".yerinblog.cc.cd";
const WEEK = 60 * 60 * 24 * 7;

/** devalue 序列化的 Map，等价于 session.set("user", { id }) */
export function sessionPayload(userId: string): string {
	return `[["Map",1,2],"user",{"data":3,"expires":-1},{"id":4},"${userId}"]`;
}

export function siteDoName(slug: string): string {
	// 与 worker.ts 里改写 emdashConfig.database.config.name 的规则保持一致。
	return slug === "main" ? MAIN_DO_NAME : `site-${slug}`;
}

type DoStub = {
	query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; changes?: number }>;
};

interface DoQueryEnv {
	DB_DO?: { idFromName(name: string): unknown; get(id: unknown): DoStub };
}

/**
 * 确保该站 DO 里有一个 role=50 的原生站主用户，返回其 id。
 * 用站点 slug 生成稳定邮箱，保证同一站重复注册/登录不会建出多个用户。
 * 表还没被 EmDash 首次访问迁移好时返回 null，由调用方稍后重试。
 */
export async function ensureSiteAdmin(env: DoQueryEnv, slug: string): Promise<string | null> {
	const ns = env.DB_DO;
	if (!ns) return null;
	const email = `${slug}@site.yerinblog.local`;
	const doName = siteDoName(slug);
	const stub = ns.get(ns.idFromName(doName));

	// 已存在则直接取回
	let id = "";
	try {
		const found = await stub.query("SELECT id FROM users WHERE email = ?1 LIMIT 1", [email]);
		const row = found.rows?.[0];
		if (row?.id) id = String(row.id);
	} catch {
		// 表尚未迁移，交给下面的 INSERT 再判断一次
	}

	const now = new Date().toISOString();
	if (!id) {
		id = crypto.randomUUID();
		try {
			await stub.query(
				`INSERT INTO users (id,email,name,role,email_verified,created_at,updated_at)
				 VALUES (?1,?2,?3,?4,?5,?6,?6)`,
				[id, email, `${slug} 站主`, 50, 1, now]
			);
		} catch (e) {
			// 表可能还没迁移；带上原因便于排查
			console.error("yb ensure user failed", e);
			return null;
		}
	}

	// 跳过 EmDash 的 setup 向导（已有站主）。必须在请求进入 emdash 中间件之前写好。
	try {
		await stub.query(
			`INSERT INTO options (name,value) VALUES ('emdash:setup_complete','true')
			 ON CONFLICT(name) DO UPDATE SET value='true'`
		);
	} catch (e) {
		console.error("yb ensure option failed", e);
	}
	return id;
}

/** 把原生 session 写进 KV；返回可直接下发的 cookie 值 */
export async function issueSession(env: { SESSION?: KVNamespace }, userId: string): Promise<string | null> {
	const kv = env.SESSION;
	if (!kv) return null;
	const sid = crypto.randomUUID();
	await kv.put(sid, sessionPayload(userId), { expirationTtl: WEEK });
	return sid;
}

/** 注册/登录成功后签名一个短期通行 token，跨子域带到原生后台完成挂钩 */
export async function makeLinkToken(secret: string, slug: string, owner: string): Promise<string> {
	const exp = Math.floor(Date.now() / 1000) + 600;
	const payload = `${slug}|${owner}|${exp}`;
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
	const hex = Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
	return `${Buffer.from(payload).toString("base64url")}.${hex}`;
}

export async function verifyLinkToken(secret: string, token: string): Promise<{ slug: string; owner: string } | null> {
	try {
		const [body, hex] = token.split(".");
		if (!body || !hex) return null;
		const payload = Buffer.from(body, "base64url").toString("utf8");
		const [slug, owner, expRaw] = payload.split("|");
		if (!slug || !owner || !expRaw || Number(expRaw) < Math.floor(Date.now() / 1000)) return null;
		const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
		const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
		const expected = Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
		if (hex !== expected) return null;
		return { slug, owner };
	} catch {
		return null;
	}
}

export function linkSecret(env: Record<string, unknown>): string {
	return String(env.EMDASH_ENCRYPTION_KEY || env.ADMIN_PASSWORD || env.OPS_PASSWORD || "yerinblog-link");
}
