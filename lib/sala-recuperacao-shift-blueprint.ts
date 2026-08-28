/**
 * Compatibilidade: a Sala de Recuperação (São Carlos) usa o blueprint
 * padrão de setor. Não é um calendário exclusivo — qualquer instituição
 * sem templates próprios recebe as mesmas janelas.
 *
 * Scripts HSC de qualificação/allowlist continuam neste arquivo só pelo
 * nome do setor e do gestor médico do piloto.
 */

export {
  DEFAULT_SECTOR_SHIFT_TEMPLATES as SALA_RECUPERACAO_SHIFT_TEMPLATES,
  defaultCalendarDaysForMonth as salaRecuperacaoCalendarDaysForMonth,
  defaultTemplateNamesForWeekday as salaRecuperacaoTemplateNamesForWeekday,
  defaultTemplatesForWeekday as salaRecuperacaoTemplatesForWeekday,
  type DefaultSectorShiftTemplate as SalaRecuperacaoShiftTemplate,
} from "./default-sector-shift-blueprint";

export const SALA_RECUPERACAO_SECTOR_NAME = "Sala de Recuperação";

export const SALA_RECUPERACAO_GESTOR_MEDICO_NAME = "Maurilio Caetano";
