import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("build nativo de push", () => {
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

  it("payload Expo envia o canal Android nomeado", () => {
    const source = readFileSync("server/notifications-service.ts", "utf8");
    expect(source).toContain('channelId: "escalas-default"');
  });
});
