// server/sso/launch.ts — SSO launch-code flow (mobile → browser handoff)
//
// Por que existe: em mobile, a sessão do Comunica+ precisa nascer no
// BROWSER do médico (cookie), mas um app nativo não consegue fazer
// form-POST num browser externo. O fluxo antigo fazia o exchange via
// fetch dentro do app — a sessão morria no app e o browser abria
// deslogado.
//
// Fluxo novo:
//   1. App (autenticado) → POST /api/sso/launch-code
//      → { launchUrl: "<base>/api/sso/launch?code=<opaco>" }
//   2. App abre launchUrl no browser (Linking.openURL)
//   3. GET /api/sso/launch consome o código (one-time, TTL 90s),
//      gera o handoff JWT NA HORA e devolve HTML com form auto-submit
//   4. Browser POSTa o token pro Comunica+ → cookie → /entry logado
//
// Segurança:
//   - Código opaco de 64 hex chars (32 bytes CSPRNG) — não é o JWT
//   - JWT nunca aparece em URL nem é persistido
//   - One-time via UPDATE condicional (WHERE used_at IS NULL)
//   - TTL 90s; códigos expirados são varridos oportunisticamente

import { randomBytes } from "crypto";
import { and, eq, isNull, lt, gt } from "drizzle-orm";
import { getDb } from "../db";
import { ssoLaunchCodes, professionalInstitutions, users } from "../../drizzle/schema";
import { generateHandoffToken } from "./generate";

const LAUNCH_CODE_TTL_MS = 90_000;

export interface CreateLaunchCodeResult {
  ok: boolean;
  code?: string;
  error?: string;
}

/** Creates a one-time launch code for the given authenticated user. */
export async function createLaunchCode(
  userId: number,
  institutionId: number,
  clientNonce: string,
): Promise<CreateLaunchCodeResult> {
  const db = await getDb();
  if (!db) return { ok: false, error: "Database unavailable" };

  // Oportunista: varre códigos expirados (mantém a tabela minúscula).
  await db
    .delete(ssoLaunchCodes)
    .where(lt(ssoLaunchCodes.expiresAt, new Date()))
    .catch(() => {});

  const code = randomBytes(32).toString("hex");
  await db.insert(ssoLaunchCodes).values({
    code,
    userId,
    institutionId,
    clientNonce,
    expiresAt: new Date(Date.now() + LAUNCH_CODE_TTL_MS),
  });

  return { ok: true, code };
}

export interface RedeemResult {
  ok: boolean;
  html?: string;
  status?: number;
  error?: string;
}

/**
 * Redeems a launch code: consumes it atomically, generates a fresh
 * handoff token and returns the auto-submit HTML page.
 */
export async function redeemLaunchCode(rawCode: string): Promise<RedeemResult> {
  const db = await getDb();
  if (!db) return { ok: false, status: 500, error: "Banco indisponível" };

  const code = rawCode.trim();
  if (!/^[a-f0-9]{64}$/.test(code)) {
    return { ok: false, status: 400, error: "Código inválido" };
  }

  // Consumo atômico: só uma requisição consegue marcar used_at.
  const [updateResult] = await db
    .update(ssoLaunchCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(ssoLaunchCodes.code, code),
        isNull(ssoLaunchCodes.usedAt),
        gt(ssoLaunchCodes.expiresAt, new Date()),
      ),
    );

  if ((updateResult as { affectedRows?: number }).affectedRows !== 1) {
    return {
      ok: false,
      status: 410,
      error: "Código expirado ou já utilizado. Volte ao app Escala+ e tente novamente.",
    };
  }

  const [row] = await db
    .select()
    .from(ssoLaunchCodes)
    .where(eq(ssoLaunchCodes.code, code))
    .limit(1);
  if (!row) return { ok: false, status: 410, error: "Código não encontrado" };

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  if (!user) return { ok: false, status: 410, error: "Usuário não encontrado" };

  // Role na instituição (mesma resolução do POST /api/sso/generate).
  let roleInInstitution = "USER";
  const [link] = await db
    .select({ roleInInstitution: professionalInstitutions.roleInInstitution })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.userId, row.userId),
        eq(professionalInstitutions.institutionId, row.institutionId),
        eq(professionalInstitutions.active, true),
      ),
    )
    .limit(1);
  if (link) roleInInstitution = link.roleInInstitution;

  const result = await generateHandoffToken({
    user,
    institutionId: row.institutionId,
    clientNonce: row.clientNonce,
    roleInInstitution,
  });

  if (!result.ok) {
    return { ok: false, status: 502, error: result.message };
  }

  return { ok: true, html: buildAutoSubmitHtml(result.targetUrl, {
    handoffToken: result.handoffToken,
    handoffMethod: "REDIRECT_CODE",
    clientNonce: row.clientNonce,
    sourceApp: "ESCALAS_MOBILE_LAUNCH",
    responseMode: "redirect",
    redirectTo: "/entry",
  }) };
}

/** Minimal auto-submit form page. Token travels in POST body only. */
function buildAutoSubmitHtml(targetUrl: string, fields: Record<string, string>): string {
  const inputs = Object.entries(fields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("\n      ");
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Abrindo Comunica+…</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; display: flex;
           align-items: center; justify-content: center; min-height: 100vh;
           margin: 0; background: #F8FAFC; color: #334155; }
    .box { text-align: center; }
    .spinner { width: 32px; height: 32px; border: 3px solid #E2E8F0;
               border-top-color: #2563EB; border-radius: 50%; margin: 0 auto 16px;
               animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="box">
    <div class="spinner"></div>
    <p>Entrando no Comunica+…</p>
    <noscript><p>JavaScript desabilitado — toque no botão:</p></noscript>
    <form id="sso" method="POST" action="${escapeHtml(targetUrl)}">
      ${inputs}
      <noscript><button type="submit">Continuar</button></noscript>
    </form>
  </div>
  <script>document.getElementById("sso").submit();</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Error page shown when a code is invalid/expired. */
export function buildErrorHtml(message: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Escala+ — SSO</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; display: flex;
           align-items: center; justify-content: center; min-height: 100vh;
           margin: 0; background: #F8FAFC; color: #334155; }
    .box { text-align: center; max-width: 320px; padding: 24px; }
    h1 { font-size: 18px; color: #0F172A; }
  </style>
</head>
<body>
  <div class="box">
    <h1>Não foi possível entrar automaticamente</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
}
