import { describe, expect, it } from "vitest";
import { getTableConfig, MySqlTable } from "drizzle-orm/mysql-core";
import { is } from "drizzle-orm";

import * as schema from "../drizzle/schema";
import {
  USER_LINKED_TABLES_KEPT_ON_PURPOSE,
  USER_OWNED_DATA_PURGE,
} from "../server/account-data-purge";

/**
 * A exclusão de conta é soft-delete: nenhum `ON DELETE` de `users` dispara.
 * Toda tabela que aponta para `users.id` precisa, portanto, de uma decisão
 * explícita — some com a conta (registro de limpeza) ou fica de propósito
 * (registro operacional, auditoria, escala). Uma tabela nova sem decisão
 * reprova aqui, em vez de guardar dado pessoal em silêncio.
 */
describe("registro de limpeza da conta cobre toda FK para users", () => {
  const tablesPointingAtUsers = Object.values(schema)
    .filter((value): value is MySqlTable => is(value, MySqlTable))
    .filter((table) =>
      getTableConfig(table).foreignKeys.some((fk) => {
        const reference = fk.reference();
        return getTableConfig(reference.foreignTable).name === "users";
      }),
    )
    .map((table) => getTableConfig(table).name)
    .sort();

  it("encontra as tabelas que apontam para users", () => {
    expect(tablesPointingAtUsers.length).toBeGreaterThan(5);
  });

  it("cada uma está na limpeza ou na lista do que fica de propósito", () => {
    const purged = new Set(
      USER_OWNED_DATA_PURGE.map((entry) => getTableConfig(entry.table).name),
    );
    const undecided = tablesPointingAtUsers.filter(
      (name) => !purged.has(name) && !USER_LINKED_TABLES_KEPT_ON_PURPOSE.has(name),
    );
    expect(undecided, "tabelas sem decisão de exclusão").toEqual([]);
  });

  it("nenhuma tabela está nas duas listas", () => {
    for (const entry of USER_OWNED_DATA_PURGE) {
      expect(
        USER_LINKED_TABLES_KEPT_ON_PURPOSE.has(getTableConfig(entry.table).name),
      ).toBe(false);
    }
  });

  it("toda coluna do registro pertence à própria tabela", () => {
    for (const entry of USER_OWNED_DATA_PURGE) {
      const columns = Object.values(getTableConfig(entry.table).columns);
      expect(columns, entry.key).toContain(entry.column);
    }
  });
});
