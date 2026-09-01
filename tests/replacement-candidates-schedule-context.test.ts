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
  it("ignora especialidade, perfil e aliases clínicos em contexto classificado", () => {
    const reader = replacementReaderSource();
    expect(reader).not.toContain("specialtiesConflict");
    expect(reader).not.toContain("medical_specialties");
    expect(reader).not.toContain("medical_specialty_id");
    expect(reader).not.toContain("operational_profile_code");
    expect(reader).not.toContain("schedule_context_allowed_qualifications");
    expect(reader).not.toContain("p.specialty");
    expect(reader).not.toContain("qualificationMatches");
  });

  it("preserva bloqueio sem contexto, tenant, ACL setorial e conflito de horário", () => {
    const reader = replacementReaderSource();
    const screen = readFileSync("app/nominate-replacement.tsx", "utf8");

    expect(reader).toContain("confirmationToken: z.string().uuid()");
    expect(reader).toContain("current.shift.scheduleContextId === null");
    expect(reader).toContain(
      "Plantão sem escala operacional classificada; solicite regularização ao gestor.",
    );
    expect(reader).toContain("sc.id = ${current.shift.scheduleContextId}");
    expect(reader).toContain(
      "sc.institution_id = ${current.shift.institutionId}",
    );
    expect(reader).toContain("sc.hospital_id = ${current.shift.hospitalId}");
    expect(reader).toContain("sc.sector_id = ${current.shift.sectorId}");
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
