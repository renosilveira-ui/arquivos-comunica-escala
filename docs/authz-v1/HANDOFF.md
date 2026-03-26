# A14 — AuthZ v1 Release/CI/Rollback — Handoff v2 (Reframe G0)

**Agente**: A14 — Release, CI e Rollback  
**Onda**: 0  
**Data v2**: 2026-03-26 (revisado por H-1 review)  
**Domínio**: Exclusivo de pipeline, CI, gates e operações de cutover/rollback. Não altera semântica de auth.

> **Nota de reframe**: Este handoff v2 corrige o escopo do v1 conforme review do H-1.
> Itens que estavam fora de escopo de A14 (audit-trail, enforce.ts, testes de enforcement)
> foram removidos como "feito" e reclassificados como recomendações para A6/A12.
> Workflows operacionais foram reclassificados como PROPOSTA.

---

## Feito

### 1. Documentos formais de release entregues

| Documento | Caminho | Conteúdo |
|-----------|---------|----------|
| Release Gates | `docs/auth/authz-release-gates-v1.md` | O que precisa estar verde, testes obrigatórios, sinais de NO-GO, sinais de rollback, pré-condições de infra |
| Go/No-Go Checklist | `docs/auth/authz-go-no-go-checklist-v1.md` | Aprovações A1–A12, testes P0, shadow mode, secrets/infra, rollback testado, aprovação H-1 |
| Cutover Runbook | `docs/auth/authz-cutover-runbook-v1.md` | Canary em staging, duração mínima, critérios de promoção, ordem de validação pós-cutover, monitoramento |
| Rollback Runbook | `docs/auth/authz-rollback-runbook-v1.md` | Opção A (workflow), Opção B (API), Opção C (dashboard), TTR alvo, evidências, post-mortem |

### 2. Proposta de workflows automatizados

Os workflows existem como **PROPOSTA** — não são operacionais até que todos os gates do checklist estejam satisfeitos.

| Workflow | Status | Pré-condições para ativar |
|----------|--------|--------------------------|
| `.github/workflows/authz-rollout.yml` | PROPOSTA | A6 + A12 congelados, secrets configurados, staging validado |
| `.github/workflows/authz-rollback.yml` | PROPOSTA | Validado em staging antes de usar em production |

### 3. Gates de CI já ativos (não dependem de A6/A12)

| Workflow | Job | O que verifica |
|----------|-----|---------------|
| `pr-quality.yml` | typecheck | Zero erros de TypeScript (app + server) |
| `pr-quality.yml` | lint | Zero erros de lint |
| `pr-quality.yml` | test | Testes completos (com MySQL) |
| `pr-quality.yml` | authz-gate | `pnpm test:authz` com `AUTHZ_V1_ENFORCE=1` — bloqueia merge se enforcement regredir |
| `pr-quality.yml` | build | Build bem-sucedido |

### 4. Flag `AUTHZ_V1_ENFORCE` — infraestrutura de rollback sem redeploy

- **Arquivo**: `server/_core/env.ts` (responsabilidade de A6, não de A14)
- `ENV.authzV1Enforce` lê `process.env.AUTHZ_V1_ENFORCE` (default `"0"` = legado)
- Alteração do env var no Render reinicia o serviço automaticamente
- Documentado em todos os runbooks como mecanismo primário de rollback

---

## Evidência

| Item | Evidência |
|------|-----------|
| 4 documentos formais criados | `docs/auth/authz-*.md` — ver listagem acima |
| Gates de CI ativos | `pr-quality.yml` com 5 jobs incluindo authz-gate |
| Proposals de workflow | `authz-rollout.yml` e `authz-rollback.yml` com avisos de PROPOSTA no header |
| Checklist cobre todos os agentes | A1, A2, A3, A5, A6, A12, A14 listados explicitamente |
| Rollback documentado em 3 opções | A, B, C no `authz-rollback-runbook-v1.md` |
| TTR alvo definido | < 2 min (detecção → authzMode=legacy) |
| Canary definido com duração mínima | 1h mínimo em staging, 4–8h recomendado |

---

## Risco Aberto

| # | Risco | Severidade | Mitigação | Dependência |
|---|-------|------------|-----------|-------------|
| R1a | `authorize()` em `enforce.ts` usa `CONFLICT_DETECTED as any` como action type no audit — placeholder não resolvido | Média | **A6** deve resolver o placeholder em `server/authz/enforce.ts` ao congelar a engine de enforcement | **A6** |
| R1b | `server/audit-trail.ts` ainda não tem evento/enum específico para decisões AuthZ | Média | **A12** deve definir o contrato de evento de auditoria (enum, payload) em `server/audit-trail.ts` quando aplicável; não confundir com o placeholder em `enforce.ts` | **A12** |
| R2 | `ENV.authzV1Enforce` é lido na inicialização do módulo; restart é necessário para aplicar mudança | Baixa | Por design — Render reinicia automaticamente; documentado nos runbooks |
| R3 | Workflows de rollout/rollback são PROPOSTA — secrets ainda não configurados | Alta | Bloco 4 do checklist Go/No-Go; responsabilidade de Infra antes do cutover |
| R4 | Canary é boolean global — sem percentual por org ou allowlist | Baixa | Decisão arquitetural; documentado em `docs/authz-v1/CANARY_CRITERIA.md` |
| R5 | A6 e A12 não estão congelados — qualquer mudança em `enforce.ts` ou `audit-trail.ts` pode invalidar os gates | Alta | Go/No-Go checklist exige aprovação explícita de A6 e A12 antes do GO |
| R6 | Legado `rbac-validations.ts` permanece ativo em modo legacy — não há data de remoção | Baixa | Intencional; remoção física é P2 após 30 dias de production estável |

---

## Próximo Passo

### Para A14 (Release) na próxima janela

1. **Aguardar congelamento de A6 e A12** — Gates bloqueantes conforme bloco 1 do checklist
2. **Validar secrets de infra** — Bloco 4 do checklist com equipe de Infra
3. **Executar canary em staging** — Mínimo 1h com `AUTHZ_V1_ENFORCE=1`, monitorar sinais
4. **Testar rollback em staging** — Executar Opção B do `authz-rollback-runbook-v1.md` e confirmar TTR < 2 min
5. **Preenchimento do checklist Go/No-Go** — Junto com on-call e H-1 antes de agendar cutover
6. **Cutover staging → production** — Somente após checklist 100% ✅ e aprovação H-1

### Para outros agentes (dependências explícitas)

| Agente | Dependência de A14 | Ação necessária |
|--------|-------------------|-----------------|
| **A6** (enforcement) | R5 acima — `enforce.ts` deve ser congelado antes do GO | Congelar `server/authz/enforce.ts` (incluindo resolver placeholder R1a); obter aprovação H-1 |
| **A12** (audit trail) | R1b acima — evento/enum de auditoria AuthZ não definido ainda | Definir contrato de evento de auditoria em `server/audit-trail.ts` quando aplicável; **não modificar** `server/authz/enforce.ts` (domínio A6) |
| **A1** (schema) | Checklist bloco 1.1 | Migração em staging executada e aprovada |
| **A2** (autenticação) | Checklist bloco 1.2 | Fluxos de login validados em staging |
| **A3** (RBAC) | Checklist bloco 1.3 | Bundles congelados |
| **A5** (sessão) | Checklist bloco 1.4 | Actor builder estável |
| **Infra** | Checklist bloco 4 — **NÃO É AÇÃO DE G0**: somente executar após A6 e A12 aprovados finais e autorização explícita do H-1 | Configurar secrets `RENDER_API_KEY`, `RENDER_SERVICE_ID` e variable `APP_URL` nos environments `staging` e `production` |

### Arquivos de domínio A14 (não alterar sem escalar)

```
docs/auth/                              ← documentos formais de release (A14)
docs/authz-v1/                          ← docs legados (substituídos por docs/auth/)
.github/workflows/pr-quality.yml        ← gates de CI
.github/workflows/db-migrate.yml        ← workflow de migração
.github/workflows/authz-rollout.yml     ← PROPOSTA de rollout
.github/workflows/authz-rollback.yml    ← PROPOSTA de rollback
```

### Arquivos de outros domínios (A14 NÃO toca)

```
server/authz/enforce.ts          ← domínio A6
server/audit-trail.ts            ← domínio A12
tests/authz-enforce.test.ts      ← domínio A6
server/_core/env.ts              ← domínio A6 (flag AUTHZ_V1_ENFORCE)
server/authz/health.ts           ← domínio A6
```

