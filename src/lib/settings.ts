/** 平台级设置：注册开关、公告、同 IP 冷却时间 */
import { db } from "./platform";

export interface PlatformSettings {
	/** 1 = 开放注册，0 = 关闭 */
	registration: number;
	/** 主站顶部公告，空字符串表示不显示 */
	announcement: string;
	/** 同一 IP 多少小时内只能建一个站 */
	ipHours: number;
}

export const DEFAULT_SETTINGS: PlatformSettings = {
	registration: 1,
	announcement: "",
	ipHours: 24,
};

let ready = false;

async function ensureTable(): Promise<void> {
	if (ready) return;
	await db()
		.prepare(
			`CREATE TABLE IF NOT EXISTS platform_setting (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL DEFAULT ''
			)`
		)
		.run();
	ready = true;
}

export async function getSettings(): Promise<PlatformSettings> {
	await ensureTable();
	const rows = await db().prepare("SELECT key, value FROM platform_setting").all<{ key: string; value: string }>();
	const out: PlatformSettings = { ...DEFAULT_SETTINGS };
	for (const row of rows.results || []) {
		if (row.key === "registration") out.registration = row.value === "1" ? 1 : 0;
		if (row.key === "announcement") out.announcement = row.value;
		if (row.key === "ipHours") out.ipHours = Number(row.value) || DEFAULT_SETTINGS.ipHours;
	}
	return out;
}

export async function saveSettings(patch: Partial<PlatformSettings>): Promise<void> {
	await ensureTable();
	const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
	if (!entries.length) return;
	await db().batch(
		entries.map(([k, v]) =>
			db()
				.prepare("INSERT INTO platform_setting (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
				.bind(k, String(v))
		)
	);
}
