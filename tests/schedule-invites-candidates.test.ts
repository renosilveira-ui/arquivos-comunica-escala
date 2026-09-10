import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  hospitals,
  institutions,
  managerScope,
  medicalSpecialties,
  professionalAccess,
  professionalInstitutions,
  professionals,
  scheduleContexts,
  scheduleInviteIssuanceFences,
  scheduleInvites,
  sectors,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { mailer } from "../server/mailer";
import { appRouter } from "../server/routers";
import * as auditTrail from "../server/audit-trail";
import { __scheduleInviteTestHooks } from "../server/schedule-invites";
import {
  hashScheduleInviteCodeV2,
  normalizeScheduleInviteCode,
} from "../lib/schedule-invite-code";
import { ensureTestAnesthesiaSpecialty } from "./helpers/open-test-scale";

describe("scheduleInvites.listCandidates — sala de espera e busca por nome", () => {
  let db: NonNullable<Awaited<ReturnType<typeof getDb>>>;
  let institutionId: number;
  let otherInstitutionId: number;
  let hospitalId: number;
  let otherHospitalId: number;
  let sectorId: number;
  let anesthesiaId: number;
  let managerUserId: number;
  let managerProfessionalId: number;
  let managerSessionVersion: number;
  let waitingUserId: number;
  let houseUserId: number;
  let alreadyInScaleUserId: number;
  let otherHouseUserId: number;
  let otherHospitalUserId: number;
  let differentSpecialtyUserId: number;

  async function createDoctor(input: {
    stamp: number;
    label: string;
    name: string;
    specialtyId: number;
    specialtyLabel: string;
    institutionId?: number;
  }) {
    const [user] = await db
      .insert(users)
      .values({
        name: input.name,
        email: `invite-cand-${input.label}-${input.stamp}@test.local`,
        passwordHash: "test",
        role: "doctor",
        approvalStatus: "APPROVED",
      })
      .$returningId();
    const [pro] = await db
      .insert(professionals)
      .values({
        userId: user.id,
        name: input.name,
        role: "Médico",
        userRole: "USER",
        medicalSpecialtyId: input.specialtyId,
        specialty: input.specialtyLabel,
      })
      .$returningId();
    if (input.institutionId != null) {
      await db.insert(professionalInstitutions).values({
        professionalId: pro.id,
        userId: user.id,
        institutionId: input.institutionId,
        roleInInstitution: "USER",
        isPrimary: true,
        active: true,
      });
    }
    return { userId: user.id, professionalId: pro.id };
  }

  function caller() {
    return appRouter.createCaller({
      user: {
        id: managerUserId,
        role: "manager",
        name: "Gestor candidatos",
        email: "gestor-cand@test.local",
        sessionVersion: managerSessionVersion,
      },
      institutionId,
      allowedInstitutionIds: [institutionId],
    } as never);
  }

  beforeAll(async () => {
    const conn = await getDb();
    if (!conn) throw new Error("Database not available");
    db = conn;
    const stamp = Date.now();

    const [institution] = await db
      .insert(institutions)
      .values({
        name: `Invite Cand Tenant ${stamp}`,
        cnpj: `${stamp}`.slice(-14).padStart(14, "0"),
        legalName: `Invite Cand ${stamp}`,
        tradeName: `IC${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    institutionId = institution.id;

    const [other] = await db
      .insert(institutions)
      .values({
        name: `Invite Cand Other ${stamp}`,
        cnpj: `${stamp}1`.slice(-14).padStart(14, "0"),
        legalName: `Invite Cand Other ${stamp}`,
        tradeName: `ICO${stamp}`.slice(0, 20),
        isActive: true,
      })
      .$returningId();
    otherInstitutionId = other.id;

    const [hospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Invite Cand Hospital ${stamp}` })
      .$returningId();
    hospitalId = hospital.id;
    const [otherHospital] = await db
      .insert(hospitals)
      .values({ institutionId, name: `Invite Cand Hospital B ${stamp}` })
      .$returningId();
    otherHospitalId = otherHospital.id;

    const [sector] = await db
      .insert(sectors)
      .values({
        institutionId,
        hospitalId,
        name: `Invite Cand Setor ${stamp}`,
        category: "cirurgico",
        color: "#2563EB",
      })
      .$returningId();
    sectorId = sector.id;

    anesthesiaId = await ensureTestAnesthesiaSpecialty(db);
    await db
      .insert(medicalSpecialties)
      .values({
        code: "CLINICA_MEDICA",
        name: "Clínica médica",
        sourceVersion: "CFM_2380_2024",
        active: true,
        sortOrder: 16,
      })
      .onDuplicateKeyUpdate({ set: { active: true } });
    const [clinica] = await db
      .select({ id: medicalSpecialties.id })
      .from(medicalSpecialties)
      .where(eq(medicalSpecialties.code, "CLINICA_MEDICA"));

    await db.insert(scheduleContexts).values({
      institutionId,
      hospitalId,
      sectorId,
      medicalSpecialtyId: anesthesiaId,
      admissionPolicy: "PINNED_QUALIFICATION",
      active: true,
    });

    const [managerUser] = await db
      .insert(users)
      .values({
        name: `Invite Cand Gestor ${stamp}`,
        email: `invite-cand-manager-${stamp}@test.local`,
        passwordHash: "test",
        role: "manager",
        approvalStatus: "APPROVED",
        sessionVersion: 1,
      })
      .$returningId();
    managerUserId = managerUser.id;
    const [managerPro] = await db
      .insert(professionals)
      .values({
        userId: managerUserId,
        name: `Invite Cand Gestor ${stamp}`,
        role: "Gestor",
        userRole: "GESTOR_MEDICO",
        medicalSpecialtyId: anesthesiaId,
        specialty: "Anestesiologia",
      })
      .$returningId();
    managerProfessionalId = managerPro.id;
    await db.insert(professionalInstitutions).values({
      professionalId: managerPro.id,
      userId: managerUserId,
      institutionId,
      roleInInstitution: "GESTOR_MEDICO",
      isPrimary: true,
      active: true,
    });
    await db.insert(managerScope).values({
      institutionId,
      managerProfessionalId: managerPro.id,
      hospitalId,
      sectorId,
      active: true,
    });
    const [managerSession] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, managerUserId));
    managerSessionVersion = managerSession!.sessionVersion;

    const waiting = await createDoctor({
      stamp,
      label: "waiting",
      name: "José da Silva Awaiting",
      specialtyId: anesthesiaId,
      specialtyLabel: "Anestesiologia",
    });
    waitingUserId = waiting.userId;

    const house = await createDoctor({
      stamp,
      label: "house",
      name: "Ana Casa Sem Setor",
      specialtyId: anesthesiaId,
      specialtyLabel: "Anestesiologia",
      institutionId,
    });
    houseUserId = house.userId;

    const already = await createDoctor({
      stamp,
      label: "already",
      name: "Bruno Já Na Escala",
      specialtyId: anesthesiaId,
      specialtyLabel: "Anestesiologia",
      institutionId,
    });
    alreadyInScaleUserId = already.userId;
    await db.insert(professionalAccess).values({
      institutionId,
      professionalId: already.professionalId,
      hospitalId,
      sectorId,
      canAccess: true,
    });

    const otherHouse = await createDoctor({
      stamp,
      label: "other",
      name: "Carla Outro Hospital",
      specialtyId: anesthesiaId,
      specialtyLabel: "Anestesiologia",
      institutionId: otherInstitutionId,
    });
    otherHouseUserId = otherHouse.userId;

    const otherHospitalDoctor = await createDoctor({
      stamp,
      label: "other-hospital",
      name: "Carla Hospital B",
      specialtyId: anesthesiaId,
      specialtyLabel: "Anestesiologia",
      institutionId,
    });
    otherHospitalUserId = otherHospitalDoctor.userId;
    await db.insert(professionalAccess).values({
      institutionId,
      professionalId: otherHospitalDoctor.professionalId,
      hospitalId: otherHospitalId,
      canAccess: true,
    });

    const differentSpecialty = await createDoctor({
      stamp,
      label: "wrong",
      name: "Diego Clínica Médica",
      specialtyId: clinica.id,
      specialtyLabel: "Clínica médica",
    });
    differentSpecialtyUserId = differentSpecialty.userId;
  });

  it("mostra a sala de espera e a casa sem exigir e-mail; isola outro hospital sem usar especialidade como ACL", async () => {
    const rows = await caller().scheduleInvites.listCandidates({
      hospitalId,
      sectorId,
    });
    const ids = rows.map((row) => row.userId);

    expect(ids).toContain(waitingUserId);
    expect(ids).toContain(houseUserId);
    expect(ids).not.toContain(alreadyInScaleUserId);
    expect(ids).not.toContain(otherHouseUserId);
    expect(ids).not.toContain(otherHospitalUserId);
    expect(ids).toContain(differentSpecialtyUserId);
    expect(rows.find((row) => row.userId === waitingUserId)?.name).toBe(
      "José da Silva Awaiting",
    );
    expect(rows[0]).not.toHaveProperty("email");
  });

  it("filtra por nome sem acento e sem maiúscula", async () => {
    const rows = await caller().scheduleInvites.listCandidates({
      hospitalId,
      sectorId,
      name: "jose",
    });
    const ids = rows.map((row) => row.userId);

    expect(ids).toContain(waitingUserId);
    expect(ids).not.toContain(houseUserId);
    expect(ids).not.toContain(otherHouseUserId);
  });

  // Regressão de segurança: a criação de convite compartilha a MESMA fonte de
  // elegibilidade da busca. Um médico que o listCandidates esconde não pode ser
  // convidado passando o userId direto (bypass por id).
  describe("create — mesma elegibilidade da busca (fail-closed por id)", () => {
    let mailSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      mailSpy = vi
        .spyOn(mailer, "sendMail")
        .mockResolvedValue({ delivered: true, transport: "resend" });
    });

    afterEach(() => {
      __scheduleInviteTestHooks.afterActivationFenceLocked = undefined;
      vi.unstubAllEnvs();
      mailSpy.mockRestore();
    });

    function inviteCodeFromMailCall(callIndex: number): string {
      const message = mailSpy.mock.calls[callIndex]?.[0];
      const match = message?.text.match(
        /cole o convite: ([A-Z2-9]{4}-[A-Z2-9]{4})/,
      );
      if (!match?.[1]) throw new Error("E-mail sem código nominal");
      return match[1];
    }

    async function activeInvitesFor(userId: number) {
      return db
        .select({
          id: scheduleInvites.id,
          codeHash: scheduleInvites.codeHash,
          codeHashVersion: scheduleInvites.codeHashVersion,
        })
        .from(scheduleInvites)
        .where(
          and(
            eq(scheduleInvites.institutionId, institutionId),
            eq(scheduleInvites.hospitalId, hospitalId),
            eq(scheduleInvites.sectorId, sectorId),
            eq(scheduleInvites.invitedUserId, userId),
            isNull(scheduleInvites.revokedAt),
            isNull(scheduleInvites.declinedAt),
            sql`${scheduleInvites.redeemedCount} = 0`,
          ),
        );
    }

    it("recusa convidar médico de hospital irmão informado direto por id", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const result = await caller().scheduleInvites.create({
          hospitalId,
          sectorId,
          userIds: [otherHospitalUserId],
        });
        expect(result.accepted).toHaveLength(0);
        expect(result.failed).toEqual([
          { userId: otherHospitalUserId, error: "Médico não encontrado" },
        ]);
        // Rejeitado antes de qualquer envio: nenhuma tentativa de e-mail.
        expect(mailSpy).not.toHaveBeenCalled();
        // Observabilidade: a recusa por id inelegível deixa sinal (sem PII).
        const warned = warnSpy.mock.calls
          .map((call) => String(call[0]))
          .join("\n");
        expect(warned).toContain("fora da elegibilidade da busca");
        expect(warned).toContain(String(otherHospitalUserId));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("recusa convidar médico travado em outra instituição por id", async () => {
      const result = await caller().scheduleInvites.create({
        hospitalId,
        sectorId,
        userIds: [otherHouseUserId],
      });
      expect(result.accepted).toHaveLength(0);
      expect(result.failed).toEqual([
        { userId: otherHouseUserId, error: "Médico não encontrado" },
      ]);
      expect(mailSpy).not.toHaveBeenCalled();
    });

    it("aplica a MESMA regra da busca ao lote: só o elegível vira convite", async () => {
      const result = await caller().scheduleInvites.create({
        hospitalId,
        sectorId,
        userIds: [
          waitingUserId,
          houseUserId,
          otherHospitalUserId,
          otherHouseUserId,
          alreadyInScaleUserId,
        ],
      });

      const acceptedIds = result.accepted.map((row) => row.userId);
      const failedIds = result.failed.map((row) => row.userId);

      // Não pode over-bloquear: sala de espera E membro da casa continuam
      // convidáveis pelo create.
      expect(acceptedIds).toContain(waitingUserId);
      expect(acceptedIds).toContain(houseUserId);
      expect(acceptedIds).not.toContain(otherHospitalUserId);
      expect(acceptedIds).not.toContain(otherHouseUserId);
      expect(acceptedIds).not.toContain(alreadyInScaleUserId);
      expect(failedIds).toEqual(
        expect.arrayContaining([
          otherHospitalUserId,
          otherHouseUserId,
          alreadyInScaleUserId,
        ]),
      );
      for (const failure of result.failed) {
        // Resposta neutra: não revela o motivo real nem confirma o vínculo.
        expect(failure.error).toBe("Médico não encontrado");
      }
    });

    it("omite identidade profissional ambígua da busca e do convite por id", async () => {
      const target = await createDoctor({
        stamp: Date.now(),
        label: `ambiguous-${Date.now()}`,
        name: "Identidade Profissional Ambígua",
        specialtyId: anesthesiaId,
        specialtyLabel: "Anestesiologia",
      });
      await db.insert(professionals).values({
        userId: target.userId,
        name: "Identidade Profissional Duplicada",
        role: "Médico",
        userRole: "USER",
        medicalSpecialtyId: anesthesiaId,
        specialty: "Anestesiologia",
      });

      const listed = await caller().scheduleInvites.listCandidates({
        hospitalId,
        sectorId,
      });
      expect(listed.map((row) => row.userId)).not.toContain(target.userId);
      const result = await caller().scheduleInvites.create({
        hospitalId,
        sectorId,
        userIds: [target.userId],
      });
      expect(result.accepted).toHaveLength(0);
      expect(result.failed).toEqual([
        { userId: target.userId, error: "Médico não encontrado" },
      ]);
      expect(mailSpy).not.toHaveBeenCalled();
    });

    it("omite vínculo institucional cujo professional pertence a outro usuário", async () => {
      const target = await createDoctor({
        stamp: Date.now(),
        label: `crossed-membership-target-${Date.now()}`,
        name: "Vínculo Profissional Cruzado",
        specialtyId: anesthesiaId,
        specialtyLabel: "Anestesiologia",
      });
      const other = await createDoctor({
        stamp: Date.now(),
        label: `crossed-membership-other-${Date.now()}`,
        name: "Outro Dono do Profissional",
        specialtyId: anesthesiaId,
        specialtyLabel: "Anestesiologia",
      });
      await db.insert(professionalInstitutions).values({
        professionalId: other.professionalId,
        userId: target.userId,
        institutionId,
        roleInInstitution: "USER",
        isPrimary: true,
        active: true,
      });

      const listed = await caller().scheduleInvites.listCandidates({
        hospitalId,
        sectorId,
      });
      expect(listed.map((row) => row.userId)).not.toContain(target.userId);

      const result = await caller().scheduleInvites.create({
        hospitalId,
        sectorId,
        userIds: [target.userId],
      });
      expect(result.accepted).toHaveLength(0);
      expect(result.failed).toEqual([
        { userId: target.userId, error: "Médico não encontrado" },
      ]);
      expect(mailSpy).not.toHaveBeenCalled();
    });

    it("pepper ausente bloqueia somente a emissão antes de enviar ou criar fence", async () => {
      const target = await createDoctor({
        stamp: Date.now(),
        label: `missing-pepper-${Date.now()}`,
        name: "Configuração Criptográfica Ausente",
        specialtyId: anesthesiaId,
        specialtyLabel: "Anestesiologia",
      });
      vi.stubEnv("SCHEDULE_INVITE_CODE_PEPPER", "");

      await expect(
        caller().scheduleInvites.create({
          hospitalId,
          sectorId,
          userIds: [target.userId],
        }),
      ).rejects.toMatchObject({
        message: "Hash seguro de convite indisponível",
      });
      expect(mailSpy).not.toHaveBeenCalled();
      const fences = await db
        .select({ id: scheduleInviteIssuanceFences.id })
        .from(scheduleInviteIssuanceFences)
        .where(
          and(
            eq(scheduleInviteIssuanceFences.institutionId, institutionId),
            eq(scheduleInviteIssuanceFences.hospitalId, hospitalId),
            eq(scheduleInviteIssuanceFences.sectorId, sectorId),
            eq(scheduleInviteIssuanceFences.invitedUserId, target.userId),
          ),
        );
      expect(fences).toHaveLength(0);
    });

    it("convite ativo impõe cooldown e nunca é substituído silenciosamente", async () => {
      const target = await createDoctor({
        stamp: Date.now(),
        label: `preserve-${Date.now()}`,
        name: "Preserva Convite Anterior",
        specialtyId: anesthesiaId,
        specialtyLabel: "Anestesiologia",
      });
      await caller().scheduleInvites.create({
        hospitalId,
        sectorId,
        userIds: [target.userId],
      });
      const before = await activeInvitesFor(target.userId);
      expect(before).toHaveLength(1);

      const providerCallsBeforeRetry = mailSpy.mock.calls.length;
      const retry = await caller().scheduleInvites.create({
        hospitalId,
        sectorId,
        userIds: [target.userId],
      });

      expect(retry.accepted).toHaveLength(0);
      expect(retry.failed[0]?.error).toContain("Já existe um convite ativo");
      expect(mailSpy).toHaveBeenCalledTimes(providerCallsBeforeRetry);
      expect(await activeInvitesFor(target.userId)).toEqual(before);
    });

    it("A lento e B concorrente: somente A chega ao provedor e pode confirmar sucesso", async () => {
      const target = await createDoctor({
        stamp: Date.now(),
        label: `success-failure-${Date.now()}`,
        name: "Concorrência Sucesso Falha",
        specialtyId: anesthesiaId,
        specialtyLabel: "Anestesiologia",
      });
      mailSpy.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () => resolve({ delivered: true, transport: "resend" }),
              40,
            );
          }),
      );

      const [attemptA, attemptB] = await Promise.all([
        caller().scheduleInvites.create({
          hospitalId,
          sectorId,
          userIds: [target.userId],
        }),
        caller().scheduleInvites.create({
          hospitalId,
          sectorId,
          userIds: [target.userId],
        }),
      ]);
      expect(attemptA.accepted).toHaveLength(1);
      expect(attemptB.accepted).toHaveLength(0);
      expect(attemptB.failed[0]?.error).toMatch(
        /em andamento|Já existe um convite ativo/,
      );
      expect(mailSpy).toHaveBeenCalledTimes(1);
      const firstCode = inviteCodeFromMailCall(0);
      expect(await activeInvitesFor(target.userId)).toEqual([
        expect.objectContaining({
          codeHashVersion: "HMAC_SHA256_V2",
          codeHash: hashScheduleInviteCodeV2(
            normalizeScheduleInviteCode(firstCode),
            process.env.SCHEDULE_INVITE_CODE_PEPPER!,
          ),
        }),
      ]);
    });

    it("duas requisições concorrentes nunca confirmam dois códigos", async () => {
      const target = await createDoctor({
        stamp: Date.now(),
        label: `both-success-${Date.now()}`,
        name: "Concorrência Dois Sucessos",
        specialtyId: anesthesiaId,
        specialtyLabel: "Anestesiologia",
      });
      const acceptedCodes: string[] = [];
      mailSpy.mockImplementation(async (message) => {
        const match = message.text.match(
          /cole o convite: ([A-Z2-9]{4}-[A-Z2-9]{4})/,
        );
        if (!match?.[1]) throw new Error("E-mail sem código nominal");
        if (mailSpy.mock.calls.length === 1) {
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        acceptedCodes.push(match[1]);
        return { delivered: true, transport: "resend" };
      });

      const attempts = await Promise.all([
        caller().scheduleInvites.create({
          hospitalId,
          sectorId,
          userIds: [target.userId],
        }),
        caller().scheduleInvites.create({
          hospitalId,
          sectorId,
          userIds: [target.userId],
        }),
      ]);
      expect(
        attempts.reduce((sum, attempt) => sum + attempt.accepted.length, 0),
      ).toBe(1);
      expect(
        attempts.reduce((sum, attempt) => sum + attempt.failed.length, 0),
      ).toBe(1);
      expect(acceptedCodes).toHaveLength(1);
      const onlyAcceptedCode = acceptedCodes[0]!;
      expect(await activeInvitesFor(target.userId)).toEqual([
        expect.objectContaining({
          codeHashVersion: "HMAC_SHA256_V2",
          codeHash: hashScheduleInviteCodeV2(
            normalizeScheduleInviteCode(onlyAcceptedCode),
            process.env.SCHEDULE_INVITE_CODE_PEPPER!,
          ),
        }),
      ]);
    });

    it("revogação de autoridade durante a rede impede ativação", async () => {
      const target = await createDoctor({
        stamp: Date.now(),
        label: `revoked-authority-${Date.now()}`,
        name: "Autoridade Revogada Durante Convite",
        specialtyId: anesthesiaId,
        specialtyLabel: "Anestesiologia",
      });
      let releaseFirst!: () => void;
      let markMailStarted!: () => void;
      const firstCanFinish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const mailStarted = new Promise<void>((resolve) => {
        markMailStarted = resolve;
      });
      mailSpy
        .mockImplementationOnce(async () => {
          markMailStarted();
          await firstCanFinish;
          return { delivered: true, transport: "resend" };
        })
        .mockResolvedValue({ delivered: true, transport: "resend" });

      const attemptA = caller().scheduleInvites.create({
        hospitalId,
        sectorId,
        userIds: [target.userId],
      });
      await mailStarted;

      try {
        await db
          .update(managerScope)
          .set({ active: false })
          .where(
            and(
              eq(managerScope.institutionId, institutionId),
              eq(managerScope.managerProfessionalId, managerProfessionalId),
              eq(managerScope.hospitalId, hospitalId),
              eq(managerScope.sectorId, sectorId),
            ),
          );
        releaseFirst();
        const result = await attemptA;
        expect(result.accepted).toHaveLength(0);
        expect(result.failed[0]?.error).toContain("não foi ativado");
        expect(await activeInvitesFor(target.userId)).toHaveLength(0);
      } finally {
        releaseFirst();
        await db
          .update(managerScope)
          .set({ active: true })
          .where(
            and(
              eq(managerScope.institutionId, institutionId),
              eq(managerScope.managerProfessionalId, managerProfessionalId),
              eq(managerScope.hospitalId, hospitalId),
              eq(managerScope.sectorId, sectorId),
            ),
          );
        const [restoredSession] = await db
          .select({ sessionVersion: users.sessionVersion })
          .from(users)
          .where(eq(users.id, managerUserId));
        managerSessionVersion = restoredSession!.sessionVersion;
      }
    });

    it("mudança de elegibilidade do destinatário durante a rede impede ativação", async () => {
      const target = await createDoctor({
        stamp: Date.now(),
        label: `recipient-changed-${Date.now()}`,
        name: "Destinatário Alterado Durante Entrega",
        specialtyId: anesthesiaId,
        specialtyLabel: "Anestesiologia",
      });
      let markMailStarted!: () => void;
      let releaseMail!: () => void;
      const mailStarted = new Promise<void>((resolve) => {
        markMailStarted = resolve;
      });
      const mailCanFinish = new Promise<void>((resolve) => {
        releaseMail = resolve;
      });
      mailSpy.mockImplementationOnce(async () => {
        markMailStarted();
        await mailCanFinish;
        return { delivered: true, transport: "resend" };
      });

      const attempt = caller().scheduleInvites.create({
        hospitalId,
        sectorId,
        userIds: [target.userId],
      });
      await mailStarted;

      // Se uma transação SQL estivesse aberta durante a rede, esta escrita
      // ficaria bloqueada pela leitura FOR UPDATE do destinatário.
      await db.insert(professionalAccess).values({
        institutionId,
        professionalId: target.professionalId,
        hospitalId,
        sectorId,
        canAccess: true,
      });
      releaseMail();

      const result = await attempt;
      expect(result.accepted).toHaveLength(0);
      expect(result.failed[0]?.error).toContain("não foi ativado");
      expect(await activeInvitesFor(target.userId)).toHaveLength(0);
    });

    it("exceção de transporte não ativa convite e retorna falha por destinatário", async () => {
      const target = await createDoctor({
        stamp: Date.now(),
        label: `transport-crash-${Date.now()}`,
        name: "Falha Abrupta do Transporte",
        specialtyId: anesthesiaId,
        specialtyLabel: "Anestesiologia",
      });
      mailSpy.mockRejectedValueOnce(new Error("simulated transport crash"));
      const result = await caller().scheduleInvites.create({
        hospitalId,
        sectorId,
        userIds: [target.userId],
      });
      expect(result.accepted).toHaveLength(0);
      expect(result.failed[0]?.error).toContain("não aceitou");
      expect(await activeInvitesFor(target.userId)).toHaveLength(0);
    });

    it("falha de ativação após aceite fica durável e não confirma sucesso", async () => {
      const target = await createDoctor({
        stamp: Date.now(),
        label: `activation-crash-${Date.now()}`,
        name: "Falha Após Aceite do Provedor",
        specialtyId: anesthesiaId,
        specialtyLabel: "Anestesiologia",
      });
      const auditSpy = vi
        .spyOn(auditTrail, "recordAudit")
        .mockRejectedValueOnce(new Error("simulated activation crash"));
      try {
        const result = await caller().scheduleInvites.create({
          hospitalId,
          sectorId,
          userIds: [target.userId],
        });
        expect(result.accepted).toHaveLength(0);
        expect(result.failed[0]?.error).toContain("não foi ativado");
        expect(await activeInvitesFor(target.userId)).toHaveLength(0);
        const [fence] = await db
          .select({
            state: scheduleInviteIssuanceFences.state,
            failureCode: scheduleInviteIssuanceFences.failureCode,
            providerAcceptedAt:
              scheduleInviteIssuanceFences.providerAcceptedAt,
          })
          .from(scheduleInviteIssuanceFences)
          .where(
            and(
              eq(scheduleInviteIssuanceFences.institutionId, institutionId),
              eq(scheduleInviteIssuanceFences.hospitalId, hospitalId),
              eq(scheduleInviteIssuanceFences.sectorId, sectorId),
              eq(scheduleInviteIssuanceFences.invitedUserId, target.userId),
            ),
          );
        expect(fence).toMatchObject({
          state: "PROVIDER_ACCEPTED_ACTIVATION_FAILED",
          failureCode: "ACTIVATION_EXCEPTION",
          providerAcceptedAt: expect.any(Date),
        });
      } finally {
        auditSpy.mockRestore();
      }
    });

    it("lê revogação corrente feita dentro da segunda transação", async () => {
      const target = await createDoctor({
        stamp: Date.now(),
        label: `second-tx-current-read-${Date.now()}`,
        name: "Leitura Corrente na Ativação",
        specialtyId: anesthesiaId,
        specialtyLabel: "Anestesiologia",
      });
      __scheduleInviteTestHooks.afterActivationFenceLocked = async () => {
        await db
          .update(managerScope)
          .set({ active: false })
          .where(
            and(
              eq(managerScope.institutionId, institutionId),
              eq(managerScope.managerProfessionalId, managerProfessionalId),
              eq(managerScope.hospitalId, hospitalId),
              eq(managerScope.sectorId, sectorId),
            ),
          );
      };

      try {
        const result = await caller().scheduleInvites.create({
          hospitalId,
          sectorId,
          userIds: [target.userId],
        });
        expect(result.accepted).toHaveLength(0);
        expect(result.failed[0]?.error).toContain("não foi ativado");
        expect(await activeInvitesFor(target.userId)).toHaveLength(0);
      } finally {
        __scheduleInviteTestHooks.afterActivationFenceLocked = undefined;
        await db
          .update(managerScope)
          .set({ active: true })
          .where(
            and(
              eq(managerScope.institutionId, institutionId),
              eq(managerScope.managerProfessionalId, managerProfessionalId),
              eq(managerScope.hospitalId, hospitalId),
              eq(managerScope.sectorId, sectorId),
            ),
          );
      }
    });

    it("dez chamadas lentas não retêm as dez conexões do pool", async () => {
      const targets = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          createDoctor({
            stamp: Date.now() + index,
            label: `pool-${index}-${Date.now()}`,
            name: `Pool Livre ${index}`,
            specialtyId: anesthesiaId,
            specialtyLabel: "Anestesiologia",
          }),
        ),
      );
      let started = 0;
      let markAllStarted!: () => void;
      let releaseProvider!: () => void;
      const allStarted = new Promise<void>((resolve) => {
        markAllStarted = resolve;
      });
      const providerCanFinish = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      mailSpy.mockImplementation(async () => {
        started += 1;
        if (started === targets.length) markAllStarted();
        await providerCanFinish;
        return { delivered: true, transport: "resend" };
      });

      const requests = Promise.all(
        targets.map((target) =>
          caller().scheduleInvites.create({
            hospitalId,
            sectorId,
            userIds: [target.userId],
          }),
        ),
      );
      try {
        await Promise.race([
          allStarted,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("As chamadas não chegaram ao provedor")),
              8_000,
            ),
          ),
        ]);
        const probe = await Promise.race([
          db.execute(sql`SELECT 1`).then(() => "available" as const),
          new Promise<"exhausted">((resolve) =>
            setTimeout(() => resolve("exhausted"), 500),
          ),
        ]);
        expect(probe).toBe("available");
      } finally {
        releaseProvider();
      }
      const results = await requests;
      expect(
        results.reduce((sum, result) => sum + result.accepted.length, 0),
      ).toBe(10);
    }, 15_000);

    it("ordena os locks quando dois gestores convidam um ao outro", async () => {
      const secondManager = await createDoctor({
        stamp: Date.now(),
        label: `cross-manager-${Date.now()}`,
        name: "Segundo Gestor Concorrente",
        specialtyId: anesthesiaId,
        specialtyLabel: "Anestesiologia",
        institutionId,
      });
      await db
        .update(users)
        .set({ role: "manager" })
        .where(eq(users.id, secondManager.userId));
      await db
        .update(professionals)
        .set({ userRole: "GESTOR_MEDICO" })
        .where(eq(professionals.id, secondManager.professionalId));
      await db
        .update(professionalInstitutions)
        .set({ roleInInstitution: "GESTOR_MEDICO" })
        .where(
          and(
            eq(
              professionalInstitutions.professionalId,
              secondManager.professionalId,
            ),
            eq(professionalInstitutions.userId, secondManager.userId),
            eq(professionalInstitutions.institutionId, institutionId),
          ),
        );
      await db.insert(managerScope).values({
        institutionId,
        managerProfessionalId: secondManager.professionalId,
        hospitalId,
        sectorId,
        active: true,
      });
      const [secondManagerSession] = await db
        .select({ sessionVersion: users.sessionVersion })
        .from(users)
        .where(eq(users.id, secondManager.userId));
      const secondCaller = appRouter.createCaller({
        user: {
          id: secondManager.userId,
          role: "manager",
          name: "Segundo Gestor Concorrente",
          email: `segundo-gestor-${secondManager.userId}@test.local`,
          sessionVersion: secondManagerSession!.sessionVersion,
        },
        institutionId,
        allowedInstitutionIds: [institutionId],
      } as never);

      let providerCalls = 0;
      let markBothStarted!: () => void;
      let releaseProvider!: () => void;
      const bothStarted = new Promise<void>((resolve) => {
        markBothStarted = resolve;
      });
      const providerCanFinish = new Promise<void>((resolve) => {
        releaseProvider = resolve;
      });
      mailSpy.mockImplementation(async () => {
        providerCalls += 1;
        if (providerCalls === 2) markBothStarted();
        await providerCanFinish;
        return { delivered: true, transport: "resend" };
      });

      const requests = [
        caller().scheduleInvites.create({
          hospitalId,
          sectorId,
          userIds: [secondManager.userId],
        }),
        secondCaller.scheduleInvites.create({
          hospitalId,
          sectorId,
          userIds: [managerUserId],
        }),
      ];
      let startFailure: unknown;
      try {
        await Promise.race([
          bothStarted,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("As duas emissões não alcançaram o provedor")),
              3_000,
            ),
          ),
        ]);
      } catch (error) {
        startFailure = error;
      } finally {
        releaseProvider();
      }
      const settled = await Promise.allSettled(requests);
      if (startFailure) throw startFailure;

      expect(settled).toEqual([
        expect.objectContaining({ status: "fulfilled" }),
        expect.objectContaining({ status: "fulfilled" }),
      ]);
      const results = settled.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      expect(
        results.reduce((sum, result) => sum + result.accepted.length, 0),
      ).toBe(2);
      expect(await activeInvitesFor(secondManager.userId)).toHaveLength(1);
      expect(await activeInvitesFor(managerUserId)).toHaveLength(1);
    });

    it("serializa reemissões concorrentes e preserva exatamente um convite ativo", async () => {
      const target = await createDoctor({
        stamp: Date.now(),
        label: `concurrent-${Date.now()}`,
        name: "Concorrência Convite",
        specialtyId: anesthesiaId,
        specialtyLabel: "Anestesiologia",
      });

      const attempts = await Promise.all(
        Array.from({ length: 6 }, () =>
          caller().scheduleInvites.create({
            hospitalId,
            sectorId,
            userIds: [target.userId],
          }),
        ),
      );
      expect(attempts).toHaveLength(6);
      expect(
        attempts.reduce((sum, attempt) => sum + attempt.accepted.length, 0),
      ).toBe(1);
      expect(
        attempts.reduce((sum, attempt) => sum + attempt.failed.length, 0),
      ).toBe(5);
      expect(mailSpy).toHaveBeenCalledTimes(1);

      const active = await db
        .select({ id: scheduleInvites.id })
        .from(scheduleInvites)
        .where(
          and(
            eq(scheduleInvites.institutionId, institutionId),
            eq(scheduleInvites.hospitalId, hospitalId),
            eq(scheduleInvites.sectorId, sectorId),
            eq(scheduleInvites.invitedUserId, target.userId),
            isNull(scheduleInvites.revokedAt),
            isNull(scheduleInvites.declinedAt),
            sql`${scheduleInvites.redeemedCount} = 0`,
          ),
        );
      expect(active).toHaveLength(1);
    });
  });
});
