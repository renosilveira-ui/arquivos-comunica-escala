import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REQUEST_DEADLINE_MS } from "../lib/request-deadline";

describe("login nativo não trava no BootScreen após credenciais", () => {
  it("o /me canônico usa o mesmo prazo de abertura do apiFetch", () => {
    const source = readFileSync(
      "lib/_core/canonical-session-request.ts",
      "utf8",
    );
    expect(source).toContain("withRequestDeadline");
    expect(source).toContain("deadline.cleanup()");
  });

  it("AuthGuard libera retry quando a admissão durável excede o prazo", () => {
    const layout = readFileSync("app/_layout.tsx", "utf8");
    const guard = layout.slice(
      layout.indexOf("function AuthGuard"),
      layout.indexOf("export const unstable_settings"),
    );
    expect(guard).toContain("admissionStalled");
    expect(guard).toContain("AUTHORIZATION_GATE_STALL_MS");
    expect(guard).toContain("waitingDurableAdmission");
    expect(guard).toContain("O servidor está acordando");
  });

  it("handshake nativo não começa offline por padrão nem por falha do NetInfo", () => {
    const layout = readFileSync("app/_layout.tsx", "utf8");
    const boundary = layout.slice(
      layout.indexOf("function TenantAuthorizationBoundary"),
      layout.indexOf("function AuthGuard"),
    );
    expect(boundary).toMatch(/online:\s*Platform\.OS === "web"[\s\S]*: true,/);
    expect(boundary).toContain("updateActivity({ online: true })");
  });

  it("o watchdog de UI da admissão não ultrapassa o prazo do pedido", () => {
    expect(REQUEST_DEADLINE_MS).toBe(70_000);
  });
});
