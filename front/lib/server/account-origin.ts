import "server-only";
import { SiwsError } from "@/lib/server/siws";

/** Never construct production email links or OAuth redirects from Host headers. */
export function accountSiteOrigin(request: Request): string {
  const requestUrl = new URL(request.url);
  if (process.env.NODE_ENV !== "production" && ["http:", "https:"].includes(requestUrl.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(requestUrl.hostname)) {
    return requestUrl.origin;
  }
  try {
    const site = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "");
    if (site.protocol !== "https:" || site.username || site.password ||
        site.search || site.hash || site.pathname !== "/") throw new Error();
    return site.origin;
  } catch {
    throw new SiwsError(503, "Account services are temporarily unavailable. Please try again later.");
  }
}
