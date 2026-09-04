import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ELIGIBLE_OFFER_RECIPIENT_HARD_LIMIT,
  EligibleOfferRecipientLimitExceededError,
  listClinicallyEligibleOfferRecipients,
} from "../server/swap-eligible-recipients";

function read(path: string): string {
  return readFileSync(path, "utf8");
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
    expect(slice).not.toContain("qualification");
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
      (_, index) => ({
        professionalId: index + 1,
        displayName: `Destinatario ${String(index).padStart(3, "0")}`,
        specialty: "Clínica Médica",
      }),
    );
    const db = {
      execute: async () => overflowing,
    };
    await expect(
      listClinicallyEligibleOfferRecipients(db, {
        shiftId: 1,
        institutionId: 1,
        excludeProfessionalId: 9,
        excludeUserId: 8,
      }),
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
    expect(listed).toHaveLength(ELIGIBLE_OFFER_RECIPIENT_HARD_LIMIT);
  });

  it("helper: lista vazia é sucesso, não erro; homônimo ganha qualificação pública", async () => {
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
    ).resolves.toEqual([]);

    const rows = [
      { professionalId: 4, displayName: "Ana Souza", specialty: "Anestesiologia" },
      { professionalId: 2, displayName: "Ana Souza", specialty: "Clínica Médica" },
      { professionalId: 3, displayName: "Bruno Lima", specialty: "Clínica Médica" },
    ];
    const listed = await listClinicallyEligibleOfferRecipients(
      { execute: async () => rows },
      {
        shiftId: 1,
        institutionId: 1,
        excludeProfessionalId: 9,
        excludeUserId: 8,
      },
    );
    expect(listed.map((row) => row.professionalId)).toEqual([2, 4, 3]);
    expect(listed[0]).toEqual({
      professionalId: 2,
      displayName: "Ana Souza",
      qualification: "Clínica Médica",
    });
    expect(listed[1]?.qualification).toBe("Anestesiologia");
    expect(listed[2]?.qualification).toBe("Clínica Médica");
  });
});
