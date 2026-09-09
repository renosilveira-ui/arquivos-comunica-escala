import { describe, expect, it } from "vitest";
import {
  assignmentLifecyclePushPresentation,
  dutyConfirmationPushPresentation,
  vacancyRequestPushPresentation,
  type CanonicalShiftPushContext,
} from "../server/contextual-push-presentation";

const context: CanonicalShiftPushContext = {
  hospitalName: "Hospital São Carlos",
  sectorName: "Sala de Recuperação",
  startAt: new Date("2032-09-12T10:00:00.000Z"),
  endAt: new Date("2032-09-12T16:00:00.000Z"),
};

describe("apresentação contextual de push", () => {
  it.each([
    [
      "CONFIRMATION_REQUEST",
      "Confirme seu plantão de 12/09/2032, 07:00–13:00.",
    ],
    [
      "NOMINATION_REQUEST",
      "Há uma nova oferta direcionada a você para 12/09/2032, 07:00–13:00.",
    ],
    [
      "REPLACEMENT_ACCEPTED_NOTICE",
      "O substituto aceitou o plantão de 12/09/2032, 07:00–13:00.",
    ],
    [
      "REPLACEMENT_DECLINED_NOTICE",
      "O substituto não aceitou o plantão de 12/09/2032, 07:00–13:00.",
    ],
    ["SSO_READY", "Seu plantão de 12/09/2032, 07:00–13:00 começou."],
    [
      "MANAGER_ESCALATION",
      "Uma confirmação do plantão de 12/09/2032, 07:00–13:00 requer verificação do gestor.",
    ],
  ] as const)("renderiza %s sem dados pessoais", (purpose, body) => {
    expect(dutyConfirmationPushPresentation(purpose, context)).toEqual({
      title: "Hospital São Carlos · Sala de Recuperação",
      body,
    });
  });

  it.each([
    [
      "MANAGER_ACTION_REQUIRED",
      "Há uma nova solicitação para o plantão de 12/09/2032, 07:00–13:00.",
    ],
    [
      "REQUEST_APPROVED",
      "Sua solicitação para o plantão de 12/09/2032, 07:00–13:00 foi aprovada.",
    ],
    [
      "REQUEST_REJECTED",
      "Sua solicitação para o plantão de 12/09/2032, 07:00–13:00 não foi aprovada.",
    ],
  ] as const)("renderiza vaga %s com o mesmo contrato", (purpose, body) => {
    expect(vacancyRequestPushPresentation(purpose, context)).toEqual({
      title: "Hospital São Carlos · Sala de Recuperação",
      body,
    });
  });

  it.each([
    ["ASSIGNED", "Você foi escalado para o plantão de 12/09/2032, 07:00–13:00."],
    [
      "UNASSIGNED",
      "Sua alocação no plantão de 12/09/2032, 07:00–13:00 foi retirada.",
    ],
  ] as const)("renderiza alocação %s com o mesmo contrato", (purpose, body) => {
    expect(assignmentLifecyclePushPresentation(purpose, context)).toEqual({
      title: "Hospital São Carlos · Sala de Recuperação",
      body,
    });
  });

  it("mantém fallback neutro quando o contexto canônico não tem nome útil", () => {
    expect(
      dutyConfirmationPushPresentation("CONFIRMATION_REQUEST", {
        ...context,
        hospitalName: " \n\t ",
      }),
    ).toBeNull();
    expect(
      vacancyRequestPushPresentation("REQUEST_APPROVED", {
        ...context,
        sectorName: "",
      }),
    ).toBeNull();
    expect(
      assignmentLifecyclePushPresentation("ASSIGNED", {
        ...context,
        sectorName: "\u200b",
      }),
    ).toBeNull();
  });

  it("normaliza controles e limita nomes administrativos excessivos", () => {
    const result = dutyConfirmationPushPresentation("CONFIRMATION_REQUEST", {
      ...context,
      hospitalName: `  Hospital\n\u202e${"A".repeat(100)}  `,
      sectorName: "Sala\tde\u200bRecuperação",
    });
    expect(result?.title).toBe(
      `Hospital ${"A".repeat(71)} · Sala de Recuperação`,
    );
    expect(result?.title).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });
});
