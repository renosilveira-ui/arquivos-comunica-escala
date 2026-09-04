import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ELIGIBLE_OFFER_RECIPIENT_HARD_LIMIT,
  EligibleOfferRecipientLimitExceededError,
  listClinicallyEligibleOfferRecipients,
  normalizeRecipientIdentityText,
  projectEligibleOfferRecipients,
  UNRESOLVED_HOMONYM_CODE,
  UNRESOLVED_HOMONYM_REASON,
} from "../server/swap-eligible-recipients";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function row(input: {
  professionalId: number;
  displayName: string;
  medicalSpecialtyName?: string | null;
  operationalProfileCode?: string | null;
}) {
  return {
    professionalId: input.professionalId,
    displayName: input.displayName,
    medicalSpecialtyName: input.medicalSpecialtyName ?? null,
    operationalProfileCode: input.operationalProfileCode ?? null,
  };
}

describe("swaps.listEligibleRecipients — contrato de fonte", () => {
  it("fonte: input só deriva o plantão; tenant e ator vêm da sessão", () => {
    const router = read("server/swap-router.ts");
    const slice = router.slice(
      router.indexOf("listEligibleRecipients:"),
      router.indexOf("accept: protectedProcedure"),
    );
    expect(slice).toContain("fromShiftInstanceId");
    expect(slice).toContain("z.strictObject");
    expect(slice).toContain("requireCanonicalAssignmentTuple");
    expect(slice).toContain("listClinicallyEligibleOfferRecipients");
    expect(slice).toContain("DB unavailable");
    expect(slice).toContain("throw error");
    expect(slice).not.toMatch(/return \[\]/);
    expect(slice).not.toContain("hospitalId");
    expect(slice).not.toContain("sectorId");
    expect(slice).not.toContain("scheduleContextId");
    expect(slice).not.toMatch(/input\.(institutionId|userId|role)/);
    expect(slice).toContain("ctx.institutionId");
    expect(slice).toContain("ctx.user");
  });

  it("fonte: elegibilidade reutiliza SQL clínico da #407, sem papel nem escopo gerencial", () => {
    const helper = read("server/swap-eligible-recipients.ts");
    expect(helper).toContain("plantonistaAccessCoversShiftSql");
    expect(helper).toContain("plantonistaQualificationMatchesContextSql");
    expect(helper).toContain("candidate list = structural eligibility");
    expect(helper).toContain("createSwapOffer = final eligibility");
    expect(helper).toContain("LEFT JOIN medical_specialties");
    expect(helper).toContain("unresolvedHomonymGroups");
    expect(helper).toContain("UNRESOLVED_HOMONYM");
    expect(helper).not.toContain("ap.specialty");
    expect(helper).not.toMatch(/manager_scope/);
    expect(helper).not.toMatch(/role_in_institution/);
    expect(helper).not.toMatch(/GESTOR_PLUS/);
    expect(helper).not.toMatch(/GESTOR_MEDICO/);
    expect(helper).not.toContain("eligibleProfessionalUserIdsForShift");
    expect(helper).not.toContain("findManagerScopeId");
    expect(helper).not.toContain("email");
    expect(helper).not.toContain("phone");
    expect(helper).not.toContain("user_id AS userId");

    const clinical = read("server/plantonista-shift-eligibility.ts");
    expect(clinical).toContain("export function plantonistaAccessCoversShiftSql");
    expect(clinical).toContain(
      "export function plantonistaQualificationMatchesContextSql",
    );
  });

  it("21. falha de DB não vira lista vazia", async () => {
    const db = {
      execute: async () => {
        throw new Error("connection reset");
      },
    };
    await expect(
      listClinicallyEligibleOfferRecipients(db, {
        shiftId: 1,
        institutionId: 1,
        excludeProfessionalId: 9,
        excludeUserId: 8,
      }),
    ).rejects.toThrow("connection reset");
  });

  it("23. teto não trunca silenciosamente", async () => {
    const overflowing = Array.from(
      { length: ELIGIBLE_OFFER_RECIPIENT_HARD_LIMIT + 1 },
      (_, index) =>
        row({
          professionalId: index + 1,
          displayName: `Destinatario ${String(index).padStart(3, "0")}`,
          medicalSpecialtyName: "Clínica Médica",
        }),
    );
    await expect(
      listClinicallyEligibleOfferRecipients(
        { execute: async () => overflowing },
        {
          shiftId: 1,
          institutionId: 1,
          excludeProfessionalId: 9,
          excludeUserId: 8,
        },
      ),
    ).rejects.toBeInstanceOf(EligibleOfferRecipientLimitExceededError);

    const exact = overflowing.slice(0, ELIGIBLE_OFFER_RECIPIENT_HARD_LIMIT);
    const listed = await listClinicallyEligibleOfferRecipients(
      { execute: async () => exact },
      {
        shiftId: 1,
        institutionId: 1,
        excludeProfessionalId: 9,
        excludeUserId: 8,
      },
    );
    expect(listed.recipients).toHaveLength(ELIGIBLE_OFFER_RECIPIENT_HARD_LIMIT);
    expect(listed.unresolvedHomonymGroups).toEqual([]);
  });

  it("helper: lista vazia é sucesso, não erro", async () => {
    await expect(
      listClinicallyEligibleOfferRecipients(
        { execute: async () => [] },
        {
          shiftId: 1,
          institutionId: 1,
          excludeProfessionalId: 9,
          excludeUserId: 8,
        },
      ),
    ).resolves.toEqual({ recipients: [], unresolvedHomonymGroups: [] });
  });
});

describe("desambiguação de destinatários", () => {
  it("1. nomes únicos → response mínimo, sem qualification", () => {
    const listed = projectEligibleOfferRecipients([
      row({
        professionalId: 3,
        displayName: "Bruno Lima",
        medicalSpecialtyName: "Clínica Médica",
      }),
      row({
        professionalId: 1,
        displayName: "Ana Costa",
        medicalSpecialtyName: "Anestesiologia",
      }),
    ]);
    expect(listed.unresolvedHomonymGroups).toEqual([]);
    expect(listed.recipients).toEqual([
      { professionalId: 1, displayName: "Ana Costa" },
      { professionalId: 3, displayName: "Bruno Lima" },
    ]);
    expect("qualification" in listed.recipients[0]!).toBe(false);
    expect("qualification" in listed.recipients[1]!).toBe(false);
  });

  it("2. dois nomes iguais + qualificações canônicas diferentes → distinguíveis", () => {
    const listed = projectEligibleOfferRecipients([
      row({
        professionalId: 4,
        displayName: "Ana Souza",
        medicalSpecialtyName: "Anestesiologia",
      }),
      row({
        professionalId: 2,
        displayName: "Ana Souza",
        medicalSpecialtyName: "Clínica Médica",
      }),
      row({
        professionalId: 3,
        displayName: "Bruno Lima",
        medicalSpecialtyName: "Clínica Médica",
      }),
    ]);
    expect(listed.unresolvedHomonymGroups).toEqual([]);
    expect(listed.recipients).toEqual([
      {
        professionalId: 4,
        displayName: "Ana Souza",
        qualification: "Anestesiologia",
      },
      {
        professionalId: 2,
        displayName: "Ana Souza",
        qualification: "Clínica Médica",
      },
      { professionalId: 3, displayName: "Bruno Lima" },
    ]);
  });

  it("3. dois nomes iguais + mesma qualificação → fail-closed, não selecionáveis", () => {
    const listed = projectEligibleOfferRecipients([
      row({
        professionalId: 10,
        displayName: "Ana Souza",
        medicalSpecialtyName: "Anestesiologia",
      }),
      row({
        professionalId: 11,
        displayName: "Ana Souza",
        medicalSpecialtyName: "Anestesiologia",
      }),
      row({
        professionalId: 3,
        displayName: "Bruno Lima",
        medicalSpecialtyName: "Clínica Médica",
      }),
    ]);
    expect(listed.recipients).toEqual([
      { professionalId: 3, displayName: "Bruno Lima" },
    ]);
    expect(listed.unresolvedHomonymGroups).toEqual([
      {
        code: UNRESOLVED_HOMONYM_CODE,
        displayName: "Ana Souza",
        qualification: "Anestesiologia",
        count: 2,
        reason: UNRESOLVED_HOMONYM_REASON,
      },
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/"professionalId":10/);
    expect(JSON.stringify(listed.unresolvedHomonymGroups)).not.toContain(
      "professionalId",
    );
  });

  it("4. três homônimos: um distinguível, dois iguais fail-closed", () => {
    const listed = projectEligibleOfferRecipients([
      row({
        professionalId: 1,
        displayName: "Ana Souza",
        medicalSpecialtyName: "Anestesiologia",
      }),
      row({
        professionalId: 2,
        displayName: "Ana Souza",
        medicalSpecialtyName: "Anestesiologia",
      }),
      row({
        professionalId: 3,
        displayName: "Ana Souza",
        medicalSpecialtyName: "Clínica Médica",
      }),
    ]);
    expect(listed.recipients).toEqual([
      {
        professionalId: 3,
        displayName: "Ana Souza",
        qualification: "Clínica Médica",
      },
    ]);
    expect(listed.unresolvedHomonymGroups).toEqual([
      {
        code: UNRESOLVED_HOMONYM_CODE,
        displayName: "Ana Souza",
        qualification: "Anestesiologia",
        count: 2,
        reason: UNRESOLVED_HOMONYM_REASON,
      },
    ]);
  });

  it("três homônimos com três qualificações distintas são todos selecionáveis", () => {
    const listed = projectEligibleOfferRecipients([
      row({
        professionalId: 1,
        displayName: "Ana Souza",
        medicalSpecialtyName: "Anestesiologia",
      }),
      row({
        professionalId: 2,
        displayName: "Ana Souza",
        medicalSpecialtyName: "Clínica Médica",
      }),
      row({
        professionalId: 3,
        displayName: "Ana Souza",
        operationalProfileCode: "MEDICO_GENERALISTA",
      }),
    ]);
    expect(listed.unresolvedHomonymGroups).toEqual([]);
    expect(listed.recipients).toHaveLength(3);
    expect(
      listed.recipients.map((item) => item.qualification).sort(),
    ).toEqual(["Anestesiologia", "Clínica Médica", "Médico generalista"]);
    for (const recipient of listed.recipients) {
      expect(recipient).toHaveProperty("qualification");
    }
  });

  it("grupo irresolvido expõe código e razão, sem id técnico", () => {
    const listed = projectEligibleOfferRecipients([
      row({
        professionalId: 10,
        displayName: "Ana Souza",
        medicalSpecialtyName: "Anestesiologia",
      }),
      row({
        professionalId: 11,
        displayName: "Ana Souza",
        medicalSpecialtyName: "Anestesiologia",
      }),
    ]);
    expect(listed.recipients).toEqual([]);
    expect(Object.keys(listed.unresolvedHomonymGroups[0]!).sort()).toEqual([
      "code",
      "count",
      "displayName",
      "qualification",
      "reason",
    ]);
    expect(listed.unresolvedHomonymGroups[0]).toMatchObject({
      code: UNRESOLVED_HOMONYM_CODE,
      reason: UNRESOLVED_HOMONYM_REASON,
      count: 2,
    });
  });

  it("5. maiúsculas e acentos caem no mesmo grupo de nome", () => {
    expect(normalizeRecipientIdentityText("Ana Souza")).toBe(
      normalizeRecipientIdentityText("ANA SOUZA"),
    );
    expect(normalizeRecipientIdentityText("Ana Souza")).toBe(
      normalizeRecipientIdentityText("Ána Souza"),
    );
    const listed = projectEligibleOfferRecipients([
      row({
        professionalId: 1,
        displayName: "Ana Souza",
        medicalSpecialtyName: "Anestesiologia",
      }),
      row({
        professionalId: 2,
        displayName: "ANA SOUZA",
        medicalSpecialtyName: "Anestesiologia",
      }),
      row({
        professionalId: 3,
        displayName: "Ána Souza",
        medicalSpecialtyName: "Clínica Médica",
      }),
    ]);
    expect(listed.recipients).toEqual([
      {
        professionalId: 3,
        displayName: "Ána Souza",
        qualification: "Clínica Médica",
      },
    ]);
    expect(listed.unresolvedHomonymGroups).toEqual([
      {
        code: UNRESOLVED_HOMONYM_CODE,
        displayName: "Ana Souza",
        qualification: "Anestesiologia",
        count: 2,
        reason: UNRESOLVED_HOMONYM_REASON,
      },
    ]);
  });

  it("6–7. discriminador nunca inclui PII; professionalId não vira label", () => {
    const listed = projectEligibleOfferRecipients([
      row({
        professionalId: 4,
        displayName: "Ana Souza",
        medicalSpecialtyName: "Anestesiologia",
      }),
      row({
        professionalId: 2,
        displayName: "Ana Souza",
        medicalSpecialtyName: "Clínica Médica",
      }),
    ]);
    const payload = JSON.stringify(listed);
    expect(payload).not.toMatch(/@/);
    expect(payload).not.toContain("email");
    expect(payload).not.toContain("phone");
    expect(payload).not.toMatch(/cpf/i);
    expect(payload).not.toMatch(/"userId"/);
    for (const recipient of listed.recipients) {
      expect(Object.keys(recipient).sort()).toEqual([
        "displayName",
        "professionalId",
        "qualification",
      ]);
      expect(recipient.displayName).not.toMatch(String(recipient.professionalId));
    }
  });

  it("8. ordenação determinística por nome, qualificação e professionalId", () => {
    const listed = projectEligibleOfferRecipients([
      row({
        professionalId: 9,
        displayName: "Carlos Recip",
        medicalSpecialtyName: "Clínica Médica",
      }),
      row({
        professionalId: 8,
        displayName: "Ana Recip",
        medicalSpecialtyName: "Anestesiologia",
      }),
      row({
        professionalId: 7,
        displayName: "Ana Recip",
        medicalSpecialtyName: "Clínica Médica",
      }),
      row({
        professionalId: 6,
        displayName: "Bruno Recip",
        medicalSpecialtyName: "Clínica Médica",
      }),
    ]);
    expect(listed.recipients.map((item) => item.professionalId)).toEqual([
      8, 7, 6, 9,
    ]);
  });

  it("qualificação canônica usa catálogo/perfil, não o rótulo legado", () => {
    const listed = projectEligibleOfferRecipients([
      row({
        professionalId: 1,
        displayName: "Ana Souza",
        medicalSpecialtyName: "Anestesiologia",
      }),
      row({
        professionalId: 2,
        displayName: "Ana Souza",
        operationalProfileCode: "MEDICO_GENERALISTA",
      }),
    ]);
    expect(listed.recipients.map((item) => item.qualification)).toEqual([
      "Anestesiologia",
      "Médico generalista",
    ]);
  });
});
