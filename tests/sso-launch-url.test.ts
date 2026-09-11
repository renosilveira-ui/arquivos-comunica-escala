import { describe, expect, it } from "vitest";
import {
  isAllowedSsoLaunchUrl,
  isAllowedSsoTargetUrl,
} from "../lib/sso-launch-url";

// A origem real do staging: tem hífen e ponto, que é justamente o que uma
// cerca mal escrita rejeitaria junto com o ataque.
const BASE = "https://escalas-staging.onrender.com";

describe("sso-launch-url", () => {
  it("aceita a URL do contrato", () => {
    expect(isAllowedSsoLaunchUrl(`${BASE}/api/sso/launch?code=abc123`, BASE)).toBe(
      true,
    );
    // Caminho não é fixado de propósito: se a rota mudar, o SSO continua.
    expect(isAllowedSsoLaunchUrl(`${BASE}/api/sso/v2/launch?code=x`, BASE)).toBe(
      true,
    );
    // Base com barra sobrando não muda a decisão.
    expect(isAllowedSsoLaunchUrl(`${BASE}/api/sso/launch`, `${BASE}/`)).toBe(
      true,
    );
  });

  it("recusa host que só PARECE o nosso", () => {
    // Sem a barra no fim da base, estes três passariam por prefixo de texto.
    expect(isAllowedSsoLaunchUrl(`${BASE}.evil.invalid/x`, BASE)).toBe(false);
    expect(isAllowedSsoLaunchUrl(`${BASE}@evil.invalid/x`, BASE)).toBe(false);
    expect(isAllowedSsoLaunchUrl(`${BASE}-evil.invalid/x`, BASE)).toBe(false);
  });

  it("recusa outro esquema e outro host", () => {
    expect(isAllowedSsoLaunchUrl("https://evil.invalid/api/sso/launch", BASE)).toBe(
      false,
    );
    expect(isAllowedSsoLaunchUrl(`http://escalas-staging.onrender.com/x`, BASE)).toBe(
      false,
    );
    expect(isAllowedSsoLaunchUrl("javascript:alert(1)", BASE)).toBe(false);
    expect(isAllowedSsoLaunchUrl("data:text/html,<script>", BASE)).toBe(false);
    expect(isAllowedSsoLaunchUrl("escalas://launch", BASE)).toBe(false);
    expect(isAllowedSsoLaunchUrl("/api/sso/launch", BASE)).toBe(false);
  });

  it("recusa o que parsers leem de formas diferentes", () => {
    expect(isAllowedSsoLaunchUrl(`${BASE}\\@evil.invalid/x`, BASE)).toBe(false);
    expect(isAllowedSsoLaunchUrl(`${BASE}/x\u0000.evil.invalid`, BASE)).toBe(
      false,
    );
    expect(isAllowedSsoLaunchUrl(`${BASE}/x y`, BASE)).toBe(false);
    expect(isAllowedSsoLaunchUrl(` ${BASE}/x`, BASE)).toBe(false);
  });

  it("recusa entrada que não é string, e base inutilizável", () => {
    expect(isAllowedSsoLaunchUrl(undefined, BASE)).toBe(false);
    expect(isAllowedSsoLaunchUrl(null, BASE)).toBe(false);
    expect(isAllowedSsoLaunchUrl(42, BASE)).toBe(false);
    expect(isAllowedSsoLaunchUrl("", BASE)).toBe(false);
    // Base vazia (web) ou relativa não dá o que comparar: nada passa.
    expect(isAllowedSsoLaunchUrl(`${BASE}/x`, "")).toBe(false);
    expect(isAllowedSsoLaunchUrl(`${BASE}/x`, "/api")).toBe(false);
    expect(isAllowedSsoLaunchUrl(`${BASE}/x`, `${BASE}/api`)).toBe(false);
  });

  it("alvo do form POST na web exige https absoluto", () => {
    expect(isAllowedSsoTargetUrl("https://comunicamais-staging.onrender.com/auth/sso/exchange")).toBe(
      true,
    );
    expect(isAllowedSsoTargetUrl("https://comunicamais-staging.onrender.com")).toBe(
      true,
    );
    // action="javascript:..." num form é execução de script, não navegação.
    expect(isAllowedSsoTargetUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedSsoTargetUrl("data:text/html,<script>")).toBe(false);
    expect(isAllowedSsoTargetUrl("http://comunicamais-staging.onrender.com/x")).toBe(
      false,
    );
    expect(isAllowedSsoTargetUrl("//evil.invalid/x")).toBe(false);
    expect(isAllowedSsoTargetUrl("/auth/sso/exchange")).toBe(false);
    expect(isAllowedSsoTargetUrl(undefined)).toBe(false);
  });
});
