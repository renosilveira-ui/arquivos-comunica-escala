import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { getDb, getUserByEmail } from "../db";
import { users, professionals } from "../../drizzle/schema";
import { sdk } from "../_core/sdk";
import { COOKIE_NAME } from "../../shared/const.js";
import { recordAudit } from "../audit-trail";

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

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year ms
  path: "/",
};

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

  const token = await sdk.createSessionToken(String(user.id), { name: user.name ?? "" });
  res.cookie(COOKIE_NAME, token, COOKIE_OPTIONS);
  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

// POST /api/auth/logout
authRouter.post("/logout", (_req: Request, res: Response): void => {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

// GET /api/auth/me
authRouter.get("/me", async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await sdk.authenticateRequest(req);
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

  // Auto-create professional record so the user can be assigned to shifts.
  // Defaults to institutionId=1; fails silently if no institution exists yet.
  try {
    await db.insert(professionals).values({
      userId: newUserId,
      institutionId: 1,
      name,
      role: mapRoleToLabel(normalizedRole),
      userRole: mapRoleToProRole(normalizedRole),
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
