import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

const ACTIVE_INSTITUTION_KEY = "active_institution_id";

let activeInstitutionCache: number | null | undefined = undefined;

function parseInstitutionId(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

async function readStoredInstitutionId(): Promise<number | null> {
  const raw = await AsyncStorage.getItem(ACTIVE_INSTITUTION_KEY);
  return parseInstitutionId(raw);
}

export async function getActiveInstitutionId(): Promise<number | null> {
  if (activeInstitutionCache !== undefined) {
    return activeInstitutionCache;
  }
  const stored = await readStoredInstitutionId();
  activeInstitutionCache = stored;
  return stored;
}

export async function persistActiveInstitutionId(institutionId: number): Promise<void> {
  activeInstitutionCache = institutionId;
  await AsyncStorage.setItem(ACTIVE_INSTITUTION_KEY, String(institutionId));
}

export async function clearActiveInstitutionId(): Promise<void> {
  activeInstitutionCache = null;
  await AsyncStorage.removeItem(ACTIVE_INSTITUTION_KEY);
}

type TenantStateValue = {
  activeInstitutionId: number | null;
  isHydrating: boolean;
  setActiveInstitutionId: (institutionId: number) => Promise<void>;
  clearInstitutionSelection: () => Promise<void>;
};

const TenantStateContext = createContext<TenantStateValue | null>(null);

export function TenantStateProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();
  const [activeInstitutionId, setActiveInstitutionIdState] = useState<number | null>(null);
  const [isHydrating, setIsHydrating] = useState(true);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const stored = await getActiveInstitutionId();
        if (mounted) setActiveInstitutionIdState(stored);
      } finally {
        if (mounted) setIsHydrating(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const setActiveInstitutionId = useCallback(async (institutionId: number) => {
    // Tenant switch must always flush cached tenant-scoped queries to prevent visual data leak.
    queryClient.clear();
    await persistActiveInstitutionId(institutionId);
    setActiveInstitutionIdState(institutionId);
  }, [queryClient]);

  const clearInstitutionSelection = useCallback(async () => {
    queryClient.clear();
    await clearActiveInstitutionId();
    setActiveInstitutionIdState(null);
  }, [queryClient]);

  const value = useMemo<TenantStateValue>(
    () => ({
      activeInstitutionId,
      isHydrating,
      setActiveInstitutionId,
      clearInstitutionSelection,
    }),
    [activeInstitutionId, clearInstitutionSelection, isHydrating, setActiveInstitutionId],
  );

  return <TenantStateContext.Provider value={value}>{children}</TenantStateContext.Provider>;
}

export function useTenantState() {
  const ctx = useContext(TenantStateContext);
  if (!ctx) {
    throw new Error("useTenantState deve ser usado dentro de TenantStateProvider");
  }
  return ctx;
}
