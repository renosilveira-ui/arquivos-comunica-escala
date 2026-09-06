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
  → roster oficial (revalidado na materialização)
  → startAt ∈ (now, now + maxLead]
  → sem duty_confirmation
  → dueAt = startAt - lead ≤ now
  → INSERT PENDING + enqueue outbox
```

Lead vigente = **compatibilidade histórica** do cron 11/17/22, não contrato
de produto escrito. `CONFIRMATION_LEAD_TIME_OWNER_DECISION_REQUIRED`
(A=9h manhã / 2h demais; B=2h universal; C=configurável). Relógio
`TZ_HOSPITAL` / `America/Sao_Paulo`. `maxLead` deriva do maior lead,
não de 9h hardcoded.

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

Confirmação é presença de quem **já está OCUPADO** na escala publicada.
A discovery **não** filtra `professional_access` nem `qualificationMatches`
(#422). `confirm()` / `getPending` / retry de push do titular **ainda
exigem** ACL (`requireOriginalAccess` default). Isso é divergência de
autoridade, não contrato de produto escrito:
`CONFIRMATION_REQUEST_ACTION_AUTHORITY_DIVERGENCE_CONFIRMED`.
Correção de AuthZ **não** cabe nesta PR de discovery — ver plano
`CONFIRMATION_CANONICAL_HOLDER_AUTHORITY`.

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
