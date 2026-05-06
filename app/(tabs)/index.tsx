import { Redirect } from "expo-router";

/**
 * Index do grupo (tabs) — redireciona para Agenda.
 *
 * A tela "Início" foi removida (per docs/product/escala-ux.md §3): o
 * dashboard genérico não trazia valor para usuário comum, e o app deve
 * abrir direto na visão de calendário. Esta entrada agora apenas
 * redireciona para `/(tabs)/calendar`.
 *
 * O entry continua existindo (em vez de excluído) porque o Expo Router
 * resolve `/(tabs)/` (rota raiz do grupo) para o arquivo `index.tsx`.
 * Sem ele, navegações para `/` ou `/(tabs)` quebrariam.
 */
export default function HomeRedirect() {
  return <Redirect href="/(tabs)/calendar" />;
}
