import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("scripts/admit-professional-to-scale.ts", "utf8");

describe("admit-professional-to-scale", () => {
  it("grava vínculo e acesso setorial só com --apply, em transação UTC", () => {
    expect(source).toContain("--apply");
    expect(source).toContain("--email");
    expect(source).toContain("--hospital");
    expect(source).toContain("--sector");
    expect(source).toContain("Informe ao menos um --sector");
    expect(source).toContain('timezone: "Z"');
    expect(source).toContain("beginTransaction");
    expect(source).toContain("INSERT INTO professional_institutions");
    expect(source).toContain("INSERT INTO professional_access");
    expect(source).toContain("sector_id");
    expect(source).toContain("can_access");
    expect(source).toContain("já está nesta escala");
    expect(source).toContain("dry-run");
    expect(source).not.toContain("passwordHash");
  });

  it("é atalho excepcional de convite e ignora especialidade", () => {
    expect(source).toContain("A especialidade NÃO concede escala");
    expect(source).toContain("Não consulta especialidade / allowlist");
    expect(source).toContain("specialtyNotUsed");
    expect(source).toContain("bypass: \"invite\"");
    expect(source).not.toContain("qualificationMatches");
    expect(source).not.toContain("medical_specialty_id");
    expect(source).not.toContain("generateScheduleInviteCode");
    expect(source).not.toContain("INSERT INTO schedule_invites");
    expect(source).toContain("já tem vínculo ativo em outra instituição");
  });
});
