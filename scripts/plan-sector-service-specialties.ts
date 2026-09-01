import { buildKnownSectorServiceSpecialtyPlan } from "../lib/known-sector-service-specialty-plan";

/**
 * Relatório estritamente local: usa somente o catálogo versionado e não abre
 * conexão com banco. A aplicação posterior deve ser feita pelo endpoint
 * administrativo, com topologia selecionada e autorização do gestor.
 */
const report = {
  mode: "READ_ONLY_PLAN",
  databaseAccess: false,
  writeOperations: [],
  institution: "Unimed",
  hospitals: buildKnownSectorServiceSpecialtyPlan(),
  intentionallyUnmapped: ["Hospital São Carlos", "Hospital das Clínicas"],
};

console.log(JSON.stringify(report, null, 2));
