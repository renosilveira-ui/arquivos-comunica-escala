type PublicUrlEnvironment = Readonly<Record<string, string | undefined>>;

export function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "0.0.0.0" ||
    normalized === "::1";
}

/**
 * Resolve a origem publica usada em links emitidos pelo servidor.
 *
 * Headers da requisicao nao entram nesta decisao: Host e X-Forwarded-* sao
 * controlaveis pelo cliente. Producao exige APP_PUBLIC_URL HTTPS explicita;
 * desenvolvimento e teste usam somente um fallback local fixo.
 */
export function resolveTrustedPublicBaseUrl(
  env: PublicUrlEnvironment = process.env,
): string | null {
  const configured = (env.APP_PUBLIC_URL ?? "").trim();
  const isProduction = env.NODE_ENV === "production";
  if (!configured) {
    return isProduction ? null : "http://localhost:8081";
  }

  try {
    const url = new URL(configured);
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
