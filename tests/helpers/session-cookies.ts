import type { Response as SupertestResponse } from "supertest";

export function setCookieHeaders(res: SupertestResponse): string[] {
  const header = res.headers["set-cookie"];
  return Array.isArray(header) ? header : header ? [header] : [];
}

export function cookiePair(res: SupertestResponse, name: string): string {
  const header = setCookieHeaders(res).find((candidate) =>
    candidate.startsWith(`${name}=`),
  );
  if (!header) throw new Error(`Cookie ${name} ausente`);
  return header.split(";", 1)[0]!;
}

function fenceFromCookieHeader(cookieHeader: string): string | null {
  const pair = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("session_fence="));
  return pair ?? null;
}

/** Cookie header com session + session_fence após login ou rotação parcial. */
export function sessionAuthCookies(
  res: SupertestResponse,
  carryFenceFrom?: string,
): string {
  const session = cookiePair(res, "session");
  try {
    return `${session}; ${cookiePair(res, "session_fence")}`;
  } catch {
    const fence = carryFenceFrom ? fenceFromCookieHeader(carryFenceFrom) : null;
    if (!fence) throw new Error("Cookie session_fence ausente");
    return `${session}; ${fence}`;
  }
}

/** Extrai cookies de autenticação de uma resposta de login (padrão dos testes). */
export function cookieOfFromLogin(
  res: SupertestResponse,
  carryFenceFrom?: string,
): string {
  return sessionAuthCookies(res, carryFenceFrom);
}
