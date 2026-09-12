/**
 * Destino pretendido antes do login.
 *
 * Sem isto, abrir um convite por QR com o app fechado leva a pessoa ao login
 * e, depois de entrar, à aba inicial: o convite se perde e ela não tem como
 * saber para onde deveria ir.
 *
 * O destino vive só em memória, de propósito. É um salto dentro da MESMA
 * sessão de JS (guard → login → destino); guardar rota pretendida em disco
 * faria o app abrir sozinho um link antigo num boot qualquer.
 */

/** Rotas do próprio fluxo de entrada: voltar para elas depois de entrar dá laço. */
const AUTH_ROUTES = new Set([
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/oauth/callback",
]);

/**
 * Só caminho interno passa.
 *
 * Na web, `router.replace` com URL absoluta — ou com `//` e `/\`, que o
 * browser resolve como protocolo-relativo — sai do domínio. Como o valor vem
 * de um link que qualquer um pode montar (QR, e-mail, mensagem), aceitar isso
 * seria um open redirect: a pessoa entra com a senha certa e cai num site de
 * terceiros já autenticada na cabeça dela.
 */
export function isSafeInternalRoute(href: string): boolean {
  if (typeof href !== "string" || href.length === 0) return false;
  if (!href.startsWith("/")) return false;
  if (href.startsWith("//") || href.startsWith("/\\")) return false;
  const path = href.split(/[?#]/)[0];
  if (path === "/") return false;
  return !AUTH_ROUTES.has(path);
}

/**
 * Recompõe "caminho?query" a partir do que o router expõe.
 *
 * Montado à mão de propósito: o `URLSearchParams` do React Native é uma
 * implementação parcial e o `toString()` já lançou "not implemented" em
 * versões passadas. Não vale apostar a navegação pós-login nisso quando
 * `encodeURIComponent` resolve e existe em todo runtime.
 */
export function buildHref(
  pathname: string,
  params: Record<string, string | string[] | undefined> = {},
): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === "string" && item.length > 0) {
        pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(item)}`);
      }
    }
  }
  return pairs.length > 0 ? `${pathname}?${pairs.join("&")}` : pathname;
}

let intendedRoute: string | null = null;

/** Guarda o destino. Ignora em silêncio o que não for caminho interno. */
export function rememberIntendedRoute(href: string): void {
  if (isSafeInternalRoute(href)) intendedRoute = href;
}

/** Devolve e ESQUECE o destino — um login, um salto. */
export function takeIntendedRoute(): string | null {
  const route = intendedRoute;
  intendedRoute = null;
  return route;
}
