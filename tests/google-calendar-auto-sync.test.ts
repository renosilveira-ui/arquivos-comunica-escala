import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

import {
  externalCalendarEventLinks,
  personalCalendarExternalLinks,
  personalCalendarImportCursors,
  personalCalendarItems,
  userExternalCredentials,
  users,
} from "../drizzle/schema";
import { EXTERNAL_LINK_STATES } from "../lib/integration-providers";
import {
  claimGoogleSyncCandidate,
  resetGoogleCalendarSyncState,
  selectGoogleSyncCandidates,
  tickGoogleCalendarSync,
} from "../server/cron/google-calendar-sync-dispatcher";
import { getDb } from "../server/db";
import { IMPORT_SOURCE_CALENDAR_ID } from "../server/integrations/google/import";
import { persistGoogleAuthorization } from "../server/integrations/google/link-service";
import type { GoogleOAuthConfig } from "../server/integrations/google/oauth";
import { GOOGLE_CALENDAR_SCOPES } from "../server/integrations/providers/calendar-provider";
import { PROVIDER_FAILURE_REASONS } from "../server/integrations/providers/types";
import { createFakeCalendarProvider } from "./helpers/fake-calendar-provider";

const stamp = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
const T0 = new Date("2026-09-12T12:00:00.000Z");
const minutes = (n: number) => n * 60_000;
const at = (n: number) => new Date(T0.getTime() + minutes(n));

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

const CONFIG: GoogleOAuthConfig = {
  clientId: "fake-client",
  clientSecret: "fake-secret",
  redirectUri: "http://localhost:3000/api/integrations/google/callback",
};

const GRANT = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAtUtc: new Date(Date.now() + 3_600_000),
  grantedScopes: [...GOOGLE_CALENDAR_SCOPES],
};

function foreignEvent(id: string, summary: string) {
  return {
    externalEventId: id,
    calendarId: IMPORT_SOURCE_CALENDAR_ID,
    etag: `"${id}"`,
    summary,
    startsAtUtc: new Date("2026-09-15T17:30:00Z"),
    endsAtUtc: new Date("2026-09-15T18:30:00Z"),
    allDay: false,
    busy: true,
    cancelled: false,
    originMarker: null,
    deleted: false,
  };
}

/**
 * O cron contra o banco real, com o provedor falso: quem está conectado é
 * sincronizado sem apertar botão; quem precisa reautorizar é deixado em paz;
 * quem falhou espera; e a paginação do Google não deixa o cursor vazio.
 */
describe("sincronização automática com o Google Agenda", () => {
  let db: Db;
  let connectedUserId = 0;
  let reauthUserId = 0;
  let deletedUserId = 0;
  const provider = createFakeCalendarProvider();

  async function link(userId: number) {
    return db
      .select({
        linkState: userExternalCredentials.linkState,
        lastSyncedAt: userExternalCredentials.lastSyncedAt,
        failures: userExternalCredentials.consecutiveFailureCount,
      })
      .from(userExternalCredentials)
      .where(eq(userExternalCredentials.userId, userId))
      .then((rows) => rows[0]);
  }

  async function importedCount(userId: number) {
    const rows = await db
      .select({ id: personalCalendarExternalLinks.id })
      .from(personalCalendarExternalLinks)
      .where(eq(personalCalendarExternalLinks.ownerUserId, userId));
    return rows.length;
  }

  beforeAll(async () => {
    const loaded = await getDb();
    if (!loaded) throw new Error("Banco de testes indisponível");
    db = loaded;
    resetGoogleCalendarSyncState();

    for (const suffix of ["conectado", "reauth", "excluido"]) {
      const [user] = await db.insert(users).values({
        name: `Auto ${suffix} ${stamp}`,
        email: `auto-${suffix}-${stamp}@test.local`,
        password: "x".repeat(20),
        role: "doctor",
      });
      if (suffix === "conectado") connectedUserId = user.insertId;
      else if (suffix === "reauth") reauthUserId = user.insertId;
      else deletedUserId = user.insertId;
      await persistGoogleAuthorization({
        db,
        userId: user.insertId,
        grant: GRANT,
        accountLabel: "medico@gmail.com",
        externalCalendarId: null,
      });
    }
    await db
      .update(userExternalCredentials)
      .set({ linkState: EXTERNAL_LINK_STATES.reauthRequired })
      .where(eq(userExternalCredentials.userId, reauthUserId));
    // Conta excluída (soft-delete) com credencial CONNECTED ainda no banco:
    // o caso que a exclusão antiga deixava para trás.
    await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(eq(users.id, deletedUserId));

    // Três eventos e páginas de dois: o sync token só vem na segunda página.
    provider.pageSize = 2;
    provider.events.set("a-1", foreignEvent("a-1", "Consulta"));
    provider.events.set("a-2", foreignEvent("a-2", "Dentista"));
    provider.events.set("a-3", foreignEvent("a-3", "Reunião"));
  });

  afterAll(async () => {
    if (!db) return;
    const ids = [connectedUserId, reauthUserId, deletedUserId].filter(Boolean);
    if (!ids.length) return;
    await db
      .delete(personalCalendarExternalLinks)
      .where(inArray(personalCalendarExternalLinks.ownerUserId, ids));
    await db
      .delete(personalCalendarImportCursors)
      .where(inArray(personalCalendarImportCursors.ownerUserId, ids));
    await db
      .delete(personalCalendarItems)
      .where(inArray(personalCalendarItems.ownerUserId, ids));
    await db
      .delete(externalCalendarEventLinks)
      .where(inArray(externalCalendarEventLinks.userId, ids));
    await db
      .delete(userExternalCredentials)
      .where(inArray(userExternalCredentials.userId, ids));
    await db.delete(users).where(inArray(users.id, ids));
  });

  it("só quem pode sincronizar entra na varredura", async () => {
    const candidates = await selectGoogleSyncCandidates(db, T0, 100);
    const ids = candidates.map((c) => c.userId);
    expect(ids).toContain(connectedUserId);
    expect(ids).not.toContain(reauthUserId);
    expect(ids).not.toContain(deletedUserId);
  });

  it("primeiro tick: conta conectada sincroniza sem botão, seguindo as páginas", async () => {
    await tickGoogleCalendarSync(T0, { provider, config: CONFIG });

    expect(await importedCount(connectedUserId)).toBe(3);
    expect(await importedCount(reauthUserId)).toBe(0);

    const [cursor] = await db
      .select({ syncCursor: personalCalendarImportCursors.syncCursor })
      .from(personalCalendarImportCursors)
      .where(
        and(
          eq(personalCalendarImportCursors.ownerUserId, connectedUserId),
          eq(
            personalCalendarImportCursors.externalCalendarId,
            IMPORT_SOURCE_CALENDAR_ID,
          ),
        ),
      );
    expect(cursor?.syncCursor).toMatch(/^sync-/);

    // O que veio do Google não volta para o Google: nenhum dos três vira
    // evento no calendário Escala+ (seria duplicata na conta do médico).
    const mirrored = await db
      .select({ sourceKind: externalCalendarEventLinks.sourceKind })
      .from(externalCalendarEventLinks)
      .where(eq(externalCalendarEventLinks.userId, connectedUserId));
    expect(mirrored.filter((m) => m.sourceKind === "PERSONAL_ITEM")).toHaveLength(0);

    const linked = await link(connectedUserId);
    expect(linked?.linkState).toBe(EXTERNAL_LINK_STATES.connected);
    expect(linked?.lastSyncedAt).not.toBeNull();
    expect((await link(reauthUserId))?.lastSyncedAt).toBeNull();
  });

  it("segundo tick logo depois não volta ao Google", async () => {
    const before = provider.calls.list;
    await tickGoogleCalendarSync(at(1), { provider, config: CONFIG });
    expect(provider.calls.list).toBe(before);
  });

  it("passados 15 minutos, sincroniza de novo — sem duplicar", async () => {
    const before = provider.calls.list;
    await tickGoogleCalendarSync(at(16), { provider, config: CONFIG });
    expect(provider.calls.list).toBeGreaterThan(before);
    expect(await importedCount(connectedUserId)).toBe(3);
  });

  /**
   * O Google fora do ar para uma conta não pode virar uma chamada por
   * minuto até alguém notar. A falha fica no vínculo e a próxima tentativa
   * espera o dobro.
   */
  it("falha fica registrada e a conta espera o backoff", async () => {
    // Duas leituras por ciclo (calendário Escala+ e o principal): as duas
    // falham, e a importação — a que interessa ao médico — registra a falha.
    provider.failNext("listChanges", PROVIDER_FAILURE_REASONS.upstreamError, 2);
    await tickGoogleCalendarSync(at(32), { provider, config: CONFIG });
    const afterFailure = await link(connectedUserId);
    expect(afterFailure?.failures).toBe(1);

    const before = provider.calls.list;
    await tickGoogleCalendarSync(at(48), { provider, config: CONFIG });
    expect(provider.calls.list).toBe(before);

    await tickGoogleCalendarSync(at(63), { provider, config: CONFIG });
    expect(provider.calls.list).toBeGreaterThan(before);
    expect((await link(connectedUserId))?.failures).toBe(0);
  });

  /**
   * Dois processos sobre o mesmo banco.
   *
   * Não é hipótese: enquanto o serviço antigo e o novo estiverem os dois no
   * ar, ambos rodam este worker contra o mesmo banco. A guarda que existia
   * era uma tabela em memória, que não atravessa processo. Quem arbitra tem
   * de ser o banco.
   */
  it("dois processos, uma conta: só um ganha a janela", async () => {
    const db = (await getDb()) as Db;
    const quando = at(80);

    const primeiro = await claimGoogleSyncCandidate(db, connectedUserId, quando);
    const segundo = await claimGoogleSyncCandidate(db, connectedUserId, quando);

    expect(primeiro).toBe(true);
    expect(segundo).toBe(false);
  });

  /**
   * A corrida de verdade, reproduzida passo a passo.
   *
   * A seleção acontece ANTES de qualquer escrita. Dois processos que varrem
   * no mesmo instante — o que acontece toda vez que um deles sobe, porque o
   * worker dá um tick no boot — enxergam a mesma conta vencida. Sem a
   * reserva, os dois partiriam do mesmo cursor do Google.
   *
   * Repare no que este teste NÃO afirma: não é toda janela que colide. A
   * varredura já descarta quem sincronizou há menos de 15 minutos, então a
   * janela de colisão é o tempo entre a seleção e a gravação. Curta — e
   * suficiente para embaralhar um cursor.
   */
  it("dois processos que selecionaram a mesma conta: só um fala com o Google", async () => {
    const db = (await getDb()) as Db;
    const quando = at(112);

    const processoA = await selectGoogleSyncCandidates(db, quando, 10);
    const processoB = await selectGoogleSyncCandidates(db, quando, 10);
    expect(processoA.some((c) => c.userId === connectedUserId)).toBe(true);
    expect(processoB.some((c) => c.userId === connectedUserId)).toBe(true);

    expect(await claimGoogleSyncCandidate(db, connectedUserId, quando)).toBe(
      true,
    );
    expect(await claimGoogleSyncCandidate(db, connectedUserId, quando)).toBe(
      false,
    );
  });
});
