import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearVerifiedNotificationForegroundSubject,
  publishVerifiedNotificationForegroundSubject,
  releaseVerifiedNotificationForegroundSubject,
} from "../lib/notification-foreground-subject";
import {
  HIDE_FOREGROUND_NOTIFICATION,
  PRESENT_FOREGROUND_NOTIFICATION,
} from "../lib/notification-foreground-handler";
import { scheduleNotification } from "../lib/notifications";

const notifications = vi.hoisted(() => ({
  setNotificationHandler: vi.fn(),
  scheduleNotificationAsync: vi.fn(async () => "scheduled-reminder"),
}));

vi.mock("expo-notifications", () => ({
  ...notifications,
  SchedulableTriggerInputTypes: { DATE: "date" },
}));

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

function foregroundBehavior(data: Record<string, unknown> | undefined) {
  const handler = notifications.setNotificationHandler.mock.calls[0]?.[0] as {
    handleNotification: (notification: unknown) => Promise<unknown>;
  };
  return handler.handleNotification({ request: { content: { data } } });
}

describe("cerca visual de notificações em primeiro plano", () => {
  beforeEach(() => {
    clearVerifiedNotificationForegroundSubject();
    notifications.scheduleNotificationAsync.mockClear();
  });

  it("instala um handler único e falha fechado sem sujeito, recipient ou igualdade", async () => {
    expect(notifications.setNotificationHandler).toHaveBeenCalledTimes(1);
    await expect(foregroundBehavior(undefined)).resolves.toEqual(
      HIDE_FOREGROUND_NOTIFICATION,
    );

    publishVerifiedNotificationForegroundSubject(7);
    await expect(foregroundBehavior({})).resolves.toEqual(
      HIDE_FOREGROUND_NOTIFICATION,
    );
    await expect(
      foregroundBehavior({ recipientUserId: 8 }),
    ).resolves.toEqual(HIDE_FOREGROUND_NOTIFICATION);
    await expect(
      foregroundBehavior({ recipientUserId: "7" }),
    ).resolves.toEqual(PRESENT_FOREGROUND_NOTIFICATION);
  });

  it("cleanup de A não apaga a publicação VERIFIED mais nova de B", async () => {
    const subjectA = publishVerifiedNotificationForegroundSubject(7);
    const subjectB = publishVerifiedNotificationForegroundSubject(8);

    releaseVerifiedNotificationForegroundSubject(subjectA);
    await expect(
      foregroundBehavior({ recipientUserId: 8 }),
    ).resolves.toEqual(PRESENT_FOREGROUND_NOTIFICATION);

    releaseVerifiedNotificationForegroundSubject(subjectB);
    await expect(
      foregroundBehavior({ recipientUserId: 8 }),
    ).resolves.toEqual(HIDE_FOREGROUND_NOTIFICATION);
  });

  it("BEGIN de sessão limpa o sujeito imediatamente", async () => {
    publishVerifiedNotificationForegroundSubject(7);
    clearVerifiedNotificationForegroundSubject();

    await expect(
      foregroundBehavior({ recipientUserId: 7 }),
    ).resolves.toEqual(HIDE_FOREGROUND_NOTIFICATION);
  });

  it("vincula a notificação local ao usuário e não expõe detalhes no conteúdo", async () => {
    const shiftDate = new Date(Date.now() + 60 * 60 * 1_000);

    await scheduleNotification(
      {
        recipientUserId: 7,
        data: { type: "reminder", shiftDate: shiftDate.toISOString() },
      },
      shiftDate,
    );

    expect(notifications.scheduleNotificationAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          title: "Escala+",
          body: "Há uma atualização disponível. Abra o aplicativo para consultar.",
          data: {
            type: "reminder",
            shiftDate: shiftDate.toISOString(),
            recipientUserId: 7,
          },
        }),
      }),
    );

    publishVerifiedNotificationForegroundSubject(8);
    const scheduled = notifications.scheduleNotificationAsync.mock.calls[0]?.[0] as {
      content: { data: Record<string, unknown> };
    };
    await expect(foregroundBehavior(scheduled.content.data)).resolves.toEqual(
      HIDE_FOREGROUND_NOTIFICATION,
    );
  });
});
