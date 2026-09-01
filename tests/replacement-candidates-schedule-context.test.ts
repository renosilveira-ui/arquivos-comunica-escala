import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function replacementReaderSource(): string {
  const source = readFileSync("server/confirmation-router.ts", "utf8");
  const start = source.indexOf("  listReplacementCandidates:");
  const end = source.indexOf("  getPending:", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("candidatos a substituição por scheduleContext canônico", () => {
  it("não decide candidatos por alias, perfil ou especialidade clínica", () => {
    const reader = replacementReaderSource();
    expect(reader).not.toContain("specialtiesConflict");
    expect(reader).not.toContain("medical_specialty_id");
    expect(reader).not.toContain("operational_profile_code");
    expect(reader).not.toContain("schedule_context_allowed_qualifications");
  });

  it("preserva tenant, identidade, ACL setorial e conflito de horário", () => {
    const reader = replacementReaderSource();
    const screen = readFileSync("app/nominate-replacement.tsx", "utf8");

    expect(reader).toContain("confirmationToken: z.string().uuid()");
    expect(reader).toContain("pi.user_id = p.user_id");
    expect(reader).toContain(
      "pi.institution_id = ${current.shift.institutionId}",
    );
    expect(reader).toContain("pa.can_access = true");
    expect(reader).toContain("sc.admission_policy = 'QUALIFICATION_ALLOWLIST'");
    expect(reader).toContain("pa.sector_id = ${current.shift.sectorId}");
    expect(reader).toContain(
      "sc.admission_policy <> 'QUALIFICATION_ALLOWLIST'",
    );
    expect(reader).toContain(
      "pa.sector_id IS NULL OR pa.sector_id = ${current.shift.sectorId}",
    );
    expect(reader).toContain("sc.active = true");
    expect(reader).toContain("sc.admission_policy = 'QUALIFICATION_ALLOWLIST'");
    expect(reader).not.toContain("schedule_context_allowed_qualifications");
    expect(reader).toContain("u.approval_status = 'APPROVED'");
    expect(reader).toContain("u.deleted_at IS NULL");
    expect(reader).toContain(
      "conflict_shift.start_at < ${current.shift.endAt}",
    );
    expect(reader).toContain(
      "conflict_shift.end_at > ${current.shift.startAt}",
    );
    expect(screen).toContain("{ confirmationToken: params.token }");
  });
});
