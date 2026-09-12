import { beforeEach, describe, expect, it } from "vitest";
import {
  buildHref,
  isSafeInternalRoute,
  forgetIntendedRoute,
  peekIntendedRoute,
  pendingDestinationNotice,
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
    // Sem URLSearchParams: a codificação tem que ser nossa e correta.
    expect(buildHref("/x", { q: "a b&c=d" })).toBe("/x?q=a%20b%26c%3Dd");
  });

  it("peek lê sem consumir — a tela de login não pode gastar o destino", () => {
    rememberIntendedRoute("/join-schedule?invite=ABC123");
    expect(peekIntendedRoute()).toBe("/join-schedule?invite=ABC123");
    // Duas leituras seguidas: uma tela que re-renderiza não perde o destino.
    expect(peekIntendedRoute()).toBe("/join-schedule?invite=ABC123");
    expect(takeIntendedRoute()).toBe("/join-schedule?invite=ABC123");
    expect(peekIntendedRoute()).toBeNull();
  });

  it("o aviso do login nomeia o que veio de fora", () => {
    const convite = pendingDestinationNotice("/join-schedule?invite=ABC123");
    expect(convite?.title).toContain("convite");
    // O e-mail manda entrar com o endereço que recebeu a mensagem; o aviso
    // repete a mesma instrução, senão a pessoa entra com outra conta.
    expect(convite?.body).toContain("e-mail");

    const plantao = pendingDestinationNotice("/confirm-duty?token=x");
    expect(plantao?.title).toContain("plantão");

    // Destino sem nome próprio ainda ganha explicação: o silêncio é o que
    // faz a pessoa achar que o link falhou.
    expect(pendingDestinationNotice("/agenda")).not.toBeNull();
  });

  it("sem destino, ou com destino recusado, não há aviso", () => {
    expect(pendingDestinationNotice(null)).toBeNull();
    expect(pendingDestinationNotice("")).toBeNull();
    // O mesmo filtro de open redirect: se a rota não passa, o aviso não sai.
    expect(pendingDestinationNotice("https://exemplo.invalido")).toBeNull();
    expect(pendingDestinationNotice("//exemplo.invalido")).toBeNull();
    expect(pendingDestinationNotice("/login")).toBeNull();
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

  it("o fim de sessão esquece o destino: B não herda o salto de A", () => {
    // A abre o convite por QR com o app deslogado; a guarda arma o destino.
    rememberIntendedRoute("/join-schedule?invite=ABC123");
    // A desiste e devolve o aparelho. endSession chama isto.
    forgetIntendedRoute();
    // B entra e vai para a casa dele, não para o convite de A.
    expect(takeIntendedRoute()).toBeNull();
  });

  it("esquecer é idempotente e não atrapalha um destino novo", () => {
    forgetIntendedRoute();
    forgetIntendedRoute();
    rememberIntendedRoute("/agenda");
    expect(takeIntendedRoute()).toBe("/agenda");
  });
});
