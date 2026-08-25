import type { ActiveTenantSnapshot } from "./tenant-state";

export type AuthorizedInstitution = Readonly<{
  id: number;
  name: string;
  roleInInstitution: "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";
  isPrimary: boolean;
}>;

export type TenantAuthorizationSubject = Readonly<{
  userId: number;
  tenant: ActiveTenantSnapshot;
}>;

export type TenantAuthorizationTicket = Readonly<{
  generation: number;
  subject: TenantAuthorizationSubject;
}>;

export type TenantAuthorizationReceipt = Readonly<{
  ticket: TenantAuthorizationTicket;
  institutions: readonly AuthorizedInstitution[];
}>;

type TenantAuthorizationIdentity = Readonly<{
  id: number;
  approvalStatus?: "PENDING" | "APPROVED";
  mustChangePassword?: boolean;
}>;

type SessionIdentityValidation =
  | Readonly<{ status: "CHECKING" | "UNAVAILABLE" }>
  | Readonly<{
      status: "VERIFIED";
      userId: number;
      isCurrent: () => boolean;
    }>;

/**
 * Só uma identidade canônica da epoch atual pode iniciar o handshake tenant.
 * Usuário ainda em memória nunca substitui o receipt fresco de /me/login.
 */
export function canStartTenantAuthorizationHandshake(params: {
  user: TenantAuthorizationIdentity | null;
  sessionValidation: SessionIdentityValidation;
}): boolean {
  const { user, sessionValidation } = params;
  return (
    user !== null &&
    sessionValidation.status === "VERIFIED" &&
    sessionValidation.userId === user.id &&
    sessionValidation.isCurrent() &&
    user.approvalStatus === "APPROVED" &&
    user.mustChangePassword === false
  );
}

export function tenantAuthorityMatchesMembership(params: {
  institutionId: number;
  membership: AuthorizedInstitution;
  capabilities: Readonly<{
    institutionId: number;
    roleInInstitution: AuthorizedInstitution["roleInInstitution"];
    isGlobalAdmin: boolean;
  }>;
  managerScope: Readonly<{
    role: AuthorizedInstitution["roleInInstitution"];
  }>;
}): boolean {
  if (params.capabilities.institutionId !== params.institutionId) return false;
  if (params.capabilities.isGlobalAdmin) return true;
  return (
    params.capabilities.roleInInstitution === params.membership.roleInInstitution &&
    params.managerScope.role === params.membership.roleInInstitution
  );
}

function sameSubject(
  left: TenantAuthorizationSubject,
  right: TenantAuthorizationSubject,
): boolean {
  return (
    left.userId === right.userId &&
    left.tenant.institutionId === right.tenant.institutionId &&
    left.tenant.revision === right.tenant.revision
  );
}

/**
 * CAS temporal do handshake institucional. A geração detecta inclusive ABA:
 * A→B→A termina no mesmo id, mas nunca reutiliza a resposta da primeira A.
 */
export class TenantAuthorizationCoordinator {
  private generation = 0;

  begin(subject: TenantAuthorizationSubject): TenantAuthorizationTicket {
    this.generation += 1;
    return { generation: this.generation, subject };
  }

  invalidate(): void {
    this.generation += 1;
  }

  isCurrent(
    ticket: TenantAuthorizationTicket,
    currentSubject: TenantAuthorizationSubject,
  ): boolean {
    return (
      ticket.generation === this.generation &&
      sameSubject(ticket.subject, currentSubject)
    );
  }
}

export type TenantAuthorizationAttemptResult =
  | Readonly<{ status: "VERIFIED"; receipt: TenantAuthorizationReceipt }>
  | Readonly<{ status: "STALE" }>
  | Readonly<{ status: "TENANT_REVOKED" }>;

export type TenantAuthorizationActivity = Readonly<{
  visible: boolean;
  online: boolean;
  revision: number;
}>;

export function transitionTenantAuthorizationActivity(
  current: TenantAuthorizationActivity,
  patch: Partial<Pick<TenantAuthorizationActivity, "visible" | "online">>,
): Readonly<{
  state: TenantAuthorizationActivity;
  action: "NONE" | "CLOSE" | "REVALIDATE";
}> {
  const state = {
    visible: patch.visible ?? current.visible,
    online: patch.online ?? current.online,
    revision: current.revision,
  };
  if (state.visible === current.visible && state.online === current.online) {
    return { state: current, action: "NONE" };
  }

  state.revision += 1;
  if (!state.visible || !state.online) return { state, action: "CLOSE" };
  return { state, action: "REVALIDATE" };
}

/**
 * Handshake imperativo: a allowlist nunca vem do QueryClient. Para tenant
 * ativo, capabilities/scope também precisam ter sido carregados frescos antes
 * de o chamador montar qualquer UI ou promover o cache persistido.
 */
export async function runTenantAuthorizationAttempt(params: {
  coordinator: TenantAuthorizationCoordinator;
  ticket: TenantAuthorizationTicket;
  currentSubject: () => TenantAuthorizationSubject;
  loadInstitutions: () => Promise<readonly AuthorizedInstitution[]>;
  loadCurrentTenantAuthority: () => Promise<void>;
  clearRevokedTenant: () => Promise<void>;
}): Promise<TenantAuthorizationAttemptResult> {
  const institutions = await params.loadInstitutions();
  if (!params.coordinator.isCurrent(params.ticket, params.currentSubject())) {
    return { status: "STALE" };
  }

  const activeInstitutionId = params.ticket.subject.tenant.institutionId;
  if (activeInstitutionId !== null) {
    if (!institutions.some((institution) => institution.id === activeInstitutionId)) {
      await params.clearRevokedTenant();
      return { status: "TENANT_REVOKED" };
    }

    await params.loadCurrentTenantAuthority();
    if (!params.coordinator.isCurrent(params.ticket, params.currentSubject())) {
      return { status: "STALE" };
    }
  }

  return {
    status: "VERIFIED",
    receipt: { ticket: params.ticket, institutions },
  };
}
