import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { getDb, getUserByEmail } from "../db";
import {
  users,
  professionals,
  institutions,
  professionalInstitutions,
  type User,
} from "../../drizzle/schema";
import { sdk } from "../_core/sdk";
import { COOKIE_NAME } from "../../shared/const.js";
import { recordAudit } from "../audit-trail";
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

async function handleSsoExchange(req: Request, res: Response): Promise<void> {
  void req;
  res.status(501).json({ error: "SSO exchange não habilitado neste build" });
}

// POST /api/auth/login
authRouter.post("/login", async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body as { email?: unknown; password?: unknown };

  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    res.status(400).json({ error: "email e password são obrigatórios" });
    return;
  }

  const user = await getUserByEmail(email.toLowerCase().trim());

  if (!user || !user.passwordHash) {
    res.status(401).json({ error: "Credenciais inválidas" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Credenciais inválidas" });
    return;
  }

  try {
    await ensureProfessionalLink(user);
  } catch (err) {
    // Não bloquear login por falha de vínculo em ambiente de desenvolvimento.
    console.warn("[auth.login] ensureProfessionalLink failed:", (err as Error).message);
  }

  const token = await sdk.createSessionToken(String(user.id), { name: user.name ?? "" });
  res.cookie(COOKIE_NAME, token, resolveSetCookieOptions(req));
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
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
  await db.update(users).set({ passwordHash: newHash }).where(eq(users.id, user.id));

  // Audit trail — útil pra detectar abuso (alguém trocou senha alheia).
  await recordAudit({
    actorUserId: user.id,
    actorRole: user.role ?? "doctor",
    actorName: user.name ?? undefined,
    action: "USER_UPDATED",
    entityType: "USER",
    entityId: user.id,
    description: "Senha alterada pelo próprio usuário",
    institutionId: 1,
  });

  res.json({ ok: true });
});

// POST /api/auth/logout
authRouter.post("/logout", (req: Request, res: Response): void => {
  // clearCookie must mirror **all attributes** (path, domain, sameSite,
  // secure) used at Set-Cookie time. Previously this passed only
  // path+domain — Chrome/Safari/Firefox silently ignored the
  // Max-Age=0 on cookies with sameSite=none/secure (the staging
  // config since PR #48), keeping the user logged in.
  res.clearCookie(COOKIE_NAME, resolveClearCookieOptions({ req }));
  res.json({ ok: true });
});

// GET /api/auth/me
authRouter.get("/me", async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await sdk.authenticateRequest(req);
    try {
      await ensureProfessionalLink(user as User);
    } catch (err) {
      console.warn("[auth.me] ensureProfessionalLink failed:", (err as Error).message);
    }
    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch {
    res.status(401).json({ error: "Não autenticado" });
  }
});

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

  const [result] = await db.insert(users).values({
    name,
    email: normalizedEmail,
    passwordHash,
    role: normalizedRole,
    loginMethod: "email",
  });

  const newUserId = (result as any).insertId as number;

  // Auto-create professional global record + canonical tenant link.
  try {
    const [proInsert] = await db.insert(professionals).values({
      userId: newUserId,
      name,
      role: mapRoleToLabel(normalizedRole),
      userRole: mapRoleToProRole(normalizedRole),
    });
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
  } catch (err) {
    console.warn("[register] Could not auto-create professional record:", (err as Error).message);
  }

  const newUser = { id: newUserId, name, email: normalizedEmail, role: normalizedRole };

  recordAudit({
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
