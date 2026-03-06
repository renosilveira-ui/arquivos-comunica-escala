// scripts/load-env.js — Carrega variáveis de ambiente (.env) antes do app.config.ts
// Em dev, usa dotenv; em produção, as vars vêm do ambiente.
try {
  require("dotenv/config");
} catch {
  // dotenv não instalado ou .env não existe — ok, usar env do sistema
}
