import {
  DEFAULT_SECTOR_SHIFT_TEMPLATES,
  type DefaultSectorShiftTemplate,
} from "./default-sector-shift-blueprint";

/**
 * O normalizador nunca decide por texto qual setor deve ser tratado. Os IDs
 * deste triplo são a única autoridade para ler e eventualmente criar a
 * estrutura mínima de uma escala.
 */
export type CorporateStructuralTarget = Readonly<{
  institutionId: number;
  hospitalId: number;
  sectorId: number;
}>;

export type CorporateStructuralScheduleContext = Readonly<{
  id: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number;
  medicalSpecialtyId: number | null;
  operationalProfileCode: string | null;
  admissionPolicy: string;
  active: boolean;
}>;

export type CorporateStructuralShiftTemplate = Readonly<{
  id: number;
  institutionId: number;
  hospitalId: number;
  sectorId: number | null;
  name: string;
  startTime: string;
  endTime: string;
  isActive: boolean;
  priority: number;
}>;

export type CorporateStructuralIssueCode =
  | "INVALID_TARGET_ID"
  | "CONTEXT_TOPOLOGY_MISMATCH"
  | "CONTEXT_DUPLICATE_GENERAL"
  | "CONTEXT_INACTIVE_GENERAL"
  | "CONTEXT_CONFIGURATION_DIVERGENT"
  | "TEMPLATE_TOPOLOGY_MISMATCH"
  | "TEMPLATE_INACTIVE"
  | "TEMPLATE_DUPLICATE"
  | "TEMPLATE_CONFIGURATION_DIVERGENT"
  | "HOSPITAL_TEMPLATE_FALLBACK_INCOMPLETE";

export type CorporateStructuralIssue = Readonly<{
  code: CorporateStructuralIssueCode;
  /** Aviso operacional que impede a alteração apenas deste setor. */
  scope: "SECTOR";
}>;

export type CorporateStructuralAction =
  | Readonly<{
      kind: "CREATE_GENERAL_CONTEXT";
      institutionId: number;
      hospitalId: number;
      sectorId: number;
      admissionPolicy: "ALL_CFM_SPECIALTIES";
      medicalSpecialtyId: null;
      operationalProfileCode: null;
    }>
  | Readonly<{
      kind: "CREATE_SECTOR_TEMPLATE";
      institutionId: number;
      hospitalId: number;
      sectorId: number;
      name: DefaultSectorShiftTemplate["name"];
      startTime: string;
      endTime: string;
      priority: number;
    }>;

export type CorporateStructuralNormalizationPlan = Readonly<{
  target: CorporateStructuralTarget;
  status: "READY" | "ALREADY_COMPLIANT" | "BLOCKED";
  issues: readonly CorporateStructuralIssue[];
  actions: readonly CorporateStructuralAction[];
}>;

export type CorporateStructuralNormalizationInput = Readonly<{
  target: CorporateStructuralTarget;
  contexts: readonly CorporateStructuralScheduleContext[];
  templates: readonly CorporateStructuralShiftTemplate[];
}>;

/**
 * A única política que o normalizador pode criar. Ela não fixa uma
 * especialidade nem um perfil operacional; logo, não introduz uma nova trava
 * de especialidade. O motor de elegibilidade existente permanece responsável
 * por ACL e qualificações já configuradas no setor.
 */
export const CORPORATE_GENERAL_CONTEXT_POLICY = "ALL_CFM_SPECIALTIES" as const;

/** Frase deliberadamente explícita exigida junto de `--apply`. */
export const CORPORATE_STRUCTURE_NORMALIZER_CONFIRMATION =
  "APPLY_MINIMUM_SCHEDULE_STRUCTURE" as const;

export type CorporateStructuralCliArgs = Readonly<{
  /** Intenção vinda da CLI; não é autorização de escrita. */
  requestedApply: boolean;
}>;

const corporateStructuralApplyAuthorization = Symbol(
  "corporate-structural-apply-authorization",
);

/**
 * Prova interna de que a CLI pediu --apply e apresentou a confirmação exata.
 * Um booleano de request nunca é aceito pelo executor como autorização.
 */
export type CorporateStructuralApplyAuthorization = Readonly<{
  [corporateStructuralApplyAuthorization]: true;
}>;

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function sameTarget(
  row: Pick<
    CorporateStructuralScheduleContext | CorporateStructuralShiftTemplate,
    "institutionId" | "hospitalId"
  > & { sectorId: number | null },
  target: CorporateStructuralTarget,
): boolean {
  return (
    row.institutionId === target.institutionId &&
    row.hospitalId === target.hospitalId &&
    row.sectorId === target.sectorId
  );
}

function normalizeClock(value: string): string {
  const trimmed = value.trim();
  if (/^\d{2}:\d{2}$/.test(trimmed)) return `${trimmed}:00`;
  return trimmed;
}

function hasExactGeneralContext(
  context: CorporateStructuralScheduleContext,
): boolean {
  return (
    context.admissionPolicy === CORPORATE_GENERAL_CONTEXT_POLICY &&
    context.medicalSpecialtyId === null &&
    context.operationalProfileCode === null
  );
}

function templateMatchesDefault(
  template: CorporateStructuralShiftTemplate,
  expected: DefaultSectorShiftTemplate,
): boolean {
  return (
    template.name === expected.name &&
    normalizeClock(template.startTime) === expected.startTime &&
    normalizeClock(template.endTime) === expected.endTime &&
    template.priority === expected.priority
  );
}

function addIssue(
  issues: CorporateStructuralIssue[],
  code: CorporateStructuralIssueCode,
): void {
  if (issues.some((issue) => issue.code === code)) return;
  issues.push({ code, scope: "SECTOR" });
}

type TemplateAssessment = Readonly<{
  issues: readonly CorporateStructuralIssue[];
  missing: readonly DefaultSectorShiftTemplate[];
}>;

function assessExactTemplateSet(
  templates: readonly CorporateStructuralShiftTemplate[],
): TemplateAssessment {
  const issues: CorporateStructuralIssue[] = [];
  const active = templates.filter((template) => template.isActive);
  if (active.length !== templates.length) addIssue(issues, "TEMPLATE_INACTIVE");

  const found = new Set<DefaultSectorShiftTemplate["name"]>();
  for (const template of active) {
    const matching = DEFAULT_SECTOR_SHIFT_TEMPLATES.find((expected) =>
      templateMatchesDefault(template, expected),
    );
    if (!matching) {
      addIssue(issues, "TEMPLATE_CONFIGURATION_DIVERGENT");
      continue;
    }
    if (found.has(matching.name)) {
      addIssue(issues, "TEMPLATE_DUPLICATE");
      continue;
    }
    found.add(matching.name);
  }

  return {
    issues,
    missing: DEFAULT_SECTOR_SHIFT_TEMPLATES.filter(
      (expected) => !found.has(expected.name),
    ),
  };
}

/**
 * Produz somente um plano. Não acessa banco e não executa mutação; isso torna
 * o dry-run testável e mantém decisão clínica/configuracional fora do script.
 */
export function planCorporateStructuralNormalization(
  input: CorporateStructuralNormalizationInput,
): CorporateStructuralNormalizationPlan {
  const { target } = input;
  const issues: CorporateStructuralIssue[] = [];
  if (
    !isPositiveSafeInteger(target.institutionId) ||
    !isPositiveSafeInteger(target.hospitalId) ||
    !isPositiveSafeInteger(target.sectorId)
  ) {
    addIssue(issues, "INVALID_TARGET_ID");
  }

  // A consulta do adaptador traz qualquer linha que referencia este sectorId.
  // Linhas fora da tripla canônica são corrupção/topologia ambígua, nunca
  // candidatas para serem reaproveitadas.
  const contextRows = input.contexts.filter(
    (context) => context.sectorId === target.sectorId,
  );
  if (contextRows.some((context) => !sameTarget(context, target))) {
    addIssue(issues, "CONTEXT_TOPOLOGY_MISMATCH");
  }
  const contexts = contextRows.filter((context) => sameTarget(context, target));
  const generalContexts = contexts.filter(hasExactGeneralContext);
  const activeGeneralContexts = generalContexts.filter(
    (context) => context.active,
  );

  if (generalContexts.length > 1) addIssue(issues, "CONTEXT_DUPLICATE_GENERAL");
  if (generalContexts.some((context) => !context.active)) {
    addIssue(issues, "CONTEXT_INACTIVE_GENERAL");
  }
  if (
    contexts.length > 0 &&
    (contexts.length !== 1 || activeGeneralContexts.length !== 1)
  ) {
    addIssue(issues, "CONTEXT_CONFIGURATION_DIVERGENT");
  }

  const sectorTemplateRows = input.templates.filter(
    (template) => template.sectorId === target.sectorId,
  );
  const hospitalTemplateRows = input.templates.filter(
    (template) =>
      template.hospitalId === target.hospitalId && template.sectorId === null,
  );
  if (
    sectorTemplateRows.some((template) => !sameTarget(template, target)) ||
    hospitalTemplateRows.some(
      (template) => template.institutionId !== target.institutionId,
    )
  ) {
    addIssue(issues, "TEMPLATE_TOPOLOGY_MISMATCH");
  }
  const sectorTemplates = sectorTemplateRows.filter((template) =>
    sameTarget(template, target),
  );
  const hospitalTemplates = hospitalTemplateRows.filter(
    (template) => template.institutionId === target.institutionId,
  );

  let missingTemplates: readonly DefaultSectorShiftTemplate[] = [];
  if (sectorTemplates.length > 0) {
    const assessment = assessExactTemplateSet(sectorTemplates);
    issues.push(...assessment.issues);
    missingTemplates = assessment.missing;
  } else if (hospitalTemplateRows.length > 0) {
    // O primeiro mês usa exclusivamente templates do setor quando eles
    // existem. Se há fallback hospitalar, criar cópia parcial no setor mudaria
    // o comportamento da agenda; por isso só aceitamos o conjunto completo.
    const assessment = assessExactTemplateSet(hospitalTemplates);
    issues.push(...assessment.issues);
    if (assessment.issues.length === 0 && assessment.missing.length > 0) {
      addIssue(issues, "HOSPITAL_TEMPLATE_FALLBACK_INCOMPLETE");
    }
  } else {
    missingTemplates = DEFAULT_SECTOR_SHIFT_TEMPLATES;
  }

  if (issues.length > 0) {
    return { target, status: "BLOCKED", issues, actions: [] };
  }

  const actions: CorporateStructuralAction[] = [];
  if (contexts.length === 0) {
    actions.push({
      kind: "CREATE_GENERAL_CONTEXT",
      institutionId: target.institutionId,
      hospitalId: target.hospitalId,
      sectorId: target.sectorId,
      admissionPolicy: CORPORATE_GENERAL_CONTEXT_POLICY,
      medicalSpecialtyId: null,
      operationalProfileCode: null,
    });
  }
  for (const template of missingTemplates) {
    actions.push({
      kind: "CREATE_SECTOR_TEMPLATE",
      institutionId: target.institutionId,
      hospitalId: target.hospitalId,
      sectorId: target.sectorId,
      name: template.name,
      startTime: template.startTime,
      endTime: template.endTime,
      priority: template.priority,
    });
  }

  return {
    target,
    status: actions.length > 0 ? "READY" : "ALREADY_COMPLIANT",
    issues: [],
    actions,
  };
}

/**
 * Parser deliberadamente pequeno e fechado: não aceita selecionar por nome,
 * nem flags que ampliem o escopo do normalizador.
 */
export function parseCorporateStructuralCliArgs(
  argv: readonly string[],
): CorporateStructuralCliArgs {
  let requestedApply = false;
  for (const token of argv) {
    if (token === "--apply") {
      requestedApply = true;
      continue;
    }
    throw new Error(`Argumento não reconhecido: ${token}`);
  }
  return { requestedApply };
}

export function authorizeCorporateStructuralApply(
  args: CorporateStructuralCliArgs,
  env: Readonly<Record<string, string | undefined>>,
): CorporateStructuralApplyAuthorization | null {
  if (!args.requestedApply) return null;
  if (
    env.CORPORATE_STRUCTURE_NORMALIZER_CONFIRM !==
    CORPORATE_STRUCTURE_NORMALIZER_CONFIRMATION
  ) {
    throw new Error(
      `--apply exige CORPORATE_STRUCTURE_NORMALIZER_CONFIRM=${CORPORATE_STRUCTURE_NORMALIZER_CONFIRMATION}`,
    );
  }
  return { [corporateStructuralApplyAuthorization]: true };
}

function hasCorporateStructuralApplyAuthorization(
  value: unknown,
): value is CorporateStructuralApplyAuthorization {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[
      corporateStructuralApplyAuthorization
    ] === true
  );
}

/**
 * Barreira adicional para dry-run: sem prova de autorização, nenhum executor
 * recebe ação.
 */
export async function executeCorporateStructuralPlan(
  plan: CorporateStructuralNormalizationPlan,
  authorization: CorporateStructuralApplyAuthorization | null,
  execute: (action: CorporateStructuralAction) => Promise<void>,
): Promise<number> {
  if (
    !hasCorporateStructuralApplyAuthorization(authorization) ||
    plan.status !== "READY"
  ) {
    return 0;
  }
  for (const action of plan.actions) await execute(action);
  return plan.actions.length;
}
