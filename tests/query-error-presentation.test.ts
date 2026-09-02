import { describe, expect, it } from "vitest";
import { presentQueryError } from "../lib/query-error-presentation";

describe("apresentação segura de erro de query", () => {
  it("não atribui erro de autorização à conexão do usuário", () => {
    const presentation = presentQueryError({ data: { code: "FORBIDDEN" } });
    expect(presentation.kind).toBe("ACCESS");
    expect(presentation.body).not.toMatch(/conexão/i);

    expect(presentQueryError({ code: "UNAUTHORIZED" }).kind).toBe("ACCESS");
  });

  it("orienta a verificar conexão somente para falha de transporte", () => {
    const presentation = presentQueryError({
      message: "Network request failed",
    });
    expect(presentation.kind).toBe("NETWORK");
    expect(presentation.body).toMatch(/conexão/i);
  });

  it("mantém erro de serviço genérico fora da hipótese de conexão", () => {
    const presentation = presentQueryError({ data: { code: "INTERNAL_SERVER_ERROR" } });
    expect(presentation.kind).toBe("SERVICE");
    expect(presentation.body).not.toMatch(/conexão/i);
  });
});
