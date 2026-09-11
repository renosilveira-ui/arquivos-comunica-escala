import { afterEach, describe, expect, it, vi } from "vitest";

import { createGoogleCalendarProvider } from "../server/integrations/google/calendar-client";

/**
 * A consulta ao Google decide se o sync token chega ou não. A regra do
 * próprio Google: `orderBy` (e `timeMax`, `q`, …) é incompatível com
 * `syncToken`, e a leitura inicial deve usar os mesmos parâmetros da
 * incremental. Com `orderBy` na leitura inicial o `nextSyncToken` não vinha,
 * e toda sincronização relia a janela inteira — foi assim no staging.
 */
describe("consulta de eventos ao Google", () => {
  const seen: string[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    seen.length = 0;
  });

  function stubFetch() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        seen.push(String(url));
        return new Response(
          JSON.stringify({ items: [], nextSyncToken: "sync-1" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
  }

  const provider = createGoogleCalendarProvider({
    clientId: "id",
    clientSecret: "secret",
    redirectUri: "http://localhost/callback",
  });

  it("leitura completa: só timeMin — sem orderBy, para o sync token vir", async () => {
    stubFetch();
    const result = await provider.listChanges({
      accessToken: "token",
      calendarId: "primary",
      cursor: { kind: "FULL_RESYNC", since: new Date("2026-09-01T00:00:00Z") },
    });
    expect(result.ok).toBe(true);
    const url = new URL(seen[0]);
    expect(url.pathname).toContain("/calendars/primary/events");
    expect(url.searchParams.get("timeMin")).toBe("2026-09-01T00:00:00.000Z");
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("showDeleted")).toBe("true");
    expect(url.searchParams.has("orderBy")).toBe(false);
    expect(url.searchParams.has("timeMax")).toBe(false);
    if (result.ok) expect(result.value.nextSyncToken).toBe("sync-1");
  });

  it("leitura incremental: só o syncToken, mais os mesmos parâmetros fixos", async () => {
    stubFetch();
    await provider.listChanges({
      accessToken: "token",
      calendarId: "primary",
      cursor: { kind: "SYNC_TOKEN", token: "sync-0" },
      pageToken: "p2",
    });
    const url = new URL(seen[0]);
    expect(url.searchParams.get("syncToken")).toBe("sync-0");
    expect(url.searchParams.get("pageToken")).toBe("p2");
    expect(url.searchParams.has("timeMin")).toBe(false);
    expect(url.searchParams.has("orderBy")).toBe(false);
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("showDeleted")).toBe("true");
  });
});
