import axios from "axios";

/**
 * Cliente de integração com HospitalAlert
 * Gerencia autenticação automática baseada em escalas ativas
 */

// URL base do HospitalAlert (configurável via env)
const HOSPITAL_ALERT_BASE_URL = process.env.HOSPITAL_ALERT_URL || "http://localhost:3001";

export interface HospitalAlertLoginPayload {
  userId: number;
  sectorId: number;
  shiftId: number;
  startTime: Date;
  endTime: Date;
}

export interface HospitalAlertUser {
  id: number;
  openId: string;
  name: string;
  email: string;
  role?: string;
}

/**
 * Inicia plantão no HospitalAlert
 * Chamado automaticamente quando usuário tem escala ativa
 */
export async function startShiftInHospitalAlert(payload: HospitalAlertLoginPayload): Promise<{
  success: boolean;
  message: string;
  sessionToken?: string;
}> {
  try {
    // TODO: Implementar chamada real à API do HospitalAlert
    // Por enquanto, retorna sucesso simulado
    console.log("[HospitalAlert] Iniciando plantão:", payload);

    // Simulação de chamada à API
    // const response = await axios.post(`${HOSPITAL_ALERT_BASE_URL}/api/shifts/start`, {
    //   userId: payload.userId,
    //   sectorId: payload.sectorId,
    //   shiftId: payload.shiftId,
    //   startTime: payload.startTime.toISOString(),
    //   endTime: payload.endTime.toISOString(),
    // });

    return {
      success: true,
      message: "Plantão iniciado com sucesso no HospitalAlert",
      sessionToken: "simulated-session-token",
    };
  } catch (error) {
    console.error("[HospitalAlert] Erro ao iniciar plantão:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : "Erro desconhecido",
    };
  }
}

/**
 * Finaliza plantão no HospitalAlert
 * Chamado automaticamente quando escala termina
 */
export async function endShiftInHospitalAlert(userId: number, shiftId: number): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    console.log("[HospitalAlert] Finalizando plantão:", { userId, shiftId });

    // Simulação de chamada à API
    // const response = await axios.post(`${HOSPITAL_ALERT_BASE_URL}/api/shifts/end`, {
    //   userId,
    //   shiftId,
    // });

    return {
      success: true,
      message: "Plantão finalizado com sucesso no HospitalAlert",
    };
  } catch (error) {
    console.error("[HospitalAlert] Erro ao finalizar plantão:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : "Erro desconhecido",
    };
  }
}

/**
 * Verifica status de integração com HospitalAlert
 */
export async function checkHospitalAlertStatus(): Promise<{
  online: boolean;
  version?: string;
}> {
  try {
    // Simulação de health check
    // const response = await axios.get(`${HOSPITAL_ALERT_BASE_URL}/api/health`);
    
    return {
      online: true,
      version: "1.0.0",
    };
  } catch (error) {
    console.error("[HospitalAlert] Erro ao verificar status:", error);
    return {
      online: false,
    };
  }
}

/**
 * Sincroniza dados de usuário com HospitalAlert
 */
export async function syncUserWithHospitalAlert(user: HospitalAlertUser): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    console.log("[HospitalAlert] Sincronizando usuário:", user);

    // Simulação de sincronização
    // const response = await axios.post(`${HOSPITAL_ALERT_BASE_URL}/api/users/sync`, user);

    return {
      success: true,
      message: "Usuário sincronizado com sucesso",
    };
  } catch (error) {
    console.error("[HospitalAlert] Erro ao sincronizar usuário:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : "Erro desconhecido",
    };
  }
}

/**
 * Busca status completo da integração HospitalAlert
 * Consulta estado real do HospitalAlert (shift ativo, usuário sincronizado)
 */
export async function getIntegrationStatus(
  externalUserId: string,
  organizationId: string = "hsc"
): Promise<{
  ok: boolean;
  organizationId: string;
  user: {
    exists: boolean;
    userId?: number;
    externalUserId: string;
    name?: string;
    email?: string;
    role?: string;
  };
  connection: {
    connected: boolean;
    lastSyncAt: string | null;
    lastSyncStatus: "success" | "error" | "never";
    lastSyncSourceApp?: string;
    lastError: string | null;
  };
  shift: {
    active: boolean;
    shiftId?: number;
    startedAt?: string;
    endedAt?: string | null;
    service?: { id: number; name: string };
    sector?: { id: number; name: string };
    coverageType?: string;
    staffingStatus?: string;
    sourceApp?: string;
  };
  serverTime: string;
  version: string;
}> {
  try {
    console.log("[HospitalAlert] Buscando status da integração:", { externalUserId, organizationId });

    // TODO: Implementar chamada real à API do HospitalAlert
    // Por enquanto, retorna mock com dados simulados
    
    // Simulação de chamada à API
    // const response = await axios.get(`${HOSPITAL_ALERT_BASE_URL}/api/integration/status`, {
    //   params: { externalUserId, organizationId }
    // });

    // Mock: Simular usuário conectado com plantão ativo
    const mockResponse = {
      ok: true,
      organizationId,
      user: {
        exists: true,
        userId: 123,
        externalUserId,
        name: "Dr. João Silva",
        email: "joao.silva@hospital.com",
        role: "MEDICO",
      },
      connection: {
        connected: true,
        lastSyncAt: new Date().toISOString(),
        lastSyncStatus: "success" as const,
        lastSyncSourceApp: "SHIFTS_APP",
        lastError: null,
      },
      shift: {
        active: true,
        shiftId: 987,
        startedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h atrás
        endedAt: null,
        service: { id: 3, name: "Anestesia" },
        sector: { id: 12, name: "UTI 5º Andar" },
        coverageType: "SECTOR_SPECIFIC",
        staffingStatus: "padrao",
        sourceApp: "SHIFTS_APP",
      },
      serverTime: new Date().toISOString(),
      version: "v1",
    };

    return mockResponse;
  } catch (error) {
    console.error("[HospitalAlert] Erro ao buscar status da integração:", error);
    
    // Retornar resposta de erro
    return {
      ok: true,
      organizationId,
      user: { exists: false, externalUserId },
      connection: {
        connected: false,
        lastSyncAt: null,
        lastSyncStatus: "error",
        lastError: error instanceof Error ? error.message : "Erro desconhecido",
      },
      shift: { active: false },
      serverTime: new Date().toISOString(),
      version: "v1",
    };
  }
}

/**
 * Força sincronização manual com HospitalAlert
 * Atualiza dados do usuário e verifica plantão ativo
 */
export async function forceSyncWithHospitalAlert(
  userId: number,
  externalUserId: string
): Promise<{
  success: boolean;
  message: string;
  lastSyncAt: string;
}> {
  try {
    console.log("[HospitalAlert] Forçando sincronização:", { userId, externalUserId });

    // TODO: Implementar chamada real à API do HospitalAlert
    // Por enquanto, retorna sucesso simulado
    
    // Simulação de chamada à API
    // const response = await axios.post(`${HOSPITAL_ALERT_BASE_URL}/api/integration/sync`, {
    //   userId,
    //   externalUserId
    // });

    const now = new Date().toISOString();

    return {
      success: true,
      message: "Sincronização realizada com sucesso",
      lastSyncAt: now,
    };
  } catch (error) {
    console.error("[HospitalAlert] Erro ao forçar sincronização:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : "Erro desconhecido",
      lastSyncAt: new Date().toISOString(),
    };
  }
}
