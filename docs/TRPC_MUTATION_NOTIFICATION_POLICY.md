# Política de notificação das mutações de API

Toda procedure tRPC construída com `.mutation()` e montada no `appRouter`, e
toda rota Express externa `POST`, `PUT`, `PATCH` ou `DELETE`, deve ter uma
entrada explícita em `server/mutation-notification-policy.ts`.

Esta é uma classificação declarativa: não acrescenta provider, evento,
entrega, migration ou escrita de auditoria. Ela descreve o comportamento que a
mutation já possui.

| Política         | Significado                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `NOTIFY`         | Já envia ou enfileira aviso dirigido a destinatário(s) identificados.                                        |
| `BROADCAST`      | Já seleciona uma audiência elegível e a avisa.                                                               |
| `SILENT_AUDITED` | Não inicia aviso ao usuário; preserva a trilha operacional existente, sem criar nova auditoria nesta camada. |

## Inventário tRPC atual

| Política         | Mutations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NOTIFY`         | `confirmations.acceptNomination`, `confirmations.declineNomination`, `confirmations.nominateReplacement`, `editor.assignDirect`, `editor.unassignDirect`, `scheduleInvites.create`, `swaps.accept`, `swaps.approveByOwner`, `swaps.offer`                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `BROADCAST`      | `shifts.notifyVacancy`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SILENT_AUDITED` | `confirmations.confirm`, `confirmations.decline`, `confirmations.registerPushToken`, `confirmations.unregisterPushToken`, `editor.markVacant`, `hospitals.create`, `profile.deactivateWhatsAppContact`, `profile.setWhatsAppContact`, `scheduleContexts.ensureDefaultSectorScale`, `scheduleInvites.revoke`, `shiftAssignments.assumeVacancy`, `shiftInstances.approveAssignment`, `shiftInstances.rejectAssignment`, `shifts.create`, `shifts.lock`, `shifts.openMonthShifts`, `shifts.publish`, `shifts.replicateMonthCalendar`, `shifts.replicateRange`, `shifts.replicateWeek`, `shifts.update`, `swaps.approve`, `swaps.cancel`, `swaps.reject`, `swaps.rejectByManager`, `voice.interpret` |

## Inventário Express externo

`EXPRESS_MUTATION_NOTIFICATION_POLICIES` usa a chave `METHOD path`, depois de
resolver os mounts `app.use()`. Há 24 endpoints externos atuais.

| Política         | Endpoints                                                                                                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NOTIFY`         | `POST /api/auth/forgot-password`, `POST /api/auth/redeem-invite`, `POST /api/auth/decline-invite`, `POST /api/admin/users/:id/reset-password`                                                                                                                |
| `BROADCAST`      | Nenhum endpoint Express atual.                                                                                                                                                                                                                               |
| `SILENT_AUDITED` | `DELETE /api/admin/users/:id`, `DELETE /api/auth/me`, `PUT /api/admin/users/:id`; os POSTs de sessão/cadastro em `/api/auth`; os três proxies em `/api/integrations/hospital-alert`; e `POST generate` / `POST launch-code` sob `/.well-known` e `/api/sso`. |

O mesmo `ssoRouter` é montado em `/.well-known` e `/api/sso`; cada caminho é
uma superfície externa distinta, portanto ambos entram no inventário sem serem
considerados duplicata.

## Porta de CI

`tests/trpc-mutation-notification-policy.test.ts` usa a AST do TypeScript,
não regex. Para tRPC, ela descobre as chamadas `.mutation()` em todos os
arquivos `server/**/*.ts`, vincula cada uma ao router montado no `appRouter` e
compara o resultado com o inventário tipado. Para Express, ela descobre
`Router()` e apps Express, resolve `app.use()` estático e compara cada rota
externa mutável com o inventário. O teste falha para:

- mutation sem política;
- rota Express externa sem política;
- política inválida ou obsoleta;
- duas mutations com o mesmo caminho; ou
- duas rotas Express com o mesmo método e caminho externo; ou
- router com mutation que não esteja montado no `appRouter`; ou
- `Router()` mutável que não esteja montado em um app Express; ou
- caminho/mount dinâmico, alias ou acesso computado que esconda um método
  Express mutável da inspeção; ou
- alias, desestruturação ou acesso computado a `.mutation` que esconderia a
  procedure da inspeção AST.

Queries continuam fora desse contrato e não são reclassificadas nem recebem
efeito colateral.

O teste também entra em `vitest.pure.config.ts`, que executa sem setup de
MySQL; assim a porta estrutural continua executável antes de qualquer banco ou
migration.

Exclusões verificadas pela fonte atual: `privacyRouter` só registra GET;
`registerOAuthRoutes` é um placeholder sem rota HTTP; o `app` direto só
registra GET de health/catch-all; e `/api/trpc` é `createExpressMiddleware`,
coberto separadamente pelo inventário tRPC.

## Exceção SSO estrita

`GET /.well-known/launch` e `GET /api/sso/launch` consomem um código SSO de uso
único porque o browser externo conclui o handoff por navegação. A exceção
nomeada é `SSO_ONE_TIME_LAUNCH_GET_CONSUMPTION_EXCEPTION`; ela não é query nem
mutation tRPC. O mesmo teste confirma os dois mounts, uma única rota `/launch`
e a chamada a `redeemLaunchCode`.
