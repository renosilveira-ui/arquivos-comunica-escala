import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const TENANT_KEY = "activeInstitutionId";

/**
 * Fonte IMEDIATA do tenant ativo, em memória de módulo.
 *
 * O storage (AsyncStorage/localStorage) é só PERSISTÊNCIA entre
 * sessões — nunca o caminho crítico de um request. A versão anterior
 * lia o AsyncStorage via import dinâmico com fallback silencioso a
 * cada request: quando esse import falhava no build de produção, a
 * escolha da instituição "gravava" no ar (set silenciosamente perdido)
 * e todo request saía SEM x-tenant-id — o servidor caía na primeira
 * instituição do usuário e telas como a Agenda vinham vazias, sem
 * nenhum erro. Também explicava o app "esquecer" a instituição ao
 * reabrir. Com a variável de módulo, trocar de instituição passa a
 * valer instantaneamente para todos os requests da sessão, mesmo que
 * a persistência falhe (pior caso: pede a instituição de novo no
 * próximo cold start).
 */
let inMemoryTenantId: number | null = null;
let hydratedFromStorage = false;
let inMemoryTenantRevision = 0;

export type ActiveTenantSnapshot = Readonly<{
  institutionId: number | null;
  revision: number;
}>;

/**
 * Snapshot síncrono usado imediatamente antes de efeitos de navegação.
 * A revisão também detecta ABA (A → B → A) durante uma operação assíncrona.
 */
export function getActiveTenantSnapshot(): ActiveTenantSnapshot {
  return {
    institutionId: inMemoryTenantId,
    revision: inMemoryTenantRevision,
  };
}

async function persistTenantSnapshot(snapshot: ActiveTenantSnapshot): Promise<void> {
  try {
    if (Platform.OS === "web") {
      if (snapshot.institutionId === null) {
        globalThis.localStorage?.removeItem(TENANT_KEY);
      } else {
        globalThis.localStorage?.setItem(TENANT_KEY, String(snapshot.institutionId));
      }
    } else if (snapshot.institutionId === null) {
      await AsyncStorage.removeItem(TENANT_KEY);
    } else {
      await AsyncStorage.setItem(TENANT_KEY, String(snapshot.institutionId));
    }
  } catch {
    // Uma escrita antiga pode ter sido aplicada antes de rejeitar. Se já ficou
    // stale, regrava o snapshot vivo; falha do snapshot atual é best-effort.
    const current = getActiveTenantSnapshot();
    if (current.revision !== snapshot.revision) {
      await persistTenantSnapshot(current);
    }
    return;
  }

  // AsyncStorage não oferece CAS. Uma escrita A pode terminar depois de B ou
  // clear e sobrescrever a persistência mais nova. A revisão transforma esse
  // término tardio em uma reconciliação, sem bloquear memória, React ou rota.
  const current = getActiveTenantSnapshot();
  if (current.revision !== snapshot.revision) {
    await persistTenantSnapshot(current);
  }
}

function parseStored(raw: string | null | undefined): number | null {
  const value = raw ? Number(raw) : NaN;
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function readFromStorage(): Promise<number | null> {
  try {
    if (Platform.OS === "web") {
      return parseStored(globalThis.localStorage?.getItem(TENANT_KEY));
    }
    return parseStored(await AsyncStorage.getItem(TENANT_KEY));
  } catch {
    return null;
  }
}

export async function getActiveInstitutionId(): Promise<number | null> {
  if (inMemoryTenantId !== null) return inMemoryTenantId;
  if (!hydratedFromStorage) {
    hydratedFromStorage = true;
    const revisionBeforeRead = inMemoryTenantRevision;
    const storedTenantId = await readFromStorage();
    // Uma escolha/limpeza concorrente é mais nova que o storage lido.
    if (inMemoryTenantRevision === revisionBeforeRead) {
      inMemoryTenantId = storedTenantId;
      inMemoryTenantRevision += 1;
    }
  }
  return inMemoryTenantId;
}

export async function setActiveInstitutionId(id: number): Promise<void> {
  // Memória primeiro: a troca vale AGORA, independente da persistência.
  inMemoryTenantId = id;
  hydratedFromStorage = true;
  inMemoryTenantRevision += 1;
  await persistTenantSnapshot(getActiveTenantSnapshot());
}

export async function clearActiveInstitutionId(): Promise<void> {
  inMemoryTenantId = null;
  hydratedFromStorage = true;
  inMemoryTenantRevision += 1;
  await persistTenantSnapshot(getActiveTenantSnapshot());
}

type TenantStateValue = {
  activeInstitutionId: number | null;
  isHydrating: boolean;
  setActiveInstitutionId: (id: number) => Promise<void>;
  clearInstitutionSelection: () => Promise<void>;
};

const TenantStateContext = createContext<TenantStateValue | null>(null);

export function TenantStateProvider({ children }: { children: ReactNode }) {
  const [activeInstitutionIdState, setActiveInstitutionIdState] = useState<number | null>(null);
  const [isHydrating, setIsHydrating] = useState(true);

  useEffect(() => {
    let mounted = true;
    getActiveInstitutionId()
      .then((id) => {
        if (mounted) setActiveInstitutionIdState(id);
      })
      .finally(() => {
        if (mounted) setIsHydrating(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const setActiveInstitutionIdFn = useCallback(async (id: number) => {
    // A aplicação da escolha (memória + revisão + React) é síncrona. Storage é
    // só persistência best-effort e nunca mantém navegação ou fila em espera.
    const persistence = setActiveInstitutionId(id);
    setActiveInstitutionIdState(id);
    void persistence.catch(() => undefined);
  }, []);

  const clearInstitutionSelection = useCallback(async () => {
    const persistence = clearActiveInstitutionId();
    setActiveInstitutionIdState(null);
    void persistence.catch(() => undefined);
  }, []);

  const value = useMemo<TenantStateValue>(
    () => ({
      activeInstitutionId: activeInstitutionIdState,
      isHydrating,
      setActiveInstitutionId: setActiveInstitutionIdFn,
      clearInstitutionSelection,
    }),
    [activeInstitutionIdState, clearInstitutionSelection, isHydrating, setActiveInstitutionIdFn],
  );

  return createElement(TenantStateContext.Provider, { value }, children);
}

export function useTenantState(): TenantStateValue {
  const ctx = useContext(TenantStateContext);
  if (!ctx) {
    throw new Error("useTenantState must be used within TenantStateProvider");
  }
  return ctx;
}
