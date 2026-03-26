# AuthZ v1 — Release Gates (v1)

**Documento**: `docs/auth/authz-release-gates-v1.md`  
**Agente**: A14 — Release, CI e Rollback  
**Status**: PROPOSTA — aguardando congelamento de A6 e A12  
**Dependências**: A6 (enforce.ts), A12 (audit trail), secrets de infra configurados

---

## 1. O que precisa estar verde antes do cutover

Todos os itens abaixo devem estar satisfeitos. Um único item vermelho bloqueia o GO.

### 1.1 Gates de agentes

| Gate | Responsável | Condição de aprovação |
|------|-------------|----------------------|
| A1 aprovado | A1 (modelo de dados) | Schema final congelado e migrado em staging |
| A2 aprovado | A2 (autenticação) | Fluxos de login e token validados em staging |
| A3 aprovado | A3 (RBAC/bundles) | Bundles e mapeamentos de ação definidos e congelados |
| A5 aprovado | A5 (contexto de sessão) | Actor builder produz Actor válido para todos os fluxos |
| A6 aprovado | A6 (enforcement) | `authorize()` em `server/authz/enforce.ts` congelado e com testes passando |
| A12 aprovado | A12 (audit trail) | `AuditEntry` com action type correto para decisões AuthZ; `recordAudit()` estável |

### 1.2 Gates de testes

| Teste | Comando | Condição |
|-------|---------|----------|
| AuthZ enforcement (sem DB) | `pnpm test:authz` com `AUTHZ_V1_ENFORCE=1` | 100% green |
| Typecheck server | `pnpm typecheck:server` | 0 erros |
| Typecheck app | `pnpm typecheck:app` | 0 erros |
| Lint | `pnpm lint` | 0 erros |
| Testes P0 com DB | `pnpm test` (com MySQL ativo) | 100% green |
| Build | `pnpm build` | 0 erros |
| Shadow mode | AUTHZ_V1_ENFORCE=1 em staging por período de canary | 0 DENY inesperados para atores legítimos |

### 1.3 Gates de infraestrutura

| Item | Condição |
|------|----------|
| `AUTHZ_V1_ENFORCE` configurado no Render (staging) | Variável presente, valor `0` antes do cutover |
| `RENDER_API_KEY` como GitHub Secret | Configurado nos environments `staging` e `production` |
| `RENDER_SERVICE_ID` como GitHub Secret | Configurado nos environments `staging` e `production` |
| `APP_URL` como GitHub Variable | Configurado nos environments `staging` e `production` |
| `/api/health` retorna `authzMode` e `db` | Resposta JSON válida com todos os campos |
| Rollback testado em staging | Flip para `AUTHZ_V1_ENFORCE=0` executado e verificado manualmente |

---

## 2. Testes obrigatórios

### P0 — Bloqueiam o GO se falhar

| Teste | Escopo | Arquivo |
|-------|--------|---------|
| ALLOW: MANAGER aprova assignment no mesmo org | enforce.ts | `tests/authz-enforce.test.ts` |
| DENY: OPERATOR não pode aprovar assignment | enforce.ts | `tests/authz-enforce.test.ts` |
| ALLOW: OPERATOR pode assumir vacancy | enforce.ts | `tests/authz-enforce.test.ts` |
| DENY: acesso cross-org rejeitado | enforce.ts | `tests/authz-enforce.test.ts` |
| DENY: sessão sem orgId rejeitada | enforce.ts | `tests/authz-enforce.test.ts` |
| DENY: ação desconhecida rejeitada | enforce.ts | `tests/authz-enforce.test.ts` |
| ALLOW: SERVICE_ACCOUNT com bundle correto | enforce.ts | `tests/authz-enforce.test.ts` |
| DENY: SERVICE_ACCOUNT com bundle errado | enforce.ts | `tests/authz-enforce.test.ts` |
| ALLOW: fallback LEGACY_BYPASS quando flag=0 | enforce.ts | `tests/authz-enforce.test.ts` |

### P0 — Smoke em staging (pós-deploy, pré-cutover)

| Endpoint | Código HTTP aceitável | Código HTTP que bloqueia GO |
|----------|----------------------|----------------------------|
| `GET /api/health` | 200 | 4xx, 5xx |
| `GET /api/health` → `authzMode` | `"legacy"` (pré-cutover) | qualquer outro valor |
| `GET /api/health` → `db` | `"up"` | `"down"` |
| `POST /api/auth/login` | 200, 400, 401, 422 | 500, 502, 503 |

### P1 — Desejáveis antes do cutover (não bloqueiam, mas devem estar resolvidos)

| Teste | Responsável |
|-------|-------------|
| Testes de RBAC legado passando | A3/A6 |
| Testes de shift workflow passando | A5 |
| Audit trail gravando corretamente no banco | A12 |

---

## 3. Sinais que impedem GO

Se qualquer um dos seguintes sinais estiver presente, o GO não é autorizado:

| Sinal | Severidade | Ação |
|-------|-----------|------|
| Qualquer teste P0 falhando | Bloqueador | Corrigir antes de agendar cutover |
| A6 ou A12 não congelados | Bloqueador | Aguardar aprovação H-1 |
| Rollback não testado em staging | Bloqueador | Executar teste de rollback antes |
| `db: "down"` em staging | Bloqueador | Resolver problema de DB |
| Secrets não configurados | Bloqueador | Configurar antes do cutover |
| Shadow mode com DENY inesperado em staging | Bloqueador | Investigar e corrigir |
| P0 incident aberto nas últimas 24h | Bloqueador | Resolver incidente antes |
| Stakeholder H-1 não aprovado | Bloqueador | Obter aprovação H-1 explícita |

---

## 4. Sinais que exigem rollback

Após cutover (AUTHZ_V1_ENFORCE=1 ativo), iniciar rollback imediatamente se:

| Sinal | Threshold | Procedimento |
|-------|-----------|--------------|
| `GET /api/health` retorna `ok: false` | Imediato | `docs/auth/authz-rollback-runbook-v1.md` |
| `authzMode` é `"v1"` mas fluxos P0 falham | Imediato | `docs/auth/authz-rollback-runbook-v1.md` |
| Taxa de erro em endpoints P0 sobe | > baseline + 2% | `docs/auth/authz-rollback-runbook-v1.md` |
| Usuário legítimo recebendo DENY no audit trail | Qualquer ocorrência | `docs/auth/authz-rollback-runbook-v1.md` |
| `db: "down"` pós-cutover | Imediato | `docs/auth/authz-rollback-runbook-v1.md` |
| Surge de 5xx inexplicável | > 5 em 1 minuto | `docs/auth/authz-rollback-runbook-v1.md` |
| Decisão do on-call | Qualquer P0 durante janela | `docs/auth/authz-rollback-runbook-v1.md` |

---

## 5. Pré-condições de secrets/env/workflows

### Variáveis de ambiente no Render

| Variável | Staging | Production | Observação |
|----------|---------|------------|------------|
| `AUTHZ_V1_ENFORCE` | `0` (pré-cutover) / `1` (pós) | `0` até cutover confirmado em staging | Não requer redeploy para mudar |
| `DATABASE_URL` | Configurado | Configurado | Necessário para `db: "up"` |
| `COOKIE_SECRET` | Configurado | Configurado | Necessário para sessões |

### GitHub Secrets (por environment)

| Secret | Environment | Responsável |
|--------|-------------|-------------|
| `RENDER_API_KEY` | staging, production | Infra |
| `RENDER_SERVICE_ID` | staging, production | Infra |
| `DATABASE_URL` | staging, production | Infra |

### GitHub Variables (por environment)

| Variable | Environment | Valor esperado |
|----------|-------------|----------------|
| `APP_URL` | staging | URL do serviço de staging |
| `APP_URL` | production | URL do serviço de production |

### Workflows — estado para cutover

| Workflow | Estado necessário | Responsável |
|----------|------------------|-------------|
| `pr-quality.yml` | Todos os jobs verdes no commit de cutover | CI |
| `db-migrate.yml` | Executado em staging com dry_run=false | A1/Infra |
| `authz-rollout.yml` | PROPOSTA — só executar após todos os gates acima | A14 |
| `authz-rollback.yml` | PROPOSTA — testar em staging antes de production | A14 |
