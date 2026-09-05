# Contrato — Escala+ Conversational Operations V1

Documento normativo do canal WhatsApp. Este incremento (A) materializa
somente a porta de entrada: transporte autenticado, identidade canônica e
persistência técnica. Não materializa troca nem cessão.

## Inventário Twilio (read-only)

`TWILIO_LIVE_INVENTORY_UNAVAILABLE` — o conector Twilio Developer Kit não
está acessível neste ambiente. Nenhum Account, sender, Messaging Service,
webhook, sandbox, Verify Service ou Content Template foi lido ou alterado.
Nenhum estado Twilio real foi inventado. A implementação usa abstração de
provider + testes locais com o validador oficial `twilio.validateRequest`.

## Canais de conteúdo

| Kind | Nesta PR | Depois |
|---|---|---|
| `TEXT` | classifica e persiste `operational_text` temporário | Incremento B: NL |
| `AUDIO` | classifica e persiste `media_url` temporário; **não** baixa/transcreve | Incremento D |
| `FORWARDED_TEXT` | texto com `forwarded=true` no envelope; continua `TEXT` | ator = remetente do canal, não o terceiro citado |
| `UNSUPPORTED_MEDIA` | classifica; sem OCR/interpretação | copy futura: texto ou áudio |

## Intents de negócio V1 (futuras — fora desta PR)

- `SWAP`
- `CESSAO`

Não parsear, não resolver, não chamar `createSwapOffer`.

## Autoridades (separação rígida)

| Superfície | Autoridade |
|---|---|
| Twilio | transporte (assinatura, MessageSid, From, mídia) |
| `user_contact_channels` | correlação canal → usuário canônico |
| `resolveCanonicalOperationalActorForUser` (B2-B) | userId autenticado → professionalId + institutionIds |
| NL Core (`server/natural-language/`) | interpretação futura (texto → slots) |
| Resolver | entidades futuras (slots → IDs); revalida membership |
| `createSwapOffer` | autoridade de negócio (#326) — **não chamada aqui** |
| App destinatário | aceite/recusa V1 |

WhatsApp **não** é autoridade de `userId`, `professionalId`,
`institutionId`, `hospitalId`, `sectorId`, `shiftInstanceId`,
`assignmentId`, autorização, papel ou eligibility.

## Regra de inferência

Um atributo omitido pode ser inferido somente quando as demais restrições
aplicadas ao estado canônico produzem exatamente um candidato. Zero gera
`NOT_FOUND`; mais de um gera `AMBIGUOUS`. Ordenação, probabilidade ou
primeiro resultado nunca constituem autoridade.

## Encaminhadas (forwarded)

Texto atribuído a terceiro dentro de mensagem encaminhada **não** equivale
a ação autenticada desse terceiro. O ator futuro é quem enviou ao Escala+
(From verificado). Metadata `Forwarded=true` é preservada no envelope, não
é autoridade conversacional.

## Confirmação e revalidação (futuro)

Nenhuma operação materializa sem confirmação explícita do solicitante.
Todo SIM futuro revalida o estado canônico no momento da execução.

## URL canônica da assinatura

A validação `X-Twilio-Signature` usa **somente**
`resolveTrustedPublicBaseUrl()` (`APP_PUBLIC_URL` em produção) +
`/api/integrations/twilio/whatsapp`.

Headers `Host` / `X-Forwarded-*` da requisição **não** entram na URL de
assinatura (são controláveis pelo cliente). Express já tem `trust proxy = 1`
para rate-limit; isso **não** substitui a URL pública configurada.

Parâmetros do formulário inbound só entram na validação se a chave for
alfanumérica estilo Twilio (`MessageSid`, `MediaUrl0`) e não for
`constructor` / `prototype`. Chaves como `__proto__` são descartadas
antes de `validateRequest` — a assinatura usa só o conjunto filtrado.

Se `APP_PUBLIC_URL` não resolver para uma origem confiável: **503**
`TWILIO_SIGNATURE_CANONICAL_URL_UNRESOLVED`. A validação **nunca** é
desligada.

URL pública esperada em staging: `https://escalas-staging.onrender.com/api/integrations/twilio/whatsapp`.

## Segredo

`TWILIO_AUTH_TOKEN` — só o **nome**. Ausente → fail-closed **503**
`TWILIO_WEBHOOK_NOT_CONFIGURED`. Não vai para o repo, `EXPO_PUBLIC_*`,
mobile, logs ou Render nesta PR.

## HTTP

| Condição | Status |
|---|---|
| Secret ou URL canônica ausente | 503 |
| `X-Twilio-Signature` ausente/inválida | 403 |
| MessageSid ausente / envelope malformado | 400 |
| Falha retryable / incompleta (Twilio deve retentar) | 503 |
| Row terminal do mesmo MessageSid | 200 (replay / no-op) |
| Aceite terminal (identidade ou READY_FOR_*) | 200 (ACK vazio, sem TwiML) |

Corpo de erro sem detalhes internos. 5xx só para falha retentável;
estado terminal corretamente processado nunca devolve 5xx.

## Modelo: fila assíncrona (não processamento síncrono)

O webhook autentica, classifica e **persiste material suficiente** para o
próximo estágio. Não chama NL Core nem baixa/transcreve áudio.

`READY_FOR_*` significa: **há material persistido suficiente para o próximo estágio**.
Sem esse material a linha **não** pode ficar `READY_FOR_*`.

## Estados de inbound

Incompletos / retomáveis (mesmo MessageSid **retoma**; HTTP **503**):

- `RECEIVED`
- `IDENTIFIED` (reservado; não é terminal)
- `RETRYABLE` — DB indisponível, falha transitória de identidade, erro
  interno de infra antes de estado terminal

Terminais (mesmo MessageSid → **200 replay / no-op**):

- `IDENTITY_NOT_FOUND`
- `IDENTITY_CONFLICT`
- `UNSUPPORTED`
- `READY_FOR_NL` — TEXT com `operational_text` persistido
- `READY_FOR_TRANSCRIPTION` — AUDIO com `media_url` persistido

Banco indisponível **nunca** vira `IDENTITY_NOT_FOUND`.
Não existe ACK terminal `FAILED`: falha transitória após INSERT fica
`RETRYABLE` para a Twilio retentar o mesmo MessageSid.

Corrida `UNIQUE (provider, provider_message_id)`: o perdedor carrega a
row e segue as mesmas regras. Nunca duas rows / duas operações.

## Persistência

Tabela `whatsapp_inbound_messages` com
`UNIQUE (provider, provider_message_id)`.

Incremento B1 cria `whatsapp_pending_intents` como memória de conversa.
Pending **não** é autoridade de acesso, elegibilidade, instituição ou
swap. O inbound **não** cria pending: continua parando em `READY_FOR_NL`.
O consumer futuro (B2+) é quem fará `READY_FOR_NL` → pending.

### Decisão de schema: status + stage (alternativa A)

`CONFIRMED` **não** é status. Confirmação permanece a mesma conversa
`OPEN` em `stage=CONFIRMATION`, para que “SIM” não se aplique a um
segundo fluxo. `CONSUMED` existe no enum para evitar `ALTER ENUM` futuro;
B1 **não** implementa `confirmAndExecute` / `markConsumed`.

| status (ciclo de vida) | stage (progresso) |
|---|---|
| `OPEN` `CANCELLED` `EXPIRED` `CONSUMED` | `PARSE` `CLARIFICATION` `CONFIRMATION` `EXECUTION` |

### Invariantes B1

- Ownership = `user_id`. Outro usuário não carrega, cancela, expira nem
  continua o pending, mesmo conhecendo o id.
- `UNIQUE (source_inbound_message_id)` — uma mensagem inbound → no
  máximo um pending.
- No máximo um `OPEN` por usuário no WhatsApp, via coluna gerada
  `open_slot` + `UNIQUE` `uniq_whatsapp_pending_open_user (user_id, open_slot)`.
- Create B1 recebe **somente** `sourceInboundMessageId`. `userId` nasce
  do inbound `READY_FOR_NL` (`source.userId`). Caller não escolhe
  identidade. Inbound sem `userId` falha fechado
  (`SOURCE_INBOUND_IDENTITY_MISSING`).
- `institution_id`, `intent_kind`, `parsed_payload`, `resolved_payload`
  e `clarification_payload` nascem `NULL`. B1 não aceita conteúdo
  parseado. B2-A introduz `advanceWhatsAppPendingFromParse` (payload
  já serializado; sem texto, parser ou resolver em runtime).
- Sem token público. Continuação futura = mesmo user verificado + OPEN
  desse user. Id interno não vai ao usuário.
- TTL conversacional: 15 minutos (`WHATSAPP_PENDING_INTENT_TTL_MS`),
  separado dos 24h do payload inbound.
- FK `source_inbound_message_id` → `whatsapp_inbound_messages.id`
  `ON DELETE RESTRICT`. User `ON DELETE CASCADE`. Institution
  `ON DELETE SET NULL`.
- Store: `server/integrations/whatsapp/pending-intent-store.ts`. Não
  importa parser, resolver, `createSwapOffer` nem Twilio SDK.
- Leituras públicas (`getWhatsAppPendingIntentByIdForUser`,
  `getWhatsAppPendingIntentBySourceForUser`,
  `getOpenWhatsAppPendingIntentForUser`) devolvem
  `WhatsAppPendingReadResult` discriminado. Memória conversacional é
  fail-closed: outage **não** é ausência.
  - DB saudável + inexistente → `{ ok: true, row: null }`
  - DB saudável + existente → `{ ok: true, row }`
  - DB indisponível (`getDb()` null) → `{ ok: false, code: "DB_UNAVAILABLE" }`
    (nunca `row: null`)
  - `getDb()` rejeitado / query falha / reload incoerente →
    `{ ok: false, code: "PERSISTENCE_FAILED" }`
  Helpers privados podem devolver `row | null` porque já receberam `db`
  válido.
- Create, cancel, expire e `clearExpiredWhatsAppPendingIntents` usam o
  mesmo par de códigos de infra. `getDb()` null → `DB_UNAVAILABLE`;
  rejeição de `getDb`/SELECT/INSERT/UPDATE/reload → `PERSISTENCE_FAILED`.
  Infra **não** vira `SOURCE_INBOUND_NOT_FOUND`, `NOT_FOUND`,
  `already_open`, `replay`, `not_due`, `already_terminal` nem zero de
  cleanup (`expired: 0` só com `ok: true` após updates concluídos).
- Cleanup: `{ ok: true, expired, payloadsCleared }` somente se os dois
  UPDATEs terminam. Falha no segundo após sucesso no primeiro →
  `PERSISTENCE_FAILED` (sem rollback; a operação é idempotente).
  `payloadsCleared = expired + leftovers` — o primeiro UPDATE já limpa
  payload das rows que expira, então elas não entram no segundo.

### Payload operacional temporário

Persistir o **mínimo** para o próximo estágio — não o dump Twilio:

| Kind | Material | Colunas |
|---|---|---|
| TEXT | conteúdo para o NL | `operational_text` |
| AUDIO | referência para recuperar mídia | `media_url`, `media_mime` |
| terminal sem próximo estágio | nenhum | limpar imediatamente |

Também: `payload_expires_at` (TTL 24h, `WHATSAPP_INBOUND_PAYLOAD_TTL_MS`)
e `payload_cleared_at`.

Não persistir: telefone completo, hash do telefone (`sender_address_hash`),
signature, Authorization, Auth Token, payload Twilio cru, dump de todos
os params. SHA determinístico do E.164 sem chave é dicionário offline —
o runtime não calcula nem grava esse campo. A coluna física nullable da
#402 permanece até o follow-up `WHATSAPP_SENDER_HASH_COLUMN_SCHEMA_CLEANUP`.

Não logar: Body, `operational_text`, URL de mídia, telefone, token.

### Retenção e limpeza

- TTL curto: 24 horas a partir da persistência/refresh do payload.
- Após consumo previsto: B2-C TEXT `READY_FOR_NL` chama
  `clearWhatsAppInboundOperationalPayloadForReadyNl({ sourceInboundMessageId, expectedUserId })`
  (compare-and-clear atômico: owner + `READY_FOR_NL` + `TEXT` +
  `payload_cleared_at IS NULL`). Incremento D chama
  `clearWhatsAppInboundOperationalPayload(id)` depois de obter a mídia.
  O helper boolean por id continua atuando em `READY_FOR_NL` /
  `READY_FOR_TRANSCRIPTION` — não apaga payload de row `RETRYABLE`
  (a retomada ainda precisa do material). B2-C não usa o helper boolean.
- Consumidor deve checar `isWhatsAppInboundPayloadUsable` (expirado ou
  limpo ≠ material disponível).
- `media_url` só é persistida se for `https:`.
- Expiração: `clearExpiredWhatsAppInboundPayloads(now)` (job futuro).
- `IDENTITY_NOT_FOUND` / `IDENTITY_CONFLICT` / `UNSUPPORTED` limpam o
  payload na hora (não há próximo estágio).

## Rate limit

O webhook passa pelo limiter global existente (200 req/min/IP). Assinatura
+ idempotência são obrigatórias agora. Limiter dedicado por `MessageSid` /
conta Twilio: follow-up **antes de produção**.

## Consumidor futuro

Incremento B1: persiste a conversa pendente. Não chama parser, resolver
nem `createSwapOffer`. Cleanup: `clearExpiredWhatsAppPendingIntents`.

Incremento B2-A (contratos de estado, esta camada): formatos JSON V1 +
transição guardada `OPEN/PARSE` → `OPEN/CLARIFICATION|CONFIRMATION`.
Não consome `READY_FOR_NL`. Não chama parser/resolver em runtime. Não
limpa inbound. Não executa swap. Não envia WhatsApp.

Incremento B2-B (ator operacional canônico, esta camada): primitive
interna `resolveCanonicalOperationalActorForUser({ userId })` em
`server/_core/canonical-operational-actor.ts`. Channel-agnostic: o
mesmo `userId` produz a mesma identidade/topologia no app, web,
WhatsApp, voz ou API futura. **Não** é `WhatsAppActor`. **Não** é
tRPC/REST. `userId` não vem da mensagem — B2-C o obterá do
inbound/pending já vinculado pelo gate de identidade.

Contrato mínimo, alinhado a `SwapIntentActor` (#400):

- sucesso: `{ userId, professionalId, institutionIds }` (ids positivos,
  únicos, ordenados crescente);
- zero membership operacional → `ACTOR_INSTITUTION_MEMBERSHIP_NOT_FOUND`
  (não devolve `institutionIds: []`);
- 0 professional → `ACTOR_PROFESSIONAL_NOT_FOUND`;
- >1 professional (schema sem UNIQUE em `professionals.user_id`) →
  `ACTOR_PROFESSIONAL_AMBIGUOUS` (nunca `LIMIT 1`);
- outage → `DB_UNAVAILABLE` / `PERSISTENCE_FAILED`, nunca NOT_FOUND.

Membership = `professional_institutions.active` + casamento
professionalId/userId + user APPROVED/`deletedAt` null + institution
`isActive`. `professional_access` e `manager_scope` **não** criam
tenant. Papel **não** cria identidade. Múltiplos tenants são sucesso:
B2-B **não** escolhe instituição.

Snapshot ≠ autorização. Read-only. Sem persistir actor no pending.

Incremento B2-C (consumer READY_FOR_NL, esta camada): primitive interna
`processWhatsAppReadyForNlInbound({ sourceInboundMessageId })` em
`server/integrations/whatsapp/ready-for-nl-consumer.ts`. B2-C não é worker
nem route HTTP nem cron. O webhook Twilio
continua ACK rápido após persistir o inbound.

Incremento B2-D (driver assíncrono, esta camada): poll durável da tabela
`whatsapp_inbound_messages` que descobre TEXT `READY_FOR_NL` autenticado
e chama B2-C. Semântica **at-least-once** + consumer B2-C idempotente —
não é exactly-once distribuído. O webhook **não** espera B2-C. ACK **não**
depende de NL. Work item nasce no banco, não em memória.

Pipeline:

```
Twilio webhook
  → persist inbound
  → READY_FOR_NL
  → ACK
Async driver (B2-D)
  → discovers READY_FOR_NL
  → processWhatsAppReadyForNlInbound (B2-C)
  → B1 → B2-B → parser/resolver → B2-A
  → CLARIFICATION | CONFIRMATION
  → stop
```

B2-D **não** executa a intenção. **Não** responde ao WhatsApp.

Arquitetura: polling periódico (8s ±1s jitter) da inbound como fila
durável. Rejeitado fire-and-forget in-process após o ACK (o processo
pode morrer e o wake-up nunca ocorre). Sem Redis/SQS. Sem tabela de
job nova: elegibilidade = `provider=TWILIO` + `READY_FOR_NL` + `TEXT` +
`user_id IS NOT NULL` + `payload_cleared_at IS NULL` + (payload ainda
utilizável **ou** pending OPEN em CLARIFICATION/CONFIRMATION). Sucesso
B2-C limpa o payload; a row deixa de ser elegível.

Claim multi-réplica: `SELECT … FOR UPDATE SKIP LOCKED` + ocupação
durável de `error_code` com prefixo `WA_NL_DRV_` (CLAIMED / RETRY / WAIT /
PARK) enquanto o status permanece `READY_FOR_NL` (status terminal do replay
Twilio). Lease stale (90s) recupera crash após claim. Backoff de infra:
30s → 2m → 10m → 30m → 60m, limitado pelo TTL do payload
(`payload_expires_at`, 24h). `ALREADY_OPEN` é WAIT (30s → 2m → 5m → 10m),
não PARK: a row reentra quando o pending alheio termina ou expira (TTL
conversacional 15 min) sem exigir terceira mensagem. `NEEDS_REFORMULATION`
é PARK deste inbound (reprocessar o mesmo texto não ajuda); a mensagem
seguinte não se perde — cai em `ALREADY_OPEN` → WAIT. Poison
(`INVALID_PAYLOAD`) e domínio terminal continuam PARK e não bloqueiam o
batch.

Flag `WHATSAPP_NL_DRIVER_ENABLED=true` (default off). Merge **não**
ativa staging. `NODE_ENV=test` não inicia o loop. SIGTERM chama
`stopWhatsAppNlDriver` e não inicia novo batch.

Batch máximo 20, oldest-first (`received_at`, `id`), um item por vez
por processo. Concorrência entre réplicas via SKIP LOCKED.
WHATSAPP_B2D_INDEX_FOLLOWUP_REQUIRED (P2): índice composto do poll
não entra nesta PR.

O driver **não** importa `createSwapOffer`, Twilio outbound, push,
transcrição nem UI mobile. Só chama `processWhatsAppReadyForNlInbound`.

Pipeline B2-C (inalterado):

```
READY_FOR_NL
  → pending B1 (só source)
  → actor canônico B2-B
  → parser/resolver (núcleo NL, sem `if source === "WHATSAPP"`)
  → CLARIFICATION | CONFIRMATION (B2-A)
  → compare-and-clear operational_text
```

Regras:

- **sem execução** — mesmo resolved completo para em `OPEN/CONFIRMATION`;
  não chama `createSwapOffer`;
- **sem outbound** — não envia WhatsApp, não monta template, não Twilio
  outbound;
- **cleanup somente pós-durabilidade** —
  `clearWhatsAppInboundOperationalPayloadForReadyNl({ sourceInboundMessageId, expectedUserId })`
  compare-and-clear atômico: o UPDATE exige `id` + provider TWILIO +
  `user_id` + `READY_FOR_NL` + `TEXT` + `payload_cleared_at IS NULL`.
  Só depois de pending comprovadamente `OPEN/CLARIFICATION` ou
  `OPEN/CONFIRMATION` do mesmo source/user (ou replay que comprova esse
  estado). Nunca o inverso. Resultado discriminado (`cleared` /
  `already_cleared` / `STATE_CHANGED` / `DB_UNAVAILABLE` /
  `PERSISTENCE_FAILED`); zero rows recarrega fail-closed, sem segundo
  UPDATE permissivo. B2-C não usa o helper boolean por id;
- **replay não reparsa** — pending persistido é a autoridade. Crash
  entre advance e clear: a próxima tentativa só reconcilia cleanup;
- identidade nasce do inbound (`source.userId`); o caller não passa
  userId, texto, telefone nem tenant;
- multi-instituição: B2-B devolve `[A,B,C]`; o resolver escolhe o
  contexto. B2-C não elege tenant;
- AUDIO / `READY_FOR_TRANSCRIPTION` / terminais de identidade não entram;
- erro de infra (DB, actor infra, parser/resolver interno, advance,
  clear, cancel de PARSE insuficiente) é retryable e **não** apaga o
  material operacional;
- `NEEDS_REFORMULATION` **não** é persistido como clarification (B2-A
  não tem família para isso): `BLOCKED`, inbound preservado (parkável),
  pending `OPEN/PARSE` é terminalizado (`CANCELLED`) via
  `cancelWhatsAppPendingOpenParse` (compare-and-set: `id` + `userId` +
  source + `OPEN` + `PARSE`). Slot OPEN libera. Replay do mesmo source
  vê `already_terminal` e **não** recria OPEN. `already_terminal` exige o
  mesmo tuple `pendingId` + `userId` + source; source divergente no
  reload devolve `STATE_CHANGED`, nunca sucesso. A próxima mensagem é um
  novo source e inicia novo pending. Se o pending já avançou para
  `CLARIFICATION`/`CONFIRMATION`, o cancel devolve `STATE_CHANGED` e
  **não** destrói o estágio durável;
- `NEEDS_CLARIFICATION` permanece `OPEN/CLARIFICATION`. Continuidade da
  próxima mensagem (resposta à clarification) é arquitetura futura —
  esta frente não rebinda source nem implementa outbound;
- conflito de domínio NL (`TERMINAL_DOMAIN_CONFLICT`) continua `BLOCKED`
  sem clarification e **sem** cancel de PARSE nesta frente.

O inbound **não** importa o consumer. O route Twilio **não** espera NL.

Incremento D: `READY_FOR_TRANSCRIPTION` → usa `media_url` → transcreve →
limpa o payload.

## Payloads persistidos V1 (B2-A)

Versão no JSON (`version: 1`). Versão desconhecida é fail-closed, sem
fallback. Não há migration por versão.

### `parsed_payload` — `WhatsAppParsedSwapIntentV1`

Espelha os slots de `SwapIntentDraft` (kind, ownShift, targetProfessional,
targetShift em SWAP). **Não** é o tipo runtime: o mapper
`serializeParsedSwapIntentV1(draft)` copia campos explícitos. Proibido
qualquer chave terminada em `Id`/`_id` e identificadores internos
(user/professional/institution/hospital/sector/shift/assignment),
telefone, email, Body Twilio, mídia, signature e tokens.

### `resolved_payload` — `WhatsAppResolvedSwapIntentV1`

Snapshot mínimo para reconstruir o summary e, no futuro, montar o input
canônico: `kind`, `institutionId`, `fromShiftInstanceId`,
`fromAssignmentId`, `toProfessionalId`, `toShiftInstanceId` (null em
CESSAO), nome do colega e labels de plantão (`dayKey`, `timeRange`,
`sectorName`, `label`).

**`resolved_payload` não é autorização.** `createSwapOffer()` revalida
ownership, elegibilidade, mês publicado e estado stale. B2-A não chama
`createSwapOffer`.

### `clarification_payload` — união discriminada por `code`

Famílias: `AMBIGUOUS_INTENT` (sem candidates; `intent_kind` permanece
null); `AMBIGUOUS_SECTOR`; `AMBIGUOUS_OWN_SHIFT`;
`AMBIGUOUS_TARGET_SHIFT`; `SWAP_TARGET_SHIFT_REQUIRED`;
`AMBIGUOUS_TARGET_PROFESSIONAL`.

Escolha humana (`AMBIGUOUS_TARGET_PROFESSIONAL`, `AMBIGUOUS_SECTOR`)
persiste opção já projetada, não o candidate cru do resolver:

- `professionalId` / `sectorId` = chave técnica da escolha;
- `label` = identificação humana segura, produzida por B2-C
  (qualificação canônica: `medical_specialties.name` ou rótulo de
  `operational_profile_code`; hospital/setor público quando couber).
  **Não** email, telefone, CPF, `userId`, nem o id interno como
  discriminador visual;
- duas opções com o mesmo `label` normalizado (case, acento, espaço)
  **não** podem ser persistidas como selecionáveis;
- se B2-C não conseguir labels distintos com dados profissionais
  permitidos: `candidates: []` e `unresolvedGroups` com
  `{ code: "UNRESOLVED_HOMONYM", label, count >= 2 }`, ou reformulação.
  Não inventar duas choices idênticas.

O raw `{ professionalId, name }` / `{ sectorId, name }` do núcleo NL
**não** é o schema V1. B2-A não consulta o banco para enriquecer.
Não basta mapear `name → label`.

Plantões (`AMBIGUOUS_OWN_SHIFT` etc.) já trazem `label` + `dayKey` +
`timeRange` + `sectorName` + `institutionName`. Sem email, telefone,
CPF ou row completa.

### Transição B2-A

Somente `OPEN + PARSE` → `OPEN + CLARIFICATION` ou
`OPEN + CONFIRMATION`, via `advanceWhatsAppPendingFromParse`. Input:
`pendingId`, `userId`, `sourceInboundMessageId` esperado, outcome
discriminado (`clarification` | `resolved`). UPDATE com WHERE no estado
esperado (`status=OPEN`, `stage=PARSE`, source, user, `expires_at > now`).
Idempotência: mesmo payload → `already_advanced`. Payload diferente →
`STATE_CHANGED` (não last-writer-wins). TTL vencido → `EXPIRED` (helper
B1). Terminais → `TERMINAL`. `institution_id` só no resolved completo.

## Follow-ups (não bloqueiam o Incremento A)

**P2 — origem da mídia (antes do Incremento D):** `media_url` hoje só
exige `https:`. Nenhuma mídia é baixada neste incremento. Antes de
download server-side, validar host/origem Twilio ou usar o mecanismo
oficial autenticado da Twilio (evitar SSRF).

**WHATSAPP_SENDER_HASH_COLUMN_SCHEMA_CLEANUP (antes de produção):** a
coluna `sender_address_hash` ficou nullable e sem escrita após a
minimização. Remover fisicamente (migration aditiva/rerodável) só se
ainda não houver valor operacional e a higiene de schema for necessária.

**P3 — TTL em estados incompletos:** `clearExpiredWhatsAppInboundPayloads`
limpa payload expirado **independentemente** do `processing_status`,
inclusive `RECEIVED` / `RETRYABLE`. Política vigente: o retry da Twilio
refresca o material a partir do envelope. Se a Twilio já parou de
retentar, a row incompleta fica sem payload — aceitável no Incremento A.
Follow-up operacional: restringir o sweep a `READY_FOR_*` se for preciso
preservar material de `RETRYABLE` além do TTL.

## Operação

- Migration inbound (já aplicada no staging):
  `drizzle/migrations/manual/2026-09-04-whatsapp-inbound-messages.sql`
- Migration B1 (já aplicada e verificada no staging):
  `drizzle/migrations/manual/2026-09-04-whatsapp-pending-intents.sql`
- B2-A **não** altera schema nem reaplica migration.
- B2-B **não** altera schema nem persiste actor.
- B2-C **não** altera schema nem migration. Consumer invocável/testável;
  **não** conecta o webhook Twilio; **não** é worker.
- B2-D **não** altera schema nem migration. Driver in-process (poll 8s)
  da inbound como fila; flag `WHATSAPP_NL_DRIVER_ENABLED` (default off).
  Não é cron Render, não é fila externa, não é fire-and-forget do webhook.
- Sem alteração de webhook/sender/Verify/templates na Twilio
- Sem Render config, secrets, EAS, WhatsApp outbound
- Parser/resolver só no consumer B2-C, nunca no route inbound nem no driver
- Sem `createSwapOffer`, sem push, sem áudio/transcrição
- Driver B2-D: at-least-once, B2-C idempotente, sem execução, sem outbound
