import { describe, expect, it } from "vitest";
import { operationalEvents, professionalInstitutions } from "../drizzle/schema";

describe("schema de ACCESS_UPDATED", () => {
  it("expõe revisão monotônica no vínculo e hash ID-only opcional no fato", () => {
    expect(professionalInstitutions.operationalRevision.name).toBe(
      "operational_revision",
    );
    expect(professionalInstitutions.operationalRevision.notNull).toBe(true);
    expect(operationalEvents.accessStateHash.name).toBe("access_state_hash");
    expect(operationalEvents.accessStateHash.notNull).toBe(false);
  });
});
