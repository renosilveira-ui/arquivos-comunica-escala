import { describe, expect, it } from "vitest";

import {
  awaitPersonalAgendaEditorStep,
  capturePersonalAgendaEditorAuthority,
  closePersonalAgendaEditorSession,
  createPersonalAgendaEditorOperationController,
  createPersonalAgendaEditorSnapshot,
  createPersonalAgendaEditorTarget,
  isPersonalAgendaEditorAuthorityCurrent,
  personalAgendaEditorVersionState,
  personalAgendaExpectedVersion,
  reconcilePersonalAgendaEditorCache,
  selectPersonalAgendaMutationRecord,
  selectPersonalAgendaEditorRecord,
  settlePersonalAgendaRefreshes,
} from "../lib/personal-agenda-editor-state";
import { SessionEpoch } from "../lib/session-epoch";

describe("estado seguro do editor da Agenda pessoal", () => {
  it("revoga a autoridade do editor na troca de conta ou de geração", () => {
    const epoch = new SessionEpoch();
    const authority = capturePersonalAgendaEditorAuthority(53, epoch);

    expect(isPersonalAgendaEditorAuthorityCurrent(authority, 53, epoch)).toBe(
      true,
    );
    expect(isPersonalAgendaEditorAuthorityCurrent(authority, 56, epoch)).toBe(
      false,
    );

    epoch.beginTransition();
    expect(isPersonalAgendaEditorAuthorityCurrent(authority, 53, epoch)).toBe(
      false,
    );
  });

  it("não continua a escrita quando a prévia termina após desmontagem", async () => {
    let releasePreview!: (value: { total: number }) => void;
    const preview = new Promise<{ total: number }>((resolve) => {
      releasePreview = resolve;
    });
    let active = true;
    let mutations = 0;

    const resultPromise = awaitPersonalAgendaEditorStep(preview, () => active);
    active = false;
    releasePreview({ total: 1 });
    const result = await resultPromise;
    if (result.current) mutations += 1;

    expect(result).toEqual({ current: false });
    expect(mutations).toBe(0);
  });

  it("descarta cache de resposta tardia após troca de identidade", async () => {
    let releaseCancel!: () => void;
    const cancel = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    let active = true;
    let cacheWrites = 0;
    const reconciliation = reconcilePersonalAgendaEditorCache({
      cancelInFlight: () => cancel,
      isCurrent: () => active,
      apply: () => {
        cacheWrites += 1;
      },
    });

    active = false;
    releaseCancel();

    await expect(reconciliation).resolves.toBe(false);
    expect(cacheWrites).toBe(0);
  });

  it("aplica a versão confirmada somente após cancelar leitura v1 em voo", async () => {
    const order: string[] = [];

    await expect(
      reconcilePersonalAgendaEditorCache({
        cancelInFlight: async () => {
          order.push("cancel-v1");
        },
        isCurrent: () => true,
        apply: () => {
          order.push("cache-v2");
        },
      }),
    ).resolves.toBe(true);

    expect(order).toEqual(["cancel-v1", "cache-v2"]);
  });

  it("não hidrata criação com o item 1 retido no cache", () => {
    const cachedItemOne = { id: 1, version: 7, title: "Item privado" };

    expect(
      selectPersonalAgendaEditorRecord(
        { sessionId: "create-1", dateKey: "2026-10-15" },
        cachedItemOne,
      ),
    ).toBeNull();
  });

  it("só aceita na edição o registro do id solicitado", () => {
    expect(
      selectPersonalAgendaEditorRecord(
        { sessionId: "edit-22", dateKey: "2026-09-09", itemId: 22 },
        { id: 21, version: 3 },
      ),
    ).toBeNull();
  });

  it("não combina campos da versão 1 com expectedVersion 2", () => {
    const target = {
      sessionId: "edit-22-v1",
      dateKey: "2026-09-09",
      itemId: 22,
    };
    const versionOne = { id: 22, version: 1 };
    const snapshot = createPersonalAgendaEditorSnapshot(target, versionOne);
    const versionTwo = { id: 22, version: 2 };

    expect(personalAgendaEditorVersionState(target, snapshot, versionTwo)).toBe(
      "REMOTE_CHANGED",
    );
    expect(() =>
      personalAgendaExpectedVersion(target, snapshot, versionTwo),
    ).toThrow("alterado em outro aparelho");
  });

  it("usa no CAS exatamente a versão que originou o formulário", () => {
    const target = {
      sessionId: "edit-22-v1",
      dateKey: "2026-09-09",
      itemId: 22,
    };
    const versionOne = { id: 22, version: 1 };
    const snapshot = createPersonalAgendaEditorSnapshot(target, versionOne);

    expect(personalAgendaExpectedVersion(target, snapshot, versionOne)).toBe(1);
  });

  it("não deixa a conclusão de uma sessão antiga fechar outra abertura", () => {
    const first = createPersonalAgendaEditorTarget({
      dateKey: "2026-09-09",
      itemId: 22,
    });
    const second = createPersonalAgendaEditorTarget({
      dateKey: "2026-09-09",
      itemId: 22,
    });

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(closePersonalAgendaEditorSession(second, first.sessionId)).toBe(
      second,
    );
    expect(
      closePersonalAgendaEditorSession(second, second.sessionId),
    ).toBeNull();
  });

  it("mantém a operação ocupada até mutation, reconciliação e callback terminarem", async () => {
    let releaseMutation!: () => void;
    let releaseReconciliation!: () => void;
    const mutation = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const reconciliation = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    const states: ("SAVE" | "DELETE" | null)[] = [];
    let commits = 0;
    let callbacks = 0;
    const controller = createPersonalAgendaEditorOperationController({
      isSessionActive: () => true,
      onChange: (state) => states.push(state),
    });

    const first = controller.run("DELETE", async () => {
      commits += 1;
      await mutation;
      await reconciliation;
      callbacks += 1;
    });
    const duplicate = await controller.run("DELETE", async () => {
      commits += 1;
    });

    expect(duplicate).toEqual({ started: false });
    expect(controller.current()).toBe("DELETE");
    expect(commits).toBe(1);
    releaseMutation();
    await Promise.resolve();
    expect(controller.current()).toBe("DELETE");
    expect(callbacks).toBe(0);
    releaseReconciliation();
    await expect(first).resolves.toMatchObject({ started: true });
    expect(callbacks).toBe(1);
    expect(controller.current()).toBeNull();
    expect(states).toEqual(["DELETE", null]);
  });

  it("não converte falha de reconciliação pós-commit em falha da escrita", async () => {
    await expect(
      settlePersonalAgendaRefreshes([
        Promise.resolve(),
        Promise.reject(new Error("cache indisponível")),
      ]),
    ).resolves.toBeUndefined();
  });

  it("reabre a própria atualização no cache novo sem falso conflito", () => {
    const updated = { id: 22, version: 2, title: "Conteúdo confirmado" };
    const cached = selectPersonalAgendaMutationRecord(22, updated);
    const reopened = createPersonalAgendaEditorTarget({
      dateKey: "2026-09-09",
      itemId: 22,
    });
    const snapshot = createPersonalAgendaEditorSnapshot(reopened, cached);

    expect(cached).toBe(updated);
    expect(personalAgendaEditorVersionState(reopened, snapshot, cached)).toBe(
      "READY",
    );
    expect(
      selectPersonalAgendaMutationRecord(22, { id: 23, version: 2 }),
    ).toBeNull();
  });
});
