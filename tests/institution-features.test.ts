import { describe, expect, it } from "vitest";
import {
  INSTITUTION_FEATURE_CODES,
  ROSTER_READ_POLICIES,
} from "../lib/institution-features";
import { resolveRosterReadPolicyFromEntitlement } from "../server/institution-features";

describe("política de leitura ampliada entre escalas", () => {
  it("mantém a funcionalidade do produto-base quando a instituição ainda não possui linha", () => {
    expect(resolveRosterReadPolicyFromEntitlement(null, 1)).toBe(
      ROSTER_READ_POLICIES.institutionWide,
    );
  });

  it("abre somente com feature exata, ativa e da mesma instituição", () => {
    const entitlement = {
      institutionId: 1,
      featureCode: INSTITUTION_FEATURE_CODES.crossScheduleRosterView,
      enabled: true,
    };
    expect(resolveRosterReadPolicyFromEntitlement(entitlement, 1)).toBe(
      ROSTER_READ_POLICIES.institutionWide,
    );
    expect(resolveRosterReadPolicyFromEntitlement(entitlement, 2)).toBe(
      ROSTER_READ_POLICIES.authorizedContextsOnly,
    );
    expect(
      resolveRosterReadPolicyFromEntitlement(
        { ...entitlement, featureCode: "UNKNOWN_FEATURE" },
        1,
      ),
    ).toBe(ROSTER_READ_POLICIES.authorizedContextsOnly);
    expect(
      resolveRosterReadPolicyFromEntitlement(
        { ...entitlement, enabled: false },
        1,
      ),
    ).toBe(ROSTER_READ_POLICIES.authorizedContextsOnly);
  });
});
