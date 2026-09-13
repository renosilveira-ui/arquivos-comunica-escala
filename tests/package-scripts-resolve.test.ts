import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Script de package.json que aponta para arquivo inexistente não falha ao
 * instalar nem ao buildar: falha só quando alguém o executa, ou — pior —
 * engana quem lê. O `"qr": "node scripts/generate_qr.mjs"` sobreviveu por
 * meses apontando para o nada e chegou a induzir a conclusão de que havia
 * um fluxo de convite por QR code no produto, que nunca existiu.
 */
// A âncora final importa: sem ela, `.js` casa dentro de `server/tsconfig.json`
// e o teste acusa um arquivo que nunca foi referenciado.
const LOCAL_PATH =
  /(?:^|\s)((?:\.\/)?(?:scripts|server|lib|app|drizzle|tools)\/[\w./@-]+\.(?:mjs|cjs|js|ts|tsx|sql))(?![\w.])/g;

describe("scripts do package.json apontam para arquivos que existem", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };

  it("nenhum script referencia caminho inexistente", () => {
    const quebrados: string[] = [];
    for (const [nome, comando] of Object.entries(pkg.scripts ?? {})) {
      for (const match of comando.matchAll(LOCAL_PATH)) {
        const caminho = match[1].replace(/^\.\//, "");
        if (!existsSync(caminho)) quebrados.push(`${nome} → ${caminho}`);
      }
    }
    expect(quebrados).toEqual([]);
  });

  it("a expressão realmente enxerga um caminho quebrado", () => {
    // Sem esta prova, um regex que não casa com nada passaria como "tudo ok".
    const falso = "node scripts/nao-existe-aqui.mjs";
    const achados = [...falso.matchAll(LOCAL_PATH)].map((m) => m[1]);
    expect(achados).toEqual(["scripts/nao-existe-aqui.mjs"]);
    expect(existsSync(achados[0])).toBe(false);
    // E não pode recortar um caminho maior pela metade.
    expect([..."tsc -p server/tsconfig.json".matchAll(LOCAL_PATH)]).toEqual([]);
  });
});

describe("dependências órfãs do QR", () => {
  it("qrcode saiu do manifesto e do lockfile", () => {
    const pkg = readFileSync("package.json", "utf8");
    expect(pkg).not.toContain("qrcode");
    expect(readFileSync("pnpm-lock.yaml", "utf8")).not.toContain("qrcode@");
  });
});
