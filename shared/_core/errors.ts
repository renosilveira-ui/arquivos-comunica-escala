// shared/_core/errors.ts — Erros customizados usados pelo server
export class ForbiddenError extends Error {
  constructor(message = "Acesso negado") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class UnauthorizedError extends Error {
  constructor(message = "Não autorizado") {
    super(message);
    this.name = "UnauthorizedError";
  }
}
