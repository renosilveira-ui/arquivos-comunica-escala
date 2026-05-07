/**
 * scripts/reset-password.ts
 *
 * Reseta a senha de um usuário via DATABASE_URL. Útil quando você
 * esqueceu a senha do admin no staging e não consegue fazer logout
 * (cookie travado por outra razão).
 *
 * Usage:
 *
 *   DATABASE_URL='mysql://...' DATABASE_SSL=insecure \
 *     pnpm tsx scripts/reset-password.ts <email> <newPassword>
 *
 * Ex:
 *
 *   DATABASE_URL='mysql://doadmin:...@db-mysql-...digitalocean.com:25060/escalas?ssl-mode=REQUIRED' \
 *     DATABASE_SSL=insecure \
 *     pnpm tsx scripts/reset-password.ts admin@escalas.com NovaSenha123
 *
 * Segurança:
 *   - bcrypt rounds=12 (mesmo do server/routes/auth.ts).
 *   - Senha é passada como argumento — fica no histórico do shell.
 *     Use uma vez, depois faça `history -d <linha>` ou rotacione.
 *   - Script aceita só email exato; não faz fuzzy match.
 *   - Se o email não existir, sai com código 1.
 */

import "dotenv/config";
import bcrypt from "bcryptjs";
import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2";
import { eq } from "drizzle-orm";
import { users } from "../drizzle/schema";
import { resolveSslConfig } from "../server/_core/db-ssl";

const BCRYPT_ROUNDS = 12;

async function main() {
  const [, , email, newPassword] = process.argv;
  if (!email || !newPassword) {
    console.error("Usage: pnpm tsx scripts/reset-password.ts <email> <newPassword>");
    process.exit(1);
  }
  if (newPassword.length < 8) {
    console.error("Erro: senha precisa ter ao menos 8 caracteres.");
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("Erro: DATABASE_URL não definida.");
    process.exit(1);
  }

  const url = new URL(databaseUrl);
  const ssl = resolveSslConfig();
  const pool = mysql.createPool({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1),
    ...(ssl ? { ssl } : {}),
  });
  const db = drizzle(pool);

  console.log(`[reset-password] resolvendo usuário: ${email}`);
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    console.error(`Erro: usuário com email '${email}' não encontrado.`);
    pool.end();
    process.exit(1);
  }

  console.log(`[reset-password] gerando bcrypt hash (rounds=${BCRYPT_ROUNDS})...`);
  const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  await db.update(users).set({ passwordHash: hash }).where(eq(users.id, user.id));
  console.log(`[reset-password] senha do usuário #${user.id} (${user.name ?? "sem nome"}) atualizada.`);
  console.log(`[reset-password] login: ${email} / senha: ${newPassword}`);
  console.log(`[reset-password] LEMBRE de rotacionar essa senha após primeiro login.`);

  pool.end();
}

main().catch((err) => {
  console.error("[reset-password] falhou:", err);
  process.exit(1);
});
