// server/_core/error-handling.ts — erro de rota NÃO pode derrubar o processo.
//
// Express 4 não captura a rejeição de um handler `async`: a promise
// rejeitada vira "unhandledRejection" e o Node (>= 15) encerra o processo.
// Foi exatamente o que aconteceu quando o login consultou uma coluna que
// ainda não existia no banco: cada tentativa de login reiniciava o
// servidor inteiro (Render: ELIFECYCLE exit 1 → 502 para todo mundo).
//
// Três camadas, da mais específica à mais geral:
//   1. installAsyncRouteForwarding(): toda rejeição de handler async vira
//      next(err) — mesma técnica do pacote express-async-errors, sem a
//      dependência.
//   2. createErrorHandler(): middleware final que loga e responde 500 JSON.
//   3. installProcessGuards(): unhandledRejection/uncaughtException logados
//      em vez de matar o processo em silêncio.

import { createRequire } from "node:module";
import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";

type Logger = { error: (obj: Record<string, unknown>, msg: string) => void };

const ASYNC_FORWARDING_MARKER = Symbol.for("escalas.async-route-forwarding.installed");

export function installAsyncRouteForwarding(): void {
  const require = createRequire(import.meta.url);
  // Camada interna do Express 4 que invoca cada handler de rota/middleware.
  const Layer = require("express/lib/router/layer") as {
    prototype: {
      handle_request: (req: Request, res: Response, next: NextFunction) => void;
      handle: unknown;
      [ASYNC_FORWARDING_MARKER]?: boolean;
    };
  };
  // Vitest isola os módulos da aplicação por arquivo, mas o módulo CommonJS
  // interno do Express pode continuar compartilhado no worker. Marcar o
  // próprio prototype evita empilhar wrappers quando o setup é reinstalado.
  if (Layer.prototype[ASYNC_FORWARDING_MARKER]) return;
  Layer.prototype[ASYNC_FORWARDING_MARKER] = true;
  const original = Layer.prototype.handle_request;
  Layer.prototype.handle_request = function (this: { handle: unknown }, req, res, next) {
    const fn = this.handle as ((...args: unknown[]) => unknown) & { length: number };
    if (fn.length > 3) return next(); // handlers de erro (err, req, res, next)
    let out: unknown;
    try {
      out = fn(req, res, next);
    } catch (err) {
      return next(err);
    }
    if (out && typeof (out as Promise<unknown>).then === "function") {
      (out as Promise<unknown>).then(undefined, next);
    }
  };
  void original;
}

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err: message, method: req.method, path: req.path, stack: err instanceof Error ? err.stack : undefined },
      "unhandled route error",
    );
    if (res.headersSent) return next(err);
    res.status(500).json({ error: "Erro interno no servidor. Tente novamente em instantes." });
  };
}

export function installProcessGuards(logger: Logger): void {
  process.on("unhandledRejection", (reason) => {
    logger.error(
      { err: reason instanceof Error ? reason.message : String(reason), stack: reason instanceof Error ? reason.stack : undefined },
      "unhandled promise rejection (processo mantido vivo)",
    );
  });
  process.on("uncaughtException", (err) => {
    // Estado pode estar corrompido: loga com contexto e deixa o Render
    // reiniciar — mas nunca em silêncio.
    logger.error({ err: err.message, stack: err.stack }, "uncaught exception — encerrando");
    process.exit(1);
  });
}
