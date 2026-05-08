import { Redirect } from "expo-router";

/**
 * Rota legada — Calendar foi unificada com Weekly em /agenda.
 * Mantemos este arquivo só pra redirecionar bookmarks e links antigos.
 */
export default function CalendarRedirect() {
  return <Redirect href="/(tabs)/agenda" />;
}
