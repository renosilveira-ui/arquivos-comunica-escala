import { beforeAll, afterAll } from "vitest";
import { closeDb, getDb } from "../server/db";
import { seedTestData } from "../server/seed-test-data";
import { installAsyncRouteForwarding } from "../server/_core/error-handling";
import {
  assertConnectedDatabaseName,
  assertDisposableTestTargetMarker,
  assertDisposableTestTargetSchema,
  DISPOSABLE_TEST_TARGET_MARKER_SELECT,
  DISPOSABLE_TEST_TARGET_SCHEMA_SELECT,
  validateStandardTestDestructiveTarget,
} from "../scripts/destructive-target-fence";

// Setup global para testes
(global as any).__DEV__ = true;

// Os testes HTTP montam apps Express mínimos, mas precisam preservar a mesma
// fronteira de erro do servidor real: rejeições de handlers async devem virar
// respostas 500, nunca conexões abruptamente resetadas.
installAsyncRouteForwarding();

// Mock AsyncStorage
const storage: Record<string, string> = {};

(global as any).AsyncStorage = {
  getItem: async (key: string) => storage[key] || null,
  setItem: async (key: string, value: string) => {
    storage[key] = value;
  },
  removeItem: async (key: string) => {
    delete storage[key];
  },
  clear: async () => {
    Object.keys(storage).forEach(key => delete storage[key]);
  },
};

// Configurar ambiente de teste
beforeAll(async () => {
  // Evitar rodar seed múltiplas vezes (1x por suite)
  if ((globalThis as any).__SEED_DONE__) return;

  console.log("🧪 Iniciando ambiente de testes...");

  // Defesa em profundidade imediatamente antes de abrir a conexão.
  const validatedTarget = validateStandardTestDestructiveTarget(process.env);

  // Log explícito da conexão do banco
  const db = await getDb();
  if (!db) {
    throw new Error("❌ Database not available");
  }
  
  // Verificar qual banco está sendo usado
  const [result] = await db.execute("SELECT DATABASE() as db_name");
  const dbName = (result as any)[0]?.db_name || "unknown";
  assertConnectedDatabaseName(
    dbName,
    validatedTarget.databaseName,
    "Connected test database",
  );
  assertDisposableTestTargetMarker(
    await db.execute(DISPOSABLE_TEST_TARGET_MARKER_SELECT),
    validatedTarget,
  );
  assertDisposableTestTargetSchema(
    await db.execute(DISPOSABLE_TEST_TARGET_SCHEMA_SELECT),
  );
  console.log(`📊 Banco de dados ativo: ${dbName}`);
  console.log(`🔧 NODE_ENV: ${process.env.NODE_ENV}`);

  // Executar seed de dados de teste
  console.log("🌱 Executando seed de dados de teste...");
  try {
    await seedTestData();
    console.log("✅ Seed concluído!");
  } catch (error) {
    console.error("❌ Erro ao executar seed:", error);
    throw error;
  }

  (globalThis as any).__SEED_DONE__ = true;
});

// Fechar conexões após todos os testes
afterAll(async () => {
  console.log("🧪 Finalizando ambiente de testes...");
  await closeDb();
});
