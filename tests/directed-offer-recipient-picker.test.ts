import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  directedOfferRecipientCopy,
  directedOfferRecipientLabel,
  isSelectableDirectedRecipient,
  parseEligibleOfferRecipientList,
  resolveDirectedOfferWrite,
  unresolvedHomonymGroupLabel,
} from "../lib/directed-offer-recipient-picker";

const validList = {
  recipients: [
    { professionalId: 11, displayName: "Ana Souza" },
    {
      professionalId: 12,
      displayName: "Bruno Lima",
      qualification: "Anestesiologia",
    },
  ],
  unresolvedHomonymGroups: [
    {
      code: "UNRESOLVED_HOMONYM",
      displayName: "Carlos Dias",
      qualification: "Clínica Médica",
      count: 2,
      reason:
        "Há mais de um profissional com este nome e a mesma qualificação. Não é possível direcionar a oferta com segurança.",
    },
  ],
};

describe("parseEligibleOfferRecipientList", () => {
  it("não trata array nu nem objeto incompleto como lista", () => {
    expect(parseEligibleOfferRecipientList([{ professionalId: 1 }])).toBeNull();
    expect(parseEligibleOfferRecipientList({ recipients: [] })).toBeNull();
    expect(
      parseEligibleOfferRecipientList({ unresolvedHomonymGroups: [] }),
    ).toBeNull();
    expect(parseEligibleOfferRecipientList(null)).toBeNull();
    expect(parseEligibleOfferRecipientList(undefined)).toBeNull();
  });

  it("projeta recipients e ignora professionalId em grupo irresolvido", () => {
    const parsed = parseEligibleOfferRecipientList({
      ...validList,
      unresolvedHomonymGroups: [
        {
          ...validList.unresolvedHomonymGroups[0],
          professionalId: 99,
        },
      ],
    });
    expect(parsed?.recipients).toEqual(validList.recipients);
    expect(parsed?.unresolvedHomonymGroups[0]).not.toHaveProperty(
      "professionalId",
    );
    expect(JSON.stringify(parsed)).not.toMatch(/"professionalId":99/);
  });
});

describe("rótulos e escrita da oferta direcionada", () => {
  it("nome único não leva qualificação; homônimo distinto leva", () => {
    expect(
      directedOfferRecipientLabel({
        professionalId: 1,
        displayName: "Ana Souza",
      }),
    ).toBe("Ana Souza");
    expect(
      directedOfferRecipientLabel({
        professionalId: 2,
        displayName: "Ana Souza",
        qualification: "Anestesiologia",
      }),
    ).toBe("Ana Souza — Anestesiologia");
    expect(
      unresolvedHomonymGroupLabel({
        code: "UNRESOLVED_HOMONYM",
        displayName: "Carlos Dias",
        qualification: "Clínica Médica",
        count: 2,
        reason: "x",
      }),
    ).toBe("Carlos Dias — Clínica Médica");
  });

  it("SWAP nunca envia toProfessionalId, mesmo com audiência dirigida residual", () => {
    const parsed = parseEligibleOfferRecipientList(validList);
    expect(
      resolveDirectedOfferWrite(
        "SWAP",
        { kind: "directed", professionalId: 11 },
        parsed,
      ),
    ).toEqual({ ok: true });
  });

  it("TRANSFER aberto omite destinatário; dirigido só se ainda estiver em recipients", () => {
    const parsed = parseEligibleOfferRecipientList(validList);
    expect(
      resolveDirectedOfferWrite("TRANSFER", { kind: "open" }, parsed),
    ).toEqual({ ok: true });
    expect(
      resolveDirectedOfferWrite(
        "TRANSFER",
        { kind: "directed", professionalId: 11 },
        parsed,
      ),
    ).toEqual({ ok: true, toProfessionalId: 11 });
    expect(
      resolveDirectedOfferWrite(
        "TRANSFER",
        { kind: "directed", professionalId: 99 },
        parsed,
      ),
    ).toEqual({
      ok: false,
      message: directedOfferRecipientCopy.staleDirected,
    });
    expect(isSelectableDirectedRecipient(11, parsed)).toBe(true);
    expect(isSelectableDirectedRecipient(99, parsed)).toBe(false);
  });

  it("dirigido sem lista parseada não vira oferta aberta em silêncio", () => {
    expect(
      resolveDirectedOfferWrite(
        "TRANSFER",
        { kind: "directed", professionalId: 11 },
        null,
      ),
    ).toEqual({
      ok: false,
      message: directedOfferRecipientCopy.waitingList,
    });
  });
});

describe("wiring da tela de oferta", () => {
  const screen = readFileSync("app/request-swap.tsx", "utf8");
  const picker = readFileSync(
    "components/swaps/DirectedOfferRecipientPicker.tsx",
    "utf8",
  );
  const helper = readFileSync("lib/directed-offer-recipient-picker.ts", "utf8");

  it("REPASSE consulta o read model canônico; SWAP não", () => {
    expect(screen).toContain("trpc.swaps.listEligibleRecipients.useQuery");
    expect(screen).toContain("type === \"TRANSFER\" && fromShiftId > 0");
    expect(screen).toContain("type === \"TRANSFER\" && selectedFrom");
    expect(screen).toContain("DirectedOfferRecipientPicker");
    const querySlice = screen.slice(
      screen.indexOf("const recipientsQuery ="),
      screen.indexOf("const recipientList ="),
    );
    expect(querySlice).toContain("fromShiftInstanceId: fromShiftId");
    expect(querySlice).not.toMatch(/institutionId|hospitalId|sectorId|qualification|toProfessionalId|userId/);
  });

  it("não trata a resposta como array nem usa listas de vacância/papel", () => {
    expect(screen).not.toMatch(/recipientsQuery\.data\.map/);
    expect(screen).not.toMatch(/listEligibleRecipients[\s\S]{0,200}\.data\.map/);
    expect(screen).not.toContain("listAssignableForShift");
    expect(screen).not.toContain("eligibleProfessionalUserIdsForShift");
    expect(screen).not.toContain("manager_scope");
    expect(helper).toContain("Array.isArray(data)");
    expect(helper).toContain("return null");
  });

  it("homônimo irresolvido não é opção; professionalId não vira label", () => {
    expect(picker).toContain("unresolvedHomonymGroups");
    expect(picker).toContain("directedOfferRecipientCopy.unresolvedHeading");
    expect(picker).toContain("directedOfferRecipientLabel");
    expect(picker).not.toMatch(/String\(.*professionalId/);
    expect(picker).not.toContain("email");
    expect(picker).not.toContain("userId");
    expect(picker).toContain("QueryErrorState");
    expect(picker).toContain("resolveOperationalListState");
    expect(picker).toContain("minHeight: 44");
  });

  it("erro de turno/profissional usa QueryErrorState com retry, não empty state", () => {
    expect(screen).toContain("<QueryErrorState");
    expect(screen).toContain("refetchProfessional");
    expect(screen).toContain("refetchShifts");
    expect(screen).toContain("resolveDirectedOfferWrite");
    expect(screen).toContain("type !== \"SWAP\" && directed.toProfessionalId");
  });
});
