import { Router, type Request, type Response } from "express";
import { eq, asc, desc, and, gte, lte, lt, sql, inArray } from "drizzle-orm";
import { getDb } from "../db";
import {
  users,
  professionals,
  professionalInstitutions,
  auditTrail,
} from "../../drizzle/schema";
import { sdk } from "../_core/sdk";
import { recordAudit } from "../audit-trail";
import { maskEmail, parseBooleanParam, sanitizeAuditRows } from "../helpers/lgpd";

type UserRole = "admin" | "manager" | "doctor" | "nurse" | "tech";

function mapRoleToProRole(role: UserRole): "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS" {
  if (role === "admin") return "GESTOR_PLUS";
  if (role === "manager") return "GESTOR_MEDICO";
  return "USER";
}

export const adminRouter = Router();

function readInstitutionId(req: Request): number | null {
  const fromQuery = req.query.institutionId;
  const fromBody = (req.body as any)?.institutionId;
  const raw = (fromBody ?? fromQuery) as string | number | undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

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

  const institutionId = readInstitutionId(req);
  if (!institutionId) {
    res.status(400).json({ error: "institutionId é obrigatório para isolamento por tenant" });
    return;
  }

  const includeSensitive = parseBooleanParam(req.query.includeSensitive);
  const proRows = await db
    .select({
      id: professionals.id,
      userId: professionals.userId,
      institutionId: professionalInstitutions.institutionId,
      role: professionals.role,
      userRole: professionals.userRole,
    })
    .from(professionals)
    .innerJoin(
      professionalInstitutions,
      and(
        eq(professionalInstitutions.professionalId, professionals.id),
        eq(professionalInstitutions.userId, professionals.userId),
      ),
    )
    .where(
      and(
        eq(professionalInstitutions.institutionId, institutionId),
        eq(professionalInstitutions.active, true),
      ),
    );

  const scopedUserIds = Array.from(new Set(proRows.map((p) => p.userId)));

  const allUsers = scopedUserIds.length
    ? await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          role: users.role,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(inArray(users.id, scopedUserIds))
        .orderBy(asc(users.name))
    : [];

  const linksByUser = new Map<number, Array<{
    id: number;
    institutionId: number;
    role: string;
    userRole: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
  }>>();

  for (const row of proRows) {
    const list = linksByUser.get(row.userId) ?? [];
    list.push({
      id: row.id,
      institutionId: row.institutionId,
      role: row.role,
      userRole: row.userRole,
    });
    linksByUser.set(row.userId, list);
  }

  const result = allUsers.map((row) => {
    const links = linksByUser.get(row.id) ?? [];
    return {
      id: row.id,
      name: row.name,
      email: includeSensitive ? row.email : maskEmail(row.email),
      role: row.role,
      createdAt: row.createdAt,
      professional: links[0] ?? null, // backward compatibility for current UI
      professionalLinks: links,
    };
  });

  if (includeSensitive) {
    const caller = (req as any).user;
    recordAudit({
      action: "USER_UPDATED",
      entityType: "USER",
      entityId: caller.id,
      actorUserId: caller.id,
      actorRole: caller.role,
      actorName: caller.name ?? undefined,
      description: "Consulta administrativa com dados sensíveis (users)",
      metadata: { route: "/api/admin/users", includeSensitive: true, institutionId },
      institutionId,
    }, req);
  }

  res.json({ users: result });
});

// POST /api/admin/users/:id/links — add institutional vínculo for a user
adminRouter.post("/users/:id/links", async (req: Request, res: Response): Promise<void> => {
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

  const { institutionId, roleLabel, userRole, name } = req.body as {
    institutionId?: number;
    roleLabel?: string;
    userRole?: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
    name?: string;
  };

  if (!institutionId || !Number.isInteger(institutionId)) {
    res.status(400).json({ error: "institutionId é obrigatório" });
    return;
  }

  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) {
    res.status(404).json({ error: "Usuário não encontrado" });
    return;
  }

  const [existing] = await db
    .select({ id: professionalInstitutions.id })
    .from(professionalInstitutions)
    .where(
      and(
        eq(professionalInstitutions.userId, userId),
        eq(professionalInstitutions.institutionId, institutionId),
      ),
    )
    .limit(1);

  if (existing) {
    res.status(409).json({ error: "Usuário já possui vínculo nesta instituição" });
    return;
  }

  const effectiveUserRole = userRole ?? mapRoleToProRole(user.role as UserRole);
  const effectiveRoleLabel = roleLabel ?? "Médico";
  const effectiveName = name?.trim() || user.name || "Profissional";

  const [existingProfessional] = await db
    .select()
    .from(professionals)
    .where(eq(professionals.userId, userId))
    .limit(1);

  let professionalId = existingProfessional?.id;
  if (!professionalId) {
    const [insertProfessional] = await db.insert(professionals).values({
      userId,
      name: effectiveName,
      role: effectiveRoleLabel,
      userRole: effectiveUserRole,
    });
    professionalId = (insertProfessional as any).insertId as number;
  } else {
    await db
      .update(professionals)
      .set({
        name: effectiveName,
        role: effectiveRoleLabel,
        userRole: effectiveUserRole,
      })
      .where(eq(professionals.id, professionalId));
  }

  const [insertResult] = await db.insert(professionalInstitutions).values({
    professionalId,
    userId,
    institutionId,
    roleInInstitution: effectiveUserRole,
    isPrimary: false,
    active: true,
  });

  const linkId = (insertResult as any).insertId as number;

  const caller = (req as any).user;
  recordAudit({
    action: "USER_UPDATED",
    entityType: "PROFESSIONAL",
    entityId: linkId,
    actorUserId: caller.id,
    actorRole: caller.role,
    actorName: caller.name ?? undefined,
    description: `Vínculo institucional criado para usuário #${userId} na instituição #${institutionId}`,
    metadata: { userId, institutionId, userRole: effectiveUserRole, roleLabel: effectiveRoleLabel },
    toUserId: userId,
    institutionId,
  }, req);

  res.status(201).json({
    professionalLink: {
      id: linkId,
      professionalId,
      userId,
      institutionId,
      name: effectiveName,
      role: effectiveRoleLabel,
      userRole: effectiveUserRole,
    },
  });
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

  const { name, email, role } = req.body as {
    name?: string;
    email?: string;
    role?: string;
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

  await db.update(users).set(updates).where(eq(users.id, userId));

  // If role changed, also update all professional links' userRole
  if (role) {
    const links = await db
      .select()
      .from(professionals)
      .where(eq(professionals.userId, userId));

    for (const pro of links) {
      await db
        .update(professionals)
        .set({ userRole: mapRoleToProRole(role as UserRole) })
        .where(eq(professionals.id, pro.id));
    }

    await db
      .update(professionalInstitutions)
      .set({ roleInInstitution: mapRoleToProRole(role as UserRole) })
      .where(eq(professionalInstitutions.userId, userId));
  }

  // Return updated user
  const [updated] = await db.select().from(users).where(eq(users.id, userId));
  if (!updated) {
    res.status(404).json({ error: "Usuário não encontrado" });
    return;
  }

  const caller = (req as any).user;
  recordAudit({
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
  }, req);

  res.json({
    user: {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      role: updated.role,
    },
  });
});

// GET /api/admin/audit — query audit trail
adminRouter.get("/audit", async (req: Request, res: Response): Promise<void> => {
  const db = await getDb();
  if (!db) {
    res.status(503).json({ error: "Banco de dados indisponivel" });
    return;
  }

  const includeSensitive = parseBooleanParam(req.query.includeSensitive);
  const institutionId = readInstitutionId(req);
  if (!institutionId) {
    res.status(400).json({ error: "institutionId é obrigatório para consulta de auditoria" });
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
  conditions.push(eq(auditTrail.institutionId, institutionId));

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

  const sanitizedRows = sanitizeAuditRows(rows as any[], includeSensitive);

  if (includeSensitive) {
    const caller = (req as any).user;
    recordAudit({
      action: "USER_UPDATED",
      entityType: "USER",
      entityId: caller.id,
      actorUserId: caller.id,
      actorRole: caller.role,
      actorName: caller.name ?? undefined,
      description: "Consulta administrativa com dados sensíveis (audit)",
      metadata: { route: "/api/admin/audit", includeSensitive: true, filters: { entityType, actorUserId, action } },
      institutionId,
    }, req);
  }

  res.json({
    data: sanitizedRows,
    total: Number(countResult[0]?.total ?? 0),
    limit: pageLimit,
    offset: pageOffset,
  });
});

// POST /api/admin/lgpd/retention — preview/apply retention for audit trail
adminRouter.post("/lgpd/retention", async (req: Request, res: Response): Promise<void> => {
  const db = await getDb();
  if (!db) {
    res.status(503).json({ error: "Banco de dados indisponível" });
    return;
  }

  const retentionDaysRaw = Number((req.body as any)?.retentionDays);
  const dryRunRaw = (req.body as any)?.dryRun;
  const institutionId = readInstitutionId(req);
  if (!institutionId) {
    res.status(400).json({ error: "institutionId é obrigatório para retenção LGPD" });
    return;
  }
  const configuredDays = Number(process.env.LGPD_AUDIT_RETENTION_DAYS || 365);
  const retentionDays = Number.isFinite(retentionDaysRaw) && retentionDaysRaw > 0
    ? Math.min(Math.floor(retentionDaysRaw), 3650)
    : Math.min(Math.max(configuredDays, 1), 3650);
  const dryRun = typeof dryRunRaw === "boolean" ? dryRunRaw : true;

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  const [beforeRow] = await db
    .select({ total: sql<number>`count(*)` })
    .from(auditTrail)
    .where(and(eq(auditTrail.institutionId, institutionId), lt(auditTrail.createdAt, cutoff)));

  const candidates = Number(beforeRow?.total ?? 0);
  let deleted = 0;

  if (!dryRun && candidates > 0) {
    const result = await db
      .delete(auditTrail)
      .where(and(eq(auditTrail.institutionId, institutionId), lt(auditTrail.createdAt, cutoff)));
    deleted = Number((result as any)?.[0]?.affectedRows ?? candidates);
  }

  const caller = (req as any).user;
  recordAudit({
    action: "USER_UPDATED",
    entityType: "USER",
    entityId: caller.id,
    actorUserId: caller.id,
    actorRole: caller.role,
    actorName: caller.name ?? undefined,
    description: dryRun
      ? "Prévia de retenção LGPD executada"
      : "Retenção LGPD aplicada ao audit trail",
    metadata: {
      route: "/api/admin/lgpd/retention",
      retentionDays,
      cutoff: cutoff.toISOString(),
      dryRun,
      candidates,
      deleted,
      institutionId,
    },
    institutionId,
  }, req);

  res.json({
    ok: true,
    dryRun,
    retentionDays,
    cutoff: cutoff.toISOString(),
    candidates,
    deleted,
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
