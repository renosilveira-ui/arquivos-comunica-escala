import { z } from "zod";

/**
 * Schemas para integração com HospitalAlert
 * Baseado em: RESUMO_TECNICO_INTEGRACAO.md
 */

// ============================================================================
// GET /api/on-duty-users
// ============================================================================

export const OnDutyUserSchema = z.object({
  id: z.string().describe("ID único do usuário no app de escalas"),
  name: z.string().describe("Nome completo do profissional"),
  role: z.string().describe("Cargo/especialidade (ex: Médico, Enfermeiro)"),
  sectorId: z.string().describe("ID do setor onde está alocado"),
  shiftStart: z.string().datetime().describe("Início do plantão (ISO 8601 UTC)"),
  shiftEnd: z.string().datetime().describe("Fim do plantão (ISO 8601 UTC)"),
});

export const GetOnDutyUsersResponseSchema = z.object({
  users: z.array(OnDutyUserSchema),
  serverTime: z.string().datetime().describe("Timestamp do servidor para debug"),
});

export type OnDutyUser = z.infer<typeof OnDutyUserSchema>;
export type GetOnDutyUsersResponse = z.infer<typeof GetOnDutyUsersResponseSchema>;

// ============================================================================
// GET /api/sectors
// ============================================================================

export const SectorSchema = z.object({
  id: z.string().describe("ID único do setor"),
  name: z.string().describe("Nome do setor (ex: UTI, Emergência)"),
  building: z.string().optional().describe("Prédio/bloco (ex: Bloco A)"),
  floor: z.number().int().optional().describe("Andar"),
});

export const GetSectorsResponseSchema = z.object({
  sectors: z.array(SectorSchema),
  serverTime: z.string().datetime().describe("Timestamp do servidor para debug"),
});

export type Sector = z.infer<typeof SectorSchema>;
export type GetSectorsResponse = z.infer<typeof GetSectorsResponseSchema>;

// ============================================================================
// POST /api/webhooks/alert-emitted
// ============================================================================

export const AlertEmittedWebhookSchema = z.object({
  alertId: z.string().describe("ID único do alerta no HospitalAlert"),
  userId: z.string().describe("ID do usuário que emitiu o alerta"),
  serviceCode: z.string().describe("Código do serviço (ex: CODIGO_AZUL)"),
  sectorId: z.string().describe("ID do setor onde foi emitido"),
  location: z.string().describe("Localização específica (ex: Leito 12)"),
  emittedAt: z.string().datetime().describe("Timestamp de emissão (ISO 8601 UTC)"),
  notifiedStations: z.array(z.string()).describe("IDs das stations notificadas"),
  voiceNoteUrl: z.string().url().optional().describe("URL da nota de voz (S3)"),
  observation: z.string().optional().describe("Observação adicional"),
});

export type AlertEmittedWebhook = z.infer<typeof AlertEmittedWebhookSchema>;

// ============================================================================
// POST /api/webhooks/alert-acknowledged
// ============================================================================

export const AlertAcknowledgedWebhookSchema = z.object({
  alertId: z.string().describe("ID único do alerta no HospitalAlert"),
  acknowledgedBy: z.string().describe("ID do usuário que confirmou"),
  acknowledgedByStation: z.string().describe("ID da station que confirmou"),
  acknowledgedAt: z.string().datetime().describe("Timestamp de confirmação (ISO 8601 UTC)"),
  responseTime: z.number().int().describe("Tempo de resposta em segundos"),
});

export type AlertAcknowledgedWebhook = z.infer<typeof AlertAcknowledgedWebhookSchema>;

// ============================================================================
// Autenticação via API Key
// ============================================================================

export const ApiKeyHeaderSchema = z.object({
  "x-api-key": z.string().describe("API key do HospitalAlert"),
});

export type ApiKeyHeader = z.infer<typeof ApiKeyHeaderSchema>;
