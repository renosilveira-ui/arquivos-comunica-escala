import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("login após cookie/token não devolve formulário vazio", () => {
  it("AuthGuard trata sessão durável sem /me como retry, não como logout", () => {
    const layout = readFileSync("app/_layout.tsx", "utf8");
    const guard = layout.slice(
      layout.indexOf("function AuthGuard"),
      layout.indexOf("export const unstable_settings"),
    );
    expect(guard).toContain("sessionValidation.durableSession");
    expect(guard).toContain("O servidor está acordando");
    expect(guard.indexOf("durableSession")).toBeLessThan(
      guard.indexOf('pathname === "/login"'),
    );
  });

  it("tela de login sai do formulário quando a admissão ficou pendente", () => {
    const login = readFileSync("app/login.tsx", "utf8");
    expect(login).toContain("result.admissionPending");
    expect(login).toContain("router.replace");
  });

  it("admissão canônica marca /me indisponível como pendente, não como login inválido", () => {
    const auth = readFileSync("hooks/use-auth.ts", "utf8");
    expect(auth).toContain("admissionPending");
    expect(auth).toContain("durableSession: true");
    expect(auth).toContain("getPersistedUserId");
  });
});
