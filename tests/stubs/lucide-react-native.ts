// tests/stubs/lucide-react-native.ts — ícones como funções vazias para
// testar em Node os módulos de lib/ que carregam ícones (lib/shift-status.ts).
// Aliasado em vitest.config.ts. Nunca usado pelo app.
export type LucideIcon = (props: Record<string, unknown>) => null;
const icon: LucideIcon = () => null;
export const CheckCircle2 = icon;
export const CircleDashed = icon;
export const Clock = icon;
export const XCircle = icon;
