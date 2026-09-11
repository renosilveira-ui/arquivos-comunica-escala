/**
 * Cerca da URL que o SSO abre no browser.
 *
 * `Linking.openURL` é o único efeito irreversível do fluxo mobile, e o alvo
 * vem do corpo de uma resposta. Só é explorável com resposta adulterada — mas
 * a defesa é barata e o estrago seria caro: a pessoa autentica no app e cai
 * num site de terceiros achando que o app a levou até lá.
 *
 * Por contrato (`server/sso/launch.ts`), `launchUrl` é
 * `<base>/api/sso/launch?code=<opaco>`, onde `<base>` é o PRÓPRIO servidor do
 * Escala — não o Comunica+. Logo a cerca certa é: mesma origem da API com que
 * o app já está falando.
 *
 * Deliberadamente NÃO fixo o caminho `/api/sso/launch`. A origem já elimina o
 * risco inteiro — a URL só pode apontar para o nosso servidor. Fixar o caminho
 * não acrescentaria segurança e quebraria o SSO em silêncio no dia em que a
 * rota mudar.
 */

/**
 * Espaço, controle e barra invertida: parsers de URL divergem no que fazem
 * com eles. Escrito com escapes, e não com os caracteres literais, para que
 * a faixa seja legível na revisão.
 */
const AMBIGUOUS = /[\s\\]|[\u0000-\u001f\u007f]/;

const ABSOLUTE_ORIGIN = /^https?:\/\/[^/?#]+$/i;

export function isAllowedSsoLaunchUrl(
  launchUrl: unknown,
  apiBaseUrl: string,
): boolean {
  if (typeof launchUrl !== "string" || launchUrl.length === 0) return false;
  if (AMBIGUOUS.test(launchUrl)) return false;

  const base = apiBaseUrl.trim().replace(/\/+$/, "");
  // Base vazia é a web (mesma origem implícita); o fluxo mobile exige base
  // absoluta. Sem ela não há com o que comparar, então nada passa.
  if (!ABSOLUTE_ORIGIN.test(base)) return false;

  // A barra é o que torna isto uma checagem de ORIGEM e não de texto: sem ela,
  // "https://host.evil.com" passaria por começar com "https://host". Também
  // barra "https://host@evil.com", porque o caractere logo após a base teria
  // de ser "/".
  return launchUrl.startsWith(base + "/");
}

/**
 * Alvo do form POST na web. Diferente do mobile, o destino aqui é o Comunica+,
 * cuja URL o cliente não conhece — não há origem para comparar.
 *
 * O que dá para barrar, e importa, é `javascript:` ou `data:` virando `action`
 * de formulário: isso é execução de script, não navegação.
 */
export function isAllowedSsoTargetUrl(targetUrl: unknown): boolean {
  if (typeof targetUrl !== "string" || targetUrl.length === 0) return false;
  if (AMBIGUOUS.test(targetUrl)) return false;
  return /^https:\/\/[^/?#]+([/?#]|$)/i.test(targetUrl);
}
