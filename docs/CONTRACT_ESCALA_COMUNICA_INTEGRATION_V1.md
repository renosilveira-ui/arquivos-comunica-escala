# Contrato Oficial Escala+ ↔ Comunica+ — Integração V1

**Status:** PROPOSTA (contract-first, sem implementação)  
**Versão:** 1.0  
**Data:** 2026-08-29  
**Autores:** Arquitetura de Integração (análise documental)  
**Escopo:** substituir conceitualmente o contrato legado "Hospital Alert" por contratos reais e suportados pelo Comunica+ atual.

---

## 1. Resumo executivo

O Escala+ mantém **dois mundos de integração** com o Comunica+:

| Mundo | Estado | Mecanismo |
|-------|--------|-----------|
| **Legado "Hospital Alert"** | Contrato **obsoleto / não suportado** no Comunica+ atual | tRPC `auth.syncUser`, `shifts.start`, `shifts.end`, `integration.getStatus` via proxy + API key |
| **Integração real (V1)** | **Implementada e auditável** nos dois lados | `POST /api/integrations/duty-roster` (JWT `duty:sync`), SSO handoff (JWT RS256), outbox server-side (`comunica-plus.ts`) |

**Conclusão arquitetural:** o contrato oficial daqui para frente **não** é o Hospital Alert tRPC. É a combinação:

1. **Duty Sync** — registrar no Comunica+ a **declaração de plantão** derivada da confirmação de escala no Escala+ (assíncrono, outbox). Isto **não** é o mesmo que “início efetivo do plantão” no sentido temporal de `shifts.start` legado.
2. **SSO Handoff** — abrir o Comunica+ autenticado no browser do médico (síncrono, one-time).
3. **Outbox de notificações** — avisos estruturados no Comunica+ (escala publicada, troca aprovada) via conta de sistema (assíncrono, feature-flag).

O legado Hospital Alert deve ser **descontinuado** após migração. Enquanto `EXPO_PUBLIC_HOSPITAL_ALERT_ENABLED=false` (padrão atual), o hardening do PR #305 é seguro; **não** afirmar que a integração legada "continua funcional".

**Evidência de upstream (staging live, 2026-08-29):**

- `https://comunicamais-staging.onrender.com/api/trpc/auth.syncUser` → HTTP 404 `NOT_FOUND`
- Idem para `shifts.start`, `shifts.end`, `integration.getStatus`
- `POST /api/integrations/duty-roster` → HTTP 401 `invalid_token` (endpoint existe)

**AÇÃO NO RENDER (esta frente):** **NÃO** — documento apenas. Ver seção 15.

---

## 2. Contrato legado identificado

### 2.1 Superfície no Escala+

| Componente | Arquivo | Função |
|------------|---------|--------|
| Cliente | `lib/hospitalAlertClient.ts` | Chama proxy `/api/integrations/hospital-alert/*` |
| Orquestrador | `lib/integrationOrchestrator.ts` | `syncUser`, `startShift`, `endShift`, `getIntegrationStatus` |
| Fila offline | `lib/integrationQueue.ts`, `lib/integrationQueueProcessor.ts` | Retry/debounce no cliente |
| Hooks | `hooks/use-integration-manager.ts`, `hooks/use-hospital-alert-sync.ts` | Disparam no login e polling de escala |
| Provider | `components/IntegrationManagerProvider.tsx` | Gate: `EXPO_PUBLIC_HOSPITAL_ALERT_ENABLED` |
| Proxy | `server/routes/hospital-alert.ts` | Repassa para upstream tRPC com `Authorization: Bearer ${HOSPITAL_ALERT_API_KEY}` |
| Config cliente | `lib/hospitalAlertConfig.ts` | `ORGANIZATION_ID: "hsc"` hardcoded |

### 2.2 Procedures esperadas (upstream)

| Procedure | Método Escala+ | Payload principal |
|-----------|----------------|-------------------|
| `auth.syncUser` | POST `/sync-user` | `externalUserId`, `organizationId`, `name`, `email`, `role` |
| `shifts.start` | POST `/shifts/start` | `externalUserId`, `organizationId`, `serviceId`, `sectorId`, `coverageType`, `sourceApp` |
| `shifts.end` | POST `/shifts/end` | `externalUserId`, `organizationId`, `sourceApp` |
| `integration.getStatus` | GET `/status` | query: `externalUserId`, `organizationId` |

### 2.3 Identidade legada

- `externalUserId` = `shiftsapp:${escalaUserId}` (agora derivado server-side no proxy, commit `487cf3e`)
- `organizationId` = slug `"hsc"` no cliente; env `HOSPITAL_ALERT_ORG_ID` no servidor
- Auth upstream: Bearer API key (não existe handler equivalente no Comunica+ tRPC auditado)

### 2.4 Status no Comunica+

**Ref auditada:** `renosilveira-ui/Comunicamais` @ `main` / `4b604268`  
**Resultado:** procedures **ausentes** do `appRouter`. Nenhum middleware tRPC consome `Authorization: Bearer` como API key de integração Hospital Alert.

---

## 3. Capacidades reais do Comunica+

### 3.1 `POST /api/integrations/duty-roster`

**Arquivo:** `Comunicamais/app/api/integrations/duty-roster/route.ts`

| Aspecto | Contrato |
|---------|----------|
| **Auth** | JWT RS256 no header `Authorization: Bearer <token>` ou body `{ token }` |
| **JWKS** | `SSO_JWKS_URL` (mesma chave do SSO Escala+) |
| **Claims obrigatórios** | `scope: "duty:sync"`, `organizationId` (UUID), `email`, `action` (`CONFIRM` \| `WITHDRAW`), `dutyType` (`PLANTAO` \| `SOBREAVISO`), `dutyStart`, `dutyEnd` (ISO 8601), `jti`, `exp`, `iat` |
| **Issuer/Audience** | `SSO_EXPECTED_ISS` / `SSO_EXPECTED_AUD` |
| **Anti-replay** | `jti` consumido uma vez (`consumeJtiOnce`) |
| **Matching usuário** | `email` + `organizationId` → lookup em `users` (mesmo padrão SSO) |
| **Idempotência** | Chave natural `(organizationId, userId, dutyStartAt)` na tabela `duty_confirmations` |
| **Efeito** | Grava/atualiza `duty_confirmations` com `source: "ESCALA"` |
| **Erros** | `401 invalid_token`, `403 invalid_scope` / `user_inactive`, `404 user_not_found`, `400 invalid_request` |
| **Headers opcionais** | `Idempotency-Key`, `X-Escala-Confirmation-State` (observabilidade) |

### 3.2 `dutyRoster.*` (tRPC, sessão humana)

**Arquivo:** `Comunicamais/server/routers/duty-roster.ts`

- `declare`, `withdraw`, `listOnDuty` — **somente `ctx.userId`** (auto-declaração pelo profissional logado no Comunica+)
- **Não** substitui integração máquina-a-máquina do Escala+

### 3.3 `integrations.resolveUserIdByEmail` (tRPC)

**Arquivo:** `Comunicamais/server/routers/integrations.ts`

- `protectedProcedure` — exige sessão Comunica+ de usuário humano/admin
- Resolve `userId` por email dentro da org do ator
- Usado pelo outbox Escala+ (`server/integrations/comunica-plus.ts`), não pelo app mobile

### 3.4 SSO Handoff (Comunica+ como receptor)

- Escala+ assina JWT handoff (`server/sso/generate.ts`) com `organizationId`, `email`, `externalId: escala:user:{id}`
- Comunica+ valida JWKS, cria sessão browser
- Fluxo mobile: `launch-code` → redeem → form POST (`server/sso/launch.ts`)

### 3.5 Tenant isolation (Comunica+)

- Middleware `mesmoHospitalDoInput` em `server/trpc.ts`
- `assertSameOrganization` em `server/lib/authz-org.ts`
- Testes: `server/routers/cross-org-tenant.test.ts`

### 3.6 Outbox Escala+ → Comunica+ (notices)

**Arquivo:** `server/integrations/comunica-plus.ts`

- Auth: `auth.login` com conta de sistema (`COMUNICA_PLUS_SYSTEM_EMAIL/PASSWORD/PIN`)
- Resolve destinatário por email → `integrations.resolveUserIdByEmail` → `notices.createStructuredNotice`
- Eventos: `ROSTER_PUBLISHED`, `SHIFT_SWAP_APPROVED`
- Feature flag: `COMUNICA_PLUS_OUTBOUND_ENABLED=0` (fail-closed em staging Blueprint)

---

## 4. Necessidades reais do Escala+

### 4.1 Fluxo A — Sincronizar perfil do profissional

| Pergunta | Resposta |
|----------|----------|
| Quem inicia? | Cliente (`use-integration-manager.ts`) no login |
| Evento | Usuário autenticou no Escala+ |
| Dado necessário no Comunica+ | `name`, `email`, `role`, vínculo org |
| Tipo | Comando (legado: `syncUser`) |
| Síncrono? | Tentativa imediata + fila offline |
| Pode ser assíncrono? | Sim |
| Impacto se falhar | Baixo — Comunica+ já faz matching por **email** no duty-roster e SSO |

**Achado:** não há procedure equivalente no Comunica+. O matching por email no duty-roster e SSO **substitui** a necessidade de sync de perfil, desde que o usuário exista no Comunica+ com o mesmo email.

### 4.2 Fluxo B — Registrar declaração de plantão (CONFIRM)

| Pergunta | Resposta |
|----------|----------|
| Quem inicia? | **Duas implementações concorrentes:** |
| | (B1) Cliente legado: `startShift` ao detectar escala ativa (`shiftDetector.ts` — **ainda usa DEMO_SHIFTS**) |
| | (B2) **Real:** servidor em `confirmation-router.ts` → `enqueueDutySync(CONFIRM)` na confirmação de presença |
| Evento | Médico **confirmou presença** na escala oficial (evento de negócio no Escala+) |
| Dado necessário | `email`, `organizationId`, `dutyStart/End`, `dutyType`, `action: CONFIRM` |
| Tipo | Comando / evento de **declaração** |
| Síncrono? | Outbox assíncrono (worker cron) |
| Impacto se falhar | **Alto** — Comunica+ não reflete a declaração; roteamento operacional degradado |

**Semântica importante — CONFIRM ≠ início efetivo de plantão:**

| Conceito | O que significa |
|----------|-----------------|
| `CONFIRM` (duty-roster) | “Este profissional **declara/assume** o plantão do turno X no Comunica+”, disparado pela **confirmação de escala** no Escala+ |
| `shifts.start` (legado) | “Iniciar plantão **agora**”, disparado por detector temporal no cliente (horário de escala ativa) |
| Início efetivo operacional | Pode coincidir com `dutyStart`, mas **não é modelado** como evento separado no contrato V1 |

O Comunica+ grava `duty_confirmations.confirmed_at` no `CONFIRM`; o intervalo do turno vem de `dutyStart`/`dutyEnd` no JWT. Não há equivalente auditado a um comando “start now” desacoplado da confirmação.

**Fonte de verdade:** fluxo B2 (duty-sync server-side), não B1.

### 4.3 Fluxo C — Retirar declaração de plantão (WITHDRAW)

| Pergunta | Resposta |
|----------|----------|
| Quem inicia? | (C1) Cliente legado: `endShift` quando escala termina (detector temporal) |
| | (C2) **Real:** `enqueueDutySync(WITHDRAW)` em recusa/troca/substituição (`confirmation-router.ts`) |
| Evento | Declaração **revogada** por evento de negócio (recusa, troca aceita, etc.) |
| Dado | `action: WITHDRAW`, mesmo envelope de identidade |
| Impacto se falhar | Médio — plantonista pode permanecer declarado no Comunica+ |

**Semântica importante — WITHDRAW ≠ equivalência perfeita de `shifts.end`:**

| Conceito | Cobertura no V1 |
|----------|-----------------|
| `shifts.end` (legado) | Encerramento **temporal** automático quando a escala deixa de estar ativa no cliente |
| `WITHDRAW` (duty-roster) | Revogação da **declaração** quando há evento explícito no fluxo de confirmação |

**Atendimento parcial:** `WITHDRAW` cobre recusa, troca e compensações modeladas em `confirmation-router.ts`. **Não cobre** automaticamente o fim natural do turno se nenhum evento de confirmação disparar `WITHDRAW` — gap conhecido que pode exigir job de reconciliação (Fase 2/PR-E) ou extensão futura do contrato.

### 4.4 Fluxo D — Consultar status da integração

| Pergunta | Resposta |
|----------|----------|
| Quem inicia? | `use-hospital-alert-sync.ts` (não wired no provider atual; provider usa `use-integration-manager`) |
| Evento | UI quer mostrar "conectado / plantão ativo" |
| Dado | Estado upstream de sync e shift |
| Tipo | Consulta |
| Síncrono? | Sim |
| Impacto se falhar | Baixo (UX) — não bloqueia operação clínica |

**Achado:** Comunica+ **não** expõe `integration.getStatus`. Status deve ser **derivado localmente** (último duty-sync SENT/FAILED) ou nova API read-only futura.

### 4.5 Fluxo E — SSO para Comunica+

| Pergunta | Resposta |
|----------|----------|
| Quem inicia? | Usuário ("Abrir Comunica+") ou auto-SSO pós-confirmação |
| Evento | Handoff browser/mobile |
| Dado | JWT handoff com identidade + plantão ativo |
| Tipo | Comando síncrono |
| Impacto se falhar | Médio — usuário faz login manual no Comunica+ |

**Arquivos:** `server/sso/generate.ts`, `server/sso/launch.ts`, `hooks/use-sso-handoff.ts`

### 4.6 Fluxo F — Notificações estruturadas (outbox)

| Pergunta | Resposta |
|----------|----------|
| Quem inicia? | Servidor (`month-guards.ts`, `swap-router.ts`) |
| Evento | Escala publicada / troca aprovada |
| Dado | Template + `targetUserId` resolvido por email |
| Tipo | Evento assíncrono |
| Impacto se falhar | Baixo/médio — aviso não chega, escala local permanece |

### 4.7 Fluxo G — Worker de entrega

| Pergunta | Resposta |
|----------|----------|
| Quem inicia? | Cron `shift-confirmation-dispatcher.ts` |
| Processa | `processPendingDutySyncs`, `processPendingComunicaPlusOutbox`, push |
| Onde roda | **Mesmo processo web** Escala+ (sem worker Render separado hoje) |

---

## 5. Gap analysis

| Necessidade Escala+ | Contrato legado | Capacidade Comunica+ atual | Gap | Ação recomendada |
|---------------------|-----------------|----------------------------|-----|------------------|
| Sync perfil no login | `auth.syncUser` | Matching por email (duty-roster, SSO) | **Não atende como API dedicada; atende semanticamente** | **Descontinuar** `syncUser`; garantir usuários com mesmo email |
| Início de plantão (confirmação oficial) | `shifts.start` | `duty-roster` `CONFIRM` | **Atende semanticamente como declaração**, não como “start now” temporal | **Promover** duty-sync; não chamar CONFIRM de `shifts.start` |
| Início de plantão (detector temporal cliente) | `shifts.start` | — | **Não atende** (e detector usa demo data) | **Remover** polling cliente; confiar em confirmação + cron |
| Fim de plantão | `shifts.end` | `duty-roster` `WITHDRAW` | **Atende parcialmente** — só onde há evento de confirmação explícito; **não** cobre término temporal automático | Mapear encerramentos de negócio para `WITHDRAW`; avaliar reconciliação/cron |
| Status integração | `integration.getStatus` | — | **Não atende** | Status local via outbox + métricas; API read futura opcional |
| Abrir Comunica+ logado | — | SSO handoff JWT | **Atende** | Manter e documentar como contrato separado |
| Aviso escala publicada | — | `notices.createStructuredNotice` via outbox | **Atende** (flag off) | Habilitar `COMUNICA_PLUS_OUTBOUND_ENABLED` após gate operacional |
| Auth máquina-a-máquina plantão | API key Bearer | JWT `duty:sync` RS256 | Legado **inexistente** no Comunica+ | **Adotar** JWT duty:sync exclusivamente |
| Tenant org | slug `"hsc"` | UUID + `SSO_ORG_MAP` | Formato incompatível | **Usar** `SSO_ORG_MAP` como única fonte |
| Identidade profissional | `shiftsapp:{id}` | `email` + lookup (correlação atual) | Modelos diferentes | **Abandonar** `externalUserId` livre; usar correlação assinada no JWT; evoluir para mapping UUID |

---

## 6. Modelo de identidade

### 6.1 Identificador de correlação atual (V1)

No V1, o elo entre Escala+ e Comunica+ é o **email normalizado** (`externalSubject` no duty-sync, claim `email` no JWT). Isto é um **identificador de correlação operacional**, não uma identidade canônica eterna:

- Funciona porque ambos os sistemas fazem lookup em `users.email` dentro da mesma `organizationId`.
- É frágil a troca de email, contas duplicadas ou divergência de cadastro.
- O JWT assina o email no momento da emissão; o Comunica+ revalida contra o registro vivo.

**Evolução recomendada (V2+):** mapping explícito `escalaUserId` ↔ `comunicaUserId` (UUID↔UUID), persistido server-side no Escala+, com email como atributo mutável — não como chave primária cross-system.

### 6.2 Fontes de verdade (V1)

| Entidade | Fonte de verdade | Formato | Observação |
|----------|-------------------|---------|------------|
| Correlação cross-system (V1) | **Email** normalizado lowercase | `user@hospital.com` | Lookup no Comunica+ (`users.email` + `organizationId`); **não** identidade canônica permanente |
| Usuário Escala+ | `users.id` (numérico) | interno | Candidato a chave estável em mapping V2+ |
| Usuário Comunica+ | `users.id` (UUID) | interno | Resolvido server-side por email hoje; alvo de mapping V2+ |
| Organização | `SSO_ORG_MAP` | `institutionId` → UUID Comunica+ | Injétivo; fail-closed se ausente |
| Plantão | `duty_confirmations` + snapshot Escala+ | `dutyStart`/`dutyEnd` ISO, `dutyType` | Chave idempotente inclui `dutyStartAt` |
| Estabelecimento | `institutionId` Escala+ | numérico | Mapeado para org UUID |

### 6.3 O que NÃO usar

- `externalUserId` fornecido pelo cliente (`shiftsapp:*` como input confiável)
- Slug `"hsc"` hardcoded no bundle
- `organizationId` escolhido pelo cliente em query/body

### 6.4 Claims JWT duty:sync (oficial)

Emitidos **somente** pelo servidor Escala+ (`server/sso/duty-sync.ts`):

```
scope: "duty:sync"
iss: SSO_ISSUER (ex: escalas-app)
aud: SSO_AUDIENCE (ex: comunicamais)
sub: email do profissional
organizationId: UUID Comunica+ (de SSO_ORG_MAP)
email: mesmo que sub
action: CONFIRM | WITHDRAW
dutyType: PLANTAO | SOBREAVISO
dutyStart, dutyEnd: ISO 8601 do turno real
sourceSequence: id da notification/outbox row
idempotencyKeySha256: hash da dedupKey
jti: UUID único
exp: ~90s
```

---

## 7. Modelo de autenticação máquina-a-máquina

### 7.1 Comparação

| Mecanismo | Adequação duty sync | Estado |
|-----------|---------------------|--------|
| **A. API key Bearer** (Hospital Alert) | Ruim — sem scope, sem replay protection no Comunica+ | **Não suportado** no Comunica+ auditado |
| **B. JWT RS256 `duty:sync`** | **Ideal** — já implementado bilateralmente | **Adotar** |
| C. HMAC | Possível, mas duplicaria SSO | Não recomendado |
| D. OAuth client credentials | Overhead novo | Não necessário |
| E. Sessão sistema (`auth.login`) | Adequado para **outbox notices**, não para duty | Já usado em `comunica-plus.ts` |

### 7.2 Decisão

**Usar JWT RS256 com scope `duty:sync`** para duty-roster.

**Por quê:**

- Implementado e testado (`tests/confirmation-boundaries.test.ts`, `Comunicamais/app/api/integrations/duty-roster/route.ts`)
- Mesma PKI do SSO (`SSO_PRIVATE_KEY_JWK` / JWKS)
- Anti-replay via `jti`
- Scope limitado (`duty:sync` ≠ handoff SSO)
- TTL curto (90s)

**Rotação:** `SSO_KID` + rotação de JWK; Comunica+ consome JWKS remoto.

**Prevenção replay:** `jti` one-time store no Comunica+.

---

## 8. Contrato oficial proposto (V1)

### 8.1 Duty Sync — registrar declaração de plantão (CONFIRM / WITHDRAW)

| Campo | Valor |
|-------|-------|
| **METHOD** | `POST` |
| **PATH** | `/api/integrations/duty-roster` |
| **AUTH** | `Authorization: Bearer <JWT duty:sync>` |
| **INPUT (claims JWT)** | Ver seção 6.4 |
| **SEMÂNTICA** | `CONFIRM` = registrar declaração de plantão (não é `shifts.start` temporal). `WITHDRAW` = revogar declaração (cobertura **parcial** vs `shifts.end`; ver §4.3) |
| **INPUT (body opcional)** | `{ "sourceSequence": <number> }` |
| **HEADERS opcionais** | `Idempotency-Key`, `X-Escala-Confirmation-State` |
| **OUTPUT (200)** | `{ "ok": true, "action": "CONFIRM"\|"WITHDRAW", "reactivated"?: boolean, "existed"?: boolean }` |
| **ERRORS** | `401` token inválido/expirado/replay; `403` scope/usuário inativo; `404` user_not_found; `400` payload inválido; `503` JWKS ausente |
| **IDEMPOTENCY** | `(organizationId, userId, dutyStartAt)` no Comunica+; `dedupKey` no outbox Escala+ |
| **AUDIT** | `logAuditStrict` no Comunica+ (`DUTY_SYNC_CONFIRMED` / `DUTY_SYNC_WITHDRAWN`) |
| **RETRY** | Outbox Escala+ com backoff exponencial até 30min |
| **TIMEOUT** | Escala+: 15s; recomendado manter |

**Quem emite:** apenas `server/sso/duty-sync.ts` (nunca o app cliente).

### 8.2 Duty Sync — consumo (lado Escala+)

| Campo | Valor |
|-------|-------|
| **Trigger** | Mutações em `confirmation-router.ts` (confirm, decline, replacement, etc.) |
| **Enqueue** | `enqueueDutySync(...)` na mesma transação da confirmação |
| **Process** | `processPendingDutySyncs()` no cron (`shift-confirmation-dispatcher.ts`) |
| **Destino URL** | `SSO_TARGET_URL` (não `HOSPITAL_ALERT_URL`) |

### 8.3 SSO Handoff — abrir Comunica+

| Campo | Valor |
|-------|-------|
| **METHOD** | `POST` (form) após redeem de launch-code |
| **PATH** | Endpoint Comunica+ de exchange SSO (receptor) |
| **AUTH** | JWT handoff RS256, scope handoff (distinto de `duty:sync`) |
| **INPUT** | `handoffToken`, `clientNonce`, `organizationId`, claims de plantão |
| **OUTPUT** | Sessão cookie no browser Comunica+ |
| **IDEMPOTENCY** | `jti` / launch-code one-time |
| **TIMEOUT** | 90s TTL token |

*Detalhe do endpoint receptor Comunica+: fora do escopo deste documento; validar no repo Comunica+ antes de implementação.*

### 8.4 Outbox — notificação estruturada

| Campo | Valor |
|-------|-------|
| **Trigger** | Publicação de escala / aprovação de troca |
| **AUTH** | Sessão `auth.login` conta sistema |
| **Procedures** | `integrations.resolveUserIdByEmail`, `notices.createStructuredNotice` |
| **INPUT** | `templateCode`, `targetUserId` (UUID Comunica+), `organizationId`, `pin` sistema |
| **RETRY/OUTBOX** | `processPendingComunicaPlusOutbox()` |
| **FLAG** | `COMUNICA_PLUS_OUTBOUND_ENABLED=1` |

### 8.5 Status operacional (proposto — não existe hoje)

| Campo | Valor |
|-------|-------|
| **METHOD** | `GET` (proposta) |
| **PATH** | `/api/integrations/escala/duty-sync-status` (Escala+ interno) ou leitura de `notifications.providerReceipt` |
| **AUTH** | Sessão Escala+ |
| **OUTPUT** | Último duty-sync por confirmação: `SENT` / `PENDING` / `FAILED` |
| **Nota** | Substitui `integration.getStatus` legado sem exigir API nova no Comunica+ |

---

## 9. Estratégia de migração

### Fase 0 — Gate (concluído parcialmente)

- [x] Confirmar procedures legadas 404 no staging Comunica+
- [x] Confirmar duty-roster existe
- [ ] Ler `HOSPITAL_ALERT_URL` real no Render Dashboard (produção)
- [ ] Confirmar commit/ref do serviço upstream se URL ≠ Comunica+ staging

### Fase 1 — Congelar legado (sem quebrar)

- Manter `EXPO_PUBLIC_HOSPITAL_ALERT_ENABLED=false` (já padrão)
- PR #305 merge como **hardening** (APROVADO CONDICIONALMENTE)
- Documentar que proxy legado é **deprecated**

### Fase 2 — Promover duty-sync

- Garantir `SSO_ORG_MAP` completo em todos os tenants
- Garantir emails Escala+ = emails Comunica+ para profissionais integrados
- Validar cron processa `processPendingDutySyncs` em produção
- Testes de ponta a ponta: confirmar presença → plantonista visível no Comunica+

### Fase 3 — Remover superfície legada

- Remover `IntegrationManagerProvider` / hooks Hospital Alert
- Remover `server/routes/hospital-alert.ts` e envs `HOSPITAL_ALERT_*`
- Remover `lib/hospitalAlert*` e fila offline cliente
- Migrar UI de status para leitura do outbox duty-sync

### Fase 4 — Habilitar outbox notices

- Gate operacional `COMUNICA_PLUS_OUTBOUND_ENABLED`
- Conta sistema + PIN no Comunica+
- Validar templates `ROSTER_PUBLISHED`, `SHIFT_SWAP_APPROVED`

### Compatibilidade

| Superfície | Estratégia |
|------------|------------|
| Escala+ web | Flag off → zero chamadas legadas; sem regressão |
| Escala+ mobile | Idem; SSO handoff inalterado |
| Comunica+ | Sem mudança — já consome duty-roster |
| Usuários existentes | Email como correlação V1; sem migração de `shiftsapp:id`; planejar mapping UUID V2+ |
| Plantões atuais | Re-sync via confirmações pendentes ou job de reconciliação |
| Sessões | Independentes; SSO não afetado |
| SSO/outbox | Permanecem; são o caminho real |

---

## 10. Env vars futuras

### Manter (contrato V1)

| Variável | Serviço | Função |
|----------|---------|--------|
| `SSO_TARGET_URL` | Escala+ web | Base URL Comunica+ para duty-sync e SSO |
| `SSO_ISSUER` | Escala+ web | Issuer JWT |
| `SSO_AUDIENCE` | Escala+ web | Audience JWT |
| `SSO_KID` | Escala+ web | Key ID JWKS |
| `SSO_PRIVATE_KEY_JWK` | Escala+ web | Chave privada assinatura |
| `SSO_ORG_MAP` | Escala+ web | Map institution → org UUID |
| `COMUNICA_PLUS_URL` | Escala+ web | Outbox notices |
| `COMUNICA_PLUS_SYSTEM_*` | Escala+ web | Conta sistema outbox |
| `COMUNICA_PLUS_OUTBOUND_ENABLED` | Escala+ web | Gate outbox |
| `SSO_JWKS_URL` / `SSO_EXPECTED_*` | Comunica+ web | Validação JWT |

### Descontinuar (após Fase 3)

| Variável | Motivo |
|----------|--------|
| `HOSPITAL_ALERT_URL` | Contrato upstream inexistente |
| `HOSPITAL_ALERT_API_KEY` | Auth model obsoleto |
| `HOSPITAL_ALERT_ORG_ID` | Substituído por `SSO_ORG_MAP` |
| `EXPO_PUBLIC_HOSPITAL_ALERT_ENABLED` | Feature legada |

### Renomear (recomendação futura, não nesta frente)

| De | Para (sugestão) |
|----|-----------------|
| "Hospital Alert" (código/docs) | `ComunicaDutySync` / `COMUNICA_DUTY_SYNC` |
| `hospital-alert` (rota proxy) | Remover, não renomear |

---

## 11. Deprecações

| Item | Ação | Prazo sugerido |
|------|------|----------------|
| tRPC `auth.syncUser` / `shifts.*` / `integration.getStatus` | **Deprecar** (já ausentes no Comunica+) | Imediato |
| `lib/hospitalAlertClient.ts` e orquestrador cliente | **Remover** após Fase 3 | Pós-validação duty-sync |
| `server/routes/hospital-alert.ts` | **Remover** | Pós-validação duty-sync |
| `shiftDetector.ts` demo-based para integração | **Remover** uso em integração | Com remoção do legado |
| `use-hospital-alert-sync.ts` | **Remover** (não wired no provider) | Limpeza |
| Slug `"hsc"` em `hospitalAlertConfig.ts` | **Remover** com legado | Fase 3 |

---

## 12. Riscos

| Risco | Severidade | Mitigação |
|-------|------------|-----------|
| Duplicidade B1 (cliente) vs B2 (servidor) para plantão | Alta | Desligar legado; uma fonte de verdade |
| Email divergente entre sistemas | Alta | Validação no onboarding; alerta em duty-sync `user_not_found`; evoluir para mapping UUID |
| `WITHDRAW` não cobre término temporal automático | Média | Job reconciliação ou extensão contrato V2 |
| `SSO_ORG_MAP` incompleto | Alta | Fail-closed já implementado (`UNMAPPED_COMUNICA_ORGANIZATION`) |
| `HOSPITAL_ALERT_URL` em produção aponta para serviço desconhecido | Média | Gate Dashboard Render |
| Outbox single-instance (memória) | Média | `numInstances: 1` documentado em `render.yaml` |
| Confundir duty-sync com SSO handoff | Média | Scopes distintos; documentação |
| Remover legado antes de duty-sync validado | Alta | Critérios de aceite seção 13 |

---

## 13. Critérios de aceite

1. Médico confirma plantão no Escala+ → em até N minutos aparece em `duty_confirmations` Comunica+ com `source: "ESCALA"`.
2. Recusa/troca gera `WITHDRAW` idempotente no Comunica+.
3. Nenhuma chamada do app cliente para procedures tRPC legadas em produção.
4. `EXPO_PUBLIC_HOSPITAL_ALERT_ENABLED` removido ou permanentemente `false` até Fase 3 completa.
5. SSO handoff continua funcionando sem regressão.
6. Logs/auditoria duty-sync rastreáveis por `confirmationId` / `sourceSequence`.
7. Testes automatizados `confirmation-boundaries` e probe staging verdes.

---

## 14. Plano em PRs pequenos

| PR | Escopo | Risco |
|----|--------|-------|
| PR-A | Documentação + marcar legado `@deprecated` em comentários | Baixo |
| PR-B | Remover `IntegrationManagerProvider` quando flag sempre false | Baixo |
| PR-C | UI status local via outbox duty-sync (substitui `getIntegrationStatus`) | Médio |
| PR-D | Remover proxy `hospital-alert` + envs Blueprint | Médio |
| PR-E | Job reconciliação plantões (opcional) | Médio |
| PR-F | Habilitar `COMUNICA_PLUS_OUTBOUND_ENABLED` com runbook | Médio |

**Ordem:** A → validação operacional duty-sync → C → D → F → E (opcional)

---

## 15. Ação no Render

### Nesta frente (documental)

**AÇÃO NO RENDER: NÃO**

Nenhuma alteração de env, deploy ou serviço.

### Futura implementação (referência)

| Serviço | Alteração provável |
|---------|-------------------|
| **Escala+ web** | Remover `HOSPITAL_ALERT_*`; manter `SSO_*`, `COMUNICA_PLUS_*` |
| **Escala+ worker** | **NÃO** — cron roda no web hoje |
| **Comunica+ web** | Garantir `SSO_JWKS_URL` aponta para Escala+; sem mudança de API |
| **Comunica+ worker** | **NÃO** para duty-sync |
| **Expo build** | Remover `EXPO_PUBLIC_HOSPITAL_ALERT_ENABLED` do bundle (rebuild) |

### Verificação pendente (somente leitura)

1. Dashboard Render → `escalas-staging` → Environment → valor real de `HOSPITAL_ALERT_URL`
2. Se URL = `comunicamais-staging.onrender.com` → contrato legado **confirmadamente inválido**
3. Se URL = outro host → auditar esse artefato antes de qualquer remoção

---

## Apêndice A — Referências de código

### Escala+

- `server/sso/duty-sync.ts` — emissor JWT + outbox
- `server/confirmation-router.ts` — triggers CONFIRM/WITHDRAW
- `server/integrations/comunica-plus.ts` — outbox notices
- `server/sso/generate.ts` — SSO handoff
- `lib/integrationOrchestrator.ts` — legado cliente
- `server/routes/hospital-alert.ts` — proxy legado (deprecated)

### Comunica+

- `app/api/integrations/duty-roster/route.ts` — receptor duty sync
- `server/routers/duty-roster.ts` — auto-declaração humana
- `server/routers/integrations.ts` — resolve email (sessão)
- `server/trpc.ts` — tenant middleware

---

## Apêndice B — Veredito de integração

> O contrato oficial Escala+ → Comunica+ V1 é **Duty Sync via JWT `duty:sync`**, complementado por **SSO Handoff** e **Outbox de Notices**. O contrato Hospital Alert tRPC está **obsoleto e não suportado** pelo Comunica+ atual.
