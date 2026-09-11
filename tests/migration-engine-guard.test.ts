import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../drizzle/migrations/manual", import.meta.url),
);

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

function read(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, name), "utf8");
}

/**
 * Em 11/09/2026 a fundação da Agenda de Compromissos nunca chegou ao staging.
 * As cinco tabelas não existiam, a tela abria vazia, e a funcionalidade
 * parecia não ter sido entregue — porque, no ambiente do usuário, não tinha.
 *
 * A causa era uma linha: um rascunho `CREATE TEMPORARY TABLE ... ENGINE=MEMORY`
 * para conferir contrato. MySQL gerenciado — DigitalOcean, que é onde o
 * staging roda — desabilita esse engine, e a migração abortava na primeira
 * instrução com "Storage engine MEMORY is disabled", antes de criar qualquer
 * tabela. Falha fechada, como deve ser, e silenciosa para quem olhava o app.
 *
 * O conserto de duas linhas já foi. Este teste é o que impede a armadilha de
 * voltar: quem escrever a próxima migração não tem como saber dessa história.
 */
describe("migrations rodam no banco de destino, não só no do desenvolvedor", () => {
  it("existe migração para conferir", () => {
    expect(migrationFiles().length).toBeGreaterThan(10);
  });

  /**
   * A lista de engines proibidos é curta de propósito: só o que o MySQL
   * gerenciado recusa. InnoDB é o único que o projeto precisa.
   */
  it("nenhuma migração usa engine que o MySQL gerenciado desabilita", () => {
    // `(?<![\w@])` evita casar o fim de nomes de variável SQL como
    // `@ssc_post_rules_engine = 1`, que nada têm a ver com engine de tabela.
    const proibidos =
      /(?<![\w@])ENGINE\s*=\s*(MEMORY|HEAP|FEDERATED|BLACKHOLE)\b/i;
    const ofensores: string[] = [];
    for (const name of migrationFiles()) {
      const match = read(name).match(proibidos);
      if (match) ofensores.push(`${name} → ${match[0]}`);
    }
    expect(
      ofensores,
      "MySQL gerenciado recusa estes engines; use ENGINE=InnoDB, inclusive em TEMPORARY TABLE",
    ).toEqual([]);
  });

  /**
   * `SUPER` e variáveis globais também não existem num banco gerenciado: a
   * conta da aplicação não tem esse privilégio, e a migração abortaria no
   * meio — pior que abortar no começo, porque deixa estado parcial.
   */
  it("nenhuma migração exige privilégio que a conta gerenciada não tem", () => {
    const proibidos =
      /\b(SET\s+GLOBAL|CREATE\s+USER|GRANT\s|SUPER\b|SET\s+@@GLOBAL)/i;
    const ofensores: string[] = [];
    for (const name of migrationFiles()) {
      const semComentarios = read(name)
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
      const match = semComentarios.match(proibidos);
      if (match) ofensores.push(`${name} → ${match[0].trim()}`);
    }
    expect(
      ofensores,
      "banco gerenciado não concede estes privilégios à conta da aplicação",
    ).toEqual([]);
  });

  /**
   * O engine importa para tabela de verdade também: MyISAM não tem transação
   * nem chave estrangeira, e uma tabela dessas passaria despercebida até o
   * primeiro rollback que não desfez nada.
   */
  it("toda tabela criada é InnoDB", () => {
    const ofensores: string[] = [];
    for (const name of migrationFiles()) {
      for (const match of read(name).matchAll(
        /(?<![\w@])ENGINE\s*=\s*([A-Za-z]\w*)/gi,
      )) {
        if (match[1].toUpperCase() !== "INNODB") {
          ofensores.push(`${name} → ENGINE=${match[1]}`);
        }
      }
    }
    expect(ofensores).toEqual([]);
  });
});
