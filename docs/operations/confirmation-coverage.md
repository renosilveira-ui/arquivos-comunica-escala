# Cobertura 24/7 das confirmações de plantão

Finding 4 da auditoria. O dispatcher (`server/cron/shift-confirmation-dispatcher.ts`)
roda **dentro do processo web**, com `setInterval` de 60 s após o `listen`,
e também via CLI one-shot (`pnpm confirmation:tick`). Os dois chamam o
mesmo `tick()`.

No plano Render **free** a instância dorme após 15 min sem tráfego.
Enquanto dorme, não há tick in-process: a rechecagem +30 min e o push de
início (lookback 5 min) não correm. A **discovery** de pedidos de
confirmação é due-based e faz catch-up no próximo tick enquanto o plantão
ainda não começou — um deploy/sleep que atravessa 11:00 BRT **não** perde
mais o pedido do dia. Pontualidade 24/7 (recheck, start-push, primeiro
aviso no due) continua `EXTERNAL_INFRA_ACTION_REQUIRED`.

O código deste repositório **não consegue** manter o processo acordado.
Fechar o finding operacional é decisão de custo do PO.

## Algoritmo de discovery (código)

```
now
  → assignments OCUPADO + is_active
  → user APPROVED + membership ativa
  → schedule_context ativo
  → professional_access canônico (#317/#426)
  → roster oficial (revalidado na materialização)
  → startAt ∈ (now, now + maxLead]
  → sem duty_confirmation
  → dueAt = startAt - lead ≤ now
  → INSERT PENDING + enqueue outbox
    (requireValidDutyConfirmation, requireOriginalAccess default true)
```

Lead (owner): início ∈ [06:30, 07:30] hospital local → 9h; demais → 2h.
Relógio `TZ_HOSPITAL` / `America/Sao_Paulo`. `maxLead` deriva do maior lead.

| Início do plantão | Lead vigente (opção A) | dueAt histórico equivalente |
|---|---|---|
| 07:00 ±30 min | 9h | 22:00 do dia anterior |
| 13:00, 19:00 e demais | 2h | 11:00 / 17:00 |

Plantão já iniciado (`startAt <= now`): nenhuma solicitação nova.
Assignment tardio, swap/substituição com novo `assignment_id`, publicação
tardia e restart: o próximo tick captura se o due já venceu e o plantão
ainda não começou.

Idempotência: `unique(assignment_id)`. CLI × web no mesmo instante = 1
linha.

Confirmação é presença de quem **já está OCUPADO** na escala publicada
**e** tem `professional_access` canônico atual (#426). Papel, scope,
convite e qualification **não** substituem access. `qualificationMatches`
não reentra no integrity pós-occupancy. Occupancy sem ACL continua
possível (#422); confirmation recusa — decisão A/B/C de occupancy
permanece aberta.

## O que o código já faz

- `tick()` imediato no boot (catch-up due-based).
- `setInterval` 60 s enquanto o processo web está vivo.
- `stopConfirmationCron()` no SIGTERM (isolado do stop do driver WhatsApp).
- CLI one-shot: `pnpm confirmation:tick` (dev) e
  `node dist/run-confirmation-tick.mjs` (artefato de produção).
- O tick é idempotente entre processos: `unique(assignment_id)` na criação da
  confirmação; CAS no outbox/recheck. Web acordado + Cron simultâneos não
  duplicam push com autoridade.

## O que o código não faz (e não deve)

- Não muda `plan: free` → `starter` neste repositório.
- Não cria um serviço `type: cron` ativo no Blueprint (mínimo US$ 1/mês;
  aplicar o YAML cobraria).
- Não liga o CLI sozinho. Sem serviço sempre-on ou Cron cobrado, recheck e
  start-push continuam sujeitos ao spin-down.

## Opções de infra (PO)

Qualquer uma fecha o finding operacional. Não são exclusivas; A+B é
redundante e seguro.

| Opção | Custo (ordem de grandeza) | Efeito |
|---|---|---|
| **A.** `plan: starter` no web `escalas-staging` | US$ 7/mês | Sem spin-down. O `setInterval` in-process cobre 24/7. |
| **B.** Render Cron cobrado chamando o CLI a cada minuto | US$ 1/mês mínimo | Cobre o web dormindo. O web no free continua com o intervalo só quando acordado. |

A discovery due-based tolera intervalo maior que 1 min (o atraso máximo do
primeiro pedido é o intervalo, não uma janela de 20 min). Recheck +30 min e
o push de início (lookback 5 min) ainda pedem frequência **≤ 5 min**;
`* * * * *` permanece a recomendação.

Recomendação para o piloto São Carlos: **A** (também elimina o cold start
percebido — ver `docs/operations/cold-start.md`). **B** resolve só o
dispatcher, não o spin-down do app.

## Como ligar o Cron (opção B) — não aplicar sem aprovação de custo

Serviço **separado** (não reutilizar o startCommand do web). Expressão em
**UTC**; o tick já converte para `America/Sao_Paulo`, então `* * * * *` é o
certo (não tentar “11h BRT” no cron da plataforma — a discovery não depende
mais desse minuto).

```yaml
# NÃO descomentar / NÃO aplicar sem decisão explícita de custo do PO.
# - type: cron
#   name: escalas-staging-confirmation-tick
#   runtime: node
#   region: oregon
#   plan: starter
#   branch: main
#   schedule: "* * * * *"
#   buildCommand: pnpm install --frozen-lockfile && pnpm build:confirmation-tick
#   startCommand: node dist/run-confirmation-tick.mjs
```

O Cron precisa do **mesmo** `DATABASE_URL` / `DATABASE_SSL` do web e das
env vars usadas pelos workers que o tick já dispara (push Expo, SSO/duty-sync,
Comunica+). Sem elas o tick não quebra a escala, mas o outbox não sai.

`tsx` é `devDependency`: o startCommand de produção é o bundle
`dist/run-confirmation-tick.mjs`, não `pnpm confirmation:tick`.

## Como verificar depois da ação de infra

- Starter: logs do web com `[ConfirmationCron] Started` contínuos; ausência de
  spin-down em `docs/operations/cold-start.md` (“Como medir”).
- Cron: um run por minuto no dashboard Render; log JSON
  `confirmation tick ok`; assignment due gera `Found N due assignments`.

## Compatibilidade na ativação da rotação de indicação

Cada nova indicação de substituto passa a ter um `confirmationToken` próprio.
Esse token é revalidado depois do lock transacional e também vincula payload,
autoridade e chave de idempotência dos pushes de indicação/recusa. Assim uma
ação ou entrega atrasada de uma indicação anterior não pode operar nem avisar
como se pertencesse à indicação atual.

Consequência esperada no primeiro deploy desta versão: pushes de nomeação que
já estavam em aparelhos antes do deploy e não representam o token corrente
serão recusados ao abrir ou responder. O usuário deve reabrir o plantão pela
Agenda para carregar a indicação vigente. Não há migração de dados nem aceite
automático desses links antigos.


## Estado "escalado ao gestor" não é "due"

`recheck_at` NULL em confirmação `PENDING` tem **dois** significados, e só um
é "arme-me":

| Origem | `recheck_at` | `confirmation_token` | `manager_notified` | Descoberta |
|---|---|---|---|---|
| Re-arme por mudança de horário (`confirmation-lifecycle`) | NULL | **novo** | false | volta a ser due; push novo, chave nova |
| Receipt da escalação ao gestor (`push-delivery`) | NULL | **o mesmo** | **true** | **não** é due; espera humano ou início do plantão |

Em 11/09/2026 a descoberta não distinguia os dois. Três médicos sem app
instalado tiveram o push de confirmação falho em definitivo
(`NO_REGISTERED_TOKENS`), foram escalados, e a cada minuto o cron os
redescobria, re-enfileirava o push com a mesma `dedupKey` do original,
colidia, e o tick morria antes das outras alocações — por dias.

Três travas, independentes:

1. a descoberta exclui `manager_notified = true`;
2. o re-arme consulta se o push deste ciclo já existe e, se existir, é no-op
   (`confirmation_rearm_skipped`);
3. colisão de intenção (`TrackedIntentCollisionError`) pula a alocação com log
   (`confirmation_intent_collision`) em vez de derrubar o tick.

Isso **vai acontecer de novo** para todo médico sem o app instalado: o push
falha, escala ao gestor, e a confirmação fica parada em `PENDING` até alguém
agir. É o comportamento desenhado — a diferença é que agora ele não custa o
subsistema inteiro.

## Estado terminal EXPIRED e o aviso ao gestor como escolha (12/09/2026)

Parecer de bancos (12/09): 83 confirmações `PENDING` no staging, 79 de
plantões já terminados, a mais antiga de 26/08. Depois da escalação ao
gestor a confirmação esperava um humano — e nada a encerrava quando o
plantão terminava. Decisão do PO:

- **Plantão não confirmado continua sendo avisado ao gestor da escala**, mas
  cada instituição pode desligar o aviso: "é uma decisão do grupo de
  trabalho, não imposição do sistema; nós oferecemos a ferramenta".
  Chave em Perfil → Gestão → **Plantão não confirmado** (só quem gerencia a
  escala; auditado como `INSTITUTION_FEATURE_UPDATED`). Coluna
  `institutions.notify_manager_on_unconfirmed`, ligada por padrão.
- **Confirmação sem resposta encerra quando o plantão termina**: passo
  `expireStaleConfirmations` do tick — abertas (`PENDING`, `NOMINATED`,
  `DECLINED`, `REPLACEMENT_DECLINED`) com `end_at < now` viram `EXPIRED`
  (`expired_at`), sem notificação. Terminal: ninguém sai de `EXPIRED`.
  As pendências antigas foram descartadas por este caminho na primeira
  rodada após o deploy.
- Com o aviso desligado, a escalação não cria intenção nenhuma e marca
  `escalation_suppressed_at`; a descoberta trata como escalado (não re-arma,
  não redescobre), e a confirmação segue até `EXPIRED`.
- Notificações do "produto" (o que dizer ao médico e ao gestor quando o
  plantão vira produto de verdade): dívida registrada, a resolver depois.

Migração: `drizzle/migrations/manual/2026-09-12-confirmation-expiry-and-escalation-policy.sql`.

