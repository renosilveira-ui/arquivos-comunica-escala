import { Router, type Request, type Response } from "express";
import { eq, asc } from "drizzle-orm";
import { getDb } from "../db";
import { users, professionals } from "../../drizzle/schema";
import { sdk } from "../_core/sdk";

type UserRole = "admin" | "manager" | "doctor" | "nurse" | "tech";

function mapRoleToProRole(role: UserRole): "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS" {
  if (role === "admin") return "GESTOR_PLUS";
  if (role === "manager") return "GESTOR_MEDICO";
  return "USER";
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
    })
    .from(users)
    .leftJoin(professionals, eq(professionals.userId, users.id))
    .orderBy(asc(users.name));

  const result = allUsers.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    createdAt: row.createdAt,
    professional: row.professionalId
      ? { id: row.professionalId, userRole: row.userRole }
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

  // If role changed, also update professional's userRole
  if (role) {
    const [pro] = await db
      .select()
      .from(professionals)
      .where(eq(professionals.userId, userId));

    if (pro) {
      await db
        .update(professionals)
        .set({ userRole: mapRoleToProRole(role as UserRole) })
        .where(eq(professionals.id, pro.id));
    }
  }

  // Return updated user
  const [updated] = await db.select().from(users).where(eq(users.id, userId));
  if (!updated) {
    res.status(404).json({ error: "Usuário não encontrado" });
    return;
  }

  res.json({
    user: {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      role: updated.role,
    },
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
