/**
 * Validação de conflitos de horários para escalas
 */

export interface ShiftConflict {
  hasConflict: boolean;
  conflictingShifts: Array<{
    id: number;
    sectorName: string;
    startTime: Date;
    endTime: Date;
    position: string;
  }>;
  message?: string;
}

/**
 * Verifica se um profissional já está alocado em outro turno no mesmo horário
 * @param userId ID do profissional
 * @param startTime Horário de início do novo turno
 * @param endTime Horário de fim do novo turno
 * @param existingShifts Lista de escalas existentes do profissional
 * @param excludeShiftId ID da escala a ser excluída da verificação (para edição)
 * @returns Objeto com informações sobre conflitos
 */
export function checkShiftConflicts(
  userId: number,
  startTime: Date,
  endTime: Date,
  existingShifts: Array<{
    id: number;
    sectorName: string;
    startTime: Date;
    endTime: Date;
    position: string;
  }>,
  excludeShiftId?: number
): ShiftConflict {
  const conflicts = existingShifts.filter((shift) => {
    // Ignorar a escala sendo editada
    if (excludeShiftId && shift.id === excludeShiftId) {
      return false;
    }

    // Verificar sobreposição de horários
    const shiftStart = new Date(shift.startTime);
    const shiftEnd = new Date(shift.endTime);
    const newStart = new Date(startTime);
    const newEnd = new Date(endTime);

    // Há conflito se:
    // 1. O novo turno começa durante um turno existente
    // 2. O novo turno termina durante um turno existente
    // 3. O novo turno engloba completamente um turno existente
    const hasOverlap =
      (newStart >= shiftStart && newStart < shiftEnd) ||
      (newEnd > shiftStart && newEnd <= shiftEnd) ||
      (newStart <= shiftStart && newEnd >= shiftEnd);

    return hasOverlap;
  });

  if (conflicts.length === 0) {
    return {
      hasConflict: false,
      conflictingShifts: [],
    };
  }

  // Formatar mensagem de erro
  const conflictMessages = conflicts.map((shift) => {
    const date = new Date(shift.startTime).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "short",
    });
    const startHour = new Date(shift.startTime).toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const endHour = new Date(shift.endTime).toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });
    return `${shift.sectorName} (${date}, ${startHour}-${endHour})`;
  });

  return {
    hasConflict: true,
    conflictingShifts: conflicts,
    message: `Profissional já alocado em: ${conflictMessages.join(", ")}`,
  };
}

/**
 * Valida múltiplos profissionais de uma vez
 * @param professionals Lista de IDs de profissionais a serem alocados
 * @param startTime Horário de início do turno
 * @param endTime Horário de fim do turno
 * @param allShifts Todas as escalas existentes
 * @param excludeShiftId ID da escala a ser excluída (para edição)
 * @returns Map com conflitos por profissional
 */
export function checkMultipleProfessionalsConflicts(
  professionals: number[],
  startTime: Date,
  endTime: Date,
  allShifts: Array<{
    id: number;
    userId: number;
    sectorName: string;
    startTime: Date;
    endTime: Date;
    position: string;
  }>,
  excludeShiftId?: number
): Map<number, ShiftConflict> {
  const conflictsMap = new Map<number, ShiftConflict>();

  professionals.forEach((userId) => {
    // Filtrar escalas deste profissional
    const userShifts = allShifts.filter((shift) => shift.userId === userId);

    // Verificar conflitos
    const conflict = checkShiftConflicts(
      userId,
      startTime,
      endTime,
      userShifts,
      excludeShiftId
    );

    if (conflict.hasConflict) {
      conflictsMap.set(userId, conflict);
    }
  });

  return conflictsMap;
}
