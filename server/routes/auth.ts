import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { getDb, getUserByEmail } from "../db";
import {
  users,
  professionals,
  institutions,
  professionalInstitutions,
  professionalAccess,
  hospitals,
  passwordResets,
  pushTokens,
  shiftAssignmentsV2,
  shiftInstances,
  type User,
} from "../../drizzle/schema";
import { sdk } from "../_core/sdk";
import { COOKIE_NAME } from "../../shared/const.js";
import { recordAudit } from "../audit-trail";
import { mailer } from "../mailer";
import {
  resolveClearCookieOptions,
  resolveSetCookieOptions,
} from "../_core/cookie-policy";

type UserRole = "admin" | "manager" | "doctor" | "nurse" | "tech";

function mapRoleToProRole(role: UserRole): "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS" {
  if (role === "admin") return "GESTOR_PLUS";
  if (role === "manager") return "GESTOR_MEDICO";
  return "USER";
}

function mapRoleToLabel(role: UserRole): string {
  const labels: Record<UserRole, string> = {
    admin: "Administrador",
    manager: "Gestor",
    doctor: "Médico",
    nurse: "Enfermeiro",
    tech: "Técnico de Enfermagem",
  };
  return labels[role];
}

export const authRouter = Router();

const BCRYPT_ROUNDS = 12;

const DEFAULT_INSTITUTION = {
  id: 1,
  name: "Hospital das Clínicas",
  cnpj: "00000000000000",
  legalName: "Hospital das Clínicas",
  tradeName: "Hospital das Clínicas",
} as const;

function resolveProfessionalName(user: User): string {
  const explicitName = String(user.name ?? "").trim();
  if (explicitName) return explicitName;
  const email = String(user.email ?? "").trim();
  if (email.includes("@")) return email.split("@")[0]!;
  return `Usuário ${user.id}`;
}

async function ensureProfessionalLink(user: User): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // Conveniência APENAS para contas órfãs (legado/dev, sem nenhum
  // vínculo institucional). Se o usuário já tem qualquer vínculo — ex.:
  // os anestesistas importados, ligados ao São Carlos — NÃO criar o
  // vínculo com a instituição default: isso poluía a conta com um
  // "Hospital das Clínicas" ativo no primeiro login, fazia o seletor
  // de instituição aparecer e derrubava o usuário no tenant errado.
  const [existingLink] = await db
    .select({ id: professionalInstitutions.id })
    .from(professionalInstitutions)
    .where(eq(professionalInstitutions.userId, user.id))
    .limit(1);
  if (existingLink) return;

  const [existingProfessional] = await db
    .select({ id: professionals.id })
    .from(professionals)
    .where(eq(professionals.userId, user.id))
    .limit(1);

  await db
    .insert(institutions)
    .values({
      id: DEFAULT_INSTITUTION.id,
      name: DEFAULT_INSTITUTION.name,
      cnpj: DEFAULT_INSTITUTION.cnpj,
      legalName: DEFAULT_INSTITUTION.legalName,
      tradeName: DEFAULT_INSTITUTION.tradeName,
    })
    .onDuplicateKeyUpdate({
      set: {
        name: DEFAULT_INSTITUTION.name,
        cnpj: DEFAULT_INSTITUTION.cnpj,
        legalName: DEFAULT_INSTITUTION.legalName,
        tradeName: DEFAULT_INSTITUTION.tradeName,
      },
    });

  let professionalId = existingProfessional?.id;
  try {
    if (!professionalId) {
      const [proInsert] = await db.insert(professionals).values({
        userId: user.id,
        name: resolveProfessionalName(user),
        role: mapRoleToLabel(user.role),
        userRole: mapRoleToProRole(user.role),
      });
      professionalId = (proInsert as any).insertId as number;
    }
  } catch {
    // Race-safe fallback: another request may have created the vínculo in parallel.
    const [createdInParallel] = await db
      .select({ id: professionals.id })
      .from(professionals)
      .where(eq(professionals.userId, user.id))
      .limit(1);
    if (!createdInParallel) throw new Error("Falha ao garantir vínculo profissional");
    professionalId = createdInParallel.id;
  }

  if (professionalId) {
    await db
      .insert(professionalInstitutions)
      .values({
        professionalId,
        userId: user.id,
        institutionId: DEFAULT_INSTITUTION.id,
        roleInInstitution: mapRoleToProRole(user.role as UserRole),
        isPrimary: true,
        active: true,
      })
      .onDuplicateKeyUpdate({
        set: {
          active: true,
          roleInInstitution: mapRoleToProRole(user.role as UserRole),
          isPrimary: true,
        },
      });
  }
}

async function handleSsoExchange(_req: Request, res: Response): Promise<void> {
  res.status(301).json({
    error: "Endpoint migrado. Use POST /api/sso/generate para gerar handoff token.",
    redirect: "/api/sso/generate",
  });
}

// POST /api/auth/login
authRouter.post("/login", async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body as { email?: unknown; password?: unknown };

  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    res.status(400).json({ error: "email e password são obrigatórios" });
    return;
  }

  const user = await getUserByEmail(email.toLowerCase().trim());

  // Conta excluída (soft-delete) responde igual a credencial inválida —
  // não revela que o e-mail já existiu.
  if (!user || !user.passwordHash || user.deletedAt) {
    res.status(401).json({ error: "Credenciais inválidas" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Credenciais inválidas" });
    return;
  }

  // Conta pendente de aprovação: não criar vínculo com a instituição
  // default — o auto-cadastro já criou o vínculo (inativo) com a
  // instituição escolhida, e o app bloqueia na tela de aprovação.
  if (user.approvalStatus !== "PENDING") {
    try {
      await ensureProfessionalLink(user);
    } catch (err) {
      // Não bloquear login por falha de vínculo em ambiente de desenvolvimento.
      console.warn("[auth.login] ensureProfessionalLink failed:", (err as Error).message);
    }
  }

  const token = await sdk.createSessionToken(String(user.id), { name: user.name ?? "" });
  res.cookie(COOKIE_NAME, token, resolveSetCookieOptions(req));
  res.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      approvalStatus: user.approvalStatus,
      mustChangePassword: user.mustChangePassword,
    },
    token,
  });
});

// POST /api/auth/ssoExchange (camelCase alias)
authRouter.post("/ssoExchange", handleSsoExchange);
// POST /api/auth/sso-exchange (kebab-case canonical)
authRouter.post("/sso-exchange", handleSsoExchange);

// POST /api/auth/change-password
//
// Permite que um usuário autenticado troque a própria senha.
// Requer:
//   - sessão válida (cookie session)
//   - currentPassword para evitar token-stealing → password change
//   - newPassword com regras mínimas (≥8 chars, distinto da atual)
//
// Não invalida a sessão atual — usuário continua logado com novo
// hash. Outras sessões em outros dispositivos continuam válidas
// (limitação conhecida; requer rotação de session token + revoke
// dos antigos, que é frente separada).
authRouter.post("/change-password", async (req: Request, res: Response): Promise<void> => {
  let authUser;
  try {
    authUser = await sdk.authenticateRequest(req);
  } catch {
    res.status(401).json({ error: "Não autenticado" });
    return;
  }

  const { currentPassword, newPassword } = req.body as {
    currentPassword?: unknown;
    newPassword?: unknown;
  };

  if (
    typeof currentPassword !== "string" ||
    typeof newPassword !== "string" ||
    !currentPassword ||
    !newPassword
  ) {
    res.status(400).json({ error: "currentPassword e newPassword são obrigatórios" });
    return;
  }

  if (newPassword.length < 8) {
    res.status(400).json({ error: "Nova senha precisa ter ao menos 8 caracteres" });
    return;
  }

  if (newPassword === currentPassword) {
    res.status(400).json({ error: "Nova senha precisa ser diferente da atual" });
    return;
  }

  const db = await getDb();
  if (!db) {
    res.status(500).json({ error: "Database not available" });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.id, Number(authUser.id)));
  if (!user || !user.passwordHash) {
    res.status(401).json({ error: "Conta sem senha definida" });
    return;
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Senha atual incorreta" });
    return;
  }

  const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  // Troca voluntária (ou forçada após senha temporária do admin) limpa
  // a flag must_change_password.
  await db
    .update(users)
    .set({ passwordHash: newHash, mustChangePassword: false })
    .where(eq(users.id, user.id));

  // Audit trail — útil pra detectar abuso (alguém trocou senha alheia).
  await recordAudit({
    actorUserId: user.id,
    actorRole: user.role ?? "doctor",
    actorName: user.name ?? undefined,
    action: "USER_UPDATED",
    entityType: "USER",
    entityId: user.id,
    description: "Senha alterada pelo próprio usuário",
    institutionId: await primaryInstitutionOf(user.id),
  });

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Esqueci minha senha (frente A3)
//
// POST /forgot-password {email} → sempre 200 (sem enumeração de contas).
// Se o e-mail existir, estiver ativo (não excluído) e tiver senha, gera
// token aleatório (32 bytes), grava só o sha256 com TTL de 30 min e envia
// o link por e-mail (server/mailer.ts — loga no console sem RESEND_API_KEY).
//
// POST /reset-password {token, newPassword} → valida (existe, não usado,
// não expirado), grava o novo hash e marca used_at.
//
// Sessões existentes: o cookie é um JWT sem estado (1 ano) e não há lista
// de revogação — outras sessões do usuário continuam válidas após o reset
// (mesma limitação já documentada em change-password).
// ---------------------------------------------------------------------------

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;
const FORGOT_RATE_LIMIT_MAX = 3;
const FORGOT_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

/** Rate-limit em memória: 3 pedidos por e-mail por hora. */
const forgotAttemptsByEmail = new Map<string, number[]>();

function isForgotRateLimited(email: string, now = Date.now()): boolean {
  const recent = (forgotAttemptsByEmail.get(email) ?? []).filter(
    (ts) => now - ts < FORGOT_RATE_LIMIT_WINDOW_MS,
  );
  if (recent.length >= FORGOT_RATE_LIMIT_MAX) {
    forgotAttemptsByEmail.set(email, recent);
    return true;
  }
  recent.push(now);
  forgotAttemptsByEmail.set(email, recent);
  // Poda oportunista para o Map não crescer indefinidamente.
  if (forgotAttemptsByEmail.size > 5000) {
    for (const [key, stamps] of forgotAttemptsByEmail) {
      if (!stamps.some((ts) => now - ts < FORGOT_RATE_LIMIT_WINDOW_MS)) {
        forgotAttemptsByEmail.delete(key);
      }
    }
  }
  return false;
}

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * audit_trail.institution_id é NOT NULL: usa a instituição (primária)
 * do usuário; cai na default quando a conta ainda não tem vínculo.
 */
async function resolveAuditInstitutionId(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return DEFAULT_INSTITUTION.id;
  const links = await db
    .select({
      institutionId: professionalInstitutions.institutionId,
      isPrimary: professionalInstitutions.isPrimary,
    })
    .from(professionalInstitutions)
    .where(eq(professionalInstitutions.userId, userId));
  const primary = links.find((l) => l.isPrimary) ?? links[0];
  return primary?.institutionId ?? DEFAULT_INSTITUTION.id;
}

/** Base pública do app para montar o link de redefinição. */
function resolvePublicBaseUrl(req: Request): string {
  const configured = (process.env.APP_PUBLIC_URL ?? "").trim();
  if (configured) return configured.replace(/\/$/, "");
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  const proto = forwardedProto || req.protocol || "http";
  const host = req.get("host") ?? "localhost";
  return `${proto}://${host}`;
}

authRouter.post("/forgot-password", async (req: Request, res: Response): Promise<void> => {
  const { email } = req.body as { email?: unknown };
  if (typeof email !== "string" || !email.trim()) {
    res.status(400).json({ error: "email é obrigatório" });
    return;
  }
  const normalizedEmail = email.toLowerCase().trim();

  // Resposta neutra em TODOS os caminhos abaixo (inclusive rate-limit):
  // quem pede não descobre se a conta existe.
  const neutral = { ok: true };

  if (isForgotRateLimited(normalizedEmail)) {
    res.json(neutral);
    return;
  }

  const db = await getDb();
  if (!db) {
    res.json(neutral);
    return;
  }

  const user = await getUserByEmail(normalizedEmail);
  if (!user || user.deletedAt || !user.passwordHash || !user.email) {
    res.json(neutral);
    return;
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await db.insert(passwordResets).values({
    userId: user.id,
    tokenHash: hashResetToken(token),
    expiresAt,
  });

  const link = `${resolvePublicBaseUrl(req)}/reset-password?token=${token}`;
  const firstName = resolveProfessionalName(user).split(" ")[0];
  await mailer.sendMail({
    to: user.email,
    subject: "Escala+ — redefinir sua senha",
    text: [
      `Olá, ${firstName}.`,
      "",
      "Recebemos um pedido para redefinir a senha da sua conta no Escala+.",
      "Abra o link abaixo para escolher uma nova senha (válido por 30 minutos):",
      "",
      link,
      "",
      "Se você não pediu isso, ignore este e-mail — sua senha continua a mesma.",
    ].join("\n"),
  });

  recordAudit({
    actorUserId: user.id,
    actorRole: user.role ?? "doctor",
    actorName: user.name ?? undefined,
    action: "USER_UPDATED",
    entityType: "USER",
    entityId: user.id,
    description: "Pedido de redefinição de senha (esqueci minha senha)",
    metadata: { expiresAt: expiresAt.toISOString() },
    institutionId: await resolveAuditInstitutionId(user.id),
  });

  res.json(neutral);
});

authRouter.post("/reset-password", async (req: Request, res: Response): Promise<void> => {
  const { token, newPassword } = req.body as { token?: unknown; newPassword?: unknown };

  if (typeof token !== "string" || !token.trim() || typeof newPassword !== "string" || !newPassword) {
    res.status(400).json({ error: "token e newPassword são obrigatórios" });
    return;
  }
  if (newPassword.length < 8) {
    res.status(400).json({ error: "Nova senha precisa ter ao menos 8 caracteres" });
    return;
  }

  const db = await getDb();
  if (!db) {
    res.status(503).json({ error: "Banco de dados indisponível" });
    return;
  }

  const INVALID = "Link inválido ou expirado. Peça uma nova redefinição de senha.";

  const [reset] = await db
    .select()
    .from(passwordResets)
    .where(eq(passwordResets.tokenHash, hashResetToken(token.trim())))
    .limit(1);

  if (!reset || reset.usedAt || reset.expiresAt.getTime() <= Date.now()) {
    res.status(400).json({ error: INVALID });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.id, reset.userId)).limit(1);
  if (!user || user.deletedAt) {
    res.status(400).json({ error: INVALID });
    return;
  }

  const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  await db
    .update(users)
    .set({ passwordHash: newHash, mustChangePassword: false })
    .where(eq(users.id, user.id));
  await db
    .update(passwordResets)
    .set({ usedAt: new Date() })
    .where(eq(passwordResets.id, reset.id));

  recordAudit({
    actorUserId: user.id,
    actorRole: user.role ?? "doctor",
    actorName: user.name ?? undefined,
    action: "USER_UPDATED",
    entityType: "USER",
    entityId: user.id,
    description: "Senha redefinida via link de 'esqueci minha senha'",
    institutionId: await resolveAuditInstitutionId(user.id),
  });

  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Exclusão de conta pelo próprio usuário (Apple 5.1.1(v))
//
// DELETE /me {password} → exige a senha correta. Bloqueia (409) se houver
// plantão futuro alocado — o gestor precisa realocar antes. Caso contrário
// faz soft-delete: anonimiza nome/e-mail, marca deleted_at, desativa os
// vínculos institucionais, apaga push tokens e encerra a sessão.
//
// A linha de users permanece (FKs em audit_trail, shift_assignments,
// swap_requests etc.) — apenas anonimizada.
// ---------------------------------------------------------------------------

const FUTURE_SHIFTS_MESSAGE =
  "Você tem plantões futuros alocados — peça ao gestor para realocá-los antes de excluir a conta.";

authRouter.delete("/me", async (req: Request, res: Response): Promise<void> => {
  let authUser: User;
  try {
    authUser = await sdk.authenticateRequest(req);
  } catch {
    res.status(401).json({ error: "Não autenticado" });
    return;
  }

  const { password } = req.body as { password?: unknown };
  if (typeof password !== "string" || !password) {
    res.status(400).json({ error: "password é obrigatório" });
    return;
  }

  const db = await getDb();
  if (!db) {
    res.status(503).json({ error: "Banco de dados indisponível" });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.id, authUser.id)).limit(1);
  if (!user || user.deletedAt) {
    res.status(401).json({ error: "Não autenticado" });
    return;
  }
  if (!user.passwordHash) {
    res.status(400).json({ error: "Conta sem senha definida" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Senha incorreta" });
    return;
  }

  // Plantões futuros: qualquer alocação ativa em shift_instances com
  // start_at no futuro (instante UTC no banco; comparação por instante).
  const professionalRows = await db
    .select({ id: professionals.id })
    .from(professionals)
    .where(eq(professionals.userId, user.id));
  const professionalIds = professionalRows.map((p) => p.id);

  if (professionalIds.length > 0) {
    for (const professionalId of professionalIds) {
      const [future] = await db
        .select({ id: shiftAssignmentsV2.id })
        .from(shiftAssignmentsV2)
        .innerJoin(shiftInstances, eq(shiftInstances.id, shiftAssignmentsV2.shiftInstanceId))
        .where(
          and(
            eq(shiftAssignmentsV2.professionalId, professionalId),
            eq(shiftAssignmentsV2.isActive, true),
            gt(shiftInstances.startAt, new Date()),
          ),
        )
        .limit(1);
      if (future) {
        res.status(409).json({ error: FUTURE_SHIFTS_MESSAGE });
        return;
      }
    }
  }

  const originalEmail = user.email;
  const now = new Date();
  // Resolver ANTES de desativar os vínculos (a auditoria precisa da
  // instituição do usuário).
  const auditInstitutionId = await resolveAuditInstitutionId(user.id);

  await db
    .update(users)
    .set({
      deletedAt: now,
      name: "Conta removida",
      email: `removido+${user.id}@anon.local`,
      mustChangePassword: false,
    })
    .where(eq(users.id, user.id));

  await db
    .update(professionalInstitutions)
    .set({ active: false })
    .where(eq(professionalInstitutions.userId, user.id));

  await db.delete(pushTokens).where(eq(pushTokens.userId, user.id));

  // Tokens de reset pendentes deixam de fazer sentido.
  await db.delete(passwordResets).where(eq(passwordResets.userId, user.id));

  recordAudit({
    actorUserId: user.id,
    actorRole: user.role ?? "doctor",
    actorName: user.name ?? undefined,
    action: "USER_UPDATED",
    entityType: "USER",
    entityId: user.id,
    description: "Conta excluída pelo próprio usuário (soft-delete, dados anonimizados)",
    metadata: { emailHash: originalEmail ? hashResetToken(originalEmail) : null },
    institutionId: auditInstitutionId,
  });

  res.clearCookie(COOKIE_NAME, resolveClearCookieOptions({ req }));
  res.json({ ok: true });
});

// POST /api/auth/logout
authRouter.post("/logout", async (req: Request, res: Response): Promise<void> => {
  // Token de push do aparelho sai junto com a sessão: senão o push do
  // plantão continuava chegando no aparelho para o usuário anterior.
  const pushToken = typeof req.body?.pushToken === "string" ? req.body.pushToken.slice(0, 512) : null;
  if (pushToken) {
    try {
      const db = await getDb();
      if (db) await db.delete(pushTokens).where(eq(pushTokens.token, pushToken));
    } catch (err) {
      console.warn("[Auth] Falha ao remover push token no logout:", JSON.stringify(String(err)));
    }
  }
  // Clear the cookie with current policy attributes.
  res.clearCookie(COOKIE_NAME, resolveClearCookieOptions({ req }));
  // Also clear with SameSite=None to invalidate cookies set before the
  // same-origin migration. Browsers only honour clearCookie when ALL
  // attributes match the original Set-Cookie; without this, users who
  // logged in under the old cross-origin setup cannot log out.
  const isSecure = req.protocol === "https" ||
    String(req.headers["x-forwarded-proto"] ?? "").includes("https") ||
    process.env.NODE_ENV === "production";
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: isSecure,
    sameSite: "none",
    path: "/",
  });
  res.json({ ok: true });
});

// GET /api/auth/me
authRouter.get("/me", async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await sdk.authenticateRequest(req);
    if (user.approvalStatus !== "PENDING") {
      try {
        await ensureProfessionalLink(user as User);
      } catch (err) {
        console.warn("[auth.me] ensureProfessionalLink failed:", (err as Error).message);
      }
    }
    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        approvalStatus: user.approvalStatus,
        mustChangePassword: user.mustChangePassword,
      },
    });
  } catch {
    res.status(401).json({ error: "Não autenticado" });
  }
});

/**
 * Instituição em que o admin cadastra o usuário: `institutionId` do body
 * (precisa existir) ou o tenant ativo do admin (x-tenant-id validado
 * contra os vínculos dele), ou o vínculo primário do admin. Sem nenhum → 400.
 */
class RegisterInstitutionError extends Error {}
async function resolveRegisterInstitution(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  caller: User,
  req: Request,
): Promise<number> {
  const fromBody = Number((req.body as { institutionId?: unknown })?.institutionId);
  if (Number.isFinite(fromBody) && fromBody > 0) {
    const [inst] = await db.select({ id: institutions.id }).from(institutions).where(eq(institutions.id, fromBody)).limit(1);
    if (!inst) throw new RegisterInstitutionError("Instituição informada não existe");
    return inst.id;
  }
  const header = req.headers["x-tenant-id"];
  const fromHeader = typeof header === "string" ? Number(header) : NaN;
  const links = await db
    .select({ institutionId: professionalInstitutions.institutionId, isPrimary: professionalInstitutions.isPrimary })
    .from(professionalInstitutions)
    .where(and(eq(professionalInstitutions.userId, caller.id), eq(professionalInstitutions.active, true)));
  if (Number.isFinite(fromHeader) && links.some((l) => l.institutionId === fromHeader)) return fromHeader;
  const primary = links.find((l) => l.isPrimary) ?? links[0];
  if (primary) return primary.institutionId;
  throw new RegisterInstitutionError("Informe a instituição do novo usuário (institutionId): o admin não tem vínculo ativo");
}

/** Instituição primária (ou única ativa) do usuário, para a trilha de auditoria. */
async function primaryInstitutionOf(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return DEFAULT_INSTITUTION.id;
  const links = await db
    .select({ institutionId: professionalInstitutions.institutionId, isPrimary: professionalInstitutions.isPrimary })
    .from(professionalInstitutions)
    .where(and(eq(professionalInstitutions.userId, userId), eq(professionalInstitutions.active, true)));
  return (links.find((l) => l.isPrimary) ?? links[0])?.institutionId ?? DEFAULT_INSTITUTION.id;
}

// POST /api/auth/register — somente admin
authRouter.post("/register", async (req: Request, res: Response): Promise<void> => {
  let caller;
  try {
    caller = await sdk.authenticateRequest(req);
  } catch {
    res.status(401).json({ error: "Não autenticado" });
    return;
  }

  if (caller.role !== "admin") {
    res.status(403).json({ error: "Apenas administradores podem cadastrar usuários" });
    return;
  }

  const { name, email, password, role } = req.body as {
    name?: unknown;
    email?: unknown;
    password?: unknown;
    role?: unknown;
  };

  if (
    typeof name !== "string" ||
    typeof email !== "string" ||
    typeof password !== "string" ||
    !name ||
    !email ||
    !password
  ) {
    res.status(400).json({ error: "name, email e password são obrigatórios" });
    return;
  }

  const VALID_ROLES = ["admin", "manager", "doctor", "nurse", "tech"] as const;
  type ValidRole = typeof VALID_ROLES[number];
  const normalizedRole: ValidRole = !role
    ? "doctor"
    : VALID_ROLES.includes(role as ValidRole)
    ? (role as ValidRole)
    : null!;

  if (!normalizedRole) {
    res.status(400).json({ error: `role inválido. Valores aceitos: ${VALID_ROLES.join(", ")}` });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  const existing = await getUserByEmail(normalizedEmail);
  if (existing) {
    res.status(409).json({ error: "Email já cadastrado" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const db = await getDb();
  if (!db) {
    res.status(503).json({ error: "Banco de dados indisponível" });
    return;
  }
  let targetInstitutionId: number;
  try {
    targetInstitutionId = await resolveRegisterInstitution(db, caller, req);
  } catch (err) {
    if (err instanceof RegisterInstitutionError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }

  const [result] = await db.insert(users).values({
    name,
    email: normalizedEmail,
    passwordHash,
    role: normalizedRole,
    loginMethod: "email",
  });

  const newUserId = (result as any).insertId as number;

  // Auto-create professional record + tenant link + hospital access.
  let newProfessionalId: number | null = null;
  try {
    // 1. Instituição-alvo já resolvida (instituição do admin / body).
    //    NUNCA cria/sobrescreve instituição aqui — o upsert antigo renomeava
    //    "Hospital das Clínicas" e zerava o CNPJ a cada cadastro
    //    (auditoria 22/08 parte 2).
    // 2. Create professional record
    const [proInsert] = await db.insert(professionals).values({
      userId: newUserId,
      name,
      role: mapRoleToLabel(normalizedRole),
      userRole: mapRoleToProRole(normalizedRole),
    });
    newProfessionalId = (proInsert as any).insertId as number;

    // 3. Create professional ↔ institution link
    if (newProfessionalId) {
      await db
        .insert(professionalInstitutions)
        .values({
          professionalId: newProfessionalId,
          userId: newUserId,
          institutionId: targetInstitutionId,
          roleInInstitution: mapRoleToProRole(normalizedRole),
          isPrimary: true,
          active: true,
        })
        .onDuplicateKeyUpdate({
          set: {
            active: true,
            roleInInstitution: mapRoleToProRole(normalizedRole),
            isPrimary: true,
          },
        });

      // 4. Grant access to all hospitals in the institution (sectorId=null = all sectors)
      const institutionHospitals = await db
        .select({ id: hospitals.id })
        .from(hospitals)
        .where(eq(hospitals.institutionId, targetInstitutionId));

      for (const hospital of institutionHospitals) {
        await db
          .insert(professionalAccess)
          .values({
            institutionId: targetInstitutionId,
            professionalId: newProfessionalId,
            hospitalId: hospital.id,
            sectorId: null,
            canAccess: true,
          })
          .onDuplicateKeyUpdate({ set: { canAccess: true } });
      }
    }
  } catch (err) {
    console.warn("[register] Could not auto-create professional record:", (err as Error).message);
  }

  const newUser = { id: newUserId, name, email: normalizedEmail, role: normalizedRole };

  recordAudit({
    institutionId: targetInstitutionId,
    action: "USER_CREATED",
    entityType: "USER",
    entityId: newUserId,
    actorUserId: caller.id,
    actorRole: caller.role,
    actorName: caller.name ?? undefined,
    description: `Usuário ${name} (${normalizedRole}) criado por ${caller.name ?? "admin"}`,
    metadata: { email: normalizedEmail, role: normalizedRole },
  });

  res.status(201).json({ user: newUser });
});

// ---------------------------------------------------------------------------
// Auto-cadastro público (feat/self-signup)
//
// Fluxo: qualquer pessoa cria conta escolhendo a instituição → a conta
// nasce com approval_status PENDING e vínculo institucional INATIVO
// (invisível para escalas/alocação) → um administrador aprova na aba
// Admin, o que ativa o vínculo e concede acesso aos hospitais.
//
// Defesa em profundidade: mesmo logado, o usuário PENDING não passa nas
// procedures de tenant (sem vínculo ativo) e o app bloqueia na tela
// "Aguardando aprovação".
// ---------------------------------------------------------------------------

// GET /api/auth/signup-institutions — público: instituições disponíveis
// para o seletor da tela de cadastro (somente id + nome).
authRouter.get("/signup-institutions", async (_req: Request, res: Response): Promise<void> => {
  const db = await getDb();
  if (!db) {
    res.status(503).json({ error: "Banco de dados indisponível" });
    return;
  }
  const rows = await db
    .select({ id: institutions.id, name: institutions.name })
    .from(institutions)
    .where(eq(institutions.isActive, true))
    .orderBy(institutions.name);
  res.json({ institutions: rows });
});

// POST /api/auth/signup — público: cria conta pendente de aprovação.
authRouter.post("/signup", async (req: Request, res: Response): Promise<void> => {
  const { name, email, password, institutionId, specialty } = req.body as {
    name?: unknown;
    email?: unknown;
    password?: unknown;
    institutionId?: unknown;
    specialty?: unknown;
  };

  if (
    typeof name !== "string" ||
    typeof email !== "string" ||
    typeof password !== "string" ||
    !name.trim() ||
    !email.trim() ||
    !password
  ) {
    res.status(400).json({ error: "name, email e password são obrigatórios" });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ error: "A senha deve ter pelo menos 8 caracteres" });
    return;
  }

  const instId = Number(institutionId);
  if (!Number.isInteger(instId) || instId <= 0) {
    res.status(400).json({ error: "Selecione uma instituição" });
    return;
  }

  const db = await getDb();
  if (!db) {
    res.status(503).json({ error: "Banco de dados indisponível" });
    return;
  }

  const [institution] = await db
    .select({ id: institutions.id, name: institutions.name })
    .from(institutions)
    .where(eq(institutions.id, instId))
    .limit(1);
  if (!institution) {
    res.status(400).json({ error: "Instituição não encontrada" });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await getUserByEmail(normalizedEmail);
  if (existing) {
    res.status(409).json({ error: "Email já cadastrado" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const trimmedName = name.trim();

  const [result] = await db.insert(users).values({
    name: trimmedName,
    email: normalizedEmail,
    passwordHash,
    role: "doctor",
    loginMethod: "email",
    approvalStatus: "PENDING",
  });
  const newUserId = (result as any).insertId as number;

  try {
    const [proInsert] = await db.insert(professionals).values({
      userId: newUserId,
      name: trimmedName,
      role: mapRoleToLabel("doctor"),
      userRole: "USER",
      specialty: typeof specialty === "string" && specialty.trim() ? specialty.trim().slice(0, 100) : null,
    });
    const newProfessionalId = (proInsert as any).insertId as number;

    // Vínculo INATIVO até a aprovação: não aparece em listagens de
    // alocação nem passa no resolveTenantActor.
    await db.insert(professionalInstitutions).values({
      professionalId: newProfessionalId,
      userId: newUserId,
      institutionId: institution.id,
      roleInInstitution: "USER",
      isPrimary: true,
      active: false,
    });
  } catch (err) {
    // Sem vínculo o usuário fica órfão — remover para permitir novo cadastro.
    console.error("[signup] Falha ao criar vínculo, revertendo usuário:", (err as Error).message);
    try {
      await db.delete(professionals).where(eq(professionals.userId, newUserId));
      await db.delete(users).where(eq(users.id, newUserId));
    } catch (cleanupErr) {
      console.error("[signup] Falha na limpeza do cadastro incompleto:", (cleanupErr as Error).message);
    }
    res.status(500).json({ error: "Falha ao criar cadastro. Tente novamente." });
    return;
  }

  recordAudit({
    action: "USER_CREATED",
    entityType: "USER",
    entityId: newUserId,
    actorUserId: newUserId,
    actorRole: "doctor",
    actorName: trimmedName,
    description: `Auto-cadastro de ${trimmedName} (${normalizedEmail}) na instituição ${institution.name} — aguardando aprovação`,
    metadata: { email: normalizedEmail, institutionId: institution.id, selfSignup: true },
  });

  res.status(201).json({ ok: true, pending: true });
});
