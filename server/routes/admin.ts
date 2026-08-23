import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { randomInt } from "node:crypto";
import { eq, asc, desc, and, gte, lte, sql, isNull } from "drizzle-orm";
import { getDb } from "../db";
import {
  users,
  professionals,
  auditTrail,
  institutions,
  hospitals,
  professionalInstitutions,
  professionalAccess,
} from "../../drizzle/schema";
import { sdk } from "../_core/sdk";
import { recordAudit } from "../audit-trail";

type UserRole = "admin" | "manager" | "doctor" | "nurse" | "tech";

function mapRoleToProRole(role: UserRole): "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS" {
  if (role === "admin") return "GESTOR_PLUS";
  if (role === "manager") return "GESTOR_MEDICO";
  return "USER";
}

/** Instituição do usuário-alvo (primária) — ou a do admin — para a trilha de auditoria (institution_id é NOT NULL). */
async function auditInstitutionFor(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, targetUserId: number, callerUserId: number): Promise<number> {
  for (const uid of [targetUserId, callerUserId]) {
    const links = await db
      .select({ institutionId: professionalInstitutions.institutionId, isPrimary: professionalInstitutions.isPrimary })
      .from(professionalInstitutions)
      .where(eq(professionalInstitutions.userId, uid));
    const pick = (links.find((l) => l.isPrimary) ?? links[0])?.institutionId;
    if (pick) return pick;
  }
  return 1;
}

export const adminRouter = Router();

/** Middleware: require authenticated admin */
async function requireAdmin(req: Request, res: Response, next: () => void) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (user.role !== "admin") {
      res.status(403).json({ error: "Apenas administradores podem acessar esta rota" });
      return;
    }
    (req as any).user = user;
    next();
  } catch {
    res.status(401).json({ error: "Não autenticado" });
  }
}

adminRouter.use(requireAdmin);

// GET /api/admin/users — list all users with professional info
adminRouter.get("/users", async (req: Request, res: Response): Promise<void> => {
  const db = await getDb();
  if (!db) {
    res.status(503).json({ error: "Banco de dados indisponível" });
    return;
  }

  const allUsers = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      createdAt: users.createdAt,
      professionalId: professionals.id,
      userRole: professionals.userRole,
      specialty: professionals.specialty,
    })
    .from(users)
    .leftJoin(professionals, eq(professionals.userId, users.id))
    // Contas excluídas pelo próprio usuário (soft-delete) ficam fora da
    // lista — já estão anonimizadas e não podem ser editadas.
    .where(isNull(users.deletedAt))
    .orderBy(asc(users.name));

  const result = allUsers.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: row.createdAt,
    professional: row.professionalId
      ? { id: row.professionalId, userRole: row.userRole, specialty: row.specialty }
      : null,
  }));

  res.json({ users: result });
});

// PUT /api/admin/users/:id — update user
adminRouter.put("/users/:id", async (req: Request, res: Response): Promise<void> => {
  const userId = Number(req.params.id);
  if (!userId || isNaN(userId)) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }

  const db = await getDb();
  if (!db) {
    res.status(503).json({ error: "Banco de dados indisponível" });
    return;
  }

  const { name, email, role, specialty } = req.body as {
    name?: string;
    email?: string;
    role?: string;
    specialty?: string | null;
  };

  const VALID_ROLES: UserRole[] = ["admin", "manager", "doctor", "nurse", "tech"];

  // Validate role if provided
  if (role && !VALID_ROLES.includes(role as UserRole)) {
    res.status(400).json({ error: `role inválido. Valores aceitos: ${VALID_ROLES.join(", ")}` });
    return;
  }

  // Build update object
  const updates: Record<string, unknown> = {};
  if (name) updates.name = name;
  if (email) updates.email = email.toLowerCase().trim();
  if (role) updates.role = role;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nenhum campo para atualizar" });
    return;
  }

  // Vários writes dependentes → transação: papel, especialidade e vínculos
  // mudam juntos ou não mudam.
  await db.transaction(async (tx) => {
    await tx.update(users).set(updates).where(eq(users.id, userId));

    // Especialidade (serviço) vive no professional
    if (specialty !== undefined) {
      await tx
        .update(professionals)
        .set({ specialty: specialty && specialty.trim() ? specialty.trim() : null })
        .where(eq(professionals.userId, userId));
    }

    if (role) {
      const proRole = mapRoleToProRole(role as UserRole);
      await tx
        .update(professionals)
        .set({ userRole: proRole })
        .where(eq(professionals.userId, userId));

      // A autorização por tenant (policy.ts, month-guards, editor, swaps)
      // lê SOMENTE professional_institutions.role_in_institution. Sem esta
      // linha, rebaixar um gestor não revogava nada e promover um médico
      // não concedia nada (auditoria 22/08, achado A1).
      await tx
        .update(professionalInstitutions)
        .set({ roleInInstitution: proRole })
        .where(eq(professionalInstitutions.userId, userId));
    }
  });

  // Return updated user
  const [updated] = await db.select().from(users).where(eq(users.id, userId));
  if (!updated) {
    res.status(404).json({ error: "Usuário não encontrado" });
    return;
  }

  const caller = (req as any).user;
  recordAudit({
    institutionId: await auditInstitutionFor(db, userId, caller.id),
    action: role ? "USER_ROLE_CHANGED" : "USER_UPDATED",
    entityType: "USER",
    entityId: userId,
    actorUserId: caller.id,
    actorRole: caller.role,
    actorName: caller.name ?? undefined,
    description: role
      ? `Role de usuário #${userId} alterado para ${role} por ${caller.name ?? "admin"}`
      : `Usuário #${userId} atualizado por ${caller.name ?? "admin"}`,
    metadata: { changes: updates },
  });

  res.json({
    user: {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      role: updated.role,
    },
  });
});

// ---------------------------------------------------------------------------
// POST /api/admin/users/:id/reset-password — senha temporária (frente A3)
//
// Gera uma senha legível de 12 caracteres (sem 0/O/1/l/I), grava o hash
// e liga must_change_password: no próximo login o app obriga a troca.
// A senha em claro é devolvida UMA vez na resposta — não é persistida
// nem logada.
// ---------------------------------------------------------------------------

const TEMP_PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const TEMP_PASSWORD_LENGTH = 12;

function generateTemporaryPassword(): string {
  let out = "";
  for (let i = 0; i < TEMP_PASSWORD_LENGTH; i++) {
    out += TEMP_PASSWORD_ALPHABET[randomInt(TEMP_PASSWORD_ALPHABET.length)];
  }
  return out;
}

adminRouter.post("/users/:id/reset-password", async (req: Request, res: Response): Promise<void> => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }

  const db = await getDb();
  if (!db) {
    res.status(503).json({ error: "Banco de dados indisponível" });
    return;
  }

  const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!target || target.deletedAt) {
    res.status(404).json({ error: "Usuário não encontrado" });
    return;
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await bcrypt.hash(temporaryPassword, 12);
  await db
    .update(users)
    .set({ passwordHash, mustChangePassword: true })
    .where(eq(users.id, userId));

  // audit_trail.institution_id é NOT NULL: usa a instituição (primária)
  // do usuário alvo; cai na default (1) quando não há vínculo.
  const links = await db
    .select({
      institutionId: professionalInstitutions.institutionId,
      isPrimary: professionalInstitutions.isPrimary,
    })
    .from(professionalInstitutions)
    .where(eq(professionalInstitutions.userId, userId));
  const auditInstitutionId = (links.find((l) => l.isPrimary) ?? links[0])?.institutionId ?? 1;

  const caller = (req as any).user;
  recordAudit({
    action: "USER_UPDATED",
    entityType: "USER",
    entityId: userId,
    actorUserId: caller.id,
    actorRole: caller.role,
    actorName: caller.name ?? undefined,
    description: `Senha de usuário #${userId} redefinida por ${caller.name ?? "admin"} (senha temporária, troca obrigatória no próximo login)`,
    metadata: { mustChangePassword: true },
    institutionId: auditInstitutionId,
  });

  res.json({ ok: true, temporaryPassword });
});

// GET /api/admin/audit — query audit trail
adminRouter.get("/audit", async (req: Request, res: Response): Promise<void> => {
  const db = await getDb();
  if (!db) {
    res.status(503).json({ error: "Banco de dados indisponivel" });
    return;
  }

  const {
    entityType,
    entityId,
    actorUserId,
    startDate,
    endDate,
    action,
    limit: rawLimit,
    offset: rawOffset,
  } = req.query as Record<string, string | undefined>;

  const conditions = [];

  if (entityType) conditions.push(eq(auditTrail.entityType, entityType as any));
  if (entityId) conditions.push(eq(auditTrail.entityId, Number(entityId)));
  if (actorUserId) conditions.push(eq(auditTrail.actorUserId, Number(actorUserId)));
  if (action) conditions.push(eq(auditTrail.action, action as any));
  if (startDate) conditions.push(gte(auditTrail.createdAt, new Date(startDate)));
  if (endDate) conditions.push(lte(auditTrail.createdAt, new Date(endDate)));

  const pageLimit = Math.min(Number(rawLimit) || 50, 200);
  const pageOffset = Number(rawOffset) || 0;

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, countResult] = await Promise.all([
    db
      .select()
      .from(auditTrail)
      .where(where)
      .orderBy(desc(auditTrail.createdAt))
      .limit(pageLimit)
      .offset(pageOffset),
    db
      .select({ total: sql<number>`count(*)` })
      .from(auditTrail)
      .where(where),
  ]);

  res.json({
    data: rows,
    total: Number(countResult[0]?.total ?? 0),
    limit: pageLimit,
    offset: pageOffset,
  });
});

// DELETE /api/admin/users/:id — not implemented (no isActive field)
adminRouter.delete("/users/:id", async (req: Request, res: Response): Promise<void> => {
  const caller = (req as any).user;
  const userId = Number(req.params.id);

  if (userId === caller.id) {
    res.status(400).json({ error: "Não é possível desativar a si mesmo" });
    return;
  }

  res.status(501).json({ error: "Funcionalidade de desativação ainda não implementada (campo isActive não existe na tabela users)" });
});

// ---------------------------------------------------------------------------
// Cadastros pendentes (auto-cadastro público — feat/self-signup)
// ---------------------------------------------------------------------------

// GET /api/admin/pending-signups — contas aguardando aprovação
adminRouter.get("/pending-signups", async (_req: Request, res: Response): Promise<void> => {
  const db = await getDb();
  if (!db) {
    res.status(503).json({ error: "Banco de dados indisponível" });
    return;
  }

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      createdAt: users.createdAt,
      institutionId: professionalInstitutions.institutionId,
      institutionName: institutions.name,
    })
    .from(users)
    .leftJoin(professionalInstitutions, eq(professionalInstitutions.userId, users.id))
    .leftJoin(institutions, eq(institutions.id, professionalInstitutions.institutionId))
    .where(eq(users.approvalStatus, "PENDING"))
    .orderBy(asc(users.createdAt));

  res.json({ pending: rows });
});

// POST /api/admin/pending-signups/:id/approve — aprova a conta:
// APPROVED + ativa o vínculo institucional + concede acesso a todos os
// hospitais da instituição escolhida (sectorId null = todos os setores).
adminRouter.post("/pending-signups/:id/approve", async (req: Request, res: Response): Promise<void> => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }

  const db = await getDb();
  if (!db) {
    res.status(503).json({ error: "Banco de dados indisponível" });
    return;
  }

  const [pending] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!pending || pending.approvalStatus !== "PENDING") {
    res.status(404).json({ error: "Cadastro pendente não encontrado" });
    return;
  }

  await db.update(users).set({ approvalStatus: "APPROVED" }).where(eq(users.id, userId));

  const links = await db
    .select({
      id: professionalInstitutions.id,
      professionalId: professionalInstitutions.professionalId,
      institutionId: professionalInstitutions.institutionId,
    })
    .from(professionalInstitutions)
    .where(eq(professionalInstitutions.userId, userId));

  for (const link of links) {
    await db
      .update(professionalInstitutions)
      .set({ active: true })
      .where(eq(professionalInstitutions.id, link.id));

    const institutionHospitals = await db
      .select({ id: hospitals.id })
      .from(hospitals)
      .where(eq(hospitals.institutionId, link.institutionId));

    for (const hospital of institutionHospitals) {
      await db
        .insert(professionalAccess)
        .values({
          institutionId: link.institutionId,
          professionalId: link.professionalId,
          hospitalId: hospital.id,
          sectorId: null,
          canAccess: true,
        })
        .onDuplicateKeyUpdate({ set: { canAccess: true } });
    }
  }

  const caller = (req as any).user;
  recordAudit({
    institutionId: await auditInstitutionFor(db, userId, caller.id),
    action: "USER_UPDATED",
    entityType: "USER",
    entityId: userId,
    actorUserId: caller.id,
    actorRole: caller.role,
    actorName: caller.name ?? undefined,
    description: `Cadastro de ${pending.name ?? pending.email} aprovado por ${caller.name ?? "admin"}`,
    metadata: { approval: "APPROVED", selfSignup: true },
  });

  res.json({ ok: true });
});

// POST /api/admin/pending-signups/:id/reject — recusa e remove a conta
// pendente (vínculo + profissional + usuário). Só atua sobre PENDING.
adminRouter.post("/pending-signups/:id/reject", async (req: Request, res: Response): Promise<void> => {
  const userId = Number(req.params.id);
  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }

  const db = await getDb();
  if (!db) {
    res.status(503).json({ error: "Banco de dados indisponível" });
    return;
  }

  const [pending] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!pending || pending.approvalStatus !== "PENDING") {
    res.status(404).json({ error: "Cadastro pendente não encontrado" });
    return;
  }

  const caller = (req as any).user;
  // Auditar ANTES de remover (entityId preservado no trail).
  recordAudit({
    institutionId: await auditInstitutionFor(db, userId, caller.id),
    action: "USER_UPDATED",
    entityType: "USER",
    entityId: userId,
    actorUserId: caller.id,
    actorRole: caller.role,
    actorName: caller.name ?? undefined,
    description: `Cadastro de ${pending.name ?? pending.email} recusado e removido por ${caller.name ?? "admin"}`,
    metadata: { approval: "REJECTED", selfSignup: true, email: pending.email },
  });

  const pros = await db
    .select({ id: professionals.id })
    .from(professionals)
    .where(eq(professionals.userId, userId));
  for (const pro of pros) {
    await db.delete(professionalAccess).where(eq(professionalAccess.professionalId, pro.id));
  }
  await db.delete(professionalInstitutions).where(eq(professionalInstitutions.userId, userId));
  await db.delete(professionals).where(eq(professionals.userId, userId));
  await db.delete(users).where(eq(users.id, userId));

  res.json({ ok: true });
});
