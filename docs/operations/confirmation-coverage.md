# Cobertura 24/7 das confirmações de plantão

Finding 4 da auditoria. O dispatcher (`server/cron/shift-confirmation-dispatcher.ts`)
roda **dentro do processo web**, com `setInterval` de 60 s após o `listen`.
No plano Render **free** a instância dorme após 15 min sem tráfego. Enquanto
dorme, não há tick: os gatilhos 11:00 / 17:00 / 22:00 (`America/Sao_Paulo`)
e a rechecagem +30 min não disparam. A janela de catch-up de 20 min no
próximo tick **não** cobre um spin-down que atravessa o horário-gatilho.

O código deste repositório **não consegue** manter o processo acordado. Fechar
o finding é `EXTERNAL_INFRA_ACTION_REQUIRED` (decisão de custo do PO).

## O que o código já faz

- `tick()` imediato no boot (catch-up se a instância acordar ainda dentro da
  janela de 20 min).
- `setInterval` 60 s enquanto o processo web está vivo.
- `stopConfirmationCron()` no SIGTERM, para o intervalo não atrasar o drain.
- CLI one-shot: `pnpm confirmation:tick` (dev) e
  `node dist/run-confirmation-tick.mjs` (artefato de produção).
- O tick é idempotente entre processos: `unique(assignment_id)` na criação da
  confirmação; CAS no outbox/recheck. Web acordado + Cron simultâneos não
  duplicam push com autoridade.

## O que o código não faz (e não deve)

- Não muda `plan: free` → `starter` neste repositório.
- Não cria um serviço `type: cron` ativo no Blueprint (mínimo US$ 1/mês;
  aplicar o YAML cobraria).
- Não liga o CLI sozinho. Sem serviço sempre-on ou Cron cobrado, o gap
  permanece.

## Opções de infra (PO)

Qualquer uma fecha o finding. Não são exclusivas; A+B é redundante e seguro.

| Opção | Custo (ordem de grandeza) | Efeito |
|---|---|---|
| **A.** `plan: starter` no web `escalas-staging` | US$ 7/mês | Sem spin-down. O `setInterval` in-process cobre 24/7. |
| **B.** Render Cron cobrado chamando o CLI a cada minuto | US$ 1/mês mínimo | Cobre o web dormindo. O web no free continua com o intervalo só quando acordado. |

Recomendação para o piloto São Carlos: **A** (também elimina o cold start
percebido — ver `docs/operations/cold-start.md`). **B** resolve só o
dispatcher, não o spin-down do app.

## Como ligar o Cron (opção B) — não aplicar sem aprovação de custo

Serviço **separado** (não reutilizar o startCommand do web). Expressão em
**UTC**; o tick já converte para `America/Sao_Paulo`, então `* * * * *` é o
certo (não tentar “11h BRT” no cron da plataforma).

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
  `confirmation tick ok`; gatilho 11:00 BRT gera `Found N assignments` no
  mesmo minuto UTC correspondente (14:00Z no horário padrão de São Paulo).
