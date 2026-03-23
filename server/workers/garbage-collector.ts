import { and, lt } from "drizzle-orm";
import { getDb } from "../db";
import { shiftReminders, ssoUsedTokens } from "../../drizzle/schema";

const GC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1x por dia
const SSO_USED_TOKENS_EXTRA_TTL_HOURS = 48; // margem operacional de retenção
const SHIFT_REMINDERS_RETENTION_DAYS = 30; // LGPD/performance

let gcTimer: ReturnType<typeof setInterval> | null = null;

async function runGarbageCollectionCycle() {
  const db = await getDb();
  if (!db) return;

  const now = new Date();

  // Regra 1: limpar tokens SSO expirados (+ janela de segurança)
  const ssoCutoff = new Date(now.getTime() - SSO_USED_TOKENS_EXTRA_TTL_HOURS * 60 * 60 * 1000);
  await db
    .delete(ssoUsedTokens)
    .where(lt(ssoUsedTokens.expiresAt, ssoCutoff));

  // Regra 2: limpar lembretes antigos (mais de 30 dias)
  const remindersCutoff = new Date(now.getTime() - SHIFT_REMINDERS_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await db
    .delete(shiftReminders)
    .where(
      and(
        lt(shiftReminders.reminderAt, remindersCutoff),
        lt(shiftReminders.sentAt, remindersCutoff),
      ),
    );
}

export function startGarbageCollectorWorker() {
  if (gcTimer) return;

  const run = async () => {
    try {
      await runGarbageCollectionCycle();
    } catch (error) {
      console.error("[GarbageCollector] erro no ciclo:", error);
    }
  };

  void run();
  gcTimer = setInterval(() => {
    void run();
  }, GC_INTERVAL_MS);

  console.log("[GarbageCollector] started (daily)");
}
