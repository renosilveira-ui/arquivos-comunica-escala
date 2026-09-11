import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

import {
  personalCalendarExternalLinks,
  personalCalendarImportCursors,
  personalCalendarItems,
  userExternalCredentials,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import {
  IMPORT_SOURCE_CALENDAR_ID,
  runGoogleCalendarImport,
} from "../server/integrations/google/import";
import { persistGoogleAuthorization } from "../server/integrations/google/link-service";
import type { GoogleOAuthConfig } from "../server/integrations/google/oauth";
import { ESCALA_ORIGIN_MARKER } from "../server/integrations/google/sync";
import { GOOGLE_CALENDAR_SCOPES } from "../server/integrations/providers/calendar-provider";
import { deletePersonalCalendarItem } from "../server/personal-calendar-service";
import { createFakeCalendarProvider } from "./helpers/fake-calendar-provider";

const stamp = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
const TZ = "America/Sao_Paulo";

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

function foreignEvent(id: string, summary: string, etag: string) {
  return {
    externalEventId: id,
    calendarId: IMPORT_SOURCE_CALENDAR_ID,
    etag,
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
 * O caminho inteiro da importação contra o banco real: o que o Google tem
 * vira compromisso aqui, uma vez só; muda lá, muda aqui; some lá, some
 * aqui; e o que é nosso (plantão espelhado) nunca volta como compromisso.
 */
describe("importação do Google Agenda para a agenda de compromissos", () => {
  let db: Db;
  let ownerUserId = 0;
  const provider = createFakeCalendarProvider();

  async function importNow() {
    const result = await runGoogleCalendarImport({
      db,
      userId: ownerUserId,
      expectedSessionVersion: 1,
      config: CONFIG,
      provider,
      timeZone: TZ,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`importação falhou: ${result.reason}`);
    return result.value;
  }

  async function activeItems() {
    return db
      .select({
        id: personalCalendarItems.id,
        title: personalCalendarItems.title,
        version: personalCalendarItems.version,
        deletedAt: personalCalendarItems.deletedAt,
      })
      .from(personalCalendarItems)
      .where(eq(personalCalendarItems.ownerUserId, ownerUserId));
  }

  beforeAll(async () => {
    const loaded = await getDb();
    if (!loaded) throw new Error("Banco de testes indisponível");
    db = loaded;
    const [user] = await db.insert(users).values({
      name: `Importa ${stamp}`,
      email: `importa-${stamp}@test.local`,
      password: "x".repeat(20),
      role: "doctor",
    });
    ownerUserId = user.insertId;
    await persistGoogleAuthorization({
      db,
      userId: ownerUserId,
      grant: GRANT,
      accountLabel: "medico@gmail.com",
      externalCalendarId: null,
    });

    provider.events.set("g-1", foreignEvent("g-1", "Consulta", '"e1"'));
    provider.events.set("g-2", foreignEvent("g-2", "Dentista", '"e2"'));
    provider.events.set("ours", {
      ...foreignEvent("ours", "Plantão · Hospital", '"e3"'),
      originMarker: ESCALA_ORIGIN_MARKER,
    });
  });

  afterAll(async () => {
    if (!db || !ownerUserId) return;
    await db
      .delete(personalCalendarExternalLinks)
      .where(eq(personalCalendarExternalLinks.ownerUserId, ownerUserId));
    await db
      .delete(personalCalendarImportCursors)
      .where(eq(personalCalendarImportCursors.ownerUserId, ownerUserId));
    await db
      .delete(personalCalendarItems)
      .where(eq(personalCalendarItems.ownerUserId, ownerUserId));
    await db
      .delete(userExternalCredentials)
      .where(eq(userExternalCredentials.userId, ownerUserId));
    await db.delete(users).where(inArray(users.id, [ownerUserId]));
  });

  it("cria um compromisso por evento alheio e ignora o que é nosso", async () => {
    const summary = await importNow();
    expect(summary.created).toBe(2);
    expect(summary.ignored).toBe(1);
    expect(summary.resynced).toBe(false);

    const items = await activeItems();
    const titles = items.map((item) => item.title).sort();
    expect(titles).toEqual(["Consulta", "Dentista"]);
    expect(titles.some((t) => t.startsWith("Plantão"))).toBe(false);

    const links = await db
      .select()
      .from(personalCalendarExternalLinks)
      .where(eq(personalCalendarExternalLinks.ownerUserId, ownerUserId));
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.externalEventId).sort()).toEqual(["g-1", "g-2"]);

    const [cursor] = await db
      .select()
      .from(personalCalendarImportCursors)
      .where(eq(personalCalendarImportCursors.ownerUserId, ownerUserId));
    expect(cursor?.syncCursor).toMatch(/^sync-/);
    expect(cursor?.lastImportedAt).not.toBeNull();
  });

  it("é idempotente: rodar de novo não cria nem altera nada", async () => {
    const before = await activeItems();
    const summary = await importNow();
    expect(summary.created).toBe(0);
    expect(summary.updated).toBe(0);
    expect(summary.removed).toBe(0);
    expect(await activeItems()).toEqual(before);
  });

  it("compromisso importado não se edita nem se apaga aqui", async () => {
    const [item] = await activeItems();
    await expect(
      deletePersonalCalendarItem({
        db,
        ownerUserId,
        expectedSessionVersion: 1,
        itemId: item.id,
        expectedVersion: item.version,
      }),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: expect.stringContaining("Google Agenda"),
    });
  });

  it("mudou no Google (etag novo) → atualiza aqui", async () => {
    const current = provider.events.get("g-1");
    if (!current) throw new Error("fixture g-1");
    provider.events.set("g-1", {
      ...current,
      summary: "Consulta remarcada",
      etag: '"e1-b"',
    });
    const summary = await importNow();
    expect(summary.updated).toBe(1);
    expect(summary.created).toBe(0);
    const titles = (await activeItems()).map((item) => item.title).sort();
    expect(titles).toEqual(["Consulta remarcada", "Dentista"]);
  });

  it("cancelou no Google → some aqui, e o vínculo fica para não duplicar", async () => {
    provider.externallyCancel("g-2");
    const summary = await importNow();
    expect(summary.removed).toBe(1);

    const remaining = (await activeItems()).filter((i) => i.deletedAt === null);
    expect(remaining.map((i) => i.title)).toEqual(["Consulta remarcada"]);

    const [link] = await db
      .select()
      .from(personalCalendarExternalLinks)
      .where(
        and(
          eq(personalCalendarExternalLinks.ownerUserId, ownerUserId),
          eq(personalCalendarExternalLinks.externalEventId, "g-2"),
        ),
      );
    expect(link?.deletedAt).not.toBeNull();

    // O mesmo cancelamento visto de novo não conta duas vezes.
    const again = await importNow();
    expect(again.removed).toBe(0);
  });

  /**
   * Sync token expirado (410) força leitura completa. O que já existe não
   * pode virar duplicata — é a chave única do vínculo que garante.
   */
  it("cursor expirado → releitura completa sem duplicar", async () => {
    provider.expireSyncTokenOnce();
    const before = (await activeItems()).filter((i) => i.deletedAt === null);
    const summary = await importNow();
    expect(summary.resynced).toBe(true);
    expect(summary.created).toBe(0);
    const after = (await activeItems()).filter((i) => i.deletedAt === null);
    expect(after).toEqual(before);
  });
});
