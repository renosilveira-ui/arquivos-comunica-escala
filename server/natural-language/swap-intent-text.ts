// server/natural-language/swap-intent-text.ts — casamento textual puro
// (sem banco) de nomes de pessoas e de setores.
//
// Regra que vale para os dois: o casamento acontece em CAMADAS e só a
// melhor camada com resultado conta. Zero resultado é "não encontrei";
// mais de um na mesma camada é ambiguidade — nunca se escolhe o primeiro.

/** Sem acento, minúscula, espaço colapsado. Mesma folding de `foldCandidateSearch`. */
export function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Conectivos que não entram em sigla nem encerram um nome de setor. */
const CONNECTORS = new Set([
  "de",
  "da",
  "do",
  "das",
  "dos",
  "e",
  "a",
  "o",
  "as",
  "os",
  "em",
  "no",
  "na",
]);

export function isConnector(token: string): boolean {
  return CONNECTORS.has(token);
}

/**
 * Sigla calculável de um nome composto: "Sala de Recuperação" → "sr",
 * "Centro Cirúrgico" → "cc". O schema de `sectors` não tem coluna de
 * apelido/sigla (só `name`), então a sigla é derivada em tempo de leitura.
 *
 * Nome de um único termo relevante não gera sigla: "UTI" viraria "u" e
 * colidiria com qualquer setor começando por U. Esses casos são resolvidos
 * pela camada de nome exato.
 */
export function acronymOf(name: string): string | null {
  const tokens = normalizeText(name)
    .split(" ")
    .filter((token) => token.length > 0 && !isConnector(token));
  if (tokens.length < 2) return null;
  return tokens.map((token) => token[0]).join("");
}

/** Distância de edição limitada: devolve `true` só se cabe em `max`. */
export function withinEditDistance(
  a: string,
  b: string,
  max: number,
): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  if (a === b) return true;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + cost,
      );
      current.push(value);
      if (value < rowBest) rowBest = value;
    }
    // Nenhuma célula da linha cabe no orçamento: não há como melhorar.
    if (rowBest > max) return false;
    previous = current;
  }
  return previous[b.length] <= max;
}

/**
 * Fuzzy controlado: só para termos longos (≥ 5 letras) e só 1 edição.
 * Serve para escorregão de transcrição ("recuperacao" → "recuperacaoo"),
 * não para adivinhar palavra diferente.
 */
function fuzzyEqual(a: string, b: string): boolean {
  if (a.length < 5 || b.length < 5) return false;
  return withinEditDistance(a, b, 1);
}

/**
 * Camadas de casamento. Menor é mais forte; só a melhor camada com
 * resultado é considerada, e empate dentro dela é ambiguidade.
 */
export const MATCH_TIER = {
  EXACT: 1,
  ACRONYM: 2,
  PREFIX: 3,
  FUZZY: 4,
} as const;

export type MatchTier = (typeof MATCH_TIER)[keyof typeof MATCH_TIER];

/** Camada em que `query` casa com o nome de um setor, ou `null`. */
export function sectorMatchTier(query: string, name: string): MatchTier | null {
  const q = normalizeText(query);
  const candidate = normalizeText(name);
  if (!q) return null;
  if (q === candidate) return MATCH_TIER.EXACT;
  if (q === acronymOf(name)) return MATCH_TIER.ACRONYM;

  const queryTokens = q.split(" ").filter((token) => !isConnector(token));
  const nameTokens = candidate.split(" ").filter((token) => !isConnector(token));
  if (queryTokens.length === 0 || nameTokens.length === 0) return null;

  const prefixHit = queryTokens.every((token) =>
    nameTokens.some((nameToken) => nameToken.startsWith(token)),
  );
  if (prefixHit) return MATCH_TIER.PREFIX;

  const fuzzyHit = queryTokens.every((token) =>
    nameTokens.some((nameToken) => fuzzyEqual(nameToken, token)),
  );
  if (fuzzyHit) return MATCH_TIER.FUZZY;
  return null;
}

/**
 * Camada em que `query` casa com o nome de um profissional.
 *
 * Nome completo idêntico ao cadastro vence: quem diz "Bruno" com um
 * "Bruno" e um "Bruno Silva" na escala resolve no exato, sem pergunta —
 * comportamento que o comando de voz já praticava.
 */
export function professionalMatchTier(
  query: string,
  name: string,
): MatchTier | null {
  const q = normalizeText(query);
  const candidate = normalizeText(name);
  if (!q) return null;
  if (q === candidate) return MATCH_TIER.EXACT;

  const queryTokens = q.split(" ").filter(Boolean);
  const nameTokens = candidate.split(" ").filter(Boolean);
  if (queryTokens.length === 0 || nameTokens.length === 0) return null;

  // Primeiro nome, ou primeiro + último ("joao silva" para "João Pedro Silva").
  const firstLast =
    nameTokens.length > 1
      ? `${nameTokens[0]} ${nameTokens[nameTokens.length - 1]}`
      : nameTokens[0];
  if (q === nameTokens[0] || q === firstLast) return MATCH_TIER.ACRONYM;

  const prefixHit = queryTokens.every((token) =>
    nameTokens.some((nameToken) => nameToken.startsWith(token)),
  );
  if (prefixHit) return MATCH_TIER.PREFIX;

  const fuzzyHit = queryTokens.every((token) =>
    nameTokens.some((nameToken) => fuzzyEqual(nameToken, token)),
  );
  if (fuzzyHit) return MATCH_TIER.FUZZY;
  return null;
}

/**
 * Itens que casam na melhor camada disponível. Devolver a camada junto
 * permite ao chamador distinguir "não achei" de "achei vários".
 */
export function bestMatches<T>(
  items: readonly T[],
  tierOf: (item: T) => MatchTier | null,
): { tier: MatchTier | null; matches: T[] } {
  let tier: MatchTier | null = null;
  let matches: T[] = [];
  for (const item of items) {
    const itemTier = tierOf(item);
    if (itemTier === null) continue;
    if (tier === null || itemTier < tier) {
      tier = itemTier;
      matches = [item];
    } else if (itemTier === tier) {
      matches.push(item);
    }
  }
  return { tier, matches };
}
