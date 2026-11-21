/** 平台自有的域名（主站）。租户站是 <slug>.yerinblog.cc.cd，不在此列。 */
const PLATFORM_HOSTS = new Set([
	"yerinblog.cc.cd",
	"www.yerinblog.cc.cd",
	"main.yerinblog.cc.cd",
]);

export function isPlatformHost(host: string): boolean {
	return PLATFORM_HOSTS.has(host.toLowerCase());
}
