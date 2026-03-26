# AuthZ v1 — Rollback Runbook (v1)

**Documento**: `docs/auth/authz-rollback-runbook-v1.md`  
**Agente**: A14 — Release, CI e Rollback  
**TTR alvo**: < 2 minutos desde detecao do problema ate `authzMode=legacy`  
**Acionar quando**: qualquer sinal de rollback listado em `docs/auth/authz-release-gates-v1.md`

---

## TL;DR — Rollback instantaneo

O rollback do AuthZ v1 **nao requer redeploy**. Basta alterar o valor de
`AUTHZ_V1_ENFORCE` para `0` no Render. O servico reinicia automaticamente e
retorna ao modo legado em aproximadamente 30–45 segundos.

```
AUTHZ_V1_ENFORCE=0  →  authzMode=legacy  →  authorize() retorna ALLOW (LEGACY_BYPASS)
```

---

## Quando acionar o rollback

Iniciar rollback **imediatamente** se qualquer um dos seguintes ocorrer apos cutover:

| Sinal | Threshold |
|-------|-----------|
| `GET /api/health` retorna `ok: false` | Imediato |
| `authzMode` e `"v1"` mas fluxos P0 falham | Imediato |
| Taxa de erro em login/assign/approve sobe | > baseline + 2% |
| Usuario legitimo recebendo DENY no audit trail | Qualquer ocorrencia |
| `db: "down"` pós-cutover | Imediato |
| Surge de 5xx inexplicavel | > 5 em 1 minuto |
| Decisao do on-call | Qualquer P0 durante a janela |

---

## Opcao A — Rollback via workflow automatizado (recomendado se disponivel)

**Pre-requisito**: workflow `authz-rollback.yml` deve ter sido validado em staging antes de usar em producao.

```
Actions → AuthZ v1 Rollback
  environment: staging | production
  reason: <descricao curta do problema>
```

O workflow executa:
1. Registra o `authzMode` atual (pre-rollback)
2. Seta `AUTHZ_V1_ENFORCE=0` via Render API
3. Faz polling ate confirmar `authzMode=legacy`
4. Verifica `ok=true` e `db=up`
5. Gera summary com estado pre/pos e proximos passos

**Limitacao**: depende de `RENDER_API_KEY` e `RENDER_SERVICE_ID` configurados como GitHub Secrets. Se indisponiveis, usar Opcao B ou C.

---

## Opcao B — Rollback via Render API (manual rapido)

```bash
# Passo 1: Confirmar o estado atual
curl https://<APP_URL>/api/health
# Anotar: ok, db, authzMode

# Passo 2: Setar AUTHZ_V1_ENFORCE=0
curl -X PATCH \
  -H "Authorization: Bearer <RENDER_API_KEY>" \
  -H "Content-Type: application/json" \
  "https://api.render.com/v1/services/<RENDER_SERVICE_ID>/env-vars" \
  -d '[{"key":"AUTHZ_V1_ENFORCE","value":"0"}]'

# Passo 3: Aguardar ~45s
sleep 45

# Passo 4: Verificar retorno ao modo legado
curl https://<APP_URL>/api/health
# Esperado: {"ok":true,"db":"up","authzMode":"legacy","authzV1Enforce":false}
```

---

## Opcao C — Rollback via Render Dashboard (sem CLI)

1. Acessar [https://dashboard.render.com](https://dashboard.render.com)
2. Selecionar o Web Service do ambiente afetado
3. Ir em **Environment**
4. Localizar a variavel `AUTHZ_V1_ENFORCE`
5. Alterar o valor para `0`
6. Clicar **Save Changes** (o Render reinicia o servico automaticamente)

---

## Como verificar o retorno ao modo legado

### Verificacao de saude

```bash
curl https://<APP_URL>/api/health
```

Resposta esperada apos rollback:
```json
{
  "ok": true,
  "db": "up",
  "authzMode": "legacy",
  "authzV1Enforce": false,
  "timestamp": <unix_ms>
}
```

Se `authzMode` ainda estiver `"v1"` apos 60s:
- Confirmar que a variavel foi salva no Render
- Acionar restart manual: Render → Manual Deploy → Restart

### Polling de verificacao

```bash
# Fazer polling ate confirmar legacy (timeout de 2 min)
for i in $(seq 1 8); do
  sleep 15
  MODE=$(curl -sf "https://<APP_URL>/api/health" 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('authzMode','unknown'))" \
    2>/dev/null || echo "unknown")
  echo "Tentativa $i/8: authzMode=$MODE"
  [ "$MODE" = "legacy" ] && echo "ROLLBACK CONFIRMADO" && break
done
```

---

## Sinais a validar apos rollback

Execute os seguintes checks **nesta ordem** apos confirmar `authzMode=legacy`:

| Ordem | Check | Esperado |
|-------|-------|----------|
| 1 | `GET /api/health` | `ok=true, db=up, authzMode=legacy` |
| 2 | Login (usuario valido) | HTTP 200 / sucesso |
| 3 | Vacancy assume | Sucesso (sem bloqueio) |
| 4 | Assignment approve (MANAGER) | Sucesso |
| 5 | Taxa de erro P0 | Retornou ao baseline |

---

## Evidencia a coletar durante/apos rollback

| Item | Como coletar | Finalidade |
|------|-------------|------------|
| Timestamp de deteccao do problema | Anotar manualmente | Post-mortem |
| Timestamp de inicio do rollback | Anotar manualmente | Calculo do TTR |
| Timestamp de confirmacao de `authzMode=legacy` | Resposta do `/api/health` | Calculo do TTR |
| Resposta de `/api/health` pre-rollback | `curl /api/health` | Evidencia do estado com problema |
| Resposta de `/api/health` pos-rollback | `curl /api/health` | Evidencia da resolucao |
| Entradas do audit trail durante o incidente | Query SQL abaixo | Identificar DENY inesperados |
| Logs do Render durante o incidente | Render → Logs | Root cause |

**Query de evidencia do audit trail**:
```sql
-- Capturar decisoes AuthZ durante a janela do incidente
SELECT description, created_at
FROM audit_trail
WHERE description LIKE '[AUTHZ_V1]%'
  AND created_at >= '<timestamp_inicio_incidente>'
ORDER BY created_at ASC;
```

---

## TTR alvo

| Fase | Tempo alvo | Tempo maximo aceitavel |
|------|-----------|------------------------|
| Deteccao → inicio do rollback | < 30s | < 2 min |
| Inicio do rollback → `authzMode=legacy` | < 90s | < 3 min |
| **Total: Deteccao → modo legado** | **< 2 min** | **< 5 min** |

Se o TTR estiver acima do maximo aceitavel, escalar para H-1 e investigar o processo.

---

## O que o rollback NAO afeta

- **Schema do banco**: nenhuma mudanca de schema e revertida — as alteracoes do AuthZ v1 sao aditivas e retrocompativeis
- **Audit trail existente**: entradas `[AUTHZ_V1]` existentes permanecem no banco, nao afetam comportamento em runtime
- **Codigo legado**: `server/rbac-validations.ts` permanece intacto e assume o controle quando `authzMode=legacy`

---

## Notificacao e post-mortem

### Notificacao imediata (durante rollback)

Comunicar no canal de on-call:
```
[ROLLBACK INICIADO] AuthZ v1 revertido em <ambiente> em <timestamp>
Motivo: <descricao do problema>
Status: aguardando confirmacao de authzMode=legacy
```

### Notificacao de confirmacao (apos rollback)

```
[ROLLBACK CONFIRMADO] AuthZ v1 revertido em <ambiente>
authzMode=legacy ativo desde <timestamp>
TTR: <X> minutos
Proximos passos: post-mortem em 24h
```

### Post-mortem (em 24 horas)

Cobrir:
1. Root cause do sinal que acionou o rollback
2. Quais entradas do audit trail mostraram DENY/ALLOW inesperados
3. O que precisa ser corrigido antes de re-tentar cutover
4. TTR atingido vs TTR alvo

---

## Re-tentativa de cutover apos rollback

Antes de tentar cutover novamente:
1. Identificar e corrigir a causa raiz
2. Re-executar os blocos 2–5 do Go/No-Go checklist (`docs/auth/authz-go-no-go-checklist-v1.md`)
3. Re-testar com `AUTHZ_V1_ENFORCE=1` em staging (novo periodo de canary)
4. Obter aprovacao explicita do H-1
5. Re-executar o cutover via `docs/auth/authz-cutover-runbook-v1.md`
