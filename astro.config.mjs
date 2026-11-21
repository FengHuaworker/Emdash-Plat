import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, durableObjects } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";
import emdash from "emdash/astro";
import { Features } from "lightningcss";
import { currentDoName } from "./src/lib/site-context.ts";

// 两套产物：
//   YB_SITES=1  → 租户站 Worker（每站一个 DO），产物在 dist-sites
//   默认        → 主站 Worker（D1），产物在 dist
const sitesMode = process.env.YB_SITES === "1";

const database = sitesMode
	? durableObjects({
			binding: "DB_DO",
			// 每次查询时才读，按请求的 Host 选对应站点的 DO
			get name() {
				return currentDoName();
			},
		})
	: d1({ binding: "DB", session: "auto", coalesce: true });

export default defineConfig({
	output: "server",
	// 低内存机器上关闭压缩，避免 rolldown 在 8GB 机器上 OOM
	build: { minify: false },
	outDir: sitesMode ? "./dist-sites" : "./dist",
	adapter: cloudflare(),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	vite: {
		resolve: {
			alias: {
				"emdash-link-storage": fileURLToPath(new URL("./packages/emdash-link-storage/index.js", import.meta.url)),
			},
		},
		css: {
			// Keep light-dark() native so the footer theme switcher works in
			// production. For older browsers, Lightning CSS otherwise rewrites
			// it into variables that follow only prefers-color-scheme, which the
			// :root.light / :root.dark color-scheme rules in Base.astro can't
			// reach. Browsers without light-dark() get the light fallback in
			// tokens.css.
			lightningcss: { exclude: Features.LightDark },
		},
	},
	integrations: [
		react(),
		emdash({
			database,
			// 不接 R2、也不占用 KV：图片只允许外链，统一走 img.yerin.dpdns.org
			storage: { entrypoint: "emdash-link-storage", config: { host: "img.yerin.dpdns.org" } },
		}),
	],
	devToolbar: { enabled: false },
});
