export function createSectorScaleButtonTitle(): string {
  return "Criar escala do setor";
}

export function createSectorScaleModalTitle(): string {
  return "Criar escala do setor";
}

export function createSectorScaleDescription(): string {
  return "Escolha o hospital e o setor. Os turnos padrão (manhã, tarde e noite) são criados automaticamente. Depois você abre o mês na agenda.";
}

export function createSectorScaleEmptyTitle(): string {
  return "Ainda não há escala neste hospital";
}

export function createSectorScaleEmptyDescription(): string {
  return "Crie a escala do setor para abrir o calendário e os plantões vagos. Qualquer hospital da instituição usa o mesmo caminho.";
}

export function createSectorScaleNoHospitalTitle(): string {
  return "Nenhum hospital neste vínculo";
}

export function createSectorScaleNoHospitalDescription(): string {
  return "Peça ao administrador para cadastrar o hospital da instituição. Sem hospital não há calendário para abrir.";
}

export function createSectorScaleNoJurisdictionTitle(): string {
  return "Sem permissão para gerir a escala deste hospital";
}

export function createSectorScaleNoJurisdictionDescription(): string {
  return "O hospital existe neste vínculo, mas você não tem escopo para operar a escala. Peça o escopo ao administrador.";
}

export function createSectorScaleConfirmTitle(): string {
  return "Criar escala";
}

export function createSectorScaleNewSectorLabel(): string {
  return "Novo setor";
}

export function createSectorScaleNamePlaceholder(): string {
  return "Ex.: centro cirúrgico";
}

export function createSectorScaleToast(sectorName: string): string {
  return `Escala de ${sectorName} pronta. Agora você pode abrir os turnos do mês.`;
}

export function createSectorScaleDoctorHint(): string {
  return "Solicite ao gestor a liberação do hospital, setor e qualificação corretos para o seu vínculo.";
}
