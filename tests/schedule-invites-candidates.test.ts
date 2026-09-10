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
  scheduleInvites,
  sectors,
  users,
} from "../drizzle/schema";
import { getDb } from "../server/db";
import { mailer } from "../server/mailer";
import { appRouter } from "../server/routers";
import * as auditTrail from "../server/audit-trail";
import {
  hashScheduleInviteCode,
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
        await expect(
          caller().scheduleInvites.create({
            hospitalId,
            sectorId,
            userIds: [otherHospitalUserId],
          }),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
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
      await expect(
        caller().scheduleInvites.create({
          hospitalId,
          sectorId,
          userIds: [otherHouseUserId],
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
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

      const sentIds = result.sent.map((row) => row.userId);
      const failedIds = result.failed.map((row) => row.userId);

      // Não pode over-bloquear: sala de espera E membro da casa continuam
      // convidáveis pelo create.
      expect(sentIds).toContain(waitingUserId);
      expect(sentIds).toContain(houseUserId);
      expect(sentIds).not.toContain(otherHospitalUserId);
      expect(sentIds).not.toContain(otherHouseUserId);
      expect(sentIds).not.toContain(alreadyInScaleUserId);
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
      await expect(
        caller().scheduleInvites.create({
          hospitalId,
          sectorId,
          userIds: [target.userId],
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(mailSpy).not.toHaveBeenCalled();
    });

    it("falha de uma nova entrega preserva o convite ativo anterior", async () => {
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

      mailSpy.mockResolvedValueOnce({
        delivered: false,
        transport: "resend",
        error: "HTTP 503",
      });
      await expect(
        caller().scheduleInvites.create({
          hospitalId,
          sectorId,
          userIds: [target.userId],
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      expect(await activeInvitesFor(target.userId)).toEqual(before);
    });

    it("A sucesso lento e B falha rápida mantêm A ativo", async () => {
      const target = await createDoctor({
        stamp: Date.now(),
        label: `success-failure-${Date.now()}`,
        name: "Concorrência Sucesso Falha",
        specialtyId: anesthesiaId,
        specialtyLabel: "Anestesiologia",
      });
      mailSpy
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              setTimeout(
                () => resolve({ delivered: true, transport: "resend" }),
                40,
              );
            }),
        )
        .mockResolvedValueOnce({
          delivered: false,
          transport: "resend",
          error: "HTTP 503",
        });

      const [attemptA, attemptB] = await Promise.allSettled([
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
      expect(attemptA.status).toBe("fulfilled");
      expect(attemptB.status).toBe("rejected");
      const firstCode = inviteCodeFromMailCall(0);
      expect(await activeInvitesFor(target.userId)).toEqual([
        expect.objectContaining({
          codeHash: hashScheduleInviteCode(
            normalizeScheduleInviteCode(firstCode),
          ),
        }),
      ]);
    });

    it("duas entregas concorrentes deixam ativo o último código efetivamente entregue", async () => {
      const target = await createDoctor({
        stamp: Date.now(),
        label: `both-success-${Date.now()}`,
        name: "Concorrência Dois Sucessos",
        specialtyId: anesthesiaId,
        specialtyLabel: "Anestesiologia",
      });
      const deliveredCodes: string[] = [];
      mailSpy.mockImplementation(async (message) => {
        const match = message.text.match(
          /cole o convite: ([A-Z2-9]{4}-[A-Z2-9]{4})/,
        );
        if (!match?.[1]) throw new Error("E-mail sem código nominal");
        if (mailSpy.mock.calls.length === 1) {
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        deliveredCodes.push(match[1]);
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
      expect(attempts.every((attempt) => attempt.sent.length === 1)).toBe(true);
      expect(deliveredCodes).toHaveLength(2);
      const lastDelivered = deliveredCodes.at(-1)!;
      expect(await activeInvitesFor(target.userId)).toEqual([
        expect.objectContaining({
          codeHash: hashScheduleInviteCode(
            normalizeScheduleInviteCode(lastDelivered),
          ),
        }),
      ]);
    });

    it("revogação de autoridade enquanto B aguarda o mutex bloqueia A e B", async () => {
      const target = await createDoctor({
        stamp: Date.now(),
        label: `revoked-authority-${Date.now()}`,
        name: "Autoridade Revogada Durante Convite",
        specialtyId: anesthesiaId,
        specialtyLabel: "Anestesiologia",
      });
      let releaseFirst!: () => void;
      const firstCanFinish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      mailSpy
        .mockImplementationOnce(async () => {
          await firstCanFinish;
          return { delivered: true, transport: "resend" };
        })
        .mockResolvedValue({ delivered: true, transport: "resend" });

      const attemptA = caller()
        .scheduleInvites.create({
          hospitalId,
          sectorId,
          userIds: [target.userId],
        })
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const attemptB = caller()
        .scheduleInvites.create({
          hospitalId,
          sectorId,
          userIds: [target.userId],
        })
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
      await new Promise((resolve) => setTimeout(resolve, 20));

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
        const attempts = await Promise.all([attemptA, attemptB]);
        expect(attempts.map((attempt) => attempt.status)).toEqual([
          "rejected",
          "rejected",
        ]);
        for (const attempt of attempts) {
          if (attempt.status === "rejected") {
            expect(attempt.reason).toMatchObject({
              code: expect.stringMatching(/^(FORBIDDEN|CONFLICT)$/),
            });
          }
        }
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

      const attempt = caller()
        .scheduleInvites.create({
          hospitalId,
          sectorId,
          userIds: [target.userId],
        })
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason }),
        );
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
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ code: "BAD_REQUEST" });
      }
      expect(await activeInvitesFor(target.userId)).toHaveLength(0);
    });

    it("exceção de transporte preserva o convite anterior", async () => {
      const target = await createDoctor({
        stamp: Date.now(),
        label: `transport-crash-${Date.now()}`,
        name: "Falha Abrupta do Transporte",
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

      mailSpy.mockRejectedValueOnce(new Error("simulated transport crash"));
      await expect(
        caller().scheduleInvites.create({
          hospitalId,
          sectorId,
          userIds: [target.userId],
        }),
      ).rejects.toBeTruthy();
      expect(await activeInvitesFor(target.userId)).toEqual(before);
    });

    it("falha de ativação após aceite do provedor faz rollback e preserva o convite anterior", async () => {
      const target = await createDoctor({
        stamp: Date.now(),
        label: `activation-crash-${Date.now()}`,
        name: "Falha Após Aceite do Provedor",
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

      const auditSpy = vi
        .spyOn(auditTrail, "recordAudit")
        .mockRejectedValueOnce(new Error("simulated activation crash"));
      try {
        await expect(
          caller().scheduleInvites.create({
            hospitalId,
            sectorId,
            userIds: [target.userId],
          }),
        ).rejects.toThrow("simulated activation crash");
        expect(await activeInvitesFor(target.userId)).toEqual(before);
      } finally {
        auditSpy.mockRestore();
      }
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
      expect(attempts.every((attempt) => attempt.sent.length === 1)).toBe(true);

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
