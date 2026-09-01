# Contrato-alvo de notificação das mutações

O arquivo `server/mutation-notification-policy.ts` inventaria cada mutation tRPC montada no `appRouter` e cada endpoint Express externo mutável.

Este é um contrato **alvo**, não uma prova de entrega atual: esta PR não cria evento, outbox, provider, envio de push/e-mail, migration ou auditoria nova. O motor operacional futuro deverá consumir estas regras sem enviar em paralelo ao caminho antigo.

## Forma do contrato

Cada mutation ou endpoint possui um ou mais ramos `targets`:

```ts
{
  targets: [
    { policy: "NOTIFY", when: "condição verificável", audience: ["AFFECTED_ASSIGNED_PROFESSIONALS"] },
    { policy: "SILENT_AUDITED", when: "ramo sem impacto pessoal", audience: [] },
  ],
}
```

| Política         | Significado-alvo                                                               |
| ---------------- | ------------------------------------------------------------------------------ |
| `NOTIFY`         | Criar aviso dirigido após o commit para a audiência calculada pelo servidor.   |
| `BROADCAST`      | Criar aviso coletivo para a audiência elegível calculada pelo servidor.        |
| `SILENT_AUDITED` | Não comunicar usuário; preservar ou criar somente a trilha auditável adequada. |

Quando ativados, `NOTIFY` e `BROADCAST` deverão usar push e e-mail independentemente, respeitando confiança de e-mail, autorização vigente e retentativas. Esta PR ainda não implementa esses mecanismos.

As audiências são identificadores semânticos, nunca nomes de pessoas, hospitais ou setores. A resolução futura deve usar IDs de instituição, hospital, setor, contexto de escala, plantão e alocação.

## Ramos operacionais fixados

| Fluxo                                                               | Ramo-alvo                                                                                                                   |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `editor.markVacant`                                                 | `NOTIFY` aos profissionais removidos se houver alocação ativa; caso contrário `SILENT_AUDITED`.                             |
| `shiftAssignments.assumeVacancy`                                    | `NOTIFY` aos gestores responsáveis quando cria pedido pendente.                                                             |
| `shiftInstances.approveAssignment` e `rejectAssignment`             | `NOTIFY` ao profissional solicitante.                                                                                       |
| `shifts.update`                                                     | `NOTIFY` aos alocados somente quando horário, modalidade ou local muda com alocação ativa; os demais ramos são silenciosos. |
| `shifts.publish`                                                    | `NOTIFY` consolidado por profissional quando há alocações; calendário vazio é silencioso.                                   |
| `shifts.replicateRange`                                             | `NOTIFY` consolidado somente com `includeAssignments=true` e cópia efetiva; dry-run e calendário puro são silenciosos.      |
| `shifts.replicateMonthCalendar`, `replicateWeek`, `openMonthShifts` | `SILENT_AUDITED`, pois não criam alocações.                                                                                 |
| `scheduleContexts.replaceSectorServiceSpecialties`                  | `SILENT_AUDITED`: altera somente metadado assistencial descritivo, sem mudar acesso, elegibilidade ou alocação.                |
| `shifts.notifyVacancy`                                              | `BROADCAST` aos profissionais elegíveis.                                                                                    |
| `swaps.offer`                                                       | Oferta aberta faz `BROADCAST`; oferta com `toProfessionalId` faz `NOTIFY` dirigido.                                         |
| `swaps.reject` e `swaps.cancel`                                     | Avisam contraparte somente quando ela existe; dispensa/cancelamento de oferta aberta sem contraparte é silencioso.          |
| `scheduleInvites.create` e `revoke`                                 | Convite nominal criado ou revogado ativo avisa o usuário convidado.                                                         |

## Criação, convite e acesso

| Endpoint                                                       | Ramo-alvo                                                                                                                                                           |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/admin/pending-signups/:id/approve`                  | `NOTIFY` ao usuário pendente quando ativa conta e vínculo.                                                                                                          |
| `POST /api/admin/pending-signups/:id/reject`                   | `NOTIFY` ao usuário pendente; o destinatário precisa ser capturado antes da remoção.                                                                                |
| `POST /api/auth/register`                                      | `NOTIFY` somente se cria credenciais ou ativa vínculo/acesso; caso contrário silêncio auditável.                                                                    |
| `PUT /api/admin/users/:id`                                     | `NOTIFY` se muda `roleInInstitution`, `managerScopes`, contextos de escala, `professional_access` ou outra concessão/revogação; atualização cadastral é silenciosa. |
| `POST /api/auth/redeem-invite` e `decline-invite`              | `NOTIFY` ao emissor ou gestor do convite.                                                                                                                           |
| `POST /api/admin/users/:id/reset-password` e `forgot-password` | `NOTIFY` à conta-alvo.                                                                                                                                              |
| `DELETE /api/admin/users/:id`                                  | `SILENT_AUDITED` enquanto retorna `501` e não remove acesso.                                                                                                        |

Autocadastro público permanece silencioso enquanto não concede acesso institucional. Se passar a conceder, deverá receber ramo explícito e teste antes da integração.

## Porta de CI

`tests/trpc-mutation-notification-policy.test.ts` inspeciona AST do TypeScript, não regex. A suíte descobre mutations tRPC e rotas Express montadas e falha para entradas ausentes ou obsoletas, políticas inválidas, targets sem `when`, audiência inválida, caminhos ocultos por alias/acesso computado e duplicidades.

Os testes também fixam os ramos corporativos acima, para que uma alteração futura não silencie remoções, aprovações, publicações com alocação, trocas dirigidas ou alterações de acesso sem revisão deliberada.

`vitest.pure.config.ts` executa essa porta sem setup de MySQL. Queries ficam fora do contrato.

## Exceção SSO

`GET /.well-known/launch` e `GET /api/sso/launch` consomem código de uso único por navegação do browser. A exceção é `SSO_ONE_TIME_LAUNCH_GET_CONSUMPTION_EXCEPTION`; ela não é query nem mutation tRPC.
