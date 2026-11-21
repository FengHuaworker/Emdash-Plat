/**
 * 请求级的「当前站点」上下文。
 *
 * 一个 Worker 服务所有租户站：`<slug>.yerinblog.cc.cd` 解析出 slug，
 * 用 AsyncLocalStorage 带到 EmDash 内部，数据库层按 slug 选择对应的
 * Durable Object（一个 DO = 一个独立 SQLite = 一套独立站点）。
 *
 * 这个模块不能 import "cloudflare:workers"，因为 astro.config.mjs 在构建期
 * 也会读它（那时没有 Workers 运行时）。
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const ROOT_DOMAIN = "yerinblog.cc.cd";
export const MAIN_SLUG = "main";
/** 主站使用的 DO 名，保持稳定，别随便改 */
export const MAIN_DO_NAME = "emdash-main";

interface SiteContext {
	slug: string;
}

const storage = new AsyncLocalStorage<SiteContext>();

/**
 * 跨 bundle 共享的当前站点。
 *
 * astro.config.mjs 里的 `durableObjects({ get name() { return currentDoName() } })`
 * 在构建期被求值过一次，导致所有租户站共用同一个 DO。这里额外把 slug 写到
 * globalThis，并在 worker 每次请求开始时设置；getter 在运行时读到它，
 * emdash 的按请求数据库层就能按 Host 选中各站自己的 DO。
 */
const GLOBAL_SLUG_KEY = "__ybCurrentSlug";
type GlobalWithSlug = typeof globalThis & { [GLOBAL_SLUG_KEY]?: string };

/** 当前请求属于哪个站；构建期或主站请求返回 "main" */
export function currentSlug(): string {
	return storage.getStore()?.slug || (globalThis as GlobalWithSlug)[GLOBAL_SLUG_KEY] || MAIN_SLUG;
}

/** 当前请求应该用哪个 DO：主站用固定名，租户站用 site-<slug> */
export function currentDoName(): string {
	const slug = currentSlug();
	return slug === MAIN_SLUG ? MAIN_DO_NAME : `site-${slug}`;
}

/** 在指定站点的上下文里执行（ALS 会跨 await 传播） */
export function runWithSite<T>(slug: string, fn: () => T): T {
	(globalThis as GlobalWithSlug)[GLOBAL_SLUG_KEY] = slug;
	return storage.run({ slug }, fn);
}

/**
 * 从 Host 解析站点 slug。
 * - yerinblog.cc.cd / www / main → main
 * - xxx.yerinblog.cc.cd → xxx
 * - 其它域（自定义域名以后再接）→ null，表示不归本站管
 */
export function slugFromHost(host: string): string | null {
	const hostname = host.split(":")[0].toLowerCase();
	if (hostname === ROOT_DOMAIN || hostname === `www.${ROOT_DOMAIN}` || hostname === `main.${ROOT_DOMAIN}`) {
		return MAIN_SLUG;
	}
	const suffix = `.${ROOT_DOMAIN}`;
	if (!hostname.endsWith(suffix)) return null;
	const label = hostname.slice(0, -suffix.length);
	if (!label || label.includes(".")) return null;
	return label;
}
