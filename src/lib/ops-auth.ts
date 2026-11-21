/** 运维面板的登录态：密码来自 OPS_PASSWORD secret，Cookie 存 md5 派生令牌 */
import { md5 } from "./md5";

export const OPS_COOKIE = "yb_ops";

export function opsPassword(env: any): string {
	// 必须通过 wrangler secret put OPS_PASSWORD 配置，不要在源码里写默认密码。
	return (env?.OPS_PASSWORD as string) || "";
}

export function opsToken(env: any): string {
	return md5(`yb-ops:${opsPassword(env)}`);
}

export function isOpsAuthed(cookies: { get(name: string): { value: string } | undefined }, env: any): boolean {
	// 未配置密码时一律视为未授权
	if (!opsPassword(env)) return false;
	return cookies.get(OPS_COOKIE)?.value === opsToken(env);
}

export const OPS_COOKIE_OPTIONS = {
	path: "/",
	httpOnly: true,
	sameSite: "lax" as const,
	maxAge: 60 * 60 * 12,
};
