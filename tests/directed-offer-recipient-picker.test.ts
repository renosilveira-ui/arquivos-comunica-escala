import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyExplicitFromShiftChange,
  applyExplicitOperationTypeChange,
  directedOfferRecipientCopy,
  directedOfferRecipientLabel,
  isDirectedAudienceStale,
  isSelectableDirectedRecipient,
  parseEligibleOfferRecipientList,
  reduceDirectedOfferAudience,
  resolveDirectedOfferWrite,
  unresolvedHomonymGroupLabel,
  type DirectedOfferAudience,
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

describe("audiência dirigida não amplia para aberta em silêncio", () => {
  const directedB: DirectedOfferAudience = {
    kind: "directed",
    professionalId: 11,
  };
  const listWithB = parseEligibleOfferRecipientList(validList);
  const listWithoutB = parseEligibleOfferRecipientList({
    recipients: [
      {
        professionalId: 12,
        displayName: "Bruno Lima",
        qualification: "Anestesiologia",
      },
    ],
    unresolvedHomonymGroups: [],
  });

  it("1. directed B + B permanece elegível → envia B", () => {
    const audience = reduceDirectedOfferAudience(directedB, {
      type: "RECIPIENT_LIST_REFRESH",
      list: listWithB,
    });
    expect(audience).toEqual(directedB);
    expect(resolveDirectedOfferWrite("TRANSFER", audience, listWithB)).toEqual({
      ok: true,
      toProfessionalId: 11,
    });
  });

  it("2. directed B + refetch remove B → NÃO vira open", () => {
    const audience = reduceDirectedOfferAudience(directedB, {
      type: "RECIPIENT_LIST_REFRESH",
      list: listWithoutB,
    });
    expect(audience).toEqual(directedB);
    expect(audience.kind).toBe("directed");
    expect(isDirectedAudienceStale(audience, listWithoutB)).toBe(true);
  });

  it("3. stale B + submit → bloqueado com staleDirected", () => {
    const audience = reduceDirectedOfferAudience(directedB, {
      type: "RECIPIENT_LIST_REFRESH",
      list: listWithoutB,
    });
    expect(resolveDirectedOfferWrite("TRANSFER", audience, listWithoutB)).toEqual({
      ok: false,
      message: directedOfferRecipientCopy.staleDirected,
    });
  });

  it("4. stale B + usuário toca Oferta aberta → aí sim open", () => {
    const stale = reduceDirectedOfferAudience(directedB, {
      type: "RECIPIENT_LIST_REFRESH",
      list: listWithoutB,
    });
    const opened = reduceDirectedOfferAudience(stale, { type: "SELECT_OPEN" });
    expect(opened).toEqual({ kind: "open" });
    expect(resolveDirectedOfferWrite("TRANSFER", opened, listWithoutB)).toEqual({
      ok: true,
    });
  });

  it("stale B + usuário escolhe outro profissional → directed C", () => {
    const stale = reduceDirectedOfferAudience(directedB, {
      type: "RECIPIENT_LIST_REFRESH",
      list: listWithoutB,
    });
    const next = reduceDirectedOfferAudience(stale, {
      type: "SELECT_RECIPIENT",
      professionalId: 12,
    });
    expect(next).toEqual({ kind: "directed", professionalId: 12 });
    expect(resolveDirectedOfferWrite("TRANSFER", next, listWithoutB)).toEqual({
      ok: true,
      toProfessionalId: 12,
    });
  });

  it("5. mudança explícita de selectedFrom → open", () => {
    expect(applyExplicitFromShiftChange(directedB, 10, 20)).toEqual({
      kind: "open",
    });
  });

  it("re-tocar o mesmo plantão de origem preserva directed B", () => {
    expect(applyExplicitFromShiftChange(directedB, 10, 10)).toEqual(directedB);
  });

  it("6. mudança explícita de tipo → open", () => {
    expect(
      applyExplicitOperationTypeChange(directedB, "TRANSFER", "SWAP"),
    ).toEqual({ kind: "open" });
    expect(
      applyExplicitOperationTypeChange(directedB, "SWAP", "TRANSFER"),
    ).toEqual({ kind: "open" });
  });

  it("re-tocar o mesmo tipo de operação preserva directed B", () => {
    expect(
      applyExplicitOperationTypeChange(directedB, "TRANSFER", "TRANSFER"),
    ).toEqual(directedB);
  });

  it("7. erro/refetch/loading da query nunca converte directed → open", () => {
    expect(
      reduceDirectedOfferAudience(directedB, { type: "QUERY_LOADING" }),
    ).toEqual(directedB);
    expect(
      reduceDirectedOfferAudience(directedB, { type: "QUERY_ERROR" }),
    ).toEqual(directedB);
    expect(
      reduceDirectedOfferAudience(directedB, { type: "QUERY_DISABLED" }),
    ).toEqual(directedB);
  });

  it("8. perda temporária de recipientList durante fetch nunca converte directed → open", () => {
    const duringFetch = reduceDirectedOfferAudience(directedB, {
      type: "RECIPIENT_LIST_REFRESH",
      list: null,
    });
    expect(duringFetch).toEqual(directedB);
    expect(isDirectedAudienceStale(duringFetch, null)).toBe(false);
    expect(resolveDirectedOfferWrite("TRANSFER", duringFetch, null)).toEqual({
      ok: false,
      message: directedOfferRecipientCopy.waitingList,
    });
  });

  it("9. recuperação da lista contendo B preserva selection", () => {
    const duringFetch = reduceDirectedOfferAudience(directedB, {
      type: "RECIPIENT_LIST_REFRESH",
      list: null,
    });
    const recovered = reduceDirectedOfferAudience(duringFetch, {
      type: "RECIPIENT_LIST_REFRESH",
      list: listWithB,
    });
    expect(recovered).toEqual(directedB);
    expect(resolveDirectedOfferWrite("TRANSFER", recovered, listWithB)).toEqual({
      ok: true,
      toProfessionalId: 11,
    });
  });

  it("10. SWAP continua sem toProfessionalId", () => {
    expect(resolveDirectedOfferWrite("SWAP", directedB, listWithB)).toEqual({
      ok: true,
    });
    expect(
      resolveDirectedOfferWrite("SWAP", directedB, listWithB),
    ).not.toHaveProperty("toProfessionalId");
  });
});

describe("wiring da tela de oferta", () => {
  const screen = readFileSync("app/request-swap.tsx", "utf8");
  const picker = readFileSync(
    "components/swaps/DirectedOfferRecipientPicker.tsx",
    "utf8",
  );
  const helper = readFileSync("lib/directed-offer-recipient-picker.ts", "utf8");

  function extractUseEffectBodies(source: string): string[] {
    const bodies: string[] = [];
    const needle = "useEffect(";
    let from = 0;
    while (from < source.length) {
      const start = source.indexOf(needle, from);
      if (start < 0) break;
      const open = source.indexOf("{", start);
      if (open < 0) break;
      let depth = 0;
      let end = -1;
      for (let i = open; i < source.length; i++) {
        const ch = source[i];
        if (ch === "{") depth += 1;
        else if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end < 0) break;
      bodies.push(source.slice(open, end + 1));
      from = end + 1;
    }
    return bodies;
  }

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

  it("effect não converte directed → open por query/recipientList", () => {
    const effectBodies = extractUseEffectBodies(screen);
    expect(effectBodies.length).toBeGreaterThan(0);
    for (const body of effectBodies) {
      expect(body).not.toContain("setAudience");
      expect(body).not.toContain("recipientList");
      expect(body).not.toContain("recipientsQueryEnabled");
      expect(body).not.toMatch(/kind:\s*"open"/);
    }
    expect(screen).not.toMatch(/setAudience\(\{\s*kind:\s*"open"\s*\}\)/);
    expect(screen).not.toContain("if (!recipientsQueryEnabled)");
    expect(screen).not.toMatch(
      /isSelectableDirectedRecipient\(\s*audience\.professionalId/,
    );
    expect(screen).toContain("applyExplicitFromShiftChange");
    expect(screen).toContain("applyExplicitOperationTypeChange");
    expect(screen).toContain("handleSelectOfferType");
    expect(helper).toContain("QUERY_DISABLED");
    expect(helper).toContain("RECIPIENT_LIST_REFRESH");
    expect(picker).toContain("isDirectedAudienceStale");
    expect(picker).toContain("directedOfferRecipientCopy.staleDirected");
  });
});
