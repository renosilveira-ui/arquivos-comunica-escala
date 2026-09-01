import { describe, expect, it } from "vitest";
import { managerScope, professionalInstitutions } from "../drizzle/schema";
import { resolveCanonicalVacancyRequestManagerUserIds } from "../server/vacancy-request-recipients";
import type { OperationalEventTx } from "../server/operational-events";

type ManagerRows = Readonly<{
  medical: readonly { userId: number; professionalId: number }[];
  institution: readonly { userId: number; professionalId: number }[];
  globalAdmin: readonly { userId: number; professionalId: number }[];
}>;

function recipientResolutionTransaction(rows: ManagerRows): OperationalEventTx {
  let professionalInstitutionRead = 0;

  function lockable<T>(value: readonly T[]) {
    const result = Promise.resolve(value) as Promise<readonly T[]> & {
      for: (_lock: "update") => Promise<readonly T[]>;
    };
    result.for = () => result;
    return result;
  }

  return {
    select() {
      let source: unknown;
      const query = {
        from(table: unknown) {
          source = table;
          return query;
        },
        innerJoin() {
          return query;
        },
        leftJoin() {
          return query;
        },
        where() {
          return query;
        },
        for() {
          if (source === managerScope) return lockable(rows.medical);
          if (source === professionalInstitutions) {
            professionalInstitutionRead += 1;
            return lockable(
              professionalInstitutionRead === 1
                ? rows.institution
                : rows.globalAdmin,
            );
          }
          return lockable([]);
        },
      };
      return query;
    },
  } as unknown as OperationalEventTx;
}

describe("destinatários canônicos de solicitações de vaga", () => {
  it("une gestores setoriais, gestores institucionais e admins por ID ordenado", async () => {
    const userIds = await resolveCanonicalVacancyRequestManagerUserIds(
      recipientResolutionTransaction({
        medical: [
          { userId: 11, professionalId: 111 },
          { userId: 7, professionalId: 70 },
        ],
        institution: [
          { userId: 7, professionalId: 70 },
          { userId: 9, professionalId: 90 },
        ],
        globalAdmin: [
          { userId: 3, professionalId: 30 },
          { userId: 11, professionalId: 110 },
        ],
      }),
      { institutionId: 1, hospitalId: 10, sectorId: 4 },
    );

    expect(userIds).toEqual([3, 7, 9, 11]);
  });

  it("preserva a resolução vazia quando o escopo não possui gestor responsável", async () => {
    await expect(
      resolveCanonicalVacancyRequestManagerUserIds(
        recipientResolutionTransaction({
          medical: [],
          institution: [],
          globalAdmin: [],
        }),
        { institutionId: 1, hospitalId: 10, sectorId: 4 },
      ),
    ).resolves.toEqual([]);
  });

  it("falha fechado para uma linha que não identifica um usuário canônico", async () => {
    await expect(
      resolveCanonicalVacancyRequestManagerUserIds(
        recipientResolutionTransaction({
          medical: [{ userId: 0, professionalId: 70 }],
          institution: [],
          globalAdmin: [],
        }),
        { institutionId: 1, hospitalId: 10, sectorId: 4 },
      ),
    ).rejects.toThrow("Gestor responsável sem identidade canônica");
  });
});
