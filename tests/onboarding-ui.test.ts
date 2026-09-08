import {
  CreateShiftAccessBoundary,
  OnboardingDirectionScreen,
  OperationalEntry,
  UnlinkedAccountProfile,
} from "../components/OnboardingDirection";
import React, { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  institutionId: null as number | null,
  query: {
    isLoading: false,
    isFetching: false,
    isError: false,
    data: undefined as unknown,
    refetch: vi.fn(),
  },
  push: vi.fn(),
  buttons: new Map<string, { onPress: () => void; disabled?: boolean }>(),
  platform: "web",
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return state.platform;
    },
    select: (v: Record<string, unknown>) => v[state.platform] ?? v.default,
  },
  View: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) =>
    createElement("span", null, children),
  ActivityIndicator: () => createElement("span", null, "loading"),
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: state.push, replace: state.push }),
  Redirect: ({ href }: { href: string }) =>
    createElement("span", null, `redirect:${href}`),
}));
vi.mock("../hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: 9, role: "admin", name: "Pessoa", email: "conta@test.local" },
  }),
}));
vi.mock("../hooks/use-logout-action", () => ({
  useLogoutAction: () => ({ isLoggingOut: false, requestLogout: vi.fn() }),
}));
vi.mock("../lib/tenant-state", () => ({
  useTenantState: () => ({ activeInstitutionId: state.institutionId }),
}));
vi.mock("../lib/trpc", () => ({
  trpc: {
    professionals: { getMyCapabilities: { useQuery: () => state.query } },
    scheduleContexts: { listMine: { useQuery: () => state.query } },
  },
}));
vi.mock("../components/ui/ScreenGradient", () => ({
  ScreenGradient: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../components/ui/ScreenContainer", () => ({
  ScreenContainer: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../components/ui/Surface", () => ({
  Surface: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../components/ui/QueryErrorState", () => ({
  QueryErrorState: () => createElement("span", null, "query-error-retry"),
}));
vi.mock("../components/ui/AppButton", () => ({
  AppButton: (props: {
    title: string;
    onPress: () => void;
    disabled?: boolean;
  }) => {
    state.buttons.set(props.title, props);
    return createElement("button", { disabled: props.disabled }, props.title);
  },
}));

describe.each(["web", "ios", "android"])("direcionamento em %s", (platform) => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    state.platform = platform;
    state.institutionId = null;
    state.query = {
      isLoading: false,
      isFetching: false,
      isError: false,
      data: undefined,
      refetch: vi.fn(),
    };
    state.push.mockClear();
    state.buttons.clear();
  });
  it("mostra opções e Perfil para conta sem vínculo; intenção não navega para criação", () => {
    const markup = renderToStaticMarkup(
      createElement(OnboardingDirectionScreen),
    );
    expect(markup).toContain("Criar ou gerenciar uma escala");
    expect(markup).toContain("Entrar em uma escala existente");
    state.buttons.get("Criar ou gerenciar uma escala")!.onPress();
    expect(state.push).not.toHaveBeenCalled();
    state.buttons.get("Entrar em uma escala existente")!.onPress();
    expect(state.push).toHaveBeenLastCalledWith("/join-schedule");
    state.buttons.get("Meu perfil")!.onPress();
    expect(state.push).toHaveBeenLastCalledWith("/account-profile");
    expect(
      renderToStaticMarkup(createElement(UnlinkedAccountProfile)),
    ).toContain("conta@test.local");
    state.buttons.get("Começar em uma escala")!.onPress();
    expect(state.push).toHaveBeenLastCalledWith("/onboarding");
  });
  it("gestor canônico chega à criação, apesar do papel global ser irrelevante", () => {
    state.institutionId = 4;
    state.query.data = { institutionId: 4, canCreateShift: true };
    renderToStaticMarkup(createElement(OnboardingDirectionScreen));
    state.buttons.get("Criar ou gerenciar uma escala")!.onPress();
    expect(state.push).toHaveBeenCalledWith("/create-shift");
  });
  it("URL direta não monta o formulário para não gestor, erro, loading ou tenant divergente", () => {
    state.institutionId = 4;
    for (const query of [
      { data: { institutionId: 4, canCreateShift: false } },
      { data: { institutionId: 5, canCreateShift: true } },
      { data: { institutionId: 4, canCreateShift: true }, isError: true },
      { data: { institutionId: 4, canCreateShift: true }, isFetching: true },
    ]) {
      state.query = {
        isLoading: false,
        isFetching: false,
        isError: false,
        refetch: vi.fn(),
        ...query,
      };
      const markup = renderToStaticMarkup(
        createElement(
          CreateShiftAccessBoundary,
          null,
          createElement("span", null, "FORMULARIO_PRIVADO"),
        ),
      );
      expect(markup).not.toContain("FORMULARIO_PRIVADO");
    }
    state.query = {
      isLoading: false,
      isFetching: false,
      isError: false,
      data: { institutionId: 4, canCreateShift: true },
      refetch: vi.fn(),
    };
    expect(
      renderToStaticMarkup(
        createElement(CreateShiftAccessBoundary, null, "FORMULARIO_PRIVADO"),
      ),
    ).toContain("FORMULARIO_PRIVADO");
  });
  it("não força onboarding para conta com escala nem transforma falha em ausência de escala", () => {
    state.query.data = [{ id: 1 }];
    expect(renderToStaticMarkup(createElement(OperationalEntry))).toContain(
      "redirect:/(tabs)/agenda",
    );
    state.query.data = [];
    expect(renderToStaticMarkup(createElement(OperationalEntry))).toContain(
      "redirect:/onboarding",
    );
    state.query.isError = true;
    expect(renderToStaticMarkup(createElement(OperationalEntry))).toContain(
      "query-error-retry",
    );
  });
});
