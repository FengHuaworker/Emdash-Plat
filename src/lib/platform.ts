/**
 * 平台层：站点注册、额度、Cookie 身份。
 * 数据表与 EmDash 自身表共存于同一个 D1，使用 platform_ 前缀。
 */
import { env } from "cloudflare:workers";
import { md5 } from "./md5";

export interface SiteRow {
	id: string;
	title: string;
	password: string;
	ip: string;
	owner: string;
	status: number;
	created: number;
	domain?: string | null;
}

const RESERVED = new Set([
	"admin", "my", "dashboard", "dash", "api", "mail", "login", "logout", "register",
	"billing", "support", "security", "help", "status", "blog", "www", "cdn", "static",
	"assets", "img", "images", "files", "docs", "doc", "dev", "test", "staging", "ops",
	"root", "system", "prain", "yerin", "yerinblog", "official", "about", "contact",
]);

export function db(): D1Database {
	return (env as any).DB as D1Database;
}

export function kv(): KVNamespace | null {
	return ((env as any).SESSION as KVNamespace) ?? null;
}

export function clientIp(request: Request): string {
	return (
		request.headers.get("cf-connecting-ip") ||
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
		"127.0.0.1"
	);
}

/** 3–32 位，小写字母数字与连字符，首尾必须是字母数字 */
export function validateName(raw: string): { ok: boolean; message: string; value: string } {
	const value = String(raw || "").trim().toLowerCase();
	if (value.length < 3) return { ok: false, message: "至少 3 个字符", value };
	if (value.length > 32) return { ok: false, message: "最多 32 个字符", value };
	if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(value)) return { ok: false, message: "只能用小写字母、数字和连字符，且不能以连字符开头或结尾", value };
	if (value.includes("--")) return { ok: false, message: "不能出现连续连字符", value };
	if (RESERVED.has(value)) return { ok: false, message: "这个地址是保留字", value };
	return { ok: true, message: "", value };
}

let tablesReady = false;
export async function ensurePlatformTables(): Promise<void> {
	if (tablesReady) return;
	await db().batch([
		db().prepare(
			`CREATE TABLE IF NOT EXISTS platform_site (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL DEFAULT '',
				password TEXT NOT NULL DEFAULT '',
				ip TEXT NOT NULL DEFAULT '',
				owner TEXT NOT NULL DEFAULT '',
				status INTEGER NOT NULL DEFAULT 1,
				created INTEGER NOT NULL DEFAULT 0,
				domain TEXT
			)`
		),
		db().prepare("CREATE INDEX IF NOT EXISTS idx_platform_site_owner ON platform_site(owner)"),
		db().prepare("CREATE INDEX IF NOT EXISTS idx_platform_site_created ON platform_site(created DESC)"),
		db().prepare("CREATE INDEX IF NOT EXISTS idx_platform_site_status ON platform_site(status)"),
		db().prepare(
			`CREATE TABLE IF NOT EXISTS platform_setting (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL DEFAULT ''
			)`
		),
		db().prepare(
			`CREATE TABLE IF NOT EXISTS platform_event (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				ts INTEGER NOT NULL DEFAULT 0,
				kind TEXT NOT NULL DEFAULT '',
				site TEXT NOT NULL DEFAULT '',
				detail TEXT NOT NULL DEFAULT '',
				ip TEXT NOT NULL DEFAULT ''
			)`
		),
		db().prepare("CREATE INDEX IF NOT EXISTS idx_platform_event_ts ON platform_event(ts DESC)"),
	]);
	tablesReady = true;
}

export const OWNER_COOKIE = "yb_owner";

export function ownerId(request: Request): string {
	const cookie = request.headers.get("cookie") || "";
	const hit = cookie.split(";").map((c) => c.trim()).find((c) => c.startsWith(`${OWNER_COOKIE}=`));
	return hit ? hit.slice(OWNER_COOKIE.length + 1) : "";
}

export async function countByIp(ip: string, since: number): Promise<number> {
	const row = await db()
		.prepare("SELECT COUNT(*) AS n FROM platform_site WHERE ip = ?1 AND created > ?2")
		.bind(ip, since)
		.first<{ n: number }>();
	return row?.n || 0;
}

export async function countByOwner(owner: string): Promise<number> {
	const row = await db().prepare("SELECT COUNT(*) AS n FROM platform_site WHERE owner = ?1").bind(owner).first<{ n: number }>();
	return row?.n || 0;
}

export async function listSites(limit = 100): Promise<SiteRow[]> {
	const res = await db().prepare("SELECT * FROM platform_site ORDER BY created DESC LIMIT ?1").bind(limit).all<SiteRow>();
	return res.results || [];
}

export async function siteStats(): Promise<{ total: number; active: number; disabled: number }> {
	const row = await db()
		.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) AS active FROM platform_site")
		.first<{ total: number; active: number }>();
	const total = row?.total || 0;
	const active = row?.active || 0;
	return { total, active, disabled: total - active };
}

/* ---------------- 运维查询 ---------------- */

export interface SiteQuery {
	q?: string;
	status?: "all" | "on" | "off";
	sort?: "new" | "old" | "name";
	page?: number;
	pageSize?: number;
}

export async function querySites(opts: SiteQuery = {}): Promise<{ rows: SiteRow[]; total: number; page: number; pages: number }> {
	const pageSize = Math.min(100, Math.max(10, opts.pageSize || 20));
	const page = Math.max(1, opts.page || 1);
	const where: string[] = [];
	const params: unknown[] = [];

	if (opts.q) {
		where.push("(id LIKE ?" + (params.length + 1) + " OR title LIKE ?" + (params.length + 2) + ")");
		params.push(`%${opts.q}%`, `%${opts.q}%`);
	}
	if (opts.status === "on") where.push("status = 1");
	if (opts.status === "off") where.push("status = 0");
	const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
	const order = opts.sort === "old" ? "created ASC" : opts.sort === "name" ? "id ASC" : "created DESC";

	const totalRow = await db()
		.prepare(`SELECT COUNT(*) AS n FROM platform_site ${clause}`)
		.bind(...params)
		.first<{ n: number }>();
	const total = totalRow?.n || 0;
	const pages = Math.max(1, Math.ceil(total / pageSize));

	const rows = await db()
		.prepare(`SELECT * FROM platform_site ${clause} ORDER BY ${order} LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`)
		.bind(...params, pageSize, (page - 1) * pageSize)
		.all<SiteRow>();

	return { rows: rows.results || [], total, page, pages };
}

export async function getSite(id: string): Promise<SiteRow | null> {
	const row = await db().prepare("SELECT * FROM platform_site WHERE id = ?1").bind(id).first<SiteRow>();
	return row ?? null;
}

/** 按自定义域名找站点（Worker 入口用） */
export async function findSiteByDomain(host: string): Promise<SiteRow | null> {
	try {
		return await db().prepare("SELECT * FROM platform_site WHERE lower(domain) = ?1 AND status = 1").bind(host.toLowerCase()).first<SiteRow>() ?? null;
	} catch {
		return null;
	}
}

/** 校验自定义域名：不接受平台自有域，且全平台唯一 */
export async function setSiteDomain(id: string, raw: string): Promise<{ ok: boolean; message: string }> {
	let host = String(raw || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
	if (!host) {
		await db().prepare("UPDATE platform_site SET domain=NULL WHERE id=?1").bind(id).run();
		return { ok: true, message: "" };
	}
	if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host)) return { ok: false, message: "域名格式不对" };
	if (host.endsWith(".yerinblog.cc.cd") || host === "yerinblog.cc.cd") return { ok: false, message: "平台自有域名不用绑定" };
	const taken = await db().prepare("SELECT id FROM platform_site WHERE lower(domain)=?1 AND id<>?2").bind(host, id).first();
	if (taken) return { ok: false, message: "这个域名已被绑定" };
	await db().prepare("UPDATE platform_site SET domain=?1 WHERE id=?2").bind(host, id).run();
	return { ok: true, message: host };
}

export async function setSiteStatus(id: string, status: number): Promise<void> {
	await db().prepare("UPDATE platform_site SET status = ?1 WHERE id = ?2").bind(status, id).run();
}

export async function deleteSite(id: string): Promise<void> {
	await db().prepare("DELETE FROM platform_site WHERE id = ?1").bind(id).run();
	await db().prepare("DELETE FROM users WHERE email = ?1").bind(`${id}@site.yerinblog.local`).run();
}

export async function setSitePassword(id: string, raw: string): Promise<void> {
	await db().prepare("UPDATE platform_site SET password = ?1 WHERE id = ?2").bind(md5(raw), id).run();
}

/* ---------------- 额度 ---------------- */

export interface QuotaInfo {
	available: boolean;
	used: number;
	limit: number;
	remaining: number;
	percent: number;
	/** 取不到数据时的原因，用于界面上给出准确提示 */
	reason?: "no-token" | "bad-token" | "network" | "error";
}

const LIMIT = 100000;
const CACHE_KEY = "platform:quota:v1";
const CACHE_TTL = 600;

export async function getQuota(): Promise<QuotaInfo> {
	const store = kv();
	if (store) {
		try {
			const cached = await store.get(CACHE_KEY, "json");
			if (cached) return cached as QuotaInfo;
		} catch {
			/* ignore */
		}
	}

	const account = (env as any).CF_ACCOUNT_ID as string | undefined;
	const token = (env as any).CF_ANALYTICS_TOKEN as string | undefined;
	const fallback: QuotaInfo = { available: false, used: 0, limit: LIMIT, remaining: LIMIT, percent: 0 };
	if (!account || !token) return { ...fallback, reason: "no-token" };

	try {
		const since = new Date();
		since.setUTCHours(0, 0, 0, 0);
		const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				query:
					"query($a:String!,$s:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:100,filter:{datetime_geq:$s}){sum{requests}}}}}",
				variables: { a: account, s: since.toISOString() },
			}),
		});
		if (!res.ok) {
			return { ...fallback, reason: res.status === 401 || res.status === 403 ? "bad-token" : "error" };
		}
		const data: any = await res.json();
		const rows = data?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
		const used = rows.reduce((n: number, r: any) => n + (r?.sum?.requests || 0), 0);
		const info: QuotaInfo = {
			available: true,
			used,
			limit: LIMIT,
			remaining: Math.max(0, LIMIT - used),
			percent: Math.min(100, Math.round((used / LIMIT) * 1000) / 10),
		};
		if (store) {
			try {
				await store.put(CACHE_KEY, JSON.stringify(info), { expirationTtl: CACHE_TTL });
			} catch {
				/* ignore */
			}
		}
		return info;
	} catch {
		return { ...fallback, reason: "network" };
	}
}

/** 额度取不到时给用户看的说明 */
export function quotaReasonText(q: QuotaInfo): string {
	switch (q.reason) {
		case "no-token":
			return "未配置只读令牌（CF_ANALYTICS_TOKEN）";
		case "bad-token":
			return "只读令牌无效或已过期（401），需要重新签发";
		case "network":
			return "查询额度失败（网络异常），稍后重试";
		case "error":
			return "查询额度失败，稍后重试";
		default:
			return "统计未接入";
	}
}

/** 已用超过 95% 视为额度耗尽：全站只读，注册关闭 */
export const QUOTA_LOCK_PERCENT = 95;

export async function isReadOnly(): Promise<boolean> {
	// 本地验收 / 演练用：FORCE_READONLY=1 模拟额度耗尽
	if (String((env as any).FORCE_READONLY || "") === "1") return true;
	const q = await getQuota();
	return q.available && q.percent >= QUOTA_LOCK_PERCENT;
}


/* ---------------- 操作日志 ---------------- */

export interface PlatformEvent {
	id: number;
	ts: number;
	kind: string;
	site: string;
	detail: string;
	ip: string;
}

/** 记录一条平台操作；失败不影响主流程 */
export async function logEvent(kind: string, site: string, detail = "", ip = ""): Promise<void> {
	try {
		await db()
			.prepare("INSERT INTO platform_event (ts, kind, site, detail, ip) VALUES (?1, ?2, ?3, ?4, ?5)")
			.bind(Math.floor(Date.now() / 1000), kind, site, detail.slice(0, 200), ip)
			.run();
	} catch {
		/* ignore */
	}
}

export async function listEvents(limit = 50): Promise<PlatformEvent[]> {
	const res = await db()
		.prepare("SELECT * FROM platform_event ORDER BY ts DESC LIMIT ?1")
		.bind(Math.min(200, Math.max(1, limit)))
		.all<PlatformEvent>();
	return res.results || [];
}
