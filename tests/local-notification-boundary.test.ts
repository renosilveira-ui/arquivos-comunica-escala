import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  scheduleNotification,
  scheduleShiftReminder,
  sendLocalNotification,
} from "../lib/notifications";

// Este mock deliberadamente não oferece setNotificationHandler: em background
// ou app encerrado, a apresentação do SO não pode depender de código JS.
const notifications = vi.hoisted(() => ({
  scheduleNotificationAsync: vi.fn(async () => "local-notification"),
}));

vi.mock("expo-notifications", () => ({
  ...notifications,
  SchedulableTriggerInputTypes: { DATE: "date" },
}));

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

function scheduledContent() {
  return notifications.scheduleNotificationAsync.mock.calls.at(-1)?.[0]
    ?.content as {
    title: string;
    body: string;
    data: Record<string, unknown>;
  };
}

describe("fronteira de notificação local account-scoped", () => {
  beforeEach(() => {
    notifications.scheduleNotificationAsync.mockClear();
  });

  it("mantém o lembrete neutro mesmo sem handler JS disponível em background", async () => {
    const shiftDate = new Date("2031-06-01T07:00:00.000Z");

    // Chamador JS legado não consegue reintroduzir setor/horário: argumentos
    // excedentes são ignorados e nunca alcançam título, corpo ou data.
    await (scheduleShiftReminder as (...args: unknown[]) => Promise<void>)(
      7,
      shiftDate,
      "UTI",
      "07:00",
    );

    const content = scheduledContent();
    expect(content).toEqual({
      title: "Escala+",
      body: "Há uma atualização disponível. Abra o aplicativo para consultar.",
      data: {
        type: "reminder",
        shiftDate: shiftDate.toISOString(),
        recipientUserId: 7,
      },
      sound: true,
    });
    // Em background o SO só enxerga a cópia de apresentação, não data.
    expect(`${content.title} ${content.body}`).not.toMatch(/UTI|07:00/);
  });

  it("as APIs públicas exigem destinatário e sobrescrevem qualquer recipient forjado", async () => {
    await expect(
      sendLocalNotification({
        recipientUserId: 7,
        data: { type: "reminder", recipientUserId: 999 },
      }),
    ).resolves.toBeUndefined();
    expect(scheduledContent()).toEqual({
      title: "Escala+",
      body: "Há uma atualização disponível. Abra o aplicativo para consultar.",
      data: { type: "reminder", recipientUserId: 7 },
      sound: true,
    });

    await expect(
      sendLocalNotification({} as never),
    ).rejects.toThrow("Destinatário da notificação local inválido");
    await expect(
      scheduleNotification({ recipientUserId: 0 }, new Date()),
    ).rejects.toThrow("Destinatário da notificação local inválido");
  });

  it("ignora texto arbitrário de chamador e preserva cópia neutra", async () => {
    await sendLocalNotification({
      recipientUserId: 7,
      data: { type: "reminder" },
      title: "Dra. Ana na UTI",
      body: "Plantão às 07:00",
    } as never);

    const content = scheduledContent();
    expect(content.title).toBe("Escala+");
    expect(content.body).toBe(
      "Há uma atualização disponível. Abra o aplicativo para consultar.",
    );
    expect(JSON.stringify(content)).not.toMatch(/Ana|UTI|07:00/);
  });

  it("não deixa o aviso legado HospitalAlert contornar a fronteira local", () => {
    const legacyNotifier = readFileSync("lib/syncErrorNotifier.ts", "utf8");

    expect(legacyNotifier).not.toContain("expo-notifications");
    expect(legacyNotifier).not.toContain("scheduleNotificationAsync");
    expect(legacyNotifier).toContain("Aviso local legado suprimido");
  });
});
