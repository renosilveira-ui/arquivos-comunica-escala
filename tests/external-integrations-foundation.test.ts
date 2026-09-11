import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

import {
  hospitals,
  institutions,
  userExternalCredentials,
  userTravelOrigins,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { appRouter } from "../server/routers";
import {
  DEFAULT_SCHEDULE_TIME_ZONE,
  readHospitalTimeZone,
  readInstitutionTimeZone,
} from "../server/institution-time-zone";
import {
  openExternalCredential,
  sealExternalCredential,
} from "../server/external-credentials-crypto";
import {
  EXTERNAL_PROVIDERS,
  TRAVEL_ORIGIN_SEAL_SCOPE,
} from "../lib/integration-providers";

const stamp = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * Matriz montada em runtime, sem nenhum id, nome ou CNPJ fixo.
 *
 * O ponto da suíte é provar que a fundação vale para instituição, hospital e
 * setor criados DEPOIS da migration — inclusive uma instituição em fuso
 * diferente do de São Paulo, que é onde a suposição global de -03:00 quebra.
 */
const MATRIX = [
  { key: "alfa", timeZone: null as string | null, hospitalTimeZone: null },
  {
    key: "beta",
    timeZone: "America/Fortaleza",
    hospitalTimeZone: null as string | null,
  },
  {
    key: "gama",
    timeZone: "America/Sao_Paulo",
    hospitalTimeZone: "America/Manaus",
  },
] as const;

describe("fundação das integrações externas", () => {
  let db: Db;
  const institutionIds: number[] = [];
  const hospitalIds: number[] = [];
  const userIds: number[] = [];
  const byKey = new Map<
    string,
    { institutionId: number; hospitalId: number }
  >();

  beforeAll(async () => {
    const loaded = await getDb();
    if (!loaded) throw new Error("Banco de testes indisponível");
    db = loaded;

    for (const [index, entry] of MATRIX.entries()) {
      const [institution] = await db.insert(institutions).values({
        name: `Instituição ${entry.key} ${stamp}`,
        cnpj: `${stamp}${index}`.slice(-14).padStart(14, "0"),
        ...(entry.timeZone ? { timeZone: entry.timeZone } : {}),
      });
      const institutionId = institution.insertId;
      institutionIds.push(institutionId);

      const [hospital] = await db.insert(hospitals).values({
        institutionId,
        name: `Hospital ${entry.key} ${stamp}`,
        ...(entry.hospitalTimeZone ? { timeZone: entry.hospitalTimeZone } : {}),
      });
      hospitalIds.push(hospital.insertId);
      byKey.set(entry.key, { institutionId, hospitalId: hospital.insertId });
    }

    for (const suffix of ["a", "b"]) {
      const [user] = await db.insert(users).values({
        name: `Integração ${suffix} ${stamp}`,
        email: `integracao-${suffix}-${stamp}@test.local`,
        password: "x".repeat(20),
        role: "doctor",
      });
      userIds.push(user.insertId);
    }
  });

  afterAll(async () => {
    if (!db) return;
    if (userIds.length) {
      await db
        .delete(userTravelOrigins)
        .where(inArray(userTravelOrigins.userId, userIds));
      await db
        .delete(userExternalCredentials)
        .where(inArray(userExternalCredentials.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    if (hospitalIds.length) {
      await db.delete(hospitals).where(inArray(hospitals.id, hospitalIds));
    }
    if (institutionIds.length) {
      await db
        .delete(institutions)
        .where(inArray(institutions.id, institutionIds));
    }
  });

  describe("fuso por instituição — instituições criadas depois da migration", () => {
    it("instituição nova nasce com fuso válido sem ninguém configurar", async () => {
      const { institutionId } = byKey.get("alfa")!;
      expect(await readInstitutionTimeZone(db, institutionId)).toBe(
        DEFAULT_SCHEDULE_TIME_ZONE,
      );
    });

    it("instituição em outro fuso é respeitada", async () => {
      const { institutionId } = byKey.get("beta")!;
      expect(await readInstitutionTimeZone(db, institutionId)).toBe(
        "America/Fortaleza",
      );
    });

    it("hospital herda o fuso da instituição quando não declara o seu", async () => {
      const { institutionId, hospitalId } = byKey.get("beta")!;
      expect(await readHospitalTimeZone(db, institutionId, hospitalId)).toBe(
        "America/Fortaleza",
      );
    });

    it("hospital com fuso próprio sobrepõe o da instituição", async () => {
      const { institutionId, hospitalId } = byKey.get("gama")!;
      expect(await readHospitalTimeZone(db, institutionId, hospitalId)).toBe(
        "America/Manaus",
      );
    });

    it("hospital lido sob o tenant errado não vaza o fuso do dono", async () => {
      const gama = byKey.get("gama")!;
      const beta = byKey.get("beta")!;
      // Hospital de gama (America/Manaus) pedido sob o tenant beta: a linha
      // não pode ser encontrada, e o resultado cai no padrão — nunca em
      // America/Manaus, que revelaria a configuração de outro tenant.
      expect(
        await readHospitalTimeZone(db, beta.institutionId, gama.hospitalId),
      ).toBe(DEFAULT_SCHEDULE_TIME_ZONE);
    });
  });

  describe("credenciais externas — isolamento por conta", () => {
    it("um envelope não abre na conta de outro usuário", async () => {
      const [ownerId, otherId] = userIds;
      const binding = {
        userId: ownerId,
        scope: EXTERNAL_PROVIDERS.googleCalendar,
      };
      const sealed = sealExternalCredential("refresh-do-dono", binding);

      await db.insert(userExternalCredentials).values({
        userId: ownerId,
        provider: EXTERNAL_PROVIDERS.googleCalendar,
        linkState: "CONNECTED",
        sealedRefreshToken: sealed,
        encryptionKid: "development-v1",
      });

      const [stored] = await db
        .select({ sealed: userExternalCredentials.sealedRefreshToken })
        .from(userExternalCredentials)
        .where(eq(userExternalCredentials.userId, ownerId))
        .limit(1);
      expect(stored.sealed).not.toContain("refresh-do-dono");
      expect(openExternalCredential(stored.sealed!, binding)).toBe(
        "refresh-do-dono",
      );
      expect(() =>
        openExternalCredential(stored.sealed!, {
          userId: otherId,
          scope: EXTERNAL_PROVIDERS.googleCalendar,
        }),
      ).toThrow();
    });

    it("o banco recusa um segundo vínculo do mesmo provedor na mesma conta", async () => {
      const [ownerId] = userIds;
      await expect(
        db.insert(userExternalCredentials).values({
          userId: ownerId,
          provider: EXTERNAL_PROVIDERS.googleCalendar,
          linkState: "DISCONNECTED",
        }),
      ).rejects.toThrow();
    });

    it("excluir a conta remove credencial e origem de deslocamento", async () => {
      const [victim] = await db.insert(users).values({
        name: `Excluível ${stamp}`,
        email: `excluivel-${stamp}@test.local`,
        password: "x".repeat(20),
        role: "doctor",
      });
      const victimId = victim.insertId;
      const binding = {
        userId: victimId,
        scope: EXTERNAL_PROVIDERS.googleCalendar,
      };
      const originBinding = {
        userId: victimId,
        scope: TRAVEL_ORIGIN_SEAL_SCOPE,
      };
      await db.insert(userExternalCredentials).values({
        userId: victimId,
        provider: EXTERNAL_PROVIDERS.googleCalendar,
        linkState: "CONNECTED",
        sealedRefreshToken: sealExternalCredential("token", binding),
        encryptionKid: "development-v1",
      });
      await db.insert(userTravelOrigins).values({
        userId: victimId,
        label: "Casa",
        sealedLocation: sealExternalCredential("endereco", originBinding),
        encryptionKid: "development-v1",
        consentGrantedAt: new Date(),
        consentVersion: "v1",
        isDefault: true,
      });

      await db.delete(users).where(eq(users.id, victimId));

      const credentials = await db
        .select({ id: userExternalCredentials.id })
        .from(userExternalCredentials)
        .where(eq(userExternalCredentials.userId, victimId));
      const origins = await db
        .select({ id: userTravelOrigins.id })
        .from(userTravelOrigins)
        .where(eq(userTravelOrigins.userId, victimId));
      expect(credentials).toHaveLength(0);
      expect(origins).toHaveLength(0);
    });

    it("o banco garante uma única origem padrão por conta", async () => {
      const [ownerId] = userIds;
      const binding = {
        userId: ownerId,
        scope: EXTERNAL_PROVIDERS.googleCalendar,
      };
      await db.insert(userTravelOrigins).values({
        userId: ownerId,
        label: `Casa ${stamp}`,
        sealedLocation: sealExternalCredential("casa", binding),
        encryptionKid: "development-v1",
        consentGrantedAt: new Date(),
        consentVersion: "v1",
        isDefault: true,
      });
      await expect(
        db.insert(userTravelOrigins).values({
          userId: ownerId,
          label: `Sítio ${stamp}`,
          sealedLocation: sealExternalCredential("sitio", binding),
          encryptionKid: "development-v1",
          consentGrantedAt: new Date(),
          consentVersion: "v1",
          isDefault: true,
        }),
      ).rejects.toThrow();
    });
  });

  describe("Agenda pessoal — janela inválida é erro do pedido, não 500", () => {
    const callerFor = (userId: number) =>
      appRouter.createCaller({
        user: {
          id: userId,
          name: "Agenda",
          email: `agenda-${userId}@test.local`,
          role: "doctor",
          sessionVersion: 1,
        },
        institutionId: null,
        allowedInstitutionIds: [],
        tenantProfessionalId: null,
        tenantResolutionError: null,
        req: {} as never,
        res: {} as never,
      } as never);

    async function codeFor(run: () => Promise<unknown>): Promise<string> {
      try {
        await run();
        return "SEM_ERRO";
      } catch (error) {
        return error instanceof TRPCError ? error.code : "ERRO_NAO_TRPC";
      }
    }

    it("listWindow com janela invertida responde BAD_REQUEST", async () => {
      const caller = callerFor(userIds[0]);
      expect(
        await codeFor(() =>
          caller.personalCalendar.listWindow({
            fromDate: "2026-09-30",
            toDate: "2026-09-01",
          }),
        ),
      ).toBe("BAD_REQUEST");
    });

    it("listWindow com janela larga demais responde BAD_REQUEST", async () => {
      const caller = callerFor(userIds[0]);
      expect(
        await codeFor(() =>
          caller.personalCalendar.listWindow({
            fromDate: "2026-01-01",
            toDate: "2027-12-31",
          }),
        ),
      ).toBe("BAD_REQUEST");
    });

    it("checkConflicts com janela invertida responde BAD_REQUEST", async () => {
      const caller = callerFor(userIds[0]);
      expect(
        await codeFor(() =>
          caller.personalCalendar.checkConflicts({
            item: {
              kind: "APPOINTMENT",
              allDay: false,
              availability: "BUSY",
              startLocalDate: "2026-09-10",
              startLocalTime: "08:00",
              endLocalDate: "2026-09-10",
              endLocalTime: "09:00",
              timeZone: "America/Sao_Paulo",
            },
            recurrence: null,
            window: { fromDate: "2026-09-30", toDate: "2026-09-01" },
          }),
        ),
      ).toBe("BAD_REQUEST");
    });

    it("janela válida continua respondendo normalmente", async () => {
      const caller = callerFor(userIds[0]);
      const result = await caller.personalCalendar.listWindow({
        fromDate: "2026-09-01",
        toDate: "2026-09-30",
      });
      expect(result.occurrences).toEqual([]);
      expect(result.sourceItemCount).toBe(0);
    });
  });
});
