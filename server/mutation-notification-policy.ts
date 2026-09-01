/**
 * Contrato declarativo de comportamento de notificação para mutations tRPC.
 *
 * Esta camada não emite eventos, não chama providers e não escreve no banco.
 * Ela só torna a intenção revisável e permite que o teste AST impeça novas
 * mutations sem classificação explícita.
 */
export const MUTATION_NOTIFICATION_POLICIES = [
  "NOTIFY",
  "BROADCAST",
  "SILENT_AUDITED",
] as const;

export type MutationNotificationPolicy =
  (typeof MUTATION_NOTIFICATION_POLICIES)[number];

/**
 * Inventário canônico de todas as mutations tRPC publicadas no appRouter.
 *
 * NOTIFY: a mutation já agenda/entrega aviso dirigido para destinatário(s).
 * BROADCAST: a mutation já seleciona uma audiência elegível e a avisa.
 * SILENT_AUDITED: não inicia aviso ao usuário; sua trilha operacional segue
 * sendo a que já existia no domínio. A classificação não cria auditoria nova.
 */
export const TRPC_MUTATION_NOTIFICATION_POLICIES = {
  "confirmations.acceptNomination": "NOTIFY",
  "confirmations.confirm": "SILENT_AUDITED",
  "confirmations.decline": "SILENT_AUDITED",
  "confirmations.declineNomination": "NOTIFY",
  "confirmations.nominateReplacement": "NOTIFY",
  "confirmations.registerPushToken": "SILENT_AUDITED",
  "confirmations.unregisterPushToken": "SILENT_AUDITED",
  "editor.assignDirect": "NOTIFY",
  "editor.markVacant": "SILENT_AUDITED",
  "editor.unassignDirect": "NOTIFY",
  "hospitals.create": "SILENT_AUDITED",
  "profile.deactivateWhatsAppContact": "SILENT_AUDITED",
  "profile.setWhatsAppContact": "SILENT_AUDITED",
  "scheduleContexts.ensureDefaultSectorScale": "SILENT_AUDITED",
  "scheduleInvites.create": "NOTIFY",
  "scheduleInvites.revoke": "SILENT_AUDITED",
  "shiftAssignments.assumeVacancy": "SILENT_AUDITED",
  "shiftInstances.approveAssignment": "SILENT_AUDITED",
  "shiftInstances.rejectAssignment": "SILENT_AUDITED",
  "shifts.create": "SILENT_AUDITED",
  "shifts.lock": "SILENT_AUDITED",
  "shifts.notifyVacancy": "BROADCAST",
  "shifts.openMonthShifts": "SILENT_AUDITED",
  "shifts.publish": "SILENT_AUDITED",
  "shifts.replicateMonthCalendar": "SILENT_AUDITED",
  "shifts.replicateRange": "SILENT_AUDITED",
  "shifts.replicateWeek": "SILENT_AUDITED",
  "shifts.update": "SILENT_AUDITED",
  "swaps.accept": "NOTIFY",
  "swaps.approve": "SILENT_AUDITED",
  "swaps.approveByOwner": "NOTIFY",
  "swaps.cancel": "SILENT_AUDITED",
  "swaps.offer": "NOTIFY",
  "swaps.reject": "SILENT_AUDITED",
  "swaps.rejectByManager": "SILENT_AUDITED",
  "voice.interpret": "SILENT_AUDITED",
} as const satisfies Readonly<Record<string, MutationNotificationPolicy>>;

export type TrpcMutationPath = keyof typeof TRPC_MUTATION_NOTIFICATION_POLICIES;

/**
 * Exceção estrita fora do tRPC: o navegador externo precisa seguir um GET para
 * consumir o código SSO de uso único. Não é query e não entra no inventário de
 * mutations tRPC; `tests/trpc-mutation-notification-policy.test.ts` confirma
 * a rota e o consumo efetivo do código.
 */
export const SSO_ONE_TIME_LAUNCH_GET_CONSUMPTION_EXCEPTION = {
  id: "SSO_ONE_TIME_LAUNCH_GET_CONSUMPTION",
  route: "GET /api/sso/launch",
  reason:
    "O código de lançamento SSO é consumido uma única vez no navegador externo.",
} as const;
