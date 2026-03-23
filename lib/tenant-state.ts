import { Platform } from "react-native";
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

type AsyncStorageLike = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
};

async function getNativeStorage(): Promise<AsyncStorageLike | null> {
  const globalStorage = (globalThis as any)?.AsyncStorage as AsyncStorageLike | undefined;
  if (globalStorage?.getItem) return globalStorage;

  try {
    const mod = await import("@react-native-async-storage/async-storage");
    return mod.default as AsyncStorageLike;
  } catch {
    return null;
  }
}

export async function getActiveInstitutionId(): Promise<number | null> {
  if (Platform.OS === "web") {
    try {
      const raw = globalThis.localStorage?.getItem(TENANT_KEY);
      const value = raw ? Number(raw) : NaN;
      return Number.isInteger(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  const storage = await getNativeStorage();
  if (!storage) return null;
  try {
    const raw = await storage.getItem(TENANT_KEY);
    const value = raw ? Number(raw) : NaN;
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function setActiveInstitutionId(id: number): Promise<void> {
  const stringId = String(id);
  if (Platform.OS === "web") {
    try {
      globalThis.localStorage?.setItem(TENANT_KEY, stringId);
    } catch {
      // ignore storage errors in web private mode
    }
    return;
  }

  const storage = await getNativeStorage();
  if (!storage) return;
  try {
    await storage.setItem(TENANT_KEY, stringId);
  } catch {
    // ignore storage errors
  }
}

export async function clearActiveInstitutionId(): Promise<void> {
  if (Platform.OS === "web") {
    try {
      globalThis.localStorage?.removeItem(TENANT_KEY);
    } catch {
      // ignore storage errors in web private mode
    }
    return;
  }

  const storage = await getNativeStorage();
  if (!storage) return;
  try {
    await storage.removeItem(TENANT_KEY);
  } catch {
    // ignore storage errors
  }
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
    await setActiveInstitutionId(id);
    setActiveInstitutionIdState(id);
  }, []);

  const clearInstitutionSelection = useCallback(async () => {
    await clearActiveInstitutionId();
    setActiveInstitutionIdState(null);
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
