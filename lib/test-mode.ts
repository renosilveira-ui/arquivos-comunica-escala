/**
 * Modo de teste (testUserId na URL) — somente em desenvolvimento com flag explícita.
 * Nunca habilitar em builds de produção.
 */
export function isTestModeEnabled(): boolean {
  if (!__DEV__) return false;
  return (
    process.env.NEXT_PUBLIC_ENABLE_TEST_MODE === "true" ||
    process.env.EXPO_PUBLIC_ENABLE_TEST_MODE === "true"
  );
}
