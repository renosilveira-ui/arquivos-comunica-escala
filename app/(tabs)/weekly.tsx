import { Redirect } from "expo-router";

/**
 * Rota legada — Weekly foi unificada com Calendar em /agenda.
 * Mantemos este arquivo só pra redirecionar bookmarks e links antigos.
 */
export default function WeeklyRedirect() {
  return <Redirect href="/(tabs)/agenda" />;
}
