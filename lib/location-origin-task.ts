import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { serialize } from "superjson";

import { apiFetch } from "./_core/api";
import { MIN_MOVEMENT_METERS } from "./integration-providers";
import { shouldReport, type ReportedPoint } from "./location-origin";

/**
 * Ponto de partida informado pelo próprio aparelho, inclusive com o app
 * fechado.
 *
 * ## Por que uma tarefa registrada no topo do módulo
 *
 * O sistema operacional acorda o processo do app sem passar pela árvore
 * React: não existe hook, contexto nem tela nesse momento. A tarefa precisa
 * estar registrada no carregamento do módulo, e falar com o servidor por uma
 * função comum — `apiFetch`, o mesmo caminho autenticado que o resto do app
 * usa.
 *
 * ## O que esta tarefa NÃO faz
 *
 * Não acumula histórico. Guarda localmente só o último ponto enviado, para
 * decidir se o próximo vale a viagem, e o servidor guarda só o atual. Saber
 * por onde um médico andou não é necessário para dizer a que horas ele deve
 * sair de casa, e seria um compromisso de privacidade completamente
 * diferente.
 */

export const LOCATION_ORIGIN_TASK = "escala-plus-location-origin";

/** Último ponto ENVIADO. Existe para evitar rede, não para registrar trajeto. */
const LAST_SENT_KEY = "escala-plus:last-sent-origin";

async function readLastSent(): Promise<ReportedPoint | null> {
  try {
    const raw = await AsyncStorage.getItem(LAST_SENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReportedPoint>;
    if (
      typeof parsed.latitude !== "number" ||
      typeof parsed.longitude !== "number"
    ) {
      return null;
    }
    return {
      latitude: parsed.latitude,
      longitude: parsed.longitude,
      accuracyMeters:
        typeof parsed.accuracyMeters === "number"
          ? parsed.accuracyMeters
          : null,
    };
  } catch {
    return null;
  }
}

async function rememberLastSent(point: ReportedPoint): Promise<void> {
  try {
    await AsyncStorage.setItem(LAST_SENT_KEY, JSON.stringify(point));
  } catch {
    // Perder o cache local só significa uma ida a mais ao servidor, que faz a
    // mesma checagem. Não é motivo para falhar a tarefa.
  }
}

/** Limpa o rastro local ao desligar o recurso. */
export async function forgetLastSentOrigin(): Promise<void> {
  try {
    await AsyncStorage.removeItem(LAST_SENT_KEY);
  } catch {
    // Idem.
  }
}

/**
 * Envia o ponto pelo mesmo contrato tRPC que a tela usa.
 *
 * Escrito à mão porque aqui não existe React: o cliente tRPC do app vive
 * dentro de um provider. O formato (`superjson` + envelope `json`) é o mesmo
 * que o `httpBatchLink` produz — divergir dele faria o servidor recusar.
 */
export async function sendCurrentOrigin(
  point: ReportedPoint,
): Promise<boolean> {
  const result = await apiFetch<unknown>(
    "/api/trpc/departure.reportCurrentLocation",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(serialize(point)),
    },
  );
  return result.ok;
}

export async function reportPoint(point: ReportedPoint): Promise<boolean> {
  const previous = await readLastSent();
  const decision = shouldReport({ previous, next: point });
  if (!decision.send) return false;
  const sent = await sendCurrentOrigin(point);
  if (sent) await rememberLastSent(point);
  return sent;
}

// Registro no carregamento do módulo: quando o sistema acorda o app, não há
// componente montado para fazer isso.
if (Platform.OS !== "web" && !TaskManager.isTaskDefined(LOCATION_ORIGIN_TASK)) {
  TaskManager.defineTask(LOCATION_ORIGIN_TASK, async ({ data, error }) => {
    if (error) return;
    const locations = (data as { locations?: Location.LocationObject[] })
      ?.locations;
    const latest = locations?.[locations.length - 1];
    if (!latest) return;
    await reportPoint({
      latitude: latest.coords.latitude,
      longitude: latest.coords.longitude,
      accuracyMeters: latest.coords.accuracy ?? null,
    });
  });
}

export async function startLocationOrigin(): Promise<void> {
  if (Platform.OS === "web") return;
  const already = await Location.hasStartedLocationUpdatesAsync(
    LOCATION_ORIGIN_TASK,
  ).catch(() => false);
  if (already) return;

  await Location.startLocationUpdatesAsync(LOCATION_ORIGIN_TASK, {
    // Precisão de quarteirão basta para calcular um trajeto de carro, e custa
    // uma fração da bateria de `High`. Pedir precisão de metro para decidir a
    // hora de sair de casa seria gastar bateria por nada.
    accuracy: Location.Accuracy.Balanced,
    distanceInterval: MIN_MOVEMENT_METERS,
    // Sem isto o iOS pausa as atualizações quando julga que a pessoa está
    // parada — e "parada em casa" é exatamente o estado em que o aviso
    // precisa do ponto.
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: false,
    foregroundService: {
      notificationTitle: "Escala+",
      notificationBody: "Calculando a hora de sair para o seu próximo plantão.",
      notificationColor: "#01304A",
    },
  });
}

export async function stopLocationOrigin(): Promise<void> {
  if (Platform.OS === "web") return;
  const started = await Location.hasStartedLocationUpdatesAsync(
    LOCATION_ORIGIN_TASK,
  ).catch(() => false);
  if (started) await Location.stopLocationUpdatesAsync(LOCATION_ORIGIN_TASK);
  await forgetLastSentOrigin();
}
