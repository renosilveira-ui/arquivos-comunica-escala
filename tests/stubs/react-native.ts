// tests/stubs/react-native.ts — stub mínimo de react-native para testar em
// Node módulos de lib/ que só tocam Platform (theme, tenant-state, api).
// Aliasado em vitest.config.ts. Nunca usado pelo app.
type Spec<T> = { ios?: T; android?: T; web?: T; native?: T; default?: T };
export const Platform = {
  OS: "web" as const,
  select<T>(spec: Spec<T>): T | undefined {
    return spec.web ?? spec.default;
  },
};
