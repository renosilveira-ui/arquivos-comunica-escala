import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";

import {
  externalCalendarEventLinks,
  googleOauthStates,
  hospitals,
  institutions,
  professionals,
  sectors,
  shiftAssignmentsV2,
  shiftInstances,
  userExternalCredentials,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import {
  EXTERNAL_LINK_STATES,
  EXTERNAL_PROVIDERS,
  PROVIDER_OUTCOMES,
} from "../lib/integration-providers";
import {
  disconnectGoogleLink,
  persistGoogleAuthorization,
  readGoogleLink,
  recordGoogleOutcome,
} from "../server/integrations/google/link-service";
import {
  consumeGoogleAuthorizationState,
  startGoogleAuthorization,
  type GoogleOAuthConfig,
} from "../server/integrations/google/oauth";
import {
  ESCALA_ORIGIN_MARKER,
  pullGoogleCalendarChanges,
  runGoogleCalendarExport,
} from "../server/integrations/google/sync";
import { GOOGLE_CALENDAR_SCOPES } from "../server/integrations/providers/calendar-provider";
import { PROVIDER_FAILURE_REASONS } from "../server/integrations/providers/types";
import { createFakeCalendarProvider } from "./helpers/fake-calendar-provider";

const stamp = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;

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

/**
 * Duas instituições criadas em runtime, sem id fixo: o mesmo usuário tem
 * plantão nas duas. É o caso que importa — a agenda do Google do médico não
 * tem abas por hospital, então a exportação é account-wide, mas nenhum
 * plantão de terceiro pode entrar.
 */
describe("vínculo e sincronização com o Google Agenda", () => {
  let db: Db;
  const institutionIds: number[] = [];
  const hospitalIds: number[] = [];
  const sectorIds: number[] = [];
  const shiftIds: number[] = [];
  const assignmentIds: number[] = [];
  const professionalIds: number[] = [];
  const userIds: number[] = [];
  let ownerUserId = 0;
  let otherUserId = 0;

  beforeAll(async () => {
    const loaded = await getDb();
    if (!loaded) throw new Error("Banco de testes indisponível");
    db = loaded;

    for (const suffix of ["dono", "outro"]) {
      const [user] = await db.insert(users).values({
        name: `Google ${suffix} ${stamp}`,
        email: `google-${suffix}-${stamp}@test.local`,
        password: "x".repeat(20),
        role: "doctor",
      });
      userIds.push(user.insertId);
    }
    [ownerUserId, otherUserId] = userIds;

    for (const [index, key] of ["alfa", "beta"].entries()) {
      const [institution] = await db.insert(institutions).values({
        name: `Inst ${key} ${stamp}`,
        cnpj: `${stamp}${index}`.slice(-14).padStart(14, "0"),
        timeZone: index === 0 ? "America/Sao_Paulo" : "America/Manaus",
      });
      const institutionId = institution.insertId;
      institutionIds.push(institutionId);

      const [hospital] = await db.insert(hospitals).values({
        institutionId,
        name: `Hosp ${key} ${stamp}`,
      });
      hospitalIds.push(hospital.insertId);

      const [sector] = await db.insert(sectors).values({
        institutionId,
        hospitalId: hospital.insertId,
        name: `Setor ${key} ${stamp}`,
        category: "internacao",
        color: "#123456",
      });
      sectorIds.push(sector.insertId);
    }

    // O dono tem um profissional em cada instituição; o outro usuário tem um
    // profissional só, para provar que o plantão dele não vaza.
    for (const [index, institutionId] of institutionIds.entries()) {
      const [professional] = await db.insert(professionals).values({
        userId: index === 0 ? ownerUserId : ownerUserId,
        name: `Prof dono ${index} ${stamp}`,
        role: "doctor",
        institutionId,
      });
      professionalIds.push(professional.insertId);
    }
    const [otherProfessional] = await db.insert(professionals).values({
      userId: otherUserId,
      name: `Prof outro ${stamp}`,
      role: "doctor",
      institutionId: institutionIds[0],
    });
    professionalIds.push(otherProfessional.insertId);

    const base = Date.now() + 2 * 86_400_000;
    for (const [index, institutionId] of institutionIds.entries()) {
      const [shift] = await db.insert(shiftInstances).values({
        institutionId,
        hospitalId: hospitalIds[index],
        sectorId: sectorIds[index],
        label: `Plantão ${index} ${stamp}`,
        startAt: new Date(base + index * 86_400_000),
        endAt: new Date(base + index * 86_400_000 + 12 * 3_600_000),
        modality: index === 0 ? "PLANTAO" : "SOBREAVISO",
      });
      shiftIds.push(shift.insertId);
      const [assignment] = await db.insert(shiftAssignmentsV2).values({
        institutionId,
        hospitalId: hospitalIds[index],
        sectorId: sectorIds[index],
        shiftInstanceId: shift.insertId,
        professionalId: professionalIds[index],
      });
      assignmentIds.push(assignment.insertId);
    }

    // Plantão do OUTRO usuário, na instituição alfa.
    const [foreignShift] = await db.insert(shiftInstances).values({
      institutionId: institutionIds[0],
      hospitalId: hospitalIds[0],
      sectorId: sectorIds[0],
      label: `Plantão alheio ${stamp}`,
      startAt: new Date(base + 3 * 86_400_000),
      endAt: new Date(base + 3 * 86_400_000 + 12 * 3_600_000),
      modality: "PLANTAO",
    });
    shiftIds.push(foreignShift.insertId);
    const [foreignAssignment] = await db.insert(shiftAssignmentsV2).values({
      institutionId: institutionIds[0],
      hospitalId: hospitalIds[0],
      sectorId: sectorIds[0],
      shiftInstanceId: foreignShift.insertId,
      professionalId: professionalIds[2],
    });
    assignmentIds.push(foreignAssignment.insertId);
  });

  /**
   * O espelho local (`external_calendar_event_links`) representa o que já
   * está no Google. Um teste que troca o provedor por um vazio precisa
   * limpá-lo junto — senão o motor conclui, corretamente, que não há nada a
   * escrever.
   */
  /**
   * Reautoriza a conta. Chamado por todo teste que precisa de vínculo ativo:
   * depender do teste anterior ter conectado torna a suíte frágil e esconde
   * o motivo real quando um caso é executado sozinho.
   */
  async function ensureLinked(userId: number): Promise<void> {
    await persistGoogleAuthorization({
      db,
      userId,
      grant: GRANT,
      accountLabel: "medico@gmail.com",
      externalCalendarId: null,
    });
  }

  async function resetMirror(userId: number): Promise<void> {
    await db
      .delete(externalCalendarEventLinks)
      .where(eq(externalCalendarEventLinks.userId, userId));
  }

  afterAll(async () => {
    if (!db) return;
    if (userIds.length) {
      await db
        .delete(externalCalendarEventLinks)
        .where(inArray(externalCalendarEventLinks.userId, userIds));
      await db
        .delete(googleOauthStates)
        .where(inArray(googleOauthStates.userId, userIds));
      await db
        .delete(userExternalCredentials)
        .where(inArray(userExternalCredentials.userId, userIds));
    }
    if (assignmentIds.length) {
      await db
        .delete(shiftAssignmentsV2)
        .where(inArray(shiftAssignmentsV2.id, assignmentIds));
    }
    if (shiftIds.length) {
      await db
        .delete(shiftInstances)
        .where(inArray(shiftInstances.id, shiftIds));
    }
    if (professionalIds.length) {
      await db
        .delete(professionals)
        .where(inArray(professionals.id, professionalIds));
    }
    if (sectorIds.length) {
      await db.delete(sectors).where(inArray(sectors.id, sectorIds));
    }
    if (hospitalIds.length) {
      await db.delete(hospitals).where(inArray(hospitals.id, hospitalIds));
    }
    if (institutionIds.length) {
      await db
        .delete(institutions)
        .where(inArray(institutions.id, institutionIds));
    }
    if (userIds.length) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  describe("state do OAuth", () => {
    it("é consumido exatamente uma vez", async () => {
      const started = await startGoogleAuthorization({
        db,
        userId: ownerUserId,
        returnTarget: "WEB",
        config: CONFIG,
      });
      expect(started.authorizationUrl).toContain("code_challenge_method=S256");
      expect(started.authorizationUrl).toContain("access_type=offline");
      expect(started.authorizationUrl).toContain("prompt=consent");
      // O state em claro nunca é gravado.
      expect(started.authorizationUrl).toContain(
        `state=${encodeURIComponent(started.state)}`,
      );

      const first = await consumeGoogleAuthorizationState({
        db,
        state: started.state,
      });
      expect(first?.userId).toBe(ownerUserId);
      expect(first?.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);

      // Replay: o mesmo state não vale duas vezes.
      const second = await consumeGoogleAuthorizationState({
        db,
        state: started.state,
      });
      expect(second).toBeNull();
    });

    it("state desconhecido ou expirado não abre porta", async () => {
      expect(
        await consumeGoogleAuthorizationState({ db, state: "inexistente" }),
      ).toBeNull();

      const started = await startGoogleAuthorization({
        db,
        userId: ownerUserId,
        returnTarget: "MOBILE",
        config: CONFIG,
        now: new Date(Date.now() - 60 * 60 * 1000),
      });
      expect(
        await consumeGoogleAuthorizationState({ db, state: started.state }),
      ).toBeNull();
    });
  });

  describe("exportação", () => {
    it("cria os eventos dos plantões próprios, em todas as instituições", async () => {
      await persistGoogleAuthorization({
        db,
        userId: ownerUserId,
        grant: GRANT,
        accountLabel: "medico@gmail.com",
        externalCalendarId: null,
      });

      const provider = createFakeCalendarProvider();
      const result = await runGoogleCalendarExport({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
        timeZone: "America/Sao_Paulo",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.created).toBe(2);
      expect(provider.events.size).toBe(2);

      const titles = [...provider.events.values()].map((e) => e.summary);
      expect(titles.some((t) => t.startsWith("Plantão · "))).toBe(true);
      expect(titles.some((t) => t.startsWith("Sobreaviso · "))).toBe(true);
      // Plantão alheio jamais entra.
      expect(titles.some((t) => t.includes("alheio"))).toBe(false);

      // Todo evento carrega o marcador que impede laço de sincronização.
      for (const event of provider.events.values()) {
        expect(event.originMarker).toBe(ESCALA_ORIGIN_MARKER);
      }
      // Sobreaviso não bloqueia o dia.
      const oncall = [...provider.events.values()].find((e) =>
        e.summary.startsWith("Sobreaviso"),
      );
      expect(oncall?.busy).toBe(false);
    });

    it("é idempotente: rodar de novo não reescreve nada", async () => {
      await ensureLinked(ownerUserId);
      await resetMirror(ownerUserId);
      const provider = createFakeCalendarProvider();
      const first = await runGoogleCalendarExport({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
        timeZone: "America/Sao_Paulo",
      });
      expect(first.ok).toBe(true);
      const writesAfterFirst = provider.calls.upsert;

      const second = await runGoogleCalendarExport({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
        timeZone: "America/Sao_Paulo",
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.created).toBe(0);
      expect(second.value.updated).toBe(0);
      expect(second.value.unchanged).toBeGreaterThan(0);
      // Nenhuma escrita nova: é o que protege a cota do usuário.
      expect(provider.calls.upsert).toBe(writesAfterFirst);
    });

    it("o evento vira tombstone quando o plantão sai da escala", async () => {
      await ensureLinked(ownerUserId);
      await resetMirror(ownerUserId);
      const provider = createFakeCalendarProvider();
      await runGoogleCalendarExport({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
        timeZone: "America/Sao_Paulo",
      });
      const before = provider.events.size;
      expect(before).toBeGreaterThan(0);

      // Remove uma alocação: a origem sumiu.
      await db
        .delete(shiftAssignmentsV2)
        .where(eq(shiftAssignmentsV2.id, assignmentIds[1]));

      const after = await runGoogleCalendarExport({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
        timeZone: "America/Sao_Paulo",
      });
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.value.deleted).toBe(1);
      expect(provider.events.size).toBe(before - 1);

      // Restaura para não contaminar os testes seguintes.
      const [restored] = await db.insert(shiftAssignmentsV2).values({
        institutionId: institutionIds[1],
        hospitalId: hospitalIds[1],
        sectorId: sectorIds[1],
        shiftInstanceId: shiftIds[1],
        professionalId: professionalIds[1],
      });
      assignmentIds[1] = restored.insertId;
    });

    it("alocação inativa (troca ou remoção) sai do Google sem apagar a linha", async () => {
      await ensureLinked(ownerUserId);
      await resetMirror(ownerUserId);
      const provider = createFakeCalendarProvider();
      const first = await runGoogleCalendarExport({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
        timeZone: "America/Sao_Paulo",
      });
      expect(first.ok).toBe(true);
      const before = provider.events.size;
      expect(before).toBeGreaterThan(1);

      // Troca e remoção não apagam a alocação: marcam is_active = 0.
      await db
        .update(shiftAssignmentsV2)
        .set({ isActive: false })
        .where(eq(shiftAssignmentsV2.id, assignmentIds[1]));
      try {
        const after = await runGoogleCalendarExport({
          db,
          userId: ownerUserId,
          config: CONFIG,
          provider,
          timeZone: "America/Sao_Paulo",
        });
        expect(after.ok).toBe(true);
        if (!after.ok) return;
        expect(after.value.deleted).toBe(1);
        expect(provider.events.size).toBe(before - 1);
      } finally {
        await db
          .update(shiftAssignmentsV2)
          .set({ isActive: true })
          .where(eq(shiftAssignmentsV2.id, assignmentIds[1]));
      }
    });

    it("uma falha pontual não aborta o ciclo inteiro", async () => {
      await ensureLinked(ownerUserId);
      await resetMirror(ownerUserId);
      const provider = createFakeCalendarProvider();
      provider.failNext("upsertEvent", PROVIDER_FAILURE_REASONS.rateLimited);
      const result = await runGoogleCalendarExport({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
        timeZone: "America/Sao_Paulo",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.skipped).toBeGreaterThan(0);
      // O segundo item ainda foi processado.
      expect(result.value.created).toBeGreaterThan(0);
    });
  });

  describe("leitura incremental", () => {
    it("sync token expirado ressincroniza em vez de desconectar", async () => {
      await ensureLinked(ownerUserId);
      await resetMirror(ownerUserId);
      const provider = createFakeCalendarProvider();
      await runGoogleCalendarExport({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
        timeZone: "America/Sao_Paulo",
      });
      // Primeira leitura grava um cursor.
      await pullGoogleCalendarChanges({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
      });

      provider.expireSyncTokenOnce();
      const result = await pullGoogleCalendarChanges({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.resynced).toBe(true);

      const link = await readGoogleLink(db, ownerUserId);
      // O vínculo continua de pé: 410 não é credencial rejeitada.
      expect(link?.linkState).toBe(EXTERNAL_LINK_STATES.connected);
      expect(link?.syncCursor).toBeNull();
    });

    it("mudanças em várias páginas são lidas até o fim e o cursor avança", async () => {
      await ensureLinked(ownerUserId);
      await resetMirror(ownerUserId);
      const provider = createFakeCalendarProvider();
      const exported = await runGoogleCalendarExport({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
        timeZone: "America/Sao_Paulo",
      });
      expect(exported.ok).toBe(true);
      const ids = [...provider.events.keys()];
      expect(ids.length).toBeGreaterThan(1);

      // Uma página por evento: o cancelado fica na última, e o sync token
      // só vem nela. Ler só a primeira página não veria nem um nem outro.
      provider.pageSize = 1;
      provider.externallyCancel(ids[ids.length - 1]!);
      const listCallsBefore = provider.calls.list;

      const pulled = await pullGoogleCalendarChanges({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
      });
      expect(pulled.ok).toBe(true);
      if (!pulled.ok) return;
      expect(pulled.value.forgotten).toBe(1);
      expect(pulled.value.truncated).toBe(false);
      expect(provider.calls.list - listCallsBefore).toBe(ids.length);

      const link = await readGoogleLink(db, ownerUserId);
      expect(link?.syncCursor).toMatch(/^sync-/);
    });

    it("evento nosso cancelado no Google é esquecido para ser recriado", async () => {
      await ensureLinked(ownerUserId);
      await resetMirror(ownerUserId);
      const provider = createFakeCalendarProvider();
      const exported = await runGoogleCalendarExport({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
        timeZone: "America/Sao_Paulo",
      });
      expect(exported.ok).toBe(true);
      if (!exported.ok) return;
      expect(exported.value.created).toBeGreaterThan(0);
      const [firstEventId] = [...provider.events.keys()];
      expect(firstEventId).toBeDefined();
      provider.externallyCancel(firstEventId);

      const pulled = await pullGoogleCalendarChanges({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
      });
      expect(pulled.ok).toBe(true);
      if (!pulled.ok) return;
      expect(pulled.value.forgotten).toBeGreaterThan(0);

      // Plantão é read-only: apagar no Google não altera a escala, e o ciclo
      // seguinte recria o evento.
      const recreated = await runGoogleCalendarExport({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
        timeZone: "America/Sao_Paulo",
      });
      expect(recreated.ok).toBe(true);
      if (!recreated.ok) return;
      // Recriação, não atualização: o evento não existia mais no provedor.
      expect(recreated.value.created).toBeGreaterThan(0);
      // O provedor guarda o cancelado (como o Google faz) e ganha um evento
      // novo e ativo no lugar.
      const active = [...provider.events.values()].filter((e) => !e.cancelled);
      expect(active.length).toBeGreaterThan(0);
      expect(active.some((e) => e.externalEventId === firstEventId)).toBe(
        false,
      );
    });
  });

  /**
   * Em 11/09/2026 o vínculo "deu certo" e a tela disse "Tudo já estava em
   * dia" — para um calendário que nunca existiu. Os escopos não permitiam
   * `calendars.insert`, a criação falhava, e a exportação devolvia sucesso
   * com zeros sem registrar nada no vínculo.
   */
  describe("calendário dedicado", () => {
    const ESCOPOS_ANTIGOS =
      "https://www.googleapis.com/auth/calendar.calendarlist https://www.googleapis.com/auth/calendar.events";

    it("vínculo antigo, sem escopo de criação, exige reautorização — sem chamar o Google", async () => {
      await ensureLinked(ownerUserId);
      await db
        .update(userExternalCredentials)
        .set({ grantedScopes: ESCOPOS_ANTIGOS, externalCalendarId: null })
        .where(eq(userExternalCredentials.userId, ownerUserId));
      const provider = createFakeCalendarProvider();

      const result = await runGoogleCalendarExport({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
        timeZone: "America/Sao_Paulo",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe(PROVIDER_FAILURE_REASONS.authRejected);
      // Decidido pelo escopo persistido: não gastou chamada nem criou nada.
      expect(provider.calls.ensure).toBe(0);
      expect(provider.events.size).toBe(0);
      const link = await readGoogleLink(db, ownerUserId);
      expect(link?.linkState).toBe(EXTERNAL_LINK_STATES.reauthRequired);
      expect(link?.externalCalendarId).toBeNull();
      expect(link?.lastFailureReason).toBe(
        PROVIDER_FAILURE_REASONS.authRejected,
      );
    });

    it("falha do Google ao criar o calendário é falha da sincronização, registrada", async () => {
      await ensureLinked(ownerUserId);
      await db
        .update(userExternalCredentials)
        .set({ externalCalendarId: null })
        .where(eq(userExternalCredentials.userId, ownerUserId));
      const provider = createFakeCalendarProvider();
      provider.failNext(
        "ensureDedicatedCalendar",
        PROVIDER_FAILURE_REASONS.upstreamError,
      );

      const result = await runGoogleCalendarExport({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
        timeZone: "America/Sao_Paulo",
      });

      // Nunca mais "sucesso com zeros".
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe(PROVIDER_FAILURE_REASONS.upstreamError);
      expect(provider.events.size).toBe(0);
      const link = await readGoogleLink(db, ownerUserId);
      expect(link?.linkState).toBe(EXTERNAL_LINK_STATES.degraded);
      expect(link?.lastFailureReason).toBe(
        PROVIDER_FAILURE_REASONS.upstreamError,
      );
      expect(link?.externalCalendarId).toBeNull();
    });

    it("depois da reautorização com o escopo certo, cria e exporta", async () => {
      await ensureLinked(ownerUserId);
      await resetMirror(ownerUserId);
      const provider = createFakeCalendarProvider();
      const result = await runGoogleCalendarExport({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
        timeZone: "America/Sao_Paulo",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(provider.calls.ensure).toBe(1);
      expect(result.value.considered).toBeGreaterThan(0);
      expect(result.value.created).toBe(result.value.considered);
      const link = await readGoogleLink(db, ownerUserId);
      expect(link?.externalCalendarId).toBeTruthy();
      expect(link?.linkState).toBe(EXTERNAL_LINK_STATES.connected);
    });

    /** Zero mudanças tem dois significados; o resumo precisa distingui-los. */
    it("o resumo diz quantos candidatos havia, para a tela não confundir vazio com em dia", async () => {
      await ensureLinked(ownerUserId);
      await resetMirror(ownerUserId);
      const provider = createFakeCalendarProvider();
      const first = await runGoogleCalendarExport({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
        timeZone: "America/Sao_Paulo",
      });
      const second = await runGoogleCalendarExport({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
        timeZone: "America/Sao_Paulo",
      });
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.value.considered).toBe(first.value.considered);
      expect(
        second.value.created + second.value.updated + second.value.deleted,
      ).toBe(0);
      expect(second.value.unchanged).toBe(second.value.considered);
    });
  });

  describe("estado do vínculo", () => {
    it("falha transitória degrada mas continua tentando", async () => {
      const state = await recordGoogleOutcome({
        db,
        userId: ownerUserId,
        outcome: PROVIDER_OUTCOMES.retryableFailure,
        reason: PROVIDER_FAILURE_REASONS.timeout,
      });
      expect(state).toBe(EXTERNAL_LINK_STATES.degraded);
      const link = await readGoogleLink(db, ownerUserId);
      expect(link?.consecutiveFailureCount).toBeGreaterThan(0);
      expect(link?.lastFailureReason).toBe(PROVIDER_FAILURE_REASONS.timeout);
    });

    it("sucesso zera o contador e reconecta", async () => {
      await recordGoogleOutcome({
        db,
        userId: ownerUserId,
        outcome: PROVIDER_OUTCOMES.success,
      });
      const link = await readGoogleLink(db, ownerUserId);
      expect(link?.linkState).toBe(EXTERNAL_LINK_STATES.connected);
      expect(link?.consecutiveFailureCount).toBe(0);
      expect(link?.lastFailureReason).toBeNull();
    });

    it("o refresh token nunca fica em claro no banco", async () => {
      const [row] = await db
        .select({ sealed: userExternalCredentials.sealedRefreshToken })
        .from(userExternalCredentials)
        .where(eq(userExternalCredentials.userId, ownerUserId))
        .limit(1);
      expect(row.sealed).not.toContain(GRANT.refreshToken);
      expect(row.sealed).toMatch(/^v1\./);
    });

    it("desvincular revoga, apaga o envelope e desconecta", async () => {
      let revokedWith: string | null = null;
      const result = await disconnectGoogleLink({
        db,
        userId: ownerUserId,
        revoke: async (refreshToken) => {
          revokedWith = refreshToken;
          return { ok: true, value: null };
        },
      });
      expect(result.revoked).toBe(true);
      // A revogação recebe o token em claro — e só ela.
      expect(revokedWith).toBe(GRANT.refreshToken);

      const link = await readGoogleLink(db, ownerUserId);
      expect(link?.linkState).toBe(EXTERNAL_LINK_STATES.disconnected);
      expect(link?.accountLabel).toBeNull();
      expect(link?.externalCalendarId).toBeNull();

      const [row] = await db
        .select({ sealed: userExternalCredentials.sealedRefreshToken })
        .from(userExternalCredentials)
        .where(eq(userExternalCredentials.userId, ownerUserId))
        .limit(1);
      expect(row.sealed).toBeNull();
    });

    it("vínculo desconectado não tenta sincronizar", async () => {
      const provider = createFakeCalendarProvider();
      const result = await runGoogleCalendarExport({
        db,
        userId: ownerUserId,
        config: CONFIG,
        provider,
        timeZone: "America/Sao_Paulo",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe(PROVIDER_FAILURE_REASONS.authRejected);
      expect(provider.calls.upsert).toBe(0);
    });

    it("usuário sem vínculo nenhum não vaza estado de outro", async () => {
      expect(await readGoogleLink(db, otherUserId)).toBeNull();
      expect(
        await recordGoogleOutcome({
          db,
          userId: otherUserId,
          outcome: PROVIDER_OUTCOMES.success,
        }),
      ).toBeNull();
    });
  });

  describe("isolamento entre contas", () => {
    it("a exclusão da conta apaga vínculo, estado OAuth e espelho", async () => {
      const [victim] = await db.insert(users).values({
        name: `Vítima ${stamp}`,
        email: `vitima-google-${stamp}@test.local`,
        password: "x".repeat(20),
        role: "doctor",
      });
      const victimId = victim.insertId;

      await persistGoogleAuthorization({
        db,
        userId: victimId,
        grant: GRANT,
        accountLabel: null,
        externalCalendarId: "cal-vitima",
      });
      await startGoogleAuthorization({
        db,
        userId: victimId,
        returnTarget: "WEB",
        config: CONFIG,
      });
      await db.insert(externalCalendarEventLinks).values({
        userId: victimId,
        provider: EXTERNAL_PROVIDERS.googleCalendar,
        externalCalendarId: "cal-vitima",
        externalEventId: `ev-${stamp}`,
        sourceKind: "DUTY_ASSIGNMENT",
        sourceId: 1,
      });

      await db.delete(users).where(eq(users.id, victimId));

      const [credentials, states, links] = await Promise.all([
        db
          .select({ id: userExternalCredentials.id })
          .from(userExternalCredentials)
          .where(eq(userExternalCredentials.userId, victimId)),
        db
          .select({ id: googleOauthStates.id })
          .from(googleOauthStates)
          .where(eq(googleOauthStates.userId, victimId)),
        db
          .select({ id: externalCalendarEventLinks.id })
          .from(externalCalendarEventLinks)
          .where(eq(externalCalendarEventLinks.userId, victimId)),
      ]);
      expect(credentials).toHaveLength(0);
      expect(states).toHaveLength(0);
      expect(links).toHaveLength(0);
    });
  });
});
