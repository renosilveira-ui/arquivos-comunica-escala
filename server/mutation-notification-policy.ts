/**
 * Contrato alvo, declarativo e revisável, para notificações de mutações.
 *
 * Esta camada não emite eventos, não chama providers, não escreve no banco e
 * não comprova a entrega atual de push ou e-mail. Ela descreve o resultado que
 * cada fluxo deverá alcançar quando o motor operacional for conectado.
 */
export const MUTATION_NOTIFICATION_POLICIES = [
  "NOTIFY",
  "BROADCAST",
  "SILENT_AUDITED",
] as const;

export type MutationNotificationPolicy =
  (typeof MUTATION_NOTIFICATION_POLICIES)[number];

/** Audiências semânticas; nenhum nome textual é autoridade de acesso. */
export const MUTATION_NOTIFICATION_AUDIENCES = [
  "AFFECTED_ASSIGNED_PROFESSIONALS",
  "ASSIGNED_PROFESSIONALS",
  "DIRECTED_SWAP_RECIPIENT",
  "ELIGIBLE_PROFESSIONALS",
  "INVITED_USER",
  "INVITE_ISSUER_OR_MANAGER",
  "PENDING_SIGNUP_USER",
  "REPLACEMENT_CANDIDATE",
  "REQUESTING_PROFESSIONAL",
  "RESPONSIBLE_MANAGERS",
  "SWAP_COUNTERPART",
  "TARGET_ACCOUNT_USER",
] as const;

export type MutationNotificationAudience =
  (typeof MUTATION_NOTIFICATION_AUDIENCES)[number];

type NonEmptyAudience = readonly [
  MutationNotificationAudience,
  ...MutationNotificationAudience[],
];

export type MutationNotificationTarget =
  | {
      readonly policy: "SILENT_AUDITED";
      readonly when: string;
      readonly audience: readonly [];
    }
  | {
      readonly policy: "NOTIFY" | "BROADCAST";
      readonly when: string;
      readonly audience: NonEmptyAudience;
    };

/**
 * Uma mutation pode ter mais de um ramo. Cada ramo precisa declarar a
 * política, a condição de negócio e a audiência calculada pelo servidor.
 */
export type MutationNotificationTargetPolicy = {
  readonly targets: readonly [
    MutationNotificationTarget,
    ...MutationNotificationTarget[],
  ];
};

type MutationNotificationTargetInventory = Readonly<
  Record<string, MutationNotificationTargetPolicy>
>;

/** Inventário canônico de todas as mutations tRPC montadas no appRouter. */
export const TRPC_MUTATION_NOTIFICATION_TARGETS = {
  "confirmations.acceptNomination": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando o substituto indicado assume a alocação",
        audience: ["AFFECTED_ASSIGNED_PROFESSIONALS"],
      },
    ],
  },
  "confirmations.confirm": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando o próprio médico confirma o plantão sem outro destinatário afetado",
        audience: [],
      },
    ],
  },
  "confirmations.decline": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando a recusa cria necessidade de cobertura operacional",
        audience: ["RESPONSIBLE_MANAGERS"],
      },
    ],
  },
  "confirmations.declineNomination": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando o substituto indicado recusa e a cobertura volta a exigir ação",
        audience: ["RESPONSIBLE_MANAGERS"],
      },
    ],
  },
  "confirmations.nominateReplacement": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando um substituto é indicado para responder à oferta",
        audience: ["REPLACEMENT_CANDIDATE"],
      },
    ],
  },
  "confirmations.registerPushToken": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando o próprio usuário registra um dispositivo",
        audience: [],
      },
    ],
  },
  "confirmations.unregisterPushToken": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando o próprio usuário remove um dispositivo",
        audience: [],
      },
    ],
  },
  "notifications.acknowledgeAccountBadge": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando o próprio usuário reconhece os alertas visíveis da sua conta",
        audience: [],
      },
    ],
  },
  "editor.assignDirect": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando uma alocação direta é criada",
        audience: ["AFFECTED_ASSIGNED_PROFESSIONALS"],
      },
    ],
  },
  "editor.markVacant": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando remove uma ou mais alocações ativas ao marcar o plantão como vago",
        audience: ["AFFECTED_ASSIGNED_PROFESSIONALS"],
      },
      {
        policy: "SILENT_AUDITED",
        when: "quando marca como vago um plantão sem alocação ativa removida",
        audience: [],
      },
    ],
  },
  "editor.unassignDirect": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando remove uma alocação ativa específica",
        audience: ["AFFECTED_ASSIGNED_PROFESSIONALS"],
      },
    ],
  },
  "hospitals.create": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando a configuração administrativa não altera acesso ou plantão pessoal",
        audience: [],
      },
    ],
  },
  "profile.deactivateWhatsAppContact": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando o próprio usuário desativa seu contato",
        audience: [],
      },
    ],
  },
  "profile.setWhatsAppContact": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando o próprio usuário atualiza seu contato",
        audience: [],
      },
    ],
  },
  "scheduleContexts.ensureDefaultSectorScale": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando somente a estrutura mínima do setor é configurada",
        audience: [],
      },
    ],
  },
  "scheduleContexts.replaceSectorServiceSpecialties": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando somente o metadado assistencial descritivo do setor é alterado sem mudar acesso, elegibilidade ou alocação",
        audience: [],
      },
    ],
  },
  "scheduleInvites.create": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando um convite nominal é criado com sucesso",
        audience: ["INVITED_USER"],
      },
    ],
  },
  "scheduleInvites.revoke": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando um convite nominal ainda ativo é revogado",
        audience: ["INVITED_USER"],
      },
      {
        policy: "SILENT_AUDITED",
        when: "quando nenhuma permissão de convite ativa é removida",
        audience: [],
      },
    ],
  },
  "shiftAssignments.assumeVacancy": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando um profissional solicita uma vaga e a alocação pendente é criada",
        audience: ["RESPONSIBLE_MANAGERS"],
      },
    ],
  },
  "shiftInstances.approveAssignment": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando a solicitação de vaga é aprovada",
        audience: ["REQUESTING_PROFESSIONAL"],
      },
    ],
  },
  "shiftInstances.rejectAssignment": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando a solicitação de vaga é rejeitada",
        audience: ["REQUESTING_PROFESSIONAL"],
      },
    ],
  },
  "shifts.create": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando somente um turno de calendário sem alocação é criado",
        audience: [],
      },
    ],
  },
  "shifts.lock": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando o mês é bloqueado sem alteração pessoal de alocação",
        audience: [],
      },
    ],
  },
  "shifts.notifyVacancy": {
    targets: [
      {
        policy: "BROADCAST",
        when: "quando o gestor divulga explicitamente uma vaga à equipe elegível",
        audience: ["ELIGIBLE_PROFESSIONALS"],
      },
    ],
  },
  "shifts.openMonthShifts": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando abre somente o calendário do mês sem alocações",
        audience: [],
      },
    ],
  },
  "shifts.publish": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando a publicação inclui uma ou mais alocações ativas; consolidar uma mensagem por profissional e ação",
        audience: ["ASSIGNED_PROFESSIONALS"],
      },
      {
        policy: "SILENT_AUDITED",
        when: "quando a publicação contém apenas calendário sem alocações ativas",
        audience: [],
      },
    ],
  },
  "shifts.replicateMonthCalendar": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando replica somente o calendário vazio",
        audience: [],
      },
    ],
  },
  "shifts.replicateRange": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando includeAssignments é verdadeiro e ao menos uma alocação é copiada; consolidar uma mensagem por profissional e ação",
        audience: ["ASSIGNED_PROFESSIONALS"],
      },
      {
        policy: "SILENT_AUDITED",
        when: "quando é dry-run, não copia alocações ou replica somente calendário",
        audience: [],
      },
    ],
  },
  "shifts.replicateWeek": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando o wrapper replica semana sem alocações",
        audience: [],
      },
    ],
  },
  "shifts.update": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando horário, modalidade ou local de um plantão com alocação ativa é alterado",
        audience: ["AFFECTED_ASSIGNED_PROFESSIONALS"],
      },
      {
        policy: "SILENT_AUDITED",
        when: "quando não há alocação ativa afetada por horário, modalidade ou local",
        audience: [],
      },
    ],
  },
  "swaps.accept": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando a troca é aceita e efetivada",
        audience: ["SWAP_COUNTERPART"],
      },
    ],
  },
  "swaps.approve": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando o endpoint legado nega a decisão do gestor sem alterar a troca",
        audience: [],
      },
    ],
  },
  "swaps.approveByOwner": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando o dono efetiva uma candidatura residual de troca",
        audience: ["SWAP_COUNTERPART"],
      },
    ],
  },
  "swaps.cancel": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando o cancelamento atinge uma contraparte direcionada ou já aceita",
        audience: ["SWAP_COUNTERPART"],
      },
      {
        policy: "SILENT_AUDITED",
        when: "quando uma oferta aberta sem contraparte é cancelada",
        audience: [],
      },
    ],
  },
  "swaps.offer": {
    targets: [
      {
        policy: "BROADCAST",
        when: "quando a oferta é aberta e não informa toProfessionalId",
        audience: ["ELIGIBLE_PROFESSIONALS"],
      },
      {
        policy: "NOTIFY",
        when: "quando a oferta é direcionada e informa toProfessionalId",
        audience: ["DIRECTED_SWAP_RECIPIENT"],
      },
    ],
  },
  "swaps.reject": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando a contraparte rejeita uma oferta direcionada",
        audience: ["SWAP_COUNTERPART"],
      },
      {
        policy: "SILENT_AUDITED",
        when: "quando um profissional apenas dispensa para si uma oferta aberta que continua disponível",
        audience: [],
      },
    ],
  },
  "swaps.rejectByManager": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando o endpoint legado nega a decisão do gestor sem alterar a troca",
        audience: [],
      },
    ],
  },
  "voice.interpret": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando somente a interpretação de voz é registrada sem novo impacto pessoal",
        audience: [],
      },
    ],
  },
} as const satisfies MutationNotificationTargetInventory;

export type TrpcMutationPath = keyof typeof TRPC_MUTATION_NOTIFICATION_TARGETS;

/** Inventário canônico de endpoints Express externos mutáveis. */
export const EXPRESS_MUTATION_NOTIFICATION_TARGETS = {
  "DELETE /api/admin/users/:id": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "enquanto o endpoint retornar 501 e não remover acesso",
        audience: [],
      },
    ],
  },
  "DELETE /api/auth/me": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando o usuário encerra a própria sessão",
        audience: [],
      },
    ],
  },
  "POST /.well-known/generate": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando gera código técnico de SSO sem impacto pessoal de escala",
        audience: [],
      },
    ],
  },
  "POST /.well-known/launch-code": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando gera código técnico de lançamento SSO",
        audience: [],
      },
    ],
  },
  "POST /api/admin/pending-signups/:id/approve": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando a aprovação ativa a conta e o vínculo institucional pendentes",
        audience: ["PENDING_SIGNUP_USER"],
      },
    ],
  },
  "POST /api/admin/pending-signups/:id/reject": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando a recusa remove o cadastro pendente; capturar o destinatário antes da remoção",
        audience: ["PENDING_SIGNUP_USER"],
      },
    ],
  },
  "POST /api/admin/users/:id/reset-password": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando a credencial temporária é criada para a conta alvo",
        audience: ["TARGET_ACCOUNT_USER"],
      },
    ],
  },
  "POST /api/auth/change-password": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando o próprio usuário altera a própria senha sem outro destinatário",
        audience: [],
      },
    ],
  },
  "POST /api/auth/decline-invite": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando um convite é recusado",
        audience: ["INVITE_ISSUER_OR_MANAGER"],
      },
    ],
  },
  "POST /api/auth/forgot-password": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando uma solicitação de redefinição é aceita para a conta alvo",
        audience: ["TARGET_ACCOUNT_USER"],
      },
    ],
  },
  "POST /api/auth/login": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando uma sessão é iniciada sem alteração de acesso institucional",
        audience: [],
      },
    ],
  },
  "POST /api/auth/logout": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando o usuário encerra a própria sessão",
        audience: [],
      },
    ],
  },
  "POST /api/auth/redeem-invite": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando um convite é aceito e o vínculo é ativado",
        audience: ["INVITE_ISSUER_OR_MANAGER"],
      },
    ],
  },
  "POST /api/auth/register": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando cria credenciais ou ativa vínculo e acesso institucional para a conta alvo",
        audience: ["TARGET_ACCOUNT_USER"],
      },
      {
        policy: "SILENT_AUDITED",
        when: "quando a tentativa não cria nem reativa acesso institucional",
        audience: [],
      },
    ],
  },
  "POST /api/auth/reset-password": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando o próprio usuário conclui a redefinição sem outro destinatário",
        audience: [],
      },
    ],
  },
  "POST /api/auth/signup": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando o autocadastro permanece pendente e não concede acesso institucional",
        audience: [],
      },
    ],
  },
  "POST /api/auth/sso-exchange": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando a troca técnica de SSO não altera papel ou escopo",
        audience: [],
      },
    ],
  },
  "POST /api/auth/ssoExchange": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando a troca técnica de SSO não altera papel ou escopo",
        audience: [],
      },
    ],
  },
  "POST /api/integrations/hospital-alert/shifts/end": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando o proxy técnico sincroniza fim de plantão sem nova decisão pessoal",
        audience: [],
      },
    ],
  },
  "POST /api/integrations/hospital-alert/shifts/start": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando o proxy técnico sincroniza início de plantão sem nova decisão pessoal",
        audience: [],
      },
    ],
  },
  "POST /api/integrations/hospital-alert/sync-user": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando o proxy técnico sincroniza usuário sem alterar escopo no Escala",
        audience: [],
      },
    ],
  },
  "POST /api/sso/generate": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando gera código técnico de SSO sem impacto pessoal de escala",
        audience: [],
      },
    ],
  },
  "POST /api/sso/launch-code": {
    targets: [
      {
        policy: "SILENT_AUDITED",
        when: "quando gera código técnico de lançamento SSO",
        audience: [],
      },
    ],
  },
  "PUT /api/admin/users/:id": {
    targets: [
      {
        policy: "NOTIFY",
        when: "quando muda roleInInstitution, managerScopes, schedule contexts, professional_access ou outra concessão ou revogação de acesso institucional",
        audience: ["TARGET_ACCOUNT_USER"],
      },
      {
        policy: "SILENT_AUDITED",
        when: "quando altera somente dados sem impacto no papel ou escopo institucional",
        audience: [],
      },
    ],
  },
} as const satisfies MutationNotificationTargetInventory;

export type ExpressMutationEndpoint =
  keyof typeof EXPRESS_MUTATION_NOTIFICATION_TARGETS;

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
