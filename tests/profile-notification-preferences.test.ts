import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PROFILE_NOTIFICATION_ACCESSIBILITY_LABEL,
  PROFILE_NOTIFICATION_COPY,
} from "../lib/profile-notification-copy";

const perfil = readFileSync("app/(tabs)/profile.tsx", "utf8");
const copySource = readFileSync("lib/profile-notification-copy.ts", "utf8");

function notificationsSection(source: string): string {
  const start = source.indexOf("Notificações: informativo");
  const end = source.indexOf("Conta e app (Instituição");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("Perfil — preferências de notificação com estado verdadeiro", () => {
  it("não contém switches decorativos de tipos de aviso", () => {
    expect(perfil).not.toContain("Mudanças de escala");
    expect(perfil).not.toContain("Lembrete de plantão");
    expect(perfil).not.toContain('title="Comunica+"');
    expect(perfil).not.toContain("title={'Comunica+'}");
    expect(perfil).not.toContain("Alertas do sistema hospitalar");
  });

  it("não guarda estado local exclusivo dessas preferências", () => {
    expect(perfil).not.toContain("enableShiftChanges");
    expect(perfil).not.toContain("enableReminders");
    expect(perfil).not.toContain("enableHospitalAlert");
    expect(perfil).not.toContain("toggleWithHaptic");
    expect(perfil).not.toMatch(/useState\(true\)/);
  });

  it("não tem mutation fictícia nem log de atualização", () => {
    expect(perfil).not.toContain("updateSettings");
    expect(perfil).not.toContain('console.log("Atualizar configurações');
    expect(perfil).not.toContain("Atualizar configurações:");
    expect(perfil).not.toMatch(/TODO: sem API ainda/);
    expect(perfil).not.toMatch(/TODO: mutation quando a API existir/);
    expect(perfil).not.toContain("saveNotificationPreferences");
  });

  it("copy deixa claro que avisos dependem do sistema e do dispositivo", () => {
    expect(PROFILE_NOTIFICATION_COPY.body).toContain("participação nas escalas");
    expect(PROFILE_NOTIFICATION_COPY.body).toContain("permissões de notificação do dispositivo");
    expect(PROFILE_NOTIFICATION_COPY.deviceHint).toContain("configurações do aparelho");
    expect(PROFILE_NOTIFICATION_COPY.body).not.toMatch(/ligar|desligar|tipo de aviso/i);
    expect(perfil).toContain("PROFILE_NOTIFICATION_COPY");
    expect(perfil).toContain("PROFILE_NOTIFICATION_ACCESSIBILITY_LABEL");
    expect(perfil).toContain("PROFILE_NOTIFICATION_COPY.rowTitle");
  });

  it("a seção de notificações não tem switch nem papel de controle", () => {
    const section = notificationsSection(perfil);
    expect(section).not.toContain("toggle=");
    expect(section).not.toContain("accessibilityRole=\"switch\"");
    expect(section).not.toContain("accessibilityState");
    expect(section).toContain('accessibilityRole="text"');
    expect(section).not.toContain("onPress");
    expect(section).toContain("accessible");
    expect(copySource).toContain("Não há preferência granular persistida");
    expect(PROFILE_NOTIFICATION_ACCESSIBILITY_LABEL).toContain(
      PROFILE_NOTIFICATION_COPY.body,
    );
  });
});
