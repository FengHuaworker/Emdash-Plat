import type { APIRoute } from "astro";
import { OPS_COOKIE } from "../../../lib/ops-auth";

export const POST: APIRoute = async ({ cookies, redirect }) => {
	cookies.delete(OPS_COOKIE, { path: "/" });
	return redirect("/ops");
};
