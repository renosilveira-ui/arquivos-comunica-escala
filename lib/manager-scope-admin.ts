export type InstitutionRoleForScope = "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";

export type ManagerScopeDraft = {
  hospitalId: number;
  sectorId: number | null;
};

export function parseManagerScopes(raw: unknown): ManagerScopeDraft[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error("managerScopes deve ser uma lista");
  }
  const drafts: ManagerScopeDraft[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Cada escopo precisa de hospitalId");
    }
    const hospitalId = Number((item as { hospitalId?: unknown }).hospitalId);
    if (!Number.isInteger(hospitalId) || hospitalId <= 0) {
      throw new Error("hospitalId do escopo é inválido");
    }
    const rawSector = (item as { sectorId?: unknown }).sectorId;
    let sectorId: number | null = null;
    if (rawSector !== undefined && rawSector !== null && rawSector !== "") {
      const parsed = Number(rawSector);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("sectorId do escopo é inválido");
      }
      sectorId = parsed;
    }
    drafts.push({ hospitalId, sectorId });
  }
  return normalizeManagerScopes(drafts);
}

export function normalizeManagerScopes(
  scopes: readonly ManagerScopeDraft[],
): ManagerScopeDraft[] {
  const hospitalWide = new Set(
    scopes.filter((scope) => scope.sectorId == null).map((scope) => scope.hospitalId),
  );
  const seen = new Set<string>();
  const out: ManagerScopeDraft[] = [];
  for (const scope of scopes) {
    if (scope.sectorId != null && hospitalWide.has(scope.hospitalId)) {
      continue;
    }
    const key = `${scope.hospitalId}:${scope.sectorId ?? "all"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ hospitalId: scope.hospitalId, sectorId: scope.sectorId });
  }
  return out;
}

export function managerScopesRequiredForRole(
  role: InstitutionRoleForScope,
): boolean {
  return role === "GESTOR_MEDICO";
}

export function managerScopePickerTitle(): string {
  return "Hospitais que este gestor opera";
}

export function managerScopePickerHint(): string {
  return "Sem este escopo o gestor não abre calendário nem escala. Todo o hospital cobre todos os setores.";
}

export function managerScopeRequiredError(): string {
  return "Selecione o hospital que este gestor opera. Sem isso ele não abre o calendário.";
}

export function managerScopeNoHospitalError(): string {
  return "Cadastre um hospital nesta instituição antes de definir o gestor da escala.";
}

export function managerScopeHospitalWideLabel(hospitalName: string): string {
  return `${hospitalName} · todo o hospital`;
}

export function managerScopeSectorLabel(
  hospitalName: string,
  sectorName: string,
): string {
  return `${hospitalName} · ${sectorName}`;
}

export function scopeKey(scope: ManagerScopeDraft): string {
  return `${scope.hospitalId}:${scope.sectorId ?? "all"}`;
}
