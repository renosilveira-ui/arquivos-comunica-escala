import { readFileSync } from "node:fs";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { hospitalAlertRouter } from "../server/routes/hospital-alert";

/**
 * A superfície legada do Hospital Alert está congelada (ADR-001 / duty-sync V1).
 * Antes, o proxy autenticado encaminhava ao upstream com a API key do servidor
 * exigindo apenas autenticação — sem tenant/hospital/setor/papel. Agora todos os
 * endpoints falham fechado com 410, sem contatar upstream nem usar segredo.
 */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/integrations/hospital-alert", hospitalAlertRouter);
  return app;
}

describe("hospital-alert — superfície legada congelada", () => {
  const app = buildApp();
  const base = "/api/integrations/hospital-alert";

  const postEndpoints = ["/sync-user", "/shifts/start", "/shifts/end"] as const;

  for (const path of postEndpoints) {
    it(`POST ${path} responde 410 LEGACY_CONTRACT_FROZEN sem proxy`, async () => {
      const res = await request(app)
        .post(`${base}${path}`)
        // Corpo hostil (tenta forjar identidade) é irrelevante: nada é proxied.
        .send({ externalUserId: "shiftsapp:999", organizationId: "org-forjada" });
      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({
        ok: false,
        error: "LEGACY_CONTRACT_FROZEN",
      });
    });
  }

  it("GET /status responde 410 LEGACY_CONTRACT_FROZEN", async () => {
    const res = await request(app).get(`${base}/status`);
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({
      ok: false,
      error: "LEGACY_CONTRACT_FROZEN",
    });
  });

  it("falha fechado para todos: sem autenticação ainda é 410 (não 401)", async () => {
    // Sem sessão/cookie: 410 comprova que nenhuma credencial do servidor é
    // exigida ou usada e que nenhum upstream é contatado.
    const res = await request(app).post(`${base}/sync-user`).send({});
    expect(res.status).toBe(410);
  });

  it("anti-regressão: a superfície legada não reintroduz proxy nem segredo", () => {
    const src = readFileSync(
      new URL("../server/routes/hospital-alert.ts", import.meta.url),
      "utf8",
    );
    // Nenhum cliente HTTP de saída, nenhum uso de segredo/credencial upstream,
    // nenhum encaminhamento para o contrato tRPC legado.
    expect(src).not.toMatch(/\baxios\b/);
    expect(src).not.toMatch(/HOSPITAL_ALERT_API_KEY|Bearer|integrationHeaders/);
    expect(src).not.toMatch(
      /auth\.syncUser|shifts\.start|shifts\.end|integration\.getStatus/,
    );
    expect(src).toContain("LEGACY_CONTRACT_FROZEN");
  });
});
