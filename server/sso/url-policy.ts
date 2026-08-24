import { ENV } from "../_core/env";
import { isLocalHostname } from "../_core/public-url";

type UrlEnvironment = Readonly<Record<string, string | undefined>>;

/** URL externa confiavel do Comunica+, validada no momento de cada uso. */
export function resolveTrustedSsoTargetUrl(
  env: UrlEnvironment = process.env,
): string | null {
  const configured = (env.SSO_TARGET_URL ?? ENV.ssoTargetUrl).trim();
  try {
    const url = new URL(configured);
    const isProduction = env.NODE_ENV === "production";
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      (isProduction && url.protocol !== "https:") ||
      !url.hostname ||
      (isProduction && isLocalHostname(url.hostname)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}
