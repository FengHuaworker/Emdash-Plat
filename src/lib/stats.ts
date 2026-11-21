/**
 * 流量统计：直接读 Cloudflare 的 zone HTTP analytics（按 Host 分组），
 * 不需要自己埋点，也不额外消耗 Worker 请求。
 *
 * 结果在 KV 里缓存 5 分钟，避免每次打开看板都打 GraphQL。
 */
import { env } from "cloudflare:workers";

/** Cloudflare zone ID：通过 wrangler secret put CF_ZONE_ID 配置 */
function zoneId(): string {
	return String((env as any).CF_ZONE_ID || "");
}
const ROOT = "yerinblog.cc.cd";
const CACHE_KEY = "stats:hosts:v2";
const CACHE_TTL = 300;

export interface HostTraffic {
	today: number;
	week: number;
}

export interface TrafficSnapshot {
	ok: boolean;
	/** 取不到时的原因 */
	reason?: "no-token" | "bad-token" | "network" | "error";
	/** 今天（UTC 0 点起，等于北京时间 8 点）全 zone 请求数 */
	today: number;
	/** 最近 7 天全 zone 请求数 */
	week: number;
	/** host -> 流量，只包含本站域名 */
	byHost: Record<string, HostTraffic>;
}

function kv(): KVNamespace | null {
	return ((env as any).SESSION as KVNamespace) ?? null;
}

async function gql(query: string, variables: Record<string, unknown>): Promise<any> {
	const token = (env as any).CF_ANALYTICS_TOKEN as string | undefined;
	if (!token || !zoneId()) throw new Error("no-token");
	const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
	});
	if (res.status === 401 || res.status === 403) throw new Error("bad-token");
	if (!res.ok) throw new Error("error");
	return res.json();
}

function isOurs(host: string): boolean {
	return host === ROOT || host.endsWith(`.${ROOT}`);
}

export async function getTraffic(): Promise<TrafficSnapshot> {
	const store = kv();
	if (store) {
		try {
			const cached = (await store.get(CACHE_KEY, "json")) as TrafficSnapshot | null;
			if (cached) return cached;
		} catch {
			/* ignore */
		}
	}

	const empty: TrafficSnapshot = { ok: false, today: 0, week: 0, byHost: {} };
	const now = new Date();
	const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	const weekAgo = new Date(now.getTime() - 7 * 86400000);

	const query = `query($z:String!,$t:Time!,$w:Time!){
		viewer{zones(filter:{zoneTag:$z}){
			today: httpRequestsAdaptiveGroups(limit:200,filter:{datetime_geq:$t}){count dimensions{clientRequestHTTPHost}}
			week: httpRequestsAdaptiveGroups(limit:200,filter:{datetime_geq:$w}){count dimensions{clientRequestHTTPHost}}
		}}
	}`;

	let data: any;
	try {
		data = await gql(query, { z: zoneId(), t: startOfDay.toISOString(), w: weekAgo.toISOString() });
	} catch (e: any) {
		const reason = e?.message === "no-token" ? "no-token" : e?.message === "bad-token" ? "bad-token" : e?.message === "error" ? "error" : "network";
		return { ...empty, reason };
	}

	const zone = data?.data?.viewer?.zones?.[0];
	if (!zone) return { ...empty, reason: "error" };

	const byHost: Record<string, HostTraffic> = {};
	let today = 0;
	let week = 0;

	for (const row of zone.today || []) {
		const host = String(row.dimensions?.clientRequestHTTPHost || "");
		if (!isOurs(host)) continue;
		byHost[host] = { today: row.count || 0, week: 0 };
		today += row.count || 0;
	}
	for (const row of zone.week || []) {
		const host = String(row.dimensions?.clientRequestHTTPHost || "");
		if (!isOurs(host)) continue;
		if (!byHost[host]) byHost[host] = { today: 0, week: 0 };
		byHost[host].week = row.count || 0;
		week += row.count || 0;
	}

	const snapshot: TrafficSnapshot = { ok: true, today, week, byHost };
	if (store) {
		try {
			await store.put(CACHE_KEY, JSON.stringify(snapshot), { expirationTtl: CACHE_TTL });
		} catch {
			/* ignore */
		}
	}
	return snapshot;
}

export interface TrafficPoint {
	hour: string;
	count: number;
}

/** 某个 host 最近 N 小时的逐小时访问量（自适应表只保留最近几天） */
export async function getHostSeries(host: string, hours = 24): Promise<TrafficPoint[]> {
	const since = new Date(Date.now() - hours * 3600000);
	const query = `query($z:String!,$s:Time!,$h:String!){
		viewer{zones(filter:{zoneTag:$z}){
			httpRequestsAdaptiveGroups(limit:200,filter:{datetime_geq:$s,clientRequestHTTPHost:$h},orderBy:[datetimeHour_ASC]){
				count dimensions{datetimeHour}
			}
		}}
	}`;
	try {
		const data = await gql(query, { z: zoneId(), s: since.toISOString(), h: host });
		const rows = data?.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups || [];
		return rows.map((r: any) => ({ hour: String(r.dimensions?.datetimeHour || ""), count: r.count || 0 }));
	} catch {
		return [];
	}
}

/** 补齐成固定长度的小时序列（没有数据的补 0），画柱状图时不会挤成一块 */
export function fillHourly(points: TrafficPoint[], hours = 24): TrafficPoint[] {
	const map = new Map(points.map((p) => [p.hour, p.count]));
	const end = new Date();
	end.setUTCMinutes(0, 0, 0);
	const out: TrafficPoint[] = [];
	for (let i = hours - 1; i >= 0; i--) {
		const key = new Date(end.getTime() - i * 3600000).toISOString().replace(".000Z", "Z");
		out.push({ hour: key, count: map.get(key) || 0 });
	}
	return out;
}

/** 把 host 映射成站点 slug；主站返回 "main" */
export function slugOfHost(host: string): string {
	if (host === ROOT || host === `www.${ROOT}` || host === `main.${ROOT}`) return "main";
	if (host.endsWith(`.${ROOT}`)) return host.slice(0, -ROOT.length - 1);
	return host;
}
