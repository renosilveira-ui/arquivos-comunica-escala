/**
 * Detector de escala ativa
 * Identifica quando usuário tem escala ativa baseado em horários UTC
 */

import { DEMO_SHIFTS, DEMO_SERVICES } from "./demo-mode";

// ============================================================================
// TYPES
// ============================================================================

export interface ActiveShift {
  id: number;
  serviceId: number;
  serviceName: string;
  sectorId?: number | null;
  sectorName?: string | null;
  coverageType: "GLOBAL" | "SECTOR_SPECIFIC";
  staffingStatus?: string;
  startTime: Date;
  endTime: Date;
  isActive: boolean;
}

// ============================================================================
// SHIFT DETECTION
// ============================================================================

/**
 * Converte horário local para UTC
 */
function toUTC(date: Date): Date {
  return new Date(date.toISOString());
}

/**
 * Verifica se escala está ativa agora (baseado em UTC)
 */
function isShiftActive(startTime: Date, endTime: Date): boolean {
  const nowUTC = new Date();
  const startUTC = toUTC(startTime);
  const endUTC = toUTC(endTime);
  
  return nowUTC >= startUTC && nowUTC <= endUTC;
}

/**
 * Busca escala ativa do usuário
 * TODO: Substituir DEMO_SHIFTS por query real ao banco quando disponível
 */
export function getActiveShift(userId: number): ActiveShift | null {
  // TODO: Implementar query real ao banco
  // const shifts = await db.select()
  //   .from(shifts)
  //   .where(eq(shifts.userId, userId))
  //   .where(eq(shifts.status, "confirmed"));
  
  // Por enquanto, usar DEMO_SHIFTS
  // DEMO_SHIFTS é um array de objetos com estrutura: { shift, sector, shiftType, serviceId, assignments }
  const userShifts = DEMO_SHIFTS.filter(item => {
    // Verificar se usuário está nas assignments
    return item.assignments.some(a => a.professionalId === userId);
  });
  
  for (const item of userShifts) {
    const startTime = new Date(item.shift.startTime);
    const endTime = new Date(item.shift.endTime);
    
    if (isShiftActive(startTime, endTime)) {
      // Buscar informações do serviço
      const service = DEMO_SERVICES.find(s => s.id === item.serviceId);
      
      return {
        id: item.shift.id,
        serviceId: item.serviceId,
        serviceName: service?.name || "Serviço Desconhecido",
        sectorId: item.shift.sectorId,
        sectorName: item.sector.name,
        coverageType: item.shift.sectorId ? "SECTOR_SPECIFIC" : "GLOBAL",
        staffingStatus: "padrao",
        startTime,
        endTime,
        isActive: true,
      };
    }
  }
  
  return null;
}

/**
 * Busca todas as escalas do usuário (ativas e futuras)
 */
export function getUserShifts(userId: number): ActiveShift[] {
  // TODO: Implementar query real ao banco
  const userShifts = DEMO_SHIFTS.filter(item => {
    return item.assignments.some(a => a.professionalId === userId);
  });
  
  return userShifts.map(item => {
    const startTime = new Date(item.shift.startTime);
    const endTime = new Date(item.shift.endTime);
    const service = DEMO_SERVICES.find(s => s.id === item.serviceId);
    
    return {
      id: item.shift.id,
      serviceId: item.serviceId,
      serviceName: service?.name || "Serviço Desconhecido",
      sectorId: item.shift.sectorId,
      sectorName: item.sector.name,
      coverageType: item.shift.sectorId ? "SECTOR_SPECIFIC" : "GLOBAL",
      staffingStatus: "padrao",
      startTime,
      endTime,
      isActive: isShiftActive(startTime, endTime),
    };
  });
}

/**
 * Verifica se horário está em UTC
 * (helper para debug/validação)
 */
export function isUTC(date: Date): boolean {
  return date.toISOString() === date.toUTCString();
}
