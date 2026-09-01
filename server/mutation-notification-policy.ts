/**
 * Contrato declarativo de comportamento de notificação para mutações de API.
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
 * Inventário canônico de endpoints Express externos que usam POST, PUT, PATCH
 * ou DELETE. As chaves incluem método e caminho já resolvido após app.use().
 *
 * NOTIFY somente marca fluxos que já entregam ou enfileiram aviso dirigido.
 * Os demais endpoints preservam seu comportamento atual sem habilitar novos
 * eventos, providers, entregas ou escrita de auditoria.
 */
export const EXPRESS_MUTATION_NOTIFICATION_POLICIES = {
  "DELETE /api/admin/users/:id": "SILENT_AUDITED",
  "DELETE /api/auth/me": "SILENT_AUDITED",
  "POST /.well-known/generate": "SILENT_AUDITED",
  "POST /.well-known/launch-code": "SILENT_AUDITED",
  "POST /api/admin/pending-signups/:id/approve": "SILENT_AUDITED",
  "POST /api/admin/pending-signups/:id/reject": "SILENT_AUDITED",
  "POST /api/admin/users/:id/reset-password": "NOTIFY",
  "POST /api/auth/change-password": "SILENT_AUDITED",
  "POST /api/auth/decline-invite": "NOTIFY",
  "POST /api/auth/forgot-password": "NOTIFY",
  "POST /api/auth/login": "SILENT_AUDITED",
  "POST /api/auth/logout": "SILENT_AUDITED",
  "POST /api/auth/redeem-invite": "NOTIFY",
  "POST /api/auth/register": "SILENT_AUDITED",
  "POST /api/auth/reset-password": "SILENT_AUDITED",
  "POST /api/auth/signup": "SILENT_AUDITED",
  "POST /api/auth/sso-exchange": "SILENT_AUDITED",
  "POST /api/auth/ssoExchange": "SILENT_AUDITED",
  "POST /api/integrations/hospital-alert/shifts/end": "SILENT_AUDITED",
  "POST /api/integrations/hospital-alert/shifts/start": "SILENT_AUDITED",
  "POST /api/integrations/hospital-alert/sync-user": "SILENT_AUDITED",
  "POST /api/sso/generate": "SILENT_AUDITED",
  "POST /api/sso/launch-code": "SILENT_AUDITED",
  "PUT /api/admin/users/:id": "SILENT_AUDITED",
} as const satisfies Readonly<Record<string, MutationNotificationPolicy>>;

export type ExpressMutationEndpoint =
  keyof typeof EXPRESS_MUTATION_NOTIFICATION_POLICIES;

/**
 * Exceção estrita para GET com escrita: o navegador externo precisa seguir a
 * navegação para consumir o código SSO de uso único. ssoRouter é montado em
 * ambos os prefixes abaixo; não é query e não entra no inventário POST/PUT/
 * PATCH/DELETE. O teste confirma a rota, ambos os caminhos externos e o
 * consumo efetivo do código.
 */
export const SSO_ONE_TIME_LAUNCH_GET_CONSUMPTION_EXCEPTION = {
  id: "SSO_ONE_TIME_LAUNCH_GET_CONSUMPTION",
  routes: ["GET /.well-known/launch", "GET /api/sso/launch"],
  reason:
    "O código de lançamento SSO é consumido uma única vez no navegador externo em cada prefixo montado do mesmo handler.",
} as const;
