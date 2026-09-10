import { readFileSync } from "node:fs";
import {
  QueryClient,
  QueryObserver,
  onlineManager,
} from "@tanstack/react-query";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  openMonthCapacitySnapshotKey,
  resolveOpenMonthCapacityState,
} from "../lib/open-month-capacity-state";

const source = ts.createSourceFile(
  "OpenMonthShiftsButton.tsx",
  readFileSync("components/agenda/OpenMonthShiftsButton.tsx", "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function findNode(predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (predicate(node)) found ??= node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!found) throw new Error("Consumidor de capacidade não encontrado");
  return found;
}

function evaluate<T>(expression: string, bindings: Record<string, unknown>): T {
  const js = ts.transpileModule(`const subject = (${expression});`, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  return new Function(...Object.keys(bindings), `${js}\nreturn subject;`)(
    ...Object.values(bindings),
  );
}

function initializer(name: string): string {
  const node = findNode(
    (node) =>
      ts.isVariableDeclaration(node) && node.name.getText(source) === name,
  );
  return (node as ts.VariableDeclaration).initializer!.getText(source);
}

const confirmSource = findNode(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "confirm",
).getText(source);
const hydrateSource = findNode(
  (node) =>
    ts.isCallExpression(node) &&
    node.expression.getText(source) === "useEffect" &&
    node.arguments[0]?.getText(source).includes("setCapacityHydration"),
) as ts.CallExpression;
const confirmButton = findNode(
  (node) =>
    ts.isJsxSelfClosingElement(node) &&
    node.tagName.getText(source) === "AppButton" &&
    node.attributes.getText(source).includes("openMonthShiftsConfirmTitle"),
) as ts.JsxSelfClosingElement;
const disabledAttribute = confirmButton.attributes.properties.find(
  (node) => ts.isJsxAttribute(node) && node.name.getText(source) === "disabled",
) as ts.JsxAttribute;
const disabledExpression = (
  disabledAttribute.initializer as ts.JsxExpression
).expression!.getText(source);

type CapacityRule = { name: string; capacities: number[] };
const rules = (capacity: number): CapacityRule[] => [
  { name: "Manhã", capacities: Array(7).fill(capacity) },
];
const cleanups: (() => void)[] = [];

function observe(options: {
  online: boolean;
  data?: CapacityRule[];
  staleTime?: number;
  queryFn?: () => Promise<CapacityRule[]>;
}) {
  onlineManager.setOnline(options.online);
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: Infinity,
        refetchOnReconnect: false,
      },
    },
  });
  client.mount();
  const queryKey = [
    "capacityRules",
    { scheduleContextId: 100, expectedInstitutionId: 10 },
  ];
  if (options.data !== undefined)
    client.setQueryData(queryKey, options.data, {
      updatedAt: Date.now() - 60_000,
    });
  const observer = new QueryObserver(client, {
    queryKey,
    queryFn: options.queryFn ?? (() => new Promise<CapacityRule[]>(() => {})),
    staleTime: options.staleTime ?? 0,
  });
  const unsubscribe = observer.subscribe(() => {});
  cleanups.push(() => {
    unsubscribe();
    observer.destroy();
    client.clear();
    client.unmount();
  });
  return observer;
}

function hydration(query: Record<string, unknown>) {
  const setCapacityValues = vi.fn();
  const setCapacityHydration = vi.fn();
  evaluate<() => void>(hydrateSource.arguments[0].getText(source), {
    open: true,
    capacityScopeKey: "10:100",
    capacitySnapshotKey: openMonthCapacitySnapshotKey(
      "10:100",
      Number(query.dataUpdatedAt),
    ),
    capacityRules: query,
    capacityHydration: null,
    capacityDirty: false,
    emptyCapacityValues: () => ({ Manhã: "", Tarde: "", Noite: "" }),
    OPEN_MONTH_SHIFT_TEMPLATE_NAMES: ["Manhã", "Tarde", "Noite"],
    setCapacityValues,
    setCapacityHydration,
    setCapacityDirty: vi.fn(),
  })();
  return { setCapacityValues, setCapacityHydration };
}

async function attempt(
  query: Record<string, unknown>,
  options: {
    hydratedSnapshotKey?: string | null;
    capacity?: string;
  } = {},
) {
  const snapshot = openMonthCapacitySnapshotKey(
    "10:100",
    Number(query.dataUpdatedAt),
  );
  const capacityState = evaluate<string>(initializer("capacityState"), {
    capacityRules: query,
    capacitySnapshotKey: snapshot,
    capacityHydration: {
      snapshotKey:
        options.hydratedSnapshotKey === undefined
          ? snapshot
          : options.hydratedSnapshotKey,
    },
    invalidCapacity: false,
    resolveOpenMonthCapacityState,
  });
  const capacityReady = evaluate<boolean>(initializer("capacityReady"), {
    capacityState,
  });
  const mutateAsync = vi.fn(async (_input: unknown) => ({
    created: 1,
    skipped: 0,
  }));
  const lease = {};
  const openMonthShifts = { isPending: false, mutateAsync };
  const disabled = evaluate<boolean>(disabledExpression, {
    capacityReady,
    plannedCount: 1,
    openMonthShifts,
  });
  const invalidate = async () => {};
  const confirm = evaluate<() => Promise<void>>(confirmSource, {
    capacityReady,
    plannedCount: 1,
    openMonthShifts,
    actionLease: {
      capture: () => lease,
      isCurrent: (value: unknown) => value === lease,
    },
    openMonthLeaseRef: { current: null },
    selectedContext: { hospitalId: 1, sectorId: 2, scheduleContextId: 100 },
    monthKey: "2026-09",
    mode: "all-applicable",
    customNames: [],
    visibleCapacityNames: ["Manhã"],
    capacityValues: { Manhã: options.capacity ?? "2" },
    invalidateOfficialScaleAndVacancyQueries: invalidate,
    utils: {
      shifts: { hasMonthShifts: { invalidate }, rosterStatus: { invalidate } },
      filters: { hasMonthShifts: { invalidate } },
    },
    feedback: { error: vi.fn(), success: vi.fn() },
    onChanged: vi.fn(),
    openMonthShiftsToast: () => "Criado",
    close: vi.fn(),
  });
  await confirm();
  return { capacityState, disabled, mutateAsync };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  onlineManager.setOnline(true);
});

describe("capacidade pausada: QueryObserver e consumidor real de confirmação", () => {
  it("não hidrata nem envia a capacidade antiga durante success + paused", async () => {
    const observer = observe({
      online: false,
      data: rules(2),
      queryFn: async () => rules(3),
    });
    const query = observer.getCurrentResult();
    expect(query).toMatchObject({
      status: "success",
      fetchStatus: "paused",
      isFetching: false,
      isStale: true,
    });
    expect(hydration(query).setCapacityHydration).not.toHaveBeenCalled();
    const result = await attempt(query);
    expect(result.capacityState).toBe("unresolved");
    expect(result.disabled).toBe(true);
    expect(result.mutateAsync).not.toHaveBeenCalled();
  });

  it("bloqueia pending + paused sem cache e fetching com cache antigo", async () => {
    for (const options of [
      { online: false },
      { online: true, data: rules(2) },
    ]) {
      const observer = observe(options);
      const result = await attempt(observer.getCurrentResult());
      expect(result.capacityState).not.toBe("ready");
      expect(result.disabled).toBe(true);
      expect(result.mutateAsync).not.toHaveBeenCalled();
      expect(
        hydration(observer.getCurrentResult()).setCapacityHydration,
      ).not.toHaveBeenCalled();
    }
  });

  it("cache fresco validado e hidratado permanece utilizável, inclusive vazio", async () => {
    for (const data of [rules(2), []]) {
      const observer = observe({ online: false, data, staleTime: Infinity });
      const query = observer.getCurrentResult();
      expect(query).toMatchObject({
        status: "success",
        fetchStatus: "idle",
        isStale: false,
      });
      expect(hydration(query).setCapacityHydration).toHaveBeenCalledOnce();
      const result = await attempt(query, { capacity: data.length ? "2" : "" });
      expect(result.capacityState).toBe("ready");
      expect(result.disabled).toBe(false);
      expect(result.mutateAsync).toHaveBeenCalledOnce();
      expect(result.mutateAsync.mock.calls[0][0]).toMatchObject({
        capacityOverrides: data.length
          ? [{ templateName: "Manhã", requiredCapacity: 2 }]
          : [],
      });
    }
  });

  it("retomada exige a nova hidratação antes de enviar a capacidade atual", async () => {
    const observer = observe({
      online: false,
      data: rules(2),
      queryFn: async () => rules(3),
    });
    const oldSnapshot = openMonthCapacitySnapshotKey(
      "10:100",
      observer.getCurrentResult().dataUpdatedAt,
    );
    onlineManager.setOnline(true);
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().fetchStatus).toBe("idle"),
    );
    const query = observer.getCurrentResult();
    expect(query.data).toEqual(rules(3));
    const oldForm = await attempt(query, { hydratedSnapshotKey: oldSnapshot });
    expect(oldForm.mutateAsync).not.toHaveBeenCalled();
    const hydrated = hydration(query);
    expect(hydrated.setCapacityValues).toHaveBeenCalledWith({
      Manhã: "3",
      Tarde: "",
      Noite: "",
    });
    const result = await attempt(query, { capacity: "3" });
    expect(result.mutateAsync.mock.calls[0][0]).toMatchObject({
      capacityOverrides: [{ templateName: "Manhã", requiredCapacity: 3 }],
    });
  });

  it("erro real e provas ausentes ou incoerentes nunca chegam à mutação", async () => {
    const observer = observe({
      online: true,
      data: rules(2),
      queryFn: async () => {
        throw new Error("rede");
      },
    });
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().isError).toBe(true),
    );
    expect((await attempt(observer.getCurrentResult())).capacityState).toBe(
      "error",
    );
    const good = observe({
      online: true,
      data: rules(2),
      staleTime: Infinity,
    }).getCurrentResult();
    const uncertain = [
      observer.getCurrentResult(),
      { ...good, fetchStatus: undefined },
      { ...good, fetchStatus: "unexpected" },
      { ...good, data: undefined },
      { ...good, dataUpdatedAt: 0 },
      { ...good, isSuccess: false },
    ];
    for (const query of uncertain) {
      const result = await attempt(query);
      expect(result.disabled).toBe(true);
      expect(result.mutateAsync).not.toHaveBeenCalled();
    }
    const wrongScope = await attempt(good, {
      hydratedSnapshotKey: `20:100@${good.dataUpdatedAt}`,
    });
    expect(wrongScope.mutateAsync).not.toHaveBeenCalled();
  });
});
