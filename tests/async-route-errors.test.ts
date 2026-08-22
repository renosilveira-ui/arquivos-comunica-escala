// tests/async-route-errors.test.ts — rejeição em handler async vira 500,
// não derruba o processo (regressão do incidente de 2026-08-22: login com
// coluna inexistente reiniciava o servidor a cada tentativa).

import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { createErrorHandler, installAsyncRouteForwarding } from "../server/_core/error-handling";

describe("erros em rotas async", () => {
  it("handler async que rejeita responde 500 JSON em vez de matar o processo", async () => {
    installAsyncRouteForwarding();
    const logged: string[] = [];
    const app = express();
    app.get("/boom", async () => {
      throw new Error("Unknown column 'must_change_password' in 'field list'");
    });
    app.get("/ok", async (_req, res) => {
      res.json({ ok: true });
    });
    app.use(createErrorHandler({ error: (_obj, msg) => logged.push(msg) }));

    const boom = await request(app).get("/boom");
    expect(boom.status).toBe(500);
    expect(boom.body.error).toContain("Erro interno");
    expect(logged).toContain("unhandled route error");

    // O processo continua servindo normalmente depois do erro.
    const ok = await request(app).get("/ok");
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
  });

  it("handler síncrono que lança também cai no error handler", async () => {
    installAsyncRouteForwarding();
    const app = express();
    app.get("/sync", () => {
      throw new Error("sync boom");
    });
    app.use(createErrorHandler({ error: () => {} }));
    const res = await request(app).get("/sync");
    expect(res.status).toBe(500);
  });
});
