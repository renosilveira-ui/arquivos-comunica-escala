/**
 * Schemas Zod para integration.getStatus
 * Define estrutura de response para status da integração HospitalAlert
 */

import { z } from "zod";

// User info
export const IntegrationUserSchema = z.object({
  exists: z.boolean(),
  userId: z.number().optional(),
  externalUserId: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
  role: z.string().optional(),
});

// Connection status
export const IntegrationConnectionSchema = z.object({
  connected: z.boolean(),
  lastSyncAt: z.string().nullable(), // ISO 8601
  lastSyncStatus: z.enum(["success", "error", "never"]),
  lastSyncSourceApp: z.string().optional(),
  lastError: z.string().nullable(),
});

// Shift info
export const IntegrationShiftSchema = z.object({
  active: z.boolean(),
  shiftId: z.number().optional(),
  startedAt: z.string().optional(), // ISO 8601
  endedAt: z.string().nullable(),
  service: z.object({
    id: z.number(),
    name: z.string(),
  }).optional(),
  sector: z.object({
    id: z.number(),
    name: z.string(),
  }).optional(),
  coverageType: z.string().optional(), // "SECTOR_SPECIFIC", "FULL_HOSPITAL", etc
  staffingStatus: z.string().optional(), // "padrao", "extra", etc
  sourceApp: z.string().optional(), // "SHIFTS_APP", "HOSPITAL_ALERT", etc
});

// Full response
export const IntegrationStatusResponseSchema = z.object({
  ok: z.boolean(),
  organizationId: z.string(),
  user: IntegrationUserSchema,
  connection: IntegrationConnectionSchema,
  shift: IntegrationShiftSchema,
  serverTime: z.string(), // ISO 8601
  version: z.string(),
});

export type IntegrationStatusResponse = z.infer<typeof IntegrationStatusResponseSchema>;
export type IntegrationUser = z.infer<typeof IntegrationUserSchema>;
export type IntegrationConnection = z.infer<typeof IntegrationConnectionSchema>;
export type IntegrationShift = z.infer<typeof IntegrationShiftSchema>;
