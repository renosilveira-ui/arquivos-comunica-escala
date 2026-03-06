/**
 * Testes unitários para integrationts
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  enqueue,
  loadQueue,
  markSuccess,
  markError,
  markFatalError,
  getPendingItems,
  isDebounced,
  recordDebounce,
  clearQueue,
  clearDebounce,
} from "../lib/integrationQueue";

describe("integrationQueue", () => {
  beforeEach(async () => {
    // Limpar fila antes de cada teste
    await clearQueue();
    await clearDebounce();
  });

  it("deve enfileirar item e retornar ID", async () => {
    const payload = { test: "data" };
    const id = await enqueue("syncUser", payload);
    
    expect(id).toBeDefined();
    expect(id).toContain("syncUser_");
  });

  it("deve carregar fila vazia inicialmente", async () => {
    const queue = await loadQueue();
    expect(queue).toEqual([]);
  });

  it("deve salvar e carregar fila corretamente", async () => {
    const id1 = await enqueue("syncUser", { userId: 1 });
    const id2 = await enqueue("startShift", { shiftId: 1 });
    
    const queue = await loadQueue();
    expect(queue.length).toBe(2);
    expect(queue[0].type).toBe("syncUser");
    expect(queue[1].type).toBe("startShift");
  });

  it("deve marcar item como sucesso", async () => {
    const id = await enqueue("syncUser", { userId: 1 });
    await markSuccess(id);
    
    const queue = await loadQueue();
    const item = queue.find(i => i.id === id);
    
    expect(item?.status).toBe("success");
    expect(item?.lastAttemptAt).toBeDefined();
  });

  it("deve marcar item como erro e agendar próxima tentativa", async () => {
    const id = await enqueue("syncUser", { userId: 1 });
    await markError(id, "Erro de teste", 0);
    
    const queue = await loadQueue();
    const item = queue.find(i => i.id === id);
    
    expect(item?.status).toBe("pending");
    expect(item?.attempts).toBe(1);
    expect(item?.lastError).toBe("Erro de teste");
    expect(item?.nextAttemptAt).toBeDefined();
  });

  it("deve marcar item como erro fatal", async () => {
    const id = await enqueue("syncUser", { userId: 1 });
    await markFatalError(id, "Erro fatal");
    
    const queue = await loadQueue();
    const item = queue.find(i => i.id === id);
    
    expect(item?.status).toBe("error");
    expect(item?.lastError).toBe("Erro fatal");
  });

  it("deve retornar itens pendentes em ordem de prioridade", async () => {
    await enqueue("endShift", { userId: 1 });
    await enqueue("syncUser", { userId: 1 });
    await enqueue("startShift", { shiftId: 1 });
    
    const pending = await getPendingItems();
    
    expect(pending.length).toBe(3);
    expect(pending[0].type).toBe("syncUser"); // Maior prioridade
    expect(pending[1].type).toBe("startShift");
    expect(pending[2].type).toBe("endShift"); // Menor prioridade
  });

  it("deve respeitar debounce", async () => {
    const isDebounced1 = await isDebounced("syncUser", "user123");
    expect(isDebounced1).toBe(false);
    
    await recordDebounce("syncUser", "user123");
    
    const isDebounced2 = await isDebounced("syncUser", "user123");
    expect(isDebounced2).toBe(true);
  });

  it("deve limitar tamanho da fila", async () => {
    // Enfileirar mais de 50 itens
    for (let i = 0; i < 60; i++) {
      await enqueue("syncUser", { userId: i });
    }
    
    const queue = await loadQueue();
    expect(queue.length).toBeLessThanOrEqual(50);
  });

  it("deve manter apenas últimos 20 itens success", async () => {
    // Enfileirar 30 itens e marcar todos como success
    for (let i = 0; i < 30; i++) {
      const id = await enqueue("syncUser", { userId: i });
      await markSuccess(id);
    }
    
    const queue = await loadQueue();
    const successItems = queue.filter(item => item.status === "success");
    
    expect(successItems.length).toBeLessThanOrEqual(20);
  });
});
