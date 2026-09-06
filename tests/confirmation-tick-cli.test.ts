import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "../server/db";
import { tick } from "../server/cron/shift-confirmation-dispatcher";
import {
  isConfirmationTickCliPath,
  requireConfirmationTickDatabaseUrl,
  runConfirmationTickCli,
  runConfirmationTickOnce,
} from "../server/cron/confirmation-tick-cli";

vi.mock("../server/db", () => ({
  getDb: vi.fn(),
  closeDb: vi.fn(),
}));
vi.mock("../server/cron/shift-confirmation-dispatcher", () => ({
  tick: vi.fn(),
  startConfirmationCron: vi.fn(),
  stopConfirmationCron: vi.fn(),
}));

const cli = readFileSync("scripts/run-confirmation-tick.ts", "utf8");
const moduleSrc = readFileSync("server/cron/confirmation-tick-cli.ts", "utf8");
const dispatcher = readFileSync(
  "server/cron/shift-confirmation-dispatcher.ts",
  "utf8",
);
const boot = readFileSync("server/_core/index.ts", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};
const renderYaml = readFileSync("render.yaml", "utf8");
const coverageDoc = readFileSync(
  "docs/operations/confirmation-coverage.md",
  "utf8",
);
const coldStart = readFileSync("docs/operations/cold-start.md", "utf8");

function uncommentedRenderYaml(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

describe("confirmation tick CLI — source", () => {
  it("CLI one-shot não sobe HTTP nem o setInterval in-process", () => {
    expect(cli).toContain("runConfirmationTickCli");
    expect(cli).toContain("isConfirmationTickCliPath");
    expect(cli).not.toMatch(/from ["'][^"']*_core\/index/);
    expect(cli).not.toMatch(/import[\s\S]{0,120}startConfirmationCron/);
    expect(cli).not.toMatch(/startConfirmationCron\s*\(/);
    expect(cli).not.toMatch(/startWhatsAppNlDriver/);
    expect(cli).not.toMatch(/setInterval\s*\(/);
    expect(cli).not.toMatch(/createServer|express\(/);
    expect(cli).toContain("process.exit(0)");
    expect(cli).toContain("process.exit(1)");
    expect(moduleSrc).toContain("await tick(now)");
    expect(moduleSrc).toContain("await closeDb()");
    expect(moduleSrc).not.toMatch(/import[\s\S]{0,120}startConfirmationCron/);
    expect(moduleSrc).not.toMatch(/startConfirmationCron\s*\(/);
    expect(moduleSrc).not.toMatch(/startWhatsAppNlDriver/);
    expect(moduleSrc).not.toMatch(/setInterval\s*\(/);
  });

  it("package.json expõe o CLI local e o bundle de produção", () => {
    expect(pkg.scripts["confirmation:tick"]).toBe(
      "tsx scripts/run-confirmation-tick.ts",
    );
    expect(pkg.scripts["build:confirmation-tick"]).toContain(
      "scripts/run-confirmation-tick.ts",
    );
    expect(pkg.scripts["build:confirmation-tick"]).toContain(
      "dist/run-confirmation-tick.mjs",
    );
  });

  it("web ainda inicia o intervalo após listen e para no SIGTERM", () => {
    expect(boot).toContain("startConfirmationCron();");
    expect(boot).toContain("stopConfirmationCron();");
    const listenIdx = boot.indexOf('server.listen(port, "0.0.0.0"');
    const startIdx = boot.indexOf("startConfirmationCron();");
    const stopIdx = boot.indexOf("stopConfirmationCron();");
    const beforeExitIdx = boot.indexOf("onBeforeExit");
    expect(listenIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(listenIdx);
    expect(beforeExitIdx).toBeGreaterThan(startIdx);
    expect(stopIdx).toBeGreaterThan(beforeExitIdx);
    expect(boot).toContain("try {");
    expect(boot).toContain("stopWhatsAppNlDriver();");
    const beforeExit = boot.slice(boot.indexOf("onBeforeExit"));
    const cronStop = beforeExit.indexOf("stopConfirmationCron();");
    const waStop = beforeExit.indexOf("stopWhatsAppNlDriver();");
    expect(cronStop).toBeGreaterThan(-1);
    expect(waStop).toBeGreaterThan(cronStop);
    expect(beforeExit).toContain("stopConfirmationCron failed");
    expect(beforeExit).toContain("stopWhatsAppNlDriver failed");
    expect(dispatcher).toContain("setInterval");
    expect(dispatcher).toContain("isDueForConfirmation");
    expect(dispatcher).toContain("EXTERNAL_INFRA_ACTION_REQUIRED");
    expect(dispatcher).not.toContain("TRIGGER_WINDOW_MIN");
    expect(dispatcher).not.toContain("qualificationMatches");
    expect(dispatcher).not.toContain("professionalAccess");
  });

  it("Blueprint não cobra Cron sozinho; finding permanece EXTERNAL_INFRA", () => {
    expect(uncommentedRenderYaml(renderYaml)).not.toMatch(/type:\s*cron/);
    expect(uncommentedRenderYaml(renderYaml)).toContain("plan: free");
    expect(renderYaml).toContain("docs/operations/confirmation-coverage.md");
    expect(coverageDoc).toContain("EXTERNAL_INFRA_ACTION_REQUIRED");
    expect(coverageDoc).toContain("due-based");
    expect(coverageDoc).toContain("[06:30, 07:30]");
    expect(coverageDoc).toContain("professional_access");
    expect(coverageDoc).not.toContain("CONFIRMATION_LEAD_TIME_OWNER_DECISION_REQUIRED");
    expect(coverageDoc).not.toContain("CONFIRMATION_REQUEST_ACTION_AUTHORITY_DIVERGENCE_CONFIRMED");
    expect(coverageDoc).toContain("pnpm confirmation:tick");
    expect(coverageDoc).toContain("node dist/run-confirmation-tick.mjs");
    expect(coverageDoc).toContain('schedule: "* * * * *"');
    expect(coldStart).toContain("docs/operations/confirmation-coverage.md");
  });
});

describe("confirmation tick CLI — comportamento", () => {
  afterEach(() => {
    vi.mocked(getDb).mockReset();
    vi.mocked(closeDb).mockReset();
    vi.mocked(tick).mockReset();
  });

  it("reconhece o entrypoint local e o bundle, recusa o servidor HTTP", () => {
    expect(
      isConfirmationTickCliPath("scripts/run-confirmation-tick.ts"),
    ).toBe(true);
    expect(
      isConfirmationTickCliPath("/repo/dist/run-confirmation-tick.mjs"),
    ).toBe(true);
    expect(
      isConfirmationTickCliPath("C:\\\\repo\\\\run-confirmation-tick.js"),
    ).toBe(true);
    expect(isConfirmationTickCliPath("server/_core/index.ts")).toBe(false);
    expect(isConfirmationTickCliPath(undefined)).toBe(false);
  });

  it("recusa DATABASE_URL ausente ou em branco", () => {
    expect(() => requireConfirmationTickDatabaseUrl({})).toThrow(
      /DATABASE_URL é obrigatória/,
    );
    expect(
      () => requireConfirmationTickDatabaseUrl({ DATABASE_URL: "   " }),
    ).toThrow(/DATABASE_URL é obrigatória/);
    expect(
      requireConfirmationTickDatabaseUrl({
        DATABASE_URL: "mysql://root:root@127.0.0.1:3306/escalas_test",
      }),
    ).toBe("mysql://root:root@127.0.0.1:3306/escalas_test");
  });

  it("chama tick uma vez e não inicia o cron in-process", async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "mysql://root:root@127.0.0.1:3306/escalas_test";
    vi.mocked(getDb).mockResolvedValue({ ok: true } as never);
    vi.mocked(tick).mockResolvedValue(undefined);
    const now = new Date("2026-09-05T14:00:00.000Z");
    try {
      await runConfirmationTickOnce(now);
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
    expect(tick).toHaveBeenCalledTimes(1);
    expect(tick).toHaveBeenCalledWith(now);
  });

  it("aborta se o pool não conectar", async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "mysql://root:root@127.0.0.1:3306/escalas_test";
    vi.mocked(getDb).mockResolvedValue(null as never);
    try {
      await expect(runConfirmationTickOnce()).rejects.toThrow(
        /banco indisponível/,
      );
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
    expect(tick).not.toHaveBeenCalled();
  });

  it("closeDb após tick ok não falha o CLI", async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "mysql://root:root@127.0.0.1:3306/escalas_test";
    vi.mocked(getDb).mockResolvedValue({ ok: true } as never);
    vi.mocked(closeDb).mockRejectedValue(new Error("pool close"));
    vi.mocked(tick).mockResolvedValue(undefined);
    try {
      await expect(runConfirmationTickCli()).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
    expect(closeDb).toHaveBeenCalledTimes(1);
  });

  it("classifica closeDb pós-sucesso como teardown: CLI resolve mesmo se o pool falhar", async () => {
    const src = readFileSync("server/cron/confirmation-tick-cli.ts", "utf8");
    expect(src).toContain("harmless teardown");
    expect(src).toContain("await tick(now)");
    expect(src.indexOf("await tick(now)")).toBeLessThan(
      src.indexOf("confirmation tick closeDb failed"),
    );
  });

  it("encerra o pool mesmo quando o tick falha", async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "mysql://root:root@127.0.0.1:3306/escalas_test";
    vi.mocked(getDb).mockResolvedValue({ ok: true } as never);
    vi.mocked(closeDb).mockResolvedValue(undefined);
    vi.mocked(tick).mockRejectedValue(new Error("boom"));
    try {
      await expect(runConfirmationTickCli()).rejects.toThrow(/boom/);
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
    expect(closeDb).toHaveBeenCalledTimes(1);
  });
});
