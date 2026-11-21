/**
 * 外链图床存储适配器
 *
 * 本平台不提供图片上传（不使用 R2，也不占用 KV）。
 * 所有图片请先上传到 https://img.yerin.dpdns.org，再把外链粘贴到编辑器。
 *
 * 这个适配器的职责是把“上传/下载”变成明确的提示，
 * 而不是让 EmDash 抛一个看不懂的 500。
 */
export class LinkStorage {
	constructor(config = {}) {
		this.config = config;
		this.host = config.host || "img.yerin.dpdns.org";
	}

	hint() {
		return `本站不支持直接上传图片。请先到 https://${this.host} 上传，复制图片地址后粘贴到正文里。`;
	}

	getPublicUrl(key) {
		if (/^https?:\/\//i.test(key)) return key;
		return `https://${this.host}/${String(key).replace(/^\/+/, "")}`;
	}

	async upload() {
		throw new Error(this.hint());
	}

	async getSignedUploadUrl() {
		throw new Error(this.hint());
	}

	async download() {
		throw new Error(this.hint());
	}

	async delete() {
		/* 外链文件不由本站管理 */
	}

	async exists() {
		return false;
	}

	async list() {
		return { files: [] };
	}
}

export function createStorage(config = {}) {
	return new LinkStorage(config);
}
