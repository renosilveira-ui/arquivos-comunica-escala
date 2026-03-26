# AuthZ v1 — Cutover Runbook (v1)

**Documento**: `docs/auth/authz-cutover-runbook-v1.md`  
**Agente**: A14 — Release, CI e Rollback  
**Status**: PROPOSTA — para execução somente após GO aprovado pelo H-1  
**Pré-requisito obrigatório**: `docs/auth/authz-go-no-go-checklist-v1.md` 100% OK

---

## Visão geral do processo

```
staging canary (min 1h) → GO/NO-GO → cutover staging → observação → promoção a production
```

O cutover ativa `AUTHZ_V1_ENFORCE=1` sem redeploy. O rollback é possível em qualquer ponto
via flip do env var de volta para `0`. Ver `docs/auth/authz-rollback-runbook-v1.md`.

---

## Fase 1 — Canary em staging

### 1.1 Preparar staging

```bash
# Confirmar baseline antes de habilitar
curl https://<STAGING_APP_URL>/api/health
# Esperado: {"ok":true,"db":"up","authzMode":"legacy","authzV1Enforce":false}
```

### 1.2 Ativar shadow mode em staging

Via Render Dashboard (staging):
1. Render → Web Service → Environment
2. Definir `AUTHZ_V1_ENFORCE` = `1`
3. Clicar **Save Changes** (serviço reinicia automaticamente)

Via Render API (staging):
```bash
curl -X PATCH \
  -H "Authorization: Bearer <RENDER_API_KEY>" \
  -H "Content-Type: application/json" \
  "https://api.render.com/v1/services/<RENDER_SERVICE_ID>/env-vars" \
  -d '[{"key":"AUTHZ_V1_ENFORCE","value":"1"}]'
```

### 1.3 Confirmar ativação em staging

```bash
# Aguardar ~30-45s e verificar
curl https://<STAGING_APP_URL>/api/health
# Esperado: {"ok":true,"db":"up","authzMode":"v1","authzV1Enforce":true}
```

### 1.4 Duração mínima de observação de canary

**Mínimo**: 1 hora de `AUTHZ_V1_ENFORCE=1` em staging, com tráfego representativo.  
**Recomendado**: 4–8 horas antes de promover para production.

Durante o período de canary, monitorar:

| Sinal | Frequência | Ferramenta |
|-------|-----------|------------|
| `GET /api/health` → `ok` e `authzMode` | A cada 5 min | Manual / Render health check |
| Taxa de erro em endpoints P0 | Contínuo | Render metrics |
| Logs com `[AUTHZ_V1]` | A cada 15 min | Render logs |
| Audit trail — DENY inesperados | A cada 15 min | Query no banco |

**Query de monitoramento do canary** (executar em staging):
```sql
-- Verificar DENY inesperados durante canary
SELECT description, created_at
FROM audit_trail
WHERE description LIKE '[AUTHZ_V1]%decision=DENY%'
ORDER BY created_at DESC
LIMIT 100;

-- Verificar volume de decisões AuthZ
SELECT
  CASE WHEN description LIKE '%decision=ALLOW%' THEN 'ALLOW' ELSE 'DENY' END AS decision,
  COUNT(*) AS total
FROM audit_trail
WHERE description LIKE '[AUTHZ_V1]%'
GROUP BY 1;
```

### 1.5 Critérios para promoção a production

Todos os seguintes devem ser satisfeitos ao final do período de canary em staging:

| Critério | Condição de aprovação |
|---------|----------------------|
| `authzMode=v1` estável | Nenhuma troca inesperada para `legacy` durante o canary |
| P0 endpoints funcionais | Login, vacancy assume, assignment approve/reject todos operacionais |
| Taxa de erro | ≤ baseline + 1% durante todo o período de canary |
| Audit trail | Zero DENY para atores legítimos conhecidos |
| DB | `db: "up"` durante todo o período |
| Rollback testado | Flip para `AUTHZ_V1_ENFORCE=0` executado e `authzMode=legacy` confirmado em < 2 min |

Se algum critério falhar durante o canary: **NÃO promover para production** — acionar `docs/auth/authz-rollback-runbook-v1.md`.

---

## Fase 2 — Cutover em production

**Pré-requisito**: Todos os critérios do canary de staging satisfeitos + H-1 aprovado explicitamente.

### 2.1 Smoke pré-cutover em production

```bash
# Confirmar baseline de production
curl https://<PROD_APP_URL>/api/health
# Esperado: {"ok":true,"db":"up","authzMode":"legacy"}
```

### 2.2 Notificar stakeholders

1. Comunicar data/hora do cutover ao time com pelo menos 1 hora de antecedência
2. Confirmar que o on-call está disponível e ciente

### 2.3 Executar cutover em production

**Opção A — Workflow automatizado** (apenas se workflow estiver validado e secrets configurados):
```
Actions → AuthZ v1 Rollout
  environment: production
  cutover: true
  run_migrate: false
```

**Opção B — Manual via Render Dashboard**:
1. Render → Web Service (production) → Environment
2. Definir `AUTHZ_V1_ENFORCE` = `1`
3. Clicar **Save Changes**

**Opção C — Manual via Render API**:
```bash
curl -X PATCH \
  -H "Authorization: Bearer <RENDER_API_KEY>" \
  -H "Content-Type: application/json" \
  "https://api.render.com/v1/services/<RENDER_PROD_SERVICE_ID>/env-vars" \
  -d '[{"key":"AUTHZ_V1_ENFORCE","value":"1"}]'
```

### 2.4 Aguardar restart em production (~30–45s)

```bash
# Polling até confirmar v1
for i in 1 2 3 4 5 6; do
  sleep 15
  MODE=$(curl -sf "https://<PROD_APP_URL>/api/health" | jq -r '.authzMode' || echo "unknown")
  echo "Attempt $i: authzMode=$MODE"
  [ "$MODE" = "v1" ] && break
done
```

---

## Fase 3 — Validação pós-cutover (ordem obrigatória)

Execute os seguintes checks **nesta ordem**. Na primeira falha, acionar rollback imediatamente.

### Ordem de validação

| Ordem | Check | Comando / Ação | Esperado |
|-------|-------|----------------|----------|
| 1 | Health endpoint | `GET /api/health` | `ok=true, db=up, authzMode=v1` |
| 2 | Login funcional | `POST /api/auth/login` (credencial válida) | HTTP 200 |
| 3 | Vacancy assume (OPERATOR) | Fluxo no app | Sucesso |
| 4 | Assignment approve (MANAGER) | Fluxo no app | Sucesso |
| 5 | Assignment approve por OPERATOR | Fluxo no app | HTTP 403 |
| 6 | Acesso cross-org | Fluxo com recurso de outra org | HTTP 403 |
| 7 | Audit trail | Query no banco | Entradas ALLOW para itens 2–4 |

### Verificação do audit trail pós-cutover

```sql
-- Confirmar decisões ALLOW para ações legítimas
SELECT description, created_at
FROM audit_trail
WHERE description LIKE '[AUTHZ_V1]%'
ORDER BY created_at DESC
LIMIT 20;
```

---

## Fase 4 — Monitoramento inicial obrigatório

**Duração mínima**: 15 minutos após validação pós-cutover.

| Sinal | Frequência | Ação se falhar |
|-------|-----------|----------------|
| `GET /api/health` | A cada 2 min | Rollback imediato se `ok=false` ou `authzMode!=v1` |
| Taxa de erro endpoints P0 | Contínuo | Rollback se > baseline + 2% |
| Logs de erro no Render | Contínuo | Investigar `[AUTHZ_V1]` entries com DENY |
| Audit trail DENY inesperados | A cada 5 min | Rollback se qualquer DENY para ator legítimo |

### Critério de "estável" (encerrar monitoramento ativo)

O monitoramento ativo pode ser encerrado quando:
- 15 minutos sem qualquer sinal de rollback
- Taxa de erro dentro do baseline
- Todos os checks de validação pós-cutover mantidos
- Sem reclamações de usuários

### Após estabilização

1. Notificar stakeholders: "AuthZ v1 está live em production desde [timestamp]"
2. Registrar no log de mudanças: data, hora, engenheiro, estado final
3. Agendar revisão do período de canary (30 dias) para remover fallback legado (fase P2)

---

## Rollback de emergência

Se qualquer check pós-cutover falhar → **acionar imediatamente** `docs/auth/authz-rollback-runbook-v1.md`.

TTR alvo: < 2 minutos desde a detecção do problema até `authzMode=legacy`.
