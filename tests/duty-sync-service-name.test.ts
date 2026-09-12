import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { canonicalizeDutySyncServiceName } from "../server/sso/duty-sync";

/**
 * O plantão sem especialidade declarada não pode derrubar a confirmação.
 *
 * ## O defeito que estes testes trancam
 *
 * `shift_instances.specialty` aceita texto vazio, e no banco real 76 dos 453
 * plantões estavam assim — plantão sem especialidade é o caso comum, não a
 * exceção. A guarda do envelope tratava esse vazio como envelope corrompido
 * e lançava dentro da transação da confirmação: o médico tocava "Sim,
 * confirmo" e recebia "Envelope imutável inválido no duty-sync", sem
 * confirmar coisa nenhuma. Relatado pelo PO em 12/09/2026, no plantão da
 * tarde de sábado.
 *
 * A gravação logo abaixo da guarda já descartava o branco. O defeito estava
 * na guarda, não no dado.
 */

describe("nome do serviço no duty-sync", () => {
  it("nome de verdade passa, sem os espaços das pontas", () => {
    expect(canonicalizeDutySyncServiceName("Anestesiologia")).toBe(
      "Anestesiologia",
    );
    expect(canonicalizeDutySyncServiceName("  Sala de Recuperação  ")).toBe(
      "Sala de Recuperação",
    );
  });

  /** O caso do PO: especialidade vazia no banco. */
  it("vazio e só-espaço viram ausência, não erro", () => {
    expect(canonicalizeDutySyncServiceName("")).toBeNull();
    expect(canonicalizeDutySyncServiceName("   ")).toBeNull();
    expect(canonicalizeDutySyncServiceName("\t\n")).toBeNull();
  });

  it("ausente continua ausente", () => {
    expect(canonicalizeDutySyncServiceName(null)).toBeNull();
    expect(canonicalizeDutySyncServiceName(undefined)).toBeNull();
  });

  /**
   * Campo descritivo, que vira rótulo no Comunica+. Bloquear a confirmação de
   * um plantão por causa de um rótulo trocaria um problema cosmético por um
   * operacional.
   */
  it("tipo errado vira ausência, nunca exceção", () => {
    expect(canonicalizeDutySyncServiceName(42)).toBeNull();
    expect(canonicalizeDutySyncServiceName({})).toBeNull();
    expect(canonicalizeDutySyncServiceName([])).toBeNull();
    expect(() => canonicalizeDutySyncServiceName(Symbol("x"))).not.toThrow();
  });

  it("a guarda do envelope não menciona mais serviceName", () => {
    // Prende a correção no lugar: se alguém reintroduzir a validação que
    // explodia, este teste cai junto.
    const fonte = readFileSync("server/sso/duty-sync.ts", "utf8");
    const inicio = fonte.indexOf("export async function enqueueDutySync");
    expect(inicio).toBeGreaterThan(-1);
    // A partir do início da função: a mesma frase aparece antes, no
    // comentário que explica esta correção.
    const fim = fonte.indexOf("Envelope imutável inválido no duty-sync", inicio);
    expect(fim).toBeGreaterThan(inicio);
    const guarda = fonte.slice(inicio, fim);
    expect(guarda).not.toMatch(/input\.serviceName\s*!=\s*null/);
    expect(guarda).toMatch(/canonicalizeDutySyncServiceName/);
  });
});

/**
 * A segunda metade da correção: mesmo que outra invariante interna quebre um
 * dia, o médico não lê o texto que foi escrito para quem mantém o código.
 */
describe("erro interno não chega em jargão ao usuário", () => {
  const trpcFonte = readFileSync("server/_core/trpc.ts", "utf8");

  it("todo INTERNAL_SERVER_ERROR é mascarado, não só o do banco", () => {
    const formatter = trpcFonte.slice(trpcFonte.indexOf("errorFormatter"));
    // A condição não pode mais exigir cara de SQL para mascarar.
    expect(formatter).toMatch(
      /error\.code === "INTERNAL_SERVER_ERROR"\)\s*\{/,
    );
    expect(formatter).toMatch(/INTERNAL_ERROR_USER_MESSAGE/);
  });

  it("a mensagem ao usuário é em português e não cita tecnologia", () => {
    const mensagem = trpcFonte.match(
      /INTERNAL_ERROR_USER_MESSAGE =\s*\n?\s*"([^"]+)"/,
    )?.[1];
    expect(mensagem).toBeTruthy();
    expect(mensagem).toMatch(/servidor/i);
    expect(mensagem).not.toMatch(
      /envelope|duty-sync|sql|query|undefined|null|token/i,
    );
  });

  it("o detalhe continua indo para o log", () => {
    const formatter = trpcFonte.slice(trpcFonte.indexOf("errorFormatter"));
    expect(formatter).toMatch(/logger\.error/);
    expect(formatter).toMatch(/safeErrorDiagnostic/);
  });
});
