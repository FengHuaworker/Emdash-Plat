import type { APIRoute } from "astro";

/**
 * 本站不再托管图片。所有媒体请走外链图床。
 * 保留这个路由是为了给旧链接一个明确说明，而不是 404 或 500。
 */
const hint = `本站不托管图片。请到 https://img.yerin.dpdns.org 上传后，把图片地址粘贴到文章里。`;

export const GET: APIRoute = async () =>
	new Response(hint, { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8" } });
