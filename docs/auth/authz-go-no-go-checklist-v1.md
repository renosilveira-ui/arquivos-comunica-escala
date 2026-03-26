# AuthZ v1 — Go/No-Go Checklist (v1)

**Documento**: `docs/auth/authz-go-no-go-checklist-v1.md`  
**Agente**: A14 — Release, CI e Rollback  
**Status**: PROPOSTA — para uso imediato antes de qualquer cutover  
**Referência de gates**: `docs/auth/authz-release-gates-v1.md`

---

> **Uso**: Preencher este checklist em conjunto com o engenheiro de release e o on-call
> imediatamente antes de executar o cutover. Todos os itens devem estar ✅.
> Um único ❌ bloqueia o GO.

---

## Bloco 1 — Aprovações de agentes

| # | Item | Status | Responsável | Evidência |
|---|------|--------|-------------|-----------|
| 1.1 | A1 (modelo de dados) aprovado pelo H-1 | ☐ | A1 | Link do commit/PR |
| 1.2 | A2 (autenticação/login) aprovado pelo H-1 | ☐ | A2 | Link do commit/PR |
| 1.3 | A3 (RBAC/bundles) aprovado pelo H-1 | ☐ | A3 | Link do commit/PR |
| 1.4 | A5 (contexto de sessão/Actor builder) aprovado pelo H-1 | ☐ | A5 | Link do commit/PR |
| 1.5 | A6 (enforce.ts — camada central de autorização) aprovado pelo H-1 | ☐ | A6 | Link do commit/PR |
| 1.6 | A12 (audit trail — AuditEntry com tipo AuthZ correto) aprovado pelo H-1 | ☐ | A12 | Link do commit/PR |

---

## Bloco 2 — Testes P0 verdes

| # | Teste | Comando | Status | Saída esperada |
|---|-------|---------|--------|----------------|
| 2.1 | AuthZ enforcement (sem DB) | `pnpm test:authz` com `AUTHZ_V1_ENFORCE=1` | ☐ | `Tests X passed` |
| 2.2 | Typecheck server | `pnpm typecheck:server` | ☐ | 0 erros |
| 2.3 | Typecheck app | `pnpm typecheck:app` | ☐ | 0 erros |
| 2.4 | Lint | `pnpm lint` | ☐ | 0 erros |
| 2.5 | Testes completos (com DB) | `pnpm test` | ☐ | 100% green |
| 2.6 | Build | `pnpm build` | ☐ | Sem erros |

---

## Bloco 3 — Shadow mode aceitável em staging

| # | Item | Status | Evidência |
|---|------|--------|-----------|
| 3.1 | Staging rodando com `AUTHZ_V1_ENFORCE=1` por período de canary (mínimo 1h) | ☐ | Timestamp início + fim |
| 3.2 | Zero DENY inesperado para atores legítimos no audit trail durante canary | ☐ | Query no banco de staging |
| 3.3 | Zero ALLOW inesperado para atores bloqueados durante canary | ☐ | Query no banco de staging |
| 3.4 | Taxa de erro em endpoints P0 ≤ baseline + 1% durante canary | ☐ | Render metrics |
| 3.5 | `GET /api/health` retornando `authzMode: "v1"` consistentemente | ☐ | Resposta JSON |

Query de verificação de shadow mode (banco de staging):
```sql
-- DENY inesperados para atores conhecidos (não deveria haver nenhum)
SELECT * FROM audit_trail
WHERE description LIKE '[AUTHZ_V1]%'
  AND description LIKE '%decision=DENY%'
ORDER BY created_at DESC
LIMIT 50;
```

---

## Bloco 4 — Secrets e configuração de infra validados

| # | Item | Status | Responsável |
|---|------|--------|-------------|
| 4.1 | `RENDER_API_KEY` configurado como GitHub Secret em `staging` | ☐ | Infra |
| 4.2 | `RENDER_API_KEY` configurado como GitHub Secret em `production` | ☐ | Infra |
| 4.3 | `RENDER_SERVICE_ID` configurado como GitHub Secret em `staging` | ☐ | Infra |
| 4.4 | `RENDER_SERVICE_ID` configurado como GitHub Secret em `production` | ☐ | Infra |
| 4.5 | `APP_URL` configurado como GitHub Variable em `staging` | ☐ | Infra |
| 4.6 | `APP_URL` configurado como GitHub Variable em `production` | ☐ | Infra |
| 4.7 | `AUTHZ_V1_ENFORCE=0` configurado no Render (staging) antes de iniciar cutover | ☐ | A14 |
| 4.8 | `/api/health` em staging retorna `db: "up"` | ☐ | A14 |

---

## Bloco 5 — Rollback testado

| # | Item | Status | Evidência |
|---|------|--------|-----------|
| 5.1 | Procedimento de rollback manual executado em staging (Opção B do runbook) | ☐ | Log/screenshot |
| 5.2 | Após rollback, `authzMode` retornou a `"legacy"` em ≤ 2 minutos | ☐ | Timestamp |
| 5.3 | Fluxos P0 funcionando normalmente após rollback de staging | ☐ | Smoke manual |
| 5.4 | Procedimento de rollback documentado e acessível ao on-call | ☐ | `docs/auth/authz-rollback-runbook-v1.md` |

---

## Bloco 6 — Aprovação final

| # | Item | Status | Responsável |
|---|------|--------|-------------|
| 6.1 | Nenhum P0 incident aberto nas últimas 24h | ☐ | On-call |
| 6.2 | On-call disponível por 30 minutos pós-cutover | ☐ | On-call |
| 6.3 | Aprovação explícita do H-1 para execução do cutover | ☐ | H-1 |
| 6.4 | Horário de cutover definido (janela de baixo tráfego) | ☐ | A14 |

---

## Decisão

| Condição | Resultado |
|----------|-----------|
| Todos os blocos 1–6 com ✅ | **GO** |
| Qualquer item com ❌ | **NO-GO** — ver coluna "Responsável" |

**GO** deve ser explicitamente declarado pelo H-1 antes da execução.

---

## Registro de execução (preencher no dia)

| Campo | Valor |
|-------|-------|
| Data/hora do preenchimento | |
| Engenheiro de release | |
| On-call de plantão | |
| Aprovação H-1 | |
| Resultado (GO / NO-GO) | |
| Observações | |
