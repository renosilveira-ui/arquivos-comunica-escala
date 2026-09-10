import { createElement } from "react";
import * as React from "react";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import {
  QueryClient,
  QueryObserver,
  onlineManager,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ShiftDetailsScreen from "../app/shift-details";

const queries = vi.hoisted(() => ({
  shift: {} as Record<string, unknown>,
  candidates: {} as Record<string, unknown>,
}));

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const host =
    (tag: string) =>
    ({
      children,
      disabled,
    }: {
      children?: React.ReactNode;
      disabled?: boolean;
    }) =>
      createElement(tag, { disabled }, children);
  return {
    View: host("div"),
    Text: host("span"),
    TextInput: host("input"),
    TouchableOpacity: host("button"),
    ActivityIndicator: host("progress"),
    StyleSheet: { create: (styles: unknown) => styles },
    useWindowDimensions: () => ({ width: 400 }),
    Platform: {
      OS: "web",
      select: (values: Record<string, unknown>) => values.web ?? values.default,
    },
  };
});
vi.mock("lucide-react-native", () => ({
  ChevronLeft: "svg",
  Clock: "svg",
  Calendar: "svg",
  Users: "svg",
  CheckCircle2: "svg",
  AlertCircle: "svg",
  Search: "svg",
  UserPlus: "svg",
  Trash2: "svg",
  Bell: "svg",
  CloudOff: "svg",
}));
vi.mock("@/components/ui/ScreenGradient", () => ({ ScreenGradient: "main" }));
vi.mock("@/components/ui/TintedGlassCard", () => ({
  TintedGlassCard: "section",
}));
vi.mock("@/components/ui/Badge", () => ({ Badge: "mark" }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: 1 } }) }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ can: () => true }),
}));
vi.mock("@/hooks/use-action-feedback", () => ({
  useActionFeedback: () => ({ info: vi.fn() }),
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
  useLocalSearchParams: () => ({ id: "7" }),
}));
vi.mock("expo-haptics", () => ({}));
vi.mock("@/lib/demo-mode", () => ({
  isDemoMode: async () => false,
  DEMO_SHIFTS: [],
}));
vi.mock("@/lib/official-scale-vacancy-query-refresh", () => ({
  invalidateOfficialScaleAndVacancyQueries: vi.fn(),
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({}),
    shifts: {
      get: { useQuery: () => queries.shift },
      notifyVacancy: { useMutation: () => ({}) },
    },
    professionals: {
      getByUserId: { useQuery: () => ({}) },
      listAssignableForShift: { useQuery: () => queries.candidates },
    },
    confirmations: { getPending: { useQuery: () => ({}) } },
    editor: {
      assignDirect: { useMutation: () => ({}) },
      unassignDirect: { useMutation: () => ({}) },
    },
  },
}));

const shift = {
  id: 7,
  status: "VAGO",
  sectorName: "Centro cirúrgico",
  startAt: "2026-09-14T10:00:00Z",
  endAt: "2026-09-14T16:00:00Z",
  assignments: [],
  requiredCapacity: 2,
  remainingCapacity: 2,
  activeCount: 0,
};
const cleanups: (() => void)[] = [];

function observe<T>(options: {
  data?: T;
  online?: boolean;
  staleTime?: number;
  queryFn?: () => Promise<T>;
}) {
  onlineManager.setOnline(options.online ?? true);
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
  const queryKey = ["shift-details", cleanups.length];
  if (options.data !== undefined) client.setQueryData(queryKey, options.data);
  const observer = new QueryObserver(client, {
    queryKey,
    queryFn: options.queryFn ?? (() => new Promise<T>(() => {})),
    staleTime: options.staleTime ?? (options.data === undefined ? 0 : Infinity),
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

function render(
  shiftQuery: QueryObserver<unknown>,
  candidateQuery = observe({ data: [] }),
) {
  queries.shift = shiftQuery.getCurrentResult();
  queries.candidates = candidateQuery.getCurrentResult();
  return renderToStaticMarkup(createElement(ShiftDetailsScreen));
}

// O transform puro usa JSX clássico; o app usa o runtime automático do Expo.
beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
});

describe("detalhe e candidatos com QueryObserver real", () => {
  it("pending + paused sem cache não renderiza escala inexistente", () => {
    const candidates = observe({ data: [] });
    const observer = observe({ online: false });
    expect(observer.getCurrentResult()).toMatchObject({
      status: "pending",
      fetchStatus: "paused",
      isLoading: false,
      isError: false,
    });
    const html = render(observer, candidates);
    expect(html).toContain("Detalhes do plantão ainda não confirmados");
    expect(html).not.toContain("Escala não encontrada");
  });

  it("preserva carregamento real e ausência confirmada", () => {
    expect(render(observe({}))).toContain("Carregando detalhes...");
    expect(render(observe({ data: null }))).toContain("Escala não encontrada");
  });

  it("mantém erro real distinto de ausência", async () => {
    const observer = observe({
      queryFn: async () => {
        throw new Error("offline");
      },
    });
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().isError).toBe(true),
    );
    const html = render(observer);
    expect(html).toContain("Não foi possível carregar o plantão");
    expect(html).not.toContain("Escala não encontrada");
  });

  it("candidatos pending + paused sem cache não são lista vazia", () => {
    const detail = observe({ data: shift });
    const candidates = observe({ online: false });
    expect(candidates.getCurrentResult()).toMatchObject({
      status: "pending",
      fetchStatus: "paused",
    });
    const html = render(detail, candidates);
    expect(html).toContain("Profissionais ainda não confirmados");
    expect(html).not.toContain("Nenhum profissional habilitado");
  });

  it("preserva candidatos vazios, dados válidos e erro de consulta", async () => {
    const detail = observe({ data: shift });
    expect(render(detail, observe({ data: [] }))).toContain(
      "Nenhum profissional habilitado",
    );
    expect(
      render(
        detail,
        observe({
          data: [{ id: 9, name: "Profissional válido", role: "USER" }],
        }),
      ),
    ).toContain("Profissional válido");
    const candidates = observe({
      queryFn: async () => {
        throw new Error("offline");
      },
    });
    await vi.waitFor(() =>
      expect(candidates.getCurrentResult().isError).toBe(true),
    );
    const html = render(detail, candidates);
    expect(html).toContain("Não foi possível carregar os profissionais");
    expect(html).not.toContain("Nenhum profissional habilitado");
  });

  it("retomada online substitui estado não confirmado pela resposta", async () => {
    const candidates = observe({ data: [] });
    const observer = observe({ online: false, queryFn: async () => shift });
    expect(render(observer, candidates)).toContain(
      "Detalhes do plantão ainda não confirmados",
    );
    onlineManager.setOnline(true);
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().isSuccess).toBe(true),
    );
    expect(render(observer, candidates)).toContain("Centro cirúrgico");
    expect(render(observer, candidates)).not.toContain(
      "Detalhes do plantão ainda não confirmados",
    );
  });

  it("mantém dados confirmados quando o refetch pausa com cache", () => {
    const detail = observe({ online: false, data: shift, staleTime: 0 });
    const candidates = observe({
      online: false,
      data: [{ id: 9, name: "Profissional confirmado", role: "USER" }],
      staleTime: 0,
    });
    expect(detail.getCurrentResult()).toMatchObject({
      status: "success",
      fetchStatus: "paused",
    });
    const html = render(detail, candidates);
    expect(html).toContain("Centro cirúrgico");
    expect(html).toContain("Profissional confirmado");
    expect(html).not.toContain("ainda não confirmados");
  });

  it("handler real bloqueia uma seleção antiga quando candidatos ficam não resolvidos", () => {
    const source = ts.createSourceFile(
      "shift-details.tsx",
      readFileSync("app/shift-details.tsx", "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    let handler: ts.Expression | undefined;
    function visit(node: ts.Node) {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(source) === "handleAssignProfessional"
      )
        handler = node.initializer;
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(handler).toBeDefined();
    const js = ts.transpileModule(
      `const handler = ${handler!.getText(source)};`,
      {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      },
    ).outputText;
    for (const [unresolved, failed, expectedCalls] of [
      [true, false, 0],
      [false, true, 0],
      [false, false, 1],
    ]) {
      const mutate = vi.fn();
      const bindings = {
        assignableProfessionalsUnresolved: unresolved,
        assignableProfessionalsIsError: failed,
        selectedProfessionalId: 9,
        shiftId: 7,
        shiftData: { shift },
        repeatRule: "none",
        assignDirect: { mutate },
        feedback: { info: vi.fn() },
      };
      new Function(...Object.keys(bindings), `${js}\nhandler();`)(
        ...Object.values(bindings),
      );
      expect(mutate).toHaveBeenCalledTimes(Number(expectedCalls));
    }
  });
});
