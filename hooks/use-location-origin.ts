import { useCallback, useEffect, useState } from "react";
import { Linking, Platform } from "react-native";
import * as Location from "expo-location";

import {
  LOCATION_ACCESS,
  locationGuidance,
  type LocationAccess,
  type LocationGuidance,
} from "@/lib/location-origin";
import {
  reportPoint,
  startLocationOrigin,
  stopLocationOrigin,
} from "@/lib/location-origin-task";

/**
 * Localização automática para o aviso de plantão.
 *
 * Traduz o estado das permissões do aparelho para o vocabulário do produto
 * (`LocationAccess`) e expõe as três ações que a tela precisa: ligar,
 * desligar, abrir ajustes. O texto de cada estado vem de `locationGuidance`,
 * que é puro e testado — este hook só faz a ponte com o sistema operacional.
 *
 * ## "Durante o uso" não basta, e a tela precisa dizer isso
 *
 * O aviso sai uma hora antes do plantão, com o app fechado. Permissão só
 * para "durante o uso" deixa a posição congelada na última vez que o app foi
 * aberto — e o iOS não permite pedir "sempre" sem antes conceder "durante o
 * uso". Por isso o pedido é em duas etapas, e o estado intermediário é
 * tratado como pendência, não como sucesso.
 *
 * ## Web
 *
 * Navegador não tem segundo plano. Na web o hook reporta a posição uma vez,
 * quando a tela abre, e o estado máximo é `FOREGROUND` — a tela explica que
 * o trânsito só entra pelo aparelho.
 */

type PermissionSnapshot = {
  foreground: Location.PermissionStatus;
  background: Location.PermissionStatus | null;
  canAskAgain: boolean;
};

function accessFrom(snapshot: PermissionSnapshot | null): LocationAccess {
  if (!snapshot) return LOCATION_ACCESS.unknown;
  if (snapshot.foreground === Location.PermissionStatus.DENIED) {
    return LOCATION_ACCESS.denied;
  }
  if (snapshot.foreground !== Location.PermissionStatus.GRANTED) {
    return LOCATION_ACCESS.unknown;
  }
  if (snapshot.background === Location.PermissionStatus.GRANTED) {
    return LOCATION_ACCESS.always;
  }
  return LOCATION_ACCESS.foreground;
}

async function readPermissions(): Promise<PermissionSnapshot> {
  const foreground = await Location.getForegroundPermissionsAsync();
  if (Platform.OS === "web") {
    return {
      foreground: foreground.status,
      background: null,
      canAskAgain: foreground.canAskAgain,
    };
  }
  const background = await Location.getBackgroundPermissionsAsync();
  return {
    foreground: foreground.status,
    background: background.status,
    canAskAgain: foreground.canAskAgain,
  };
}

/** Uma leitura de posição, para o primeiro ponto valer já — sem esperar o SO. */
async function reportOnce(): Promise<void> {
  try {
    const position = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    await reportPoint({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyMeters: position.coords.accuracy ?? null,
    });
  } catch {
    // Sem sinal agora não é erro de produto: o próximo ponto chega quando
    // houver. A tela já diz o que acontece sem localização.
  }
}

export type LocationOriginState = {
  access: LocationAccess;
  guidance: LocationGuidance;
  busy: boolean;
  /** Ligar: pede as permissões e começa a informar a posição. */
  enable: () => Promise<void>;
  /** Desligar: para de informar e chama o descarte do ponto guardado. */
  disable: () => Promise<void>;
  openSettings: () => Promise<void>;
  refresh: () => Promise<void>;
};

export function useLocationOrigin(options: {
  /** Chamado ao desligar: a tela apaga a origem automática no servidor. */
  onDisabled?: () => Promise<void> | void;
}): LocationOriginState {
  const [snapshot, setSnapshot] = useState<PermissionSnapshot | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await readPermissions());
    } catch {
      setSnapshot(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const access = accessFrom(snapshot);

  // Já autorizado: garante que a tarefa está de pé (reinstalação, reboot) e
  // manda um ponto agora. Não pergunta nada — a permissão já foi dada.
  useEffect(() => {
    if (access === LOCATION_ACCESS.always) {
      void startLocationOrigin().catch(() => undefined);
      void reportOnce();
    } else if (access === LOCATION_ACCESS.foreground) {
      void reportOnce();
    }
  }, [access]);

  const enable = useCallback(async () => {
    setBusy(true);
    try {
      const foreground = await Location.requestForegroundPermissionsAsync();
      if (foreground.status !== Location.PermissionStatus.GRANTED) return;
      if (Platform.OS !== "web") {
        // Só depois do "durante o uso" o sistema aceita pedir "sempre".
        const background = await Location.requestBackgroundPermissionsAsync();
        if (background.status === Location.PermissionStatus.GRANTED) {
          await startLocationOrigin();
        }
      }
      await reportOnce();
    } catch {
      // A tela reflete o estado real via refresh(); não há o que explicar
      // além do que ela já explica.
    } finally {
      await refresh();
      setBusy(false);
    }
  }, [refresh]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      await stopLocationOrigin();
      await options.onDisabled?.();
    } finally {
      await refresh();
      setBusy(false);
    }
  }, [options, refresh]);

  const openSettings = useCallback(async () => {
    try {
      await Linking.openSettings();
    } catch {
      // Sem tela de ajustes (web): a orientação de texto já cobre.
    }
  }, []);

  return {
    access,
    guidance: locationGuidance(access),
    busy,
    enable,
    disable,
    openSettings,
    refresh,
  };
}
