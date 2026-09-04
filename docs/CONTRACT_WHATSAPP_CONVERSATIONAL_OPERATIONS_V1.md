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
| `TEXT` | classifica e persiste metadata | Incremento B: NL |
| `AUDIO` | classifica; **não** baixa, transcreve, armazena mídia | Incremento D |
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
| NL Core (`server/natural-language/`) | interpretação futura (texto → slots) |
| Resolver | entidades futuras (slots → IDs) |
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
| Replay do mesmo MessageSid | 200 (ACK idempotente) |
| Mensagem aceita | 200 (ACK vazio, sem TwiML) |

Corpo de erro sem detalhes internos.

## Estados de inbound

`RECEIVED` · `IDENTIFIED` · `IDENTITY_NOT_FOUND` · `IDENTITY_CONFLICT` ·
`UNSUPPORTED` · `READY_FOR_NL` · `READY_FOR_TRANSCRIPTION` · `FAILED`

Sucesso deste incremento: texto de usuário verificado → `READY_FOR_NL`
(sem interpretar o texto). Áudio identificado → `READY_FOR_TRANSCRIPTION`
(sem transcrever).

## Persistência

Tabela `whatsapp_inbound_messages` com
`UNIQUE (provider, provider_message_id)`.

**Não** nasce `whatsapp_pending_intents` nesta PR: `parsed_payload` /
`resolved_payload` ainda não têm contrato JSON travado. Criar a tabela
agora seria JSON sem schema. Incremento B cria pending junto com o
contrato de slots do NL.

Não persistir: telefone completo, Body, signature, Authorization, payload
Twilio cru, URL de mídia, áudio.

## Rate limit

O webhook passa pelo limiter global existente (200 req/min/IP). Assinatura
+ idempotência são obrigatórias agora. Limiter dedicado por `MessageSid` /
conta Twilio: follow-up **antes de produção**.

## Consumidor futuro

Incremento B: `READY_FOR_NL` → parser/resolver de
`server/natural-language/` → confirmação → `createSwapOffer`. Esta PR não
importa esses módulos no caminho inbound.

## Operação

- Migration manual: `drizzle/migrations/manual/2026-09-04-whatsapp-inbound-messages.sql`
- Aplicar em staging **somente após revisão + autorização operacional**
- Sem alteração de webhook/sender/Verify/templates na Twilio
- Sem Render config, secrets, EAS, WhatsApp outbound
