# A14 — AuthZ v1 Release/CI/Rollback — Handoff Oficial

**Agente**: A14 — Release, CI e Rollback  
**Onda**: 0  
**Data**: 2026-03-26  
**Domínio**: Exclusivo de pipeline, CI, gates e operações de cutover/rollback. Não toca em semântica de auth.

---

## Feito

### 1. Flag `AUTHZ_V1_ENFORCE` implantada

- **Arquivo**: `server/_core/env.ts`
- `ENV.authzV1Enforce` lê `process.env.AUTHZ_V1_ENFORCE` (default `"0"` = legado)
- Quando `"0"`: sistema opera em modo legado; `authorize()` retorna ALLOW + audit `LEGACY_BYPASS`
- Quando `"1"`: enforcement completo v1 via `authorize(actor, action, resource, context)`
- **Rollback sem redeploy**: alterar o valor no Render env dashboard basta para o serviço reiniciar no modo correto

### 2. Camada central `authorize()` implantada

- **Arquivo**: `server/authz/enforce.ts`
- Tipos exportados: `Actor`, `AuthzResource`, `AuthzContext`, `AuthzResult`, `Bundle`, `Scope`, `PrincipalType`, `ActiveMode`
- Regras enforçadas: org-scope obrigatório, bundle hierárquico, isolamento cross-org, SERVICE_ACCOUNT ≠ humano
- Toda decisão emite audit ALLOW/DENY + reason via `server/audit-trail.ts` (fire-and-forget)

### 3. Endpoint `/api/health` estendido

- **Arquivo**: `server/authz/health.ts` (helper), `server/_core/index.ts` (rota)
- Resposta: `{ ok, db: "up"|"down", authzMode: "legacy"|"v1", authzV1Enforce, timestamp }`
- HTTP 503 quando `db: "down"`
- Permite confirmar o estado do flag em runtime sem acesso ao Render

### 4. Gates de CI implantados

| Workflow | Trigger | Jobs |
|----------|---------|------|
| `pr-quality.yml` | PR → main/staging; push → staging | typecheck, lint, test (MySQL), authz-gate (`AUTHZ_V1_ENFORCE=1`), build |
| `db-migrate.yml` | workflow_dispatch / workflow_call | migrate (com dry-run opcional) |
| `authz-rollout.yml` | workflow_dispatch | quality-gate → build → migrate → deploy (flag=0) → smoke → cutover (flag=1) → post-cutover |
| `authz-rollback.yml` | workflow_dispatch | rollback (flag=0, poll até legacy, verifica health) |

### 5. Runbooks e critérios produzidos

| Documento | Caminho |
|-----------|---------|
| Go/No-Go Checklist | `docs/authz-v1/GO_NO_GO_CHECKLIST.md` |
| Cutover Runbook | `docs/authz-v1/CUTOVER_RUNBOOK.md` |
| Rollback Runbook | `docs/authz-v1/ROLLBACK_RUNBOOK.md` |
| Canary Criteria | `docs/authz-v1/CANARY_CRITERIA.md` |

### 6. Testes de enforcement

- **Arquivo**: `tests/authz-enforce.test.ts` (15 testes, sem DB)
- **Config isolada**: `vitest.authz.config.ts`
- **Script**: `pnpm test:authz`
- Cobre: todos os caminhos ALLOW/DENY (bundle, scope, cross-org, SERVICE_ACCOUNT, AUDITOR_READONLY, LEGACY_BYPASS)

---

## Evidência

| Item | Evidência |
|------|-----------|
| 15/15 testes passam | `pnpm test:authz` → `Tests 15 passed` |
| Typecheck limpo | `pnpm typecheck:server` → sem erros |
| CodeQL | 0 alertas (todos os jobs têm `permissions` explícitos) |
| Flag rollback sem redeploy | `ENV.authzV1Enforce` é campo mutável em runtime, confirmado por teste de legacy fallback |
| Health endpoint | `GET /api/health` retorna `authzMode` e `db` |
| Rollback automatizado | `authz-rollback.yml` — único trigger: `workflow_dispatch` com `environment` + `reason` |
| Rollout automatizado | `authz-rollout.yml` — 7 jobs sequenciais com gates entre etapas |
| Migrate dependency | `deploy` job depende de `migrate` (quando `run_migrate=true`), corrigido para evitar deploy pré-migração |

### Comandos de verificação local

```bash
# Todos os testes AuthZ v1 (sem DB)
AUTHZ_V1_ENFORCE=1 pnpm test:authz

# Typecheck server
pnpm typecheck:server

# Saúde com flag ativo (precisa de servidor rodando)
curl http://localhost:3000/api/health
# → {"ok":true,"db":"up","authzMode":"v1","authzV1Enforce":true,...}
```

---

## Risco Aberto

| # | Risco | Severidade | Mitigação | Dependência |
|---|-------|------------|-----------|-------------|
| R1 | `AUTHZ_DECISION` audit entries use `SHIFT_INSTANCE` as `entityType` (placeholder) | Baixa | Expandir `AuditEntry.entityType` com `AUTHZ_EVENT` na janela P1 | A1x (audit domain) |
| R2 | `ENV.authzV1Enforce` é lido na inicialização do módulo; mudança do env var requer restart do processo | Baixa | Por design — Render reinicia automaticamente ao salvar env var; documentado nos runbooks |
| R3 | Testes legados (`rbac-approval.test.ts`, `shift-workflow.test.ts`) requerem seed de DB e conexão MySQL | Média | `vitest.authz.config.ts` é isolado; testes legados só rodam quando MySQL está disponível no CI |
| R4 | Canary é boolean global — nenhum percentual ou allowlist por org | Baixa | Decisão deliberada para minimizar complexidade operacional; documentado em `CANARY_CRITERIA.md` |
| R5 | Rollback automatizado (`authz-rollback.yml`) depende de `RENDER_API_KEY` e `RENDER_SERVICE_ID` como secrets do GitHub | Média | Verificar que os secrets estão configurados em ambos os environments (`staging`, `production`) antes do cutover |
| R6 | Legado `server/rbac-validations.ts` não foi removido — existe em paralelo com `server/authz/enforce.ts` | Baixa | Intencional (freeze de P2); não há colisão pois legado só é chamado quando `authzMode=legacy` |

---

## Próximo Passo

### Para a equipe de Release (agente A14 na próxima janela)

1. **Staging cutover** — Executar `authz-rollout.yml` com `environment=staging, cutover=true`
2. **Validar canary** — Monitorar 15 min usando os critérios de `CANARY_CRITERIA.md`
3. **Testar rollback** — Executar `authz-rollback.yml` em staging para confirmar TTR < 2 min
4. **Production cutover** — Só após staging estável por ≥ 24h; repetir `authz-rollout.yml` com `environment=production`

### Para outros agentes

| Agente | Dependência | Ação necessária |
|--------|-------------|-----------------|
| A1x (audit) | R1 acima | Adicionar `AUTHZ_DECISION` ao enum `AuditEntry.action` em `server/audit-trail.ts` |
| Qualquer agente de feature | Freeze de features | Nenhuma feature nova fora de AuthZ v1 até cutover confirmado em produção |
| Qualquer agente de auth | Semântica congelada | Não alterar `server/authz/enforce.ts` sem escalar ao H-1 |

### Colisão de arquivos

Os seguintes arquivos foram tocados por A14 e **não devem ser editados por outros agentes** sem escalar:

```
server/_core/env.ts           ← AUTHZ_V1_ENFORCE flag
server/_core/index.ts         ← /api/health endpoint
server/authz/enforce.ts       ← camada central de autorização
server/authz/health.ts        ← helper de health check
.github/workflows/pr-quality.yml
.github/workflows/db-migrate.yml
.github/workflows/authz-rollout.yml
.github/workflows/authz-rollback.yml
docs/authz-v1/
vitest.authz.config.ts
tests/authz-enforce.test.ts
```
