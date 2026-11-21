import type { APIRoute } from "astro";

const hint = `本站不提供上传接口。请到 https://img.yerin.dpdns.org 上传图片，再把外链粘贴到文章里。`;

/** 上传接口已停用：只允许外链图床 */
export const PUT: APIRoute = async () =>
	new Response(JSON.stringify({ ok: false, error: "UPLOAD_DISABLED", message: hint }), {
		status: 410,
		headers: { "Content-Type": "application/json; charset=utf-8" },
	});

export const POST = PUT;
