# Contrato Escala+ ↔ Comunica+ — Duty Sync V2

**Status:** NORMATIVO  
**Versão:** 2.0  
**Data:** 2026-08-30  
**Escopo:** declaração de responsabilidade de plantão (`CONFIRM` / `WITHDRAW`) e presença ativa derivada no Comunica+.  
**Fora de escopo:** SSO Handoff, Hospital Alert, outbox de avisos (`COMUNICA_PLUS_OUTBOUND_ENABLED`), eventos `START` / `END`.

**Baselines auditados nesta frente**

| Sistema | Repositório | `origin/main` |
|---------|-------------|---------------|
| Escala+ | `renosilveira-ui/arquivos-comunica-escala` | `4e96dbcf9bf28b1e475447b3a3b3cc13e4f0354b` |
| Comunica+ | `renosilveira-ui/Comunicamais` | `4b604268c08439e8136e8e9257142ca1ea349ead` |

O endpoint Comunica+ `POST /api/integrations/duty-roster` permanece o receptor. Esta frente **não** altera o Comunica+ e **não** habilita outbound.

---

## 1. Invariante central

Para cada intervalo de plantão originado pelo Escala+, o Comunica+ **não pode manter como ativo** um profissional que o estado canônico atual do Escala+ já considera removido, substituído ou desistente.

Corolários:

1. A verdade local do Escala+ é autoridade. Falha de rede no Comunica+ **não** desfaz mutação local; a intenção fica no outbox retryável. Ausência de outbox **não** é sucesso silencioso.
2. Um replacement `REPLACEMENT_CONFIRMED` **supersede** o titular: o Comunica+ não pode mostrar o titular como plantonista daquele intervalo depois que o substituto assume.
3. Presença ativa **não** é um estado persistido no Escala+. É derivada no Comunica+ a partir da declaração + relógio.
4. Não existem verbos `START` ou `END` neste contrato.

---

## 2. Semântica obrigatória

### 2.1 `CONFIRM`

O Escala+ declara que o profissional confirmou **responsabilidade** pelo intervalo semiaberto `[dutyStart, dutyEnd)`.

`CONFIRM` **não** significa:

- está de plantão agora;
- login realizado;
- sessão criada;
- presença atual imediata;
- SSO / handoff disparado.

`dutyStart` e `dutyEnd` vêm do intervalo canônico da confirmação no Escala+ (horários do `shift_instances` no momento do enqueue). Não há recorte “from-now”.

### 2.2 Presença ativa (ACTIVE DUTY)

Derivada **somente** no Comunica+:

```
confirmedAt != null
AND dutyStart <= now < dutyEnd
```

Se o médico confirma às 15:00 um plantão 19:00→07:00:

| Instantâneo | Escala+ | Comunica+ (presença) |
|-------------|---------|----------------------|
| 15:00 | registra confirmação e declara o intervalo | **não** aparece como plantonista |
| 19:00 | sem evento extra | aparece automaticamente |
| 07:00 | sem evento extra | deixa de aparecer automaticamente |

Nenhum conceito local do Escala+ deve tratar `CONFIRMED` como “ativo agora” antes de `dutyStart`.

### 2.3 Fim (`END`)

O fim é **derivado pelo relógio** (`now >= dutyEnd`). Não requer evento explícito de fim no caso feliz.

### 2.4 `WITHDRAW`

A declaração anterior de responsabilidade por aquele intervalo **deixou de ser válida**.

`WITHDRAW` deve ocorrer sempre que o Escala+ souber que a declaração anterior não representa mais quem deve responder pelo plantão.

Efeito no Comunica+ (já implementado): anula `confirmedAt` na chave natural `(organizationId, userId, dutyStartAt)`. Sem `confirmedAt`, o profissional não entra em presença ativa mesmo que o relógio esteja dentro do intervalo.

`WITHDRAW` duplicado é idempotente (mesma `dedupKey` reutiliza a row; o receptor anula `confirmedAt` de novo sem efeito adicional).

### 2.5 SSO Handoff

Contrato **separado**. Confirmação de plantão **não** dispara sessão interativa, login automático nem handoff.

O botão manual **“Abrir Comunica+”** permanece, se existir, como jornada explícita do usuário.

---

## 3. Transporte

| Campo | Valor |
|-------|--------|
| Método | `POST /api/integrations/duty-roster` |
| Auth | JWT RS256, `scope: duty:sync`, mesma JWKS do SSO |
| `action` | somente `CONFIRM` \| `WITHDRAW` |
| Intervalo | claims `dutyStart`, `dutyEnd` (ISO 8601) |
| Identidade | `email` canônico (subject externo) + `organizationId` UUID mapeado |
| Idempotência Escala+ | `dedupKey` na outbox `notifications` |
| Ordenação | predecessor por `confirmationId` **ou** `(organizationId, externalSubject, shiftSnapshot.startAt)` |
| Autoridade no envio | `CONFIRM` revalida a confirmação efetiva; `WITHDRAW` usa envelope congelado |
| Fail-closed | org não mapeada → `UNMAPPED_COMUNICA_ORGANIZATION`; subject ausente/inválido → `MISSING_CANONICAL_EXTERNAL_SUBJECT`; **não** chama a rede |

Flag `COMUNICA_PLUS_OUTBOUND_ENABLED` governa o outbox de **avisos** (publicação, troca aprovada). **Não** liga nem desliga duty-sync. Permanece `0` nesta frente.

Hospital Alert permanece congelado (`EXPO_PUBLIC_HOSPITAL_ALERT_ENABLED` ≠ `true`).

---

## 4. Chave natural no Comunica+ e substituição

Chave: `(organizationId, userId, dutyStartAt)`.

Titular e substituto são **users distintos**. `WITHDRAW` do titular e `CONFIRM` do substituto não colidem na mesma row. A ordenação obrigatória é:

1. `WITHDRAW` titular (mesmo `confirmationId`, `sourceSequence` menor)
2. `CONFIRM` substituto

O predecessor por `confirmationId` impede o `CONFIRM` do substituto de ser processado enquanto o `WITHDRAW` do titular estiver `PENDING`.

### 4.1 Substituição antes do início

Reno confirmou 19:00→07:00. João assume às 15:00.

1. Escala+ atualiza verdade local (alocação do titular inativa; substituto ocupando).
2. `WITHDRAW` Reno para `[19:00, 07:00)`.
3. `CONFIRM` João para o **mesmo intervalo canônico** `[19:00, 07:00)`.

João só aparece como plantonista a partir das 19:00.

### 4.2 Substituição durante o plantão

Reno está ativo às 19:00. João assume às 23:00.

**Escolha desta frente: `SUPPORTED`.**

O intervalo enviado é o intervalo **canônico armazenado** na confirmação / turno do Escala+ (`shift.startAt` / `shift.endAt`), não um recorte `[agora, dutyEnd)`.

Motivo: recortar `dutyStart` para 23:00 criaria outra chave natural no Comunica+ e um `WITHDRAW` posterior com o `startAt` original não atingiria a row do substituto. Inventar `dutyStart = now` sem decisão de produto e sem mudança no Comunica+ viola este contrato.

Efeito:

1. Escala+ atualiza verdade local.
2. `WITHDRAW` Reno `[19:00, 07:00)` — Reno deixa de aparecer imediatamente.
3. `CONFIRM` João `[19:00, 07:00)` — João aparece imediatamente porque `now` já está dentro do intervalo.

Limitação conhecida (não bloqueia V2): o Comunica+ passa a registrar João como responsável pelo intervalo completo, inclusive 19:00–23:00, que é histórico. Presença **agora** fica correta. Recorte from-now exigiria decisão de produto (e possivelmente evolução da chave natural). **Não implementar recorte nesta frente.**

---

## 5. Máquina de estados local (`duty_confirmations`)

Transição nova, sem migration e sem estado novo:

`CONFIRMED → DECLINED` via o comando já existente `DECLINE`.

Semântica: desistência após ter confirmado. O médico permanece alocado até remoção/substituição operacional; a declaração enviada ao Comunica+ deixa de ser válida (`WITHDRAW`).

`REPLACEMENT_CONFIRMED` continua terminal na máquina. Se o substituto deixa o plantão, a autoridade operacional é **remoção de alocação** / nova substituição, que emite `WITHDRAW` do sujeito efetivo sem novo estado.

`AUTO_CONFIRMED` permanece legado somente-leitura. Se ainda existir row declarada, remoção operacional emite `WITHDRAW`.

---

## 6. Matriz de eventos de negócio

| EVENTO | CONFIRM PODE EXISTIR? | WITHDRAW NECESSÁRIO? | NOVO CONFIRM? | IMPLEMENTADO HOJE? |
|--------|----------------------|----------------------|---------------|--------------------|
| Confirmação do titular (`PENDING→CONFIRMED`) | após o evento | não | `CONFIRM` titular | sim (sem auto-SSO nesta frente) |
| Recusa do titular ainda `PENDING` | não (CONFIRM não foi enviado) | sim, compensação idempotente | não | sim |
| Desistência após `CONFIRMED` | sim | **sim** (`WITHDRAW` titular) | não | **esta frente** |
| Indicação (`DECLINED→NOMINATED`) | titular já recusado | não extra (WITHDRAW já saiu na recusa) | não | sim — não gera duty-sync |
| Recusa da indicação pelo substituto (`NOMINATED→REPLACEMENT_DECLINED`) | não do substituto | não | não | sim — não gera duty-sync |
| Aceite da indicação (`NOMINATED→REPLACEMENT_CONFIRMED`) | titular pode ter CONFIRM prévio | **sim, titular primeiro** | **sim, substituto depois** | **esta frente** (antes só CONFIRM do substituto) |
| Remoção de alocação (`unassignDirect`) após declaração | sim | **sim**, sujeito efetivo | não | **esta frente** |
| Turno marcado vago (`markVacant`) | sim | **sim**, todas as declarações do turno | não | **esta frente** |
| Convite / `assignDirect` / alocação nova | não | **não** | não até haver confirmação | sim (não gera WITHDRAW) |
| Oferta de troca ainda não efetivada | possível do titular atual | **não** (oferta ≠ roster) | não | sim |
| Troca/cessão efetivada (`swap` `APPROVED`) | possível de quem saiu | **sim**, quem deixou o intervalo | **não** automático de quem entrou | **esta frente** (WITHDRAW de quem saiu) |
| Edição temporal do turno (`startAt`/`endAt`) com declaração vigente | sim, chave Comunica+ = `dutyStart` antigo | **sim**, intervalo antigo | **sim**, intervalo novo (dedup distinta) | **esta frente** |
| Mudança de profissional via unassign+assign | sim do antigo | coberto por unassign | só se o novo confirmar | unassign nesta frente |
| Cancelamento dedicado de shift | não há entidade “cancel”; vago / unassign | coberto por `markVacant` / unassign | não | esta frente |
| Revogação administrativa de vínculo / exclusão | sim | WITHDRAW já era durável (envelope congelado) | não | sim (boundaries) |
| Comunica+ indisponível | — | outbox retryável | — | sim |
| Org mapping inválido / subject ausente | — | fail-closed, sem rede | — | sim |
| Retry atrasado de `CONFIRM` após `WITHDRAW` | envelope velho | WITHDRAW vence | `CONFIRM` velho **não** reativa | sim (revalidação + predecessor) |

---

## 7. Outbox

Reutiliza `notifications` com `title: "Duty roster sync"`.

| Propriedade | Regra |
|-------------|--------|
| Idempotência | `dedupKey` único; colisão com envelope equivalente reutiliza a row |
| Retry | erros transitórios (5xx, timeout, destino inválido) voltam a `QUEUED` com backoff; verdade local intacta |
| Ordering | `NOT EXISTS` predecessor `PENDING` na mesma confirmação ou mesma chave externa `(org, subject, startAt)` |
| Stale suppression | `CONFIRM` revalida status, assignment efetiva, snapshot e org; divergência → terminal não retryável |
| Autoridade | `WITHDRAW` não revalida assignment (compensação durável após remoção) |
| Revival | `CONFIRM` do titular após `REPLACEMENT_CONFIRMED` ou assignment inativa falha fechado; não reativa no Comunica+ |

`dedupKey` canônicos:

- `duty-confirmation:{id}:duty-sync:confirmed:{userId}`
- `duty-confirmation:{id}:duty-sync:withdraw:{userId}`
- `duty-confirmation:{id}:duty-sync:replacement-confirmed:{userId}`
- redeclaração de intervalo: `duty-confirmation:{id}:duty-sync:confirmed:{userId}:interval:{dutyStart}` e `...:withdraw:{userId}:interval:{dutyStart}`

Status local `#310`: `pending` \| `outbox_processed` \| `failed` \| `none`, `scope: "escala_outbox"`.  
`outbox_processed` significa **a outbox local marcou SENT**. Não significa “ativo no Comunica+” nem presença corrente.

---

## 8. Copy

Proibida qualquer copy que implique login imediato, sessão criada ou presença ativa imediata após confirmar.

Copy canônica de sucesso:

> Plantão confirmado. No horário do plantão, sua presença será informada automaticamente ao Comunica+.

---

## 9. Não fazer

- Não setar `COMUNICA_PLUS_OUTBOUND_ENABLED=1`.
- Não reativar Hospital Alert.
- Não criar `START` / `END`.
- Não acoplar confirmação a SSO Handoff.
- Não alterar Comunica+ nesta frente.
- Não recortar `dutyStart` para “agora” em substituição durante o plantão.
