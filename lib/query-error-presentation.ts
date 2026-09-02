export type QueryErrorPresentation = Readonly<{
  kind: "NETWORK" | "ACCESS" | "SERVICE";
  body: string;
}>;

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const value = error as {
    code?: unknown;
    data?: { code?: unknown };
  };
  const candidate = value.data?.code ?? value.code;
  return typeof candidate === "string" ? candidate : null;
}

function errorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const value = error as { message?: unknown };
  return typeof value.message === "string" ? value.message : "";
}

/**
 * Não exibe a mensagem bruta do backend: ela pode ser técnica ou revelar
 * detalhes de regra. A classificação só orienta a ação do usuário.
 */
export function presentQueryError(error?: unknown): QueryErrorPresentation {
  const code = errorCode(error);
  if (code === "UNAUTHORIZED" || code === "FORBIDDEN") {
    return {
      kind: "ACCESS",
      body: "Seu acesso a estas informações foi alterado. Atualize a tela ou entre novamente.",
    };
  }

  const message = errorMessage(error);
  if (
    code === "TIMEOUT" ||
    /network request failed|failed to fetch|network error|tempo esgotado|abort|econn|enotfound|offline/i.test(
      message,
    )
  ) {
    return {
      kind: "NETWORK",
      body: "Não foi possível comunicar com o serviço. Verifique sua conexão e tente novamente.",
    };
  }

  return {
    kind: "SERVICE",
    body: "O sistema não conseguiu carregar estas informações agora. Tente novamente em instantes.",
  };
}
