import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("build nativo de push", () => {
  it("app.config declara expo-secure-store fora do Auto Backup Android", () => {
    const source = readFileSync("app.config.ts", "utf8");
    expect(source).toContain('"expo-secure-store"');
    expect(source).toContain("configureAndroidBackup: true");
  });

  it("app.config declara o plugin expo-notifications", () => {
    const source = readFileSync("app.config.ts", "utf8");
    expect(source).toContain('"expo-notifications"');
    expect(source).toContain("enableBackgroundRemoteNotifications: true");
    expect(source).toContain('defaultChannel: "escalas-default"');
    expect(source).toContain('color: "#01304A"');
  });

  it("preview incrementa build number para o TestFlight aceitar", () => {
    const eas = JSON.parse(readFileSync("eas.json", "utf8")) as {
      build: { preview: { autoIncrement?: boolean } };
      submit?: { preview?: { ios?: { ascAppId?: string } } };
    };
    expect(eas.build.preview.autoIncrement).toBe(true);
    expect(eas.submit?.preview?.ios?.ascAppId).toBe("6802868138");
  });

  it("hooks e lib de notificação não importam theme (Platform.select quebra SSO)", () => {
    const hook = readFileSync("hooks/use-notifications.ts", "utf8");
    const lib = readFileSync("lib/notifications.ts", "utf8");
    expect(hook).not.toMatch(/from ["']@\/lib\/theme["']/);
    expect(lib).not.toMatch(/from ["']@\/lib\/theme["']/);
    expect(hook).toContain('ANDROID_NOTIFICATION_COLOR = "#01304A"');
    expect(lib).toContain('ANDROID_NOTIFICATION_COLOR = "#01304A"');
    expect(hook).toContain('setNotificationChannelAsync("escalas-default"');
    expect(lib).toContain("setNotificationChannelAsync('escalas-default'");
  });

  it("centraliza o handler visual e o prende ao sujeito VERIFIED", () => {
    const hook = readFileSync("hooks/use-notifications.ts", "utf8");
    const lib = readFileSync("lib/notifications.ts", "utf8");
    const handler = readFileSync("lib/notification-foreground-handler.ts", "utf8");
    const listener = readFileSync("components/NotificationListener.tsx", "utf8");
    const auth = readFileSync("hooks/use-auth.ts", "utf8");

    expect(hook).not.toContain("setNotificationHandler");
    expect(lib).not.toContain("setNotificationHandler");
    expect(handler.match(/setNotificationHandler/g)).toHaveLength(1);
    expect(handler).toContain("shouldPresentForegroundNotification");
    expect(handler).toContain("HIDE_FOREGROUND_NOTIFICATION");
    expect(listener).toContain("publishVerifiedNotificationForegroundSubject");
    expect(listener).toContain("releaseVerifiedNotificationForegroundSubject");
    expect(listener).toContain(
      "authorizedUserId === null || !isSessionAuthorizationCurrent()",
    );

    const closeStart = auth.indexOf("const closeAsyncSessionAdmission");
    const closeEnd = auth.indexOf("}, []);", closeStart);
    const closeBody = auth.slice(closeStart, closeEnd);
    expect(closeBody.indexOf("clearVerifiedNotificationForegroundSubject")).toBeGreaterThan(
      -1,
    );
    expect(closeBody.indexOf("clearVerifiedNotificationForegroundSubject")).toBeLessThan(
      closeBody.indexOf("Auth.closeSessionTokenTransportAdmission"),
    );

    const mutationStart = auth.indexOf("const runSessionMutation");
    const mutationBegin = auth.slice(
      mutationStart,
      auth.indexOf("const executeInsideLock", mutationStart),
    );
    expect(mutationBegin.indexOf("closeAsyncSessionAdmission()")).toBeGreaterThan(
      -1,
    );
    expect(mutationBegin.indexOf("closeAsyncSessionAdmission()")).toBeLessThan(
      mutationBegin.indexOf('setSessionValidation({ status: "CHECKING"'),
    );
  });

  it("vincula e neutraliza a criação local sem API posicional de texto", () => {
    const createShift = readFileSync("app/create-shift.tsx", "utf8");
    const hook = readFileSync("hooks/use-notifications.ts", "utf8");
    const notifications = readFileSync("lib/notifications.ts", "utf8");

    expect(createShift).toMatch(/scheduleShiftReminder\(\s*user\.id,/);
    expect(notifications).toContain("recipientUserId: userId");
    expect(notifications).toContain("export type AccountScopedLocalNotification");
    expect(notifications).toContain("LOCAL_NEUTRAL_NOTIFICATION_TITLE");
    expect(notifications).toContain("LOCAL_NEUTRAL_NOTIFICATION_BODY");
    expect(notifications).toContain("input: AccountScopedLocalNotification");
    expect(notifications).not.toMatch(/sendLocalNotification\(\s*\n\s*title:/);
    expect(notifications).not.toMatch(/scheduleNotification\(\s*\n\s*title:/);
    expect(notifications).not.toContain("sectorName");
    expect(notifications).not.toContain("shiftTime");
    expect(hook).toContain("scheduleAccountScopedNotification");
    expect(hook).not.toMatch(/export async function scheduleNotification/);
    expect(hook).not.toMatch(/scheduleNotification\(\s*\n\s*title:/);
  });

  it("payload Expo envia o canal Android nomeado", () => {
    const source = readFileSync("server/notifications-service.ts", "utf8");
    expect(source).toContain('channelId: "escalas-default"');
  });
});
