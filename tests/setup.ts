import { beforeAll, afterAll } from "vitest";
import { getDb } from "../server/db";
import { seedTestData } from "../server/seed-test-data";

// Setup global para testes
(global as any).__DEV__ = true;

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
  console.log("🧪 Iniciando ambiente de testes...");
  
  // Validar que estamos em ambiente de teste
  if (process.env.NODE_ENV !== "test") {
    console.warn("⚠️ NODE_ENV não é 'test', mas sim: " + process.env.NODE_ENV);
  }

  // Log explícito da conexão do banco
  const db = await getDb();
  if (!db) {
    throw new Error("❌ Database not available");
  }
  
  // Verificar qual banco está sendo usado
  const [result] = await db.execute("SELECT DATABASE() as db_name");
  const dbName = (result as any)[0]?.db_name || "unknown";
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
});

// Fechar conexões após todos os testes
afterAll(async () => {
  console.log("🧪 Finalizando ambiente de testes...");
  const db = await getDb();
  if (db) {
    await db.$client.end();
  }
});
