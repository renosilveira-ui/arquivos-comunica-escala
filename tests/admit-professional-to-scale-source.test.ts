import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("scripts/admit-professional-to-scale.ts", "utf8");

describe("admit-professional-to-scale", () => {
  it("grava vínculo e acesso setorial só com --apply, em transação UTC", () => {
    expect(source).toContain("--apply");
    expect(source).toContain("--email");
    expect(source).toContain("--hospital");
    expect(source).toContain("--sector");
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

  it("recusa médico preso a outra casa e não gera código de convite", () => {
    expect(source).toContain("já tem vínculo ativo em outra instituição");
    expect(source).toContain("created_by_user_id");
    expect(source).not.toContain("generateScheduleInviteCode");
    expect(source).not.toContain("INSERT INTO schedule_invites");
  });
});
