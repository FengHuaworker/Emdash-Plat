/**
 * 站点注册表（platform_site）读取。
 *
 * 主站和租户站共用同一个 D1（binding DB）里的 platform_site 表；
 * 租户站的内容数据在各自独立的 DO 里，不在此表。
 */
import { env } from "cloudflare:workers";

export interface SiteRow {
	id: string;
	title: string;
	password: string;
	ip: string;
	owner: string;
	status: number;
	created: number;
}

function db(): D1Database | null {
	const binding = (env as unknown as Record<string, unknown>).DB as D1Database | undefined;
	return binding ?? null;
}

export async function lookupSite(slug: string): Promise<SiteRow | null> {
	const database = db();
	if (!database) return null;
	try {
		const row = await database
			.prepare("SELECT id,title,password,ip,owner,status,created FROM platform_site WHERE id = ?1")
			.bind(slug)
			.first<SiteRow>();
		return row ?? null;
	} catch {
		return null;
	}
}

/** 站点是否已开通（status = 1） */
export async function isLiveSite(slug: string): Promise<boolean> {
	const row = await lookupSite(slug);
	return !!row && row.status === 1;
}
