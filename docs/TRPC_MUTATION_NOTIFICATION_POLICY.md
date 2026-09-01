# Política de notificação das mutations tRPC

Toda procedure tRPC construída com `.mutation()` e montada no `appRouter` deve
ter uma entrada explícita em
`server/mutation-notification-policy.ts`.

Esta é uma classificação declarativa: não acrescenta provider, evento,
entrega, migration ou escrita de auditoria. Ela descreve o comportamento que a
mutation já possui.

| Política         | Significado                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `NOTIFY`         | Já envia ou enfileira aviso dirigido a destinatário(s) identificados.                                        |
| `BROADCAST`      | Já seleciona uma audiência elegível e a avisa.                                                               |
| `SILENT_AUDITED` | Não inicia aviso ao usuário; preserva a trilha operacional existente, sem criar nova auditoria nesta camada. |

## Inventário atual

| Política         | Mutations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NOTIFY`         | `confirmations.acceptNomination`, `confirmations.declineNomination`, `confirmations.nominateReplacement`, `editor.assignDirect`, `editor.unassignDirect`, `scheduleInvites.create`, `swaps.accept`, `swaps.approveByOwner`, `swaps.offer`                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `BROADCAST`      | `shifts.notifyVacancy`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SILENT_AUDITED` | `confirmations.confirm`, `confirmations.decline`, `confirmations.registerPushToken`, `confirmations.unregisterPushToken`, `editor.markVacant`, `hospitals.create`, `profile.deactivateWhatsAppContact`, `profile.setWhatsAppContact`, `scheduleContexts.ensureDefaultSectorScale`, `scheduleInvites.revoke`, `shiftAssignments.assumeVacancy`, `shiftInstances.approveAssignment`, `shiftInstances.rejectAssignment`, `shifts.create`, `shifts.lock`, `shifts.openMonthShifts`, `shifts.publish`, `shifts.replicateMonthCalendar`, `shifts.replicateRange`, `shifts.replicateWeek`, `shifts.update`, `swaps.approve`, `swaps.cancel`, `swaps.reject`, `swaps.rejectByManager`, `voice.interpret` |

## Porta de CI

`tests/trpc-mutation-notification-policy.test.ts` usa a AST do TypeScript,
não regex. Ela descobre as chamadas `.mutation()` em todos os arquivos
`server/**/*.ts`, vincula cada uma ao router montado no `appRouter` e compara o
resultado com o inventário tipado. O teste falha para:

- mutation sem política;
- política inválida ou obsoleta;
- duas mutations com o mesmo caminho; ou
- router com mutation que não esteja montado no `appRouter`; ou
- alias, desestruturação ou acesso computado a `.mutation` que esconderia a
  procedure da inspeção AST.

Queries continuam fora desse contrato e não são reclassificadas nem recebem
efeito colateral.

## Exceção SSO estrita

`GET /api/sso/launch` consome um código SSO de uso único porque o browser
externo conclui o handoff por navegação. A exceção nomeada é
`SSO_ONE_TIME_LAUNCH_GET_CONSUMPTION_EXCEPTION`; ela não é uma mutation tRPC.
O mesmo teste confirma que existe exatamente uma rota `/launch` e que ela chama
`redeemLaunchCode`.
