import { beforeEach, describe, expect, it } from "vitest";
import {
  buildHref,
  isSafeInternalRoute,
  rememberIntendedRoute,
  takeIntendedRoute,
} from "../lib/post-login-redirect";

beforeEach(() => {
  takeIntendedRoute();
});

describe("post-login-redirect", () => {
  it("aceita caminho interno, com e sem query", () => {
    expect(isSafeInternalRoute("/join-schedule")).toBe(true);
    expect(isSafeInternalRoute("/join-schedule?invite=ABC123")).toBe(true);
    expect(isSafeInternalRoute("/confirm-duty?token=x#topo")).toBe(true);
  });

  it("recusa o que sairia do app — isto é o open redirect", () => {
    // Quem monta o link (QR, e-mail, mensagem) não decide para onde a
    // pessoa vai parar depois de digitar a senha.
    expect(isSafeInternalRoute("https://exemplo.invalido/phish")).toBe(false);
    expect(isSafeInternalRoute("//exemplo.invalido/phish")).toBe(false);
    expect(isSafeInternalRoute("/\\exemplo.invalido/phish")).toBe(false);
    expect(isSafeInternalRoute("escalas://qualquer")).toBe(false);
    expect(isSafeInternalRoute("javascript:alert(1)")).toBe(false);
    expect(isSafeInternalRoute("")).toBe(false);
  });

  it("recusa voltar para o próprio fluxo de entrada", () => {
    for (const route of [
      "/login",
      "/signup",
      "/forgot-password",
      "/reset-password",
      "/oauth/callback",
    ]) {
      expect(isSafeInternalRoute(route), route).toBe(false);
      expect(isSafeInternalRoute(`${route}?x=1`), route).toBe(false);
    }
    expect(isSafeInternalRoute("/")).toBe(false);
  });

  it("buildHref recompõe a query preservando o parâmetro do convite", () => {
    expect(buildHref("/join-schedule", { invite: "ABC123" })).toBe(
      "/join-schedule?invite=ABC123",
    );
    expect(buildHref("/agenda", {})).toBe("/agenda");
    expect(buildHref("/x", { a: undefined, b: "", c: "1" })).toBe("/x?c=1");
    expect(buildHref("/x", { tag: ["a", "b"] })).toBe("/x?tag=a&tag=b");
  });

  it("um login, um salto: o destino é consumido e some", () => {
    rememberIntendedRoute("/join-schedule?invite=ABC123");
    expect(takeIntendedRoute()).toBe("/join-schedule?invite=ABC123");
    expect(takeIntendedRoute()).toBeNull();
  });

  it("destino inseguro não fica guardado nem sobrescreve um bom", () => {
    rememberIntendedRoute("//exemplo.invalido");
    expect(takeIntendedRoute()).toBeNull();

    rememberIntendedRoute("/join-schedule?invite=ABC123");
    rememberIntendedRoute("https://exemplo.invalido");
    expect(takeIntendedRoute()).toBe("/join-schedule?invite=ABC123");
  });
});
