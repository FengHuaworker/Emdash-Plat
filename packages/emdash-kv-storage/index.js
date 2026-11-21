/**
 * EmDash KV 存储适配器：用 Cloudflare KV 替代 R2 存媒体文件。
 * 限制：单值 25MB、免费额度总量 1GB、每天 1000 次写入。
 */
import { env } from "cloudflare:workers";

const enc = new TextEncoder();
const PREFIX = "media:";

function kvOf(config) {
	const name = config.binding || "MEDIA_KV";
	const binding = env && env[name];
	if (!binding) throw new Error(`[emdash-kv-storage] 缺少 KV 绑定 ${name}`);
	return binding;
}

async function sign(secret, payload) {
	const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
	let bin = "";
	for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export class KVStorage {
	constructor(config = {}) {
		this.config = config;
	}

	secret() {
		return (env && (env.MEDIA_SECRET || env.EMDASH_ENCRYPTION_KEY)) || "dev-secret";
	}

	basePath() {
		return this.config.basePath || "/media";
	}

	getPublicUrl(key) {
		return `${this.basePath()}/${key}`;
	}

	async upload({ key, body, contentType, cacheControl }) {
		let bytes;
		if (body instanceof ReadableStream) bytes = new Uint8Array(await new Response(body).arrayBuffer());
		else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
		else bytes = body;
		const size = bytes.byteLength;
		await kvOf(this.config).put(`${PREFIX}${key}`, bytes, {
			metadata: { contentType, size, cacheControl: cacheControl || "", at: Date.now() },
		});
		return { key, url: this.getPublicUrl(key), size };
	}

	async download(key, options) {
		const obj = await kvOf(this.config).getWithMetadata(`${PREFIX}${key}`, "arrayBuffer");
		if (!obj || !obj.value) throw new Error(`[emdash-kv-storage] not found: ${key}`);
		const meta = obj.metadata || {};
		const buf = new Uint8Array(obj.value);
		let out = buf;
		let range;
		if (options && options.range) {
			const start = Math.max(0, options.range.offset || 0);
			const end = options.range.length ? Math.min(buf.byteLength, start + options.range.length) : buf.byteLength;
			out = buf.slice(start, end);
			range = { offset: start, length: out.byteLength };
		}
		return {
			body: new Blob([out]).stream(),
			contentType: meta.contentType || "application/octet-stream",
			size: meta.size || buf.byteLength,
			...(range ? { range } : {}),
		};
	}

	async delete(key) {
		await kvOf(this.config).delete(`${PREFIX}${key}`);
	}

	async exists(key) {
		return !!(await kvOf(this.config).get(`${PREFIX}${key}`));
	}

	async list(options = {}) {
		const res = await kvOf(this.config).list({
			prefix: `${PREFIX}${options.prefix || ""}`,
			limit: options.limit || 1000,
			...(options.cursor ? { cursor: options.cursor } : {}),
		});
		return {
			files: (res.keys || []).map((k) => {
				const meta = k.metadata || {};
				return {
					key: k.name.slice(PREFIX.length),
					size: meta.size || 0,
					lastModified: new Date(meta.at || Date.now()),
					...(meta.etag ? { etag: meta.etag } : {}),
				};
			}),
			...(res.list_complete ? {} : { nextCursor: res.cursor }),
		};
	}

	async getSignedUploadUrl({ key, contentType, expiresIn = 3600 }) {
		const exp = Date.now() + expiresIn * 1000;
		const sig = await sign(this.secret(), `${key}:${exp}:${contentType}`);
		const url = `${this.config.uploadPath || "/api/kv/upload"}?key=${encodeURIComponent(key)}&exp=${exp}&ct=${encodeURIComponent(contentType)}&sig=${sig}`;
		return {
			url,
			method: "PUT",
			headers: { "content-type": contentType },
			expiresAt: new Date(exp).toISOString(),
		};
	}
}

export function createStorage(config = {}) {
	return new KVStorage(config);
}
