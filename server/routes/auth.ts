import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { and, eq, or } from "drizzle-orm";
import { getDb, getUserByEmail } from "../db";
import {
  users,
  professionals,
  institutions,
  professionalInstitutions,
  ssoUsedTokens,
  type User,
} from "../../drizzle/schema";
import { sdk } from "../_core/sdk";
import { COOKIE_NAME } from "../../shared/const.js";
import { recordAudit } from "../audit-trail";
import { ENV } from "../_core/env";
import { isSsoJwtError, verifyComunicamaisSsoToken } from "../_core/sso";

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

function mapExternalRoleToUserRole(rawRole?: string | null): UserRole {
  const normalized = String(rawRole ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "admin" || normalized === "gestor_plus" || normalized === "gestorplus") return "admin";
  if (normalized === "manager" || normalized === "gestor_medico" || normalized === "gestormedico") return "manager";
  if (normalized === "nurse" || normalized === "enfermeiro") return "nurse";
  if (normalized === "tech" || normalized === "tecnico" || normalized === "técnico") return "tech";
  return "doctor";
}

export const authRouter = Router();

const BCRYPT_ROUNDS = 12;

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year ms
  path: "/",
};

const DEFAULT_INSTITUTION = {
  id: 1,
  name: "Hospital das Clínicas",
  cnpj: "11111111000191",
  legalName: "Hospital das Clínicas S.A.",
  tradeName: "HC",
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

    const [existingLink] = await db
      .select({ id: professionalInstitutions.id })
      .from(professionalInstitutions)
      .where(
        and(
          eq(professionalInstitutions.professionalId, professionalId),
          eq(professionalInstitutions.institutionId, DEFAULT_INSTITUTION.id),
        ),
      )
      .limit(1);

    if (!existingLink) {
      await db.insert(professionalInstitutions).values({
        professionalId,
        userId: user.id,
        institutionId: DEFAULT_INSTITUTION.id,
        roleInInstitution: mapRoleToProRole(user.role),
        isPrimary: true,
        active: true,
      });
    }
  } catch {
    // Race-safe fallback: another request may have created the vínculo in parallel.
    const [createdInParallel] = await db
      .select({ id: professionals.id })
      .from(professionals)
      .where(eq(professionals.userId, user.id))
      .limit(1);
    if (!createdInParallel) throw new Error("Falha ao garantir vínculo profissional");
  }
}

function resolveInstitutionIdFromTenantKeyMap(tenantKey: string): number | null {
  const rawMap = ENV.comunicaTenantMap.trim();
  if (!rawMap) return null;
  try {
    const parsed = JSON.parse(rawMap) as Record<string, unknown>;
    const mapped = parsed[tenantKey];
    if (typeof mapped === "number" && Number.isInteger(mapped) && mapped > 0) return mapped;
    if (typeof mapped === "string") {
      const id = Number(mapped);
      if (Number.isInteger(id) && id > 0) return id;
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveInstitutionIdByTenantKey(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  tenantKey: string,
) {
  const mappedId = resolveInstitutionIdFromTenantKeyMap(tenantKey);
  if (mappedId) {
    const [byId] = await db
      .select({ id: institutions.id })
      .from(institutions)
      .where(eq(institutions.id, mappedId))
      .limit(1);
    if (byId) return byId.id;
  }

  const maybeId = Number(tenantKey);
  if (Number.isInteger(maybeId) && maybeId > 0) {
    const [byNumeric] = await db
      .select({ id: institutions.id })
      .from(institutions)
      .where(eq(institutions.id, maybeId))
      .limit(1);
    if (byNumeric) return byNumeric.id;
  }

  const [byBusinessKey] = await db
    .select({ id: institutions.id })
    .from(institutions)
    .where(
      or(
        eq(institutions.cnpj, tenantKey),
        eq(institutions.tradeName, tenantKey),
        eq(institutions.name, tenantKey),
      ),
    )
    .limit(1);
  return byBusinessKey?.id ?? null;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as any).code === "ER_DUP_ENTRY"
  );
}

async function consumeSsoJtiOrThrow(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  input: { jti: string; sub: string; tenantKey: string; institutionId: number; expUnix: number },
) {
  try {
    await db.insert(ssoUsedTokens).values({
      jti: input.jti,
      sub: input.sub,
      tenantKey: input.tenantKey,
      institutionId: input.institutionId,
      expiresAt: new Date(input.expUnix * 1000),
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new Error("Token SSO já utilizado (anti-replay)");
    }
    throw error;
  }
}

async function resolveOrCreateUserFromSso(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  params: { sub: string; email?: string; name?: string; role?: string },
) {
  const normalizedEmail = params.email?.toLowerCase().trim();
  const normalizedName = params.name?.trim() || params.email?.split("@")[0] || `Usuário ${params.sub}`;
  const normalizedRole = mapExternalRoleToUserRole(params.role);

  const [bySub] = await db.select().from(users).where(eq(users.openId, params.sub)).limit(1);
  if (bySub) {
    await db
      .update(users)
      .set({
        name: normalizedName,
        email: normalizedEmail ?? bySub.email,
        role: normalizedRole,
        loginMethod: "sso",
        lastSignedIn: new Date(),
      })
      .where(eq(users.id, bySub.id));
    return { ...bySub, name: normalizedName, email: normalizedEmail ?? bySub.email, role: normalizedRole };
  }

  if (normalizedEmail) {
    const [byEmail] = await db.select().from(users).where(eq(users.email, normalizedEmail)).limit(1);
    if (byEmail) {
      if (byEmail.openId && byEmail.openId !== params.sub) {
        throw new Error("Conflito de identidade SSO: email já vinculado a outro sub");
      }
      await db
        .update(users)
        .set({
          openId: params.sub,
          name: normalizedName,
          role: normalizedRole,
          loginMethod: "sso",
          lastSignedIn: new Date(),
        })
        .where(eq(users.id, byEmail.id));
      return { ...byEmail, openId: params.sub, name: normalizedName, role: normalizedRole };
    }
  }

  const [inserted] = await db.insert(users).values({
    openId: params.sub,
    name: normalizedName,
    email: normalizedEmail,
    role: normalizedRole,
    loginMethod: "sso",
    lastSignedIn: new Date(),
  });

  const createdId = (inserted as any).insertId as number;
  const [created] = await db.select().from(users).where(eq(users.id, createdId)).limit(1);
  if (!created) throw new Error("Falha ao criar usuário SSO");
  return created;
}

async function ensureProfessionalForSsoUser(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  user: User,
  role?: string,
) {
  const roleLabel = mapRoleToLabel(mapExternalRoleToUserRole(role));
  const roleInInstitution = mapRoleToProRole(mapExternalRoleToUserRole(role));

  const [existing] = await db
    .select({ id: professionals.id })
    .from(professionals)
    .where(eq(professionals.userId, user.id))
    .limit(1);

  if (existing) {
    await db
      .update(professionals)
      .set({
        name: resolveProfessionalName(user),
        role: roleLabel,
        userRole: roleInInstitution,
      })
      .where(eq(professionals.id, existing.id));
    return { professionalId: existing.id, roleInInstitution };
  }

  const [inserted] = await db.insert(professionals).values({
    userId: user.id,
    name: resolveProfessionalName(user),
    role: roleLabel,
    userRole: roleInInstitution,
  });

  return { professionalId: (inserted as any).insertId as number, roleInInstitution };
}

async function handleSsoExchange(req: Request, res: Response): Promise<void> {
  const { token } = req.body as { token?: unknown };
  if (typeof token !== "string" || !token.trim()) {
    res.status(400).json({ error: "token é obrigatório" });
    return;
  }

  const db = await getDb();
  if (!db) {
    res.status(503).json({ error: "Banco de dados indisponível" });
    return;
  }

  let claims: Awaited<ReturnType<typeof verifyComunicamaisSsoToken>>;
  try {
    claims = await verifyComunicamaisSsoToken(token);
  } catch (error) {
    if (isSsoJwtError(error)) {
      res.status(401).json({ error: "Token SSO inválido ou expirado" });
      return;
    }
    res.status(400).json({ error: (error as Error).message || "Falha na validação SSO" });
    return;
  }

  const institutionId = await resolveInstitutionIdByTenantKey(db, claims.tenant_key);
  if (!institutionId) {
    res.status(403).json({ error: "tenant_key sem mapeamento válido para instituição" });
    return;
  }

  try {
    await consumeSsoJtiOrThrow(db, {
      jti: claims.jti,
      sub: claims.sub,
      tenantKey: claims.tenant_key,
      institutionId,
      expUnix: claims.exp,
    });
  } catch (error) {
    res.status(403).json({ error: (error as Error).message || "Requisição SSO rejeitada" });
    return;
  }

  let user: User;
  try {
    user = await resolveOrCreateUserFromSso(db, {
      sub: claims.sub,
      email: claims.email,
      name: claims.name,
      role: claims.role,
    });
  } catch (error) {
    res.status(409).json({ error: (error as Error).message || "Falha ao provisionar usuário SSO" });
    return;
  }

  const { professionalId, roleInInstitution } = await ensureProfessionalForSsoUser(
    db,
    user,
    claims.role,
  );

  await db
    .insert(professionalInstitutions)
    .values({
      professionalId,
      userId: user.id,
      institutionId,
      roleInInstitution,
      isPrimary: true,
      active: true,
    })
    .onDuplicateKeyUpdate({
      set: { roleInInstitution, active: true },
    });

  await recordAudit(
    {
      actorUserId: user.id,
      actorRole: "sso",
      actorName: user.name ?? undefined,
      action: "SSO_JIT_LINK_CREATED",
      entityType: "USER",
      entityId: user.id,
      description: `SSO JIT vinculado para sub=${claims.sub} tenant=${claims.tenant_key}`,
      institutionId,
      metadata: {
        sub: claims.sub,
        tenantKey: claims.tenant_key,
        jti: claims.jti,
      },
    },
    req,
  );

  const sessionToken = await sdk.createSessionToken(String(user.id), { name: user.name ?? "" });
  // First-party cookie no mesmo domínio do Escalas para evitar bloqueio de third-party cookies.
  res.cookie(COOKIE_NAME, sessionToken, COOKIE_OPTIONS);
  res.json({
    ok: true,
    institutionId,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
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
  } catch {
    res.status(503).json({ error: "Não foi possível validar o vínculo profissional no momento" });
    return;
  }

  const token = await sdk.createSessionToken(String(user.id), { name: user.name ?? "" });
  res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

// POST /api/auth/ssoExchange (camelCase alias)
authRouter.post("/ssoExchange", handleSsoExchange);
// POST /api/auth/sso-exchange (kebab-case canonical)
authRouter.post("/sso-exchange", handleSsoExchange);

// POST /api/auth/logout
authRouter.post("/logout", (_req: Request, res: Response): void => {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

// GET /api/auth/me
authRouter.get("/me", async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await sdk.authenticateRequest(req);
    try {
      await ensureProfessionalLink(user as User);
    } catch {
      res.status(503).json({ error: "Não foi possível validar o vínculo profissional no momento" });
      return;
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
    const professionalId = (proInsert as any).insertId as number;

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
          legalName: DEFAULT_INSTITUTION.legalName,
          tradeName: DEFAULT_INSTITUTION.tradeName,
        },
      });

    await db.insert(professionalInstitutions).values({
      professionalId,
      userId: newUserId,
      institutionId: DEFAULT_INSTITUTION.id,
      roleInInstitution: mapRoleToProRole(normalizedRole),
      isPrimary: true,
      active: true,
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
  }, req);

  res.status(201).json({ user: newUser });
});
