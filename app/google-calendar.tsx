import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import {
  CalendarSync,
  CheckCircle2,
  CloudOff,
  TriangleAlert,
} from "lucide-react-native";

import { AppButton } from "@/components/ui/AppButton";
import { QueryErrorState } from "@/components/ui/QueryErrorState";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { SkeletonList } from "@/components/ui/Skeleton";
import { useActionFeedback } from "@/hooks/use-action-feedback";
import {
  EXTERNAL_LINK_STATES,
  type ExternalLinkState,
} from "@/lib/integration-providers";
import { theme } from "@/lib/theme";
import { trpc } from "@/lib/trpc";

/**
 * Vínculo da conta com o Google Agenda.
 *
 * Account-wide: a tela não lê instituição nem papel. O que ela mostra é o
 * estado do vínculo do usuário e o que ele pode fazer a respeito.
 *
 * A separação de autoridade aparece na copy, não só no código: o texto diz
 * explicitamente que editar no Google não muda a escala. Quem não lê o
 * contrato lê a tela.
 */

const STATUS_COPY: Record<
  string,
  { title: string; tone: "ok" | "warn" | "bad" }
> = {
  connected: { title: "Google Agenda conectado.", tone: "ok" },
  denied: { title: "Autorização cancelada. Nada mudou.", tone: "warn" },
  expired: { title: "O link expirou. Tente conectar de novo.", tone: "warn" },
  unavailable: {
    title: "A integração não está disponível nesta instalação.",
    tone: "bad",
  },
  failed: { title: "Não foi possível concluir a conexão.", tone: "bad" },
};

function deviceTimeZone(): string {
  try {
    return (
      Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo"
    );
  } catch {
    return "America/Sao_Paulo";
  }
}

function StateBadge({ state }: { state: ExternalLinkState }) {
  const visual = {
    CONNECTED: {
      Icon: CheckCircle2,
      color: theme.colors.success,
      background: theme.colors.successSoft,
      label: "Conectado",
    },
    DEGRADED: {
      Icon: TriangleAlert,
      color: theme.colors.warning,
      background: theme.colors.warningSoft,
      label: "Instável",
    },
    REAUTH_REQUIRED: {
      Icon: TriangleAlert,
      color: theme.colors.danger,
      background: theme.colors.dangerSoft,
      label: "Reconexão necessária",
    },
    DISCONNECTED: {
      Icon: CloudOff,
      color: theme.colors.textSecondary,
      background: theme.colors.surfaceAlt,
      label: "Desconectado",
    },
  }[state];

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: theme.space[2],
        paddingHorizontal: theme.space[3],
        paddingVertical: theme.space[2],
        borderRadius: theme.radius.full,
        backgroundColor: visual.background,
      }}
    >
      <visual.Icon size={16} color={visual.color} />
      <Text
        style={{
          fontSize: theme.text.body.fontSize,
          fontWeight: "600",
          color: visual.color,
        }}
      >
        {visual.label}
      </Text>
    </View>
  );
}

export default function GoogleCalendarScreen() {
  const params = useLocalSearchParams<{ status?: string }>();
  const feedback = useActionFeedback();
  const utils = trpc.useUtils();
  const timeZone = useMemo(deviceTimeZone, []);
  const [announced, setAnnounced] = useState(false);

  const statusQuery = trpc.googleCalendar.status.useQuery(undefined, {
    staleTime: 10_000,
  });

  // O callback devolve o resultado na query string. Anunciar uma vez só:
  // repetir a cada render viraria toast em loop.
  useEffect(() => {
    const outcome = params.status;
    if (!outcome || announced) return;
    setAnnounced(true);
    const copy = STATUS_COPY[outcome];
    if (!copy) return;
    if (copy.tone === "ok") {
      feedback.success(copy.title);
      statusQuery.refetch();
    } else {
      feedback.error(copy.title);
    }
  }, [params.status, announced, feedback, statusQuery]);

  const startLink = trpc.googleCalendar.startLink.useMutation({
    onSuccess: async (data) => {
      if (Platform.OS === "web") {
        window.location.assign(data.authorizationUrl);
        return;
      }
      const result = await WebBrowser.openAuthSessionAsync(
        data.authorizationUrl,
        "escalas://google-calendar",
      );
      if (result.type === "success") {
        await utils.googleCalendar.status.invalidate();
      }
    },
    onError: (error) => feedback.error(error.message),
  });

  const disconnect = trpc.googleCalendar.disconnect.useMutation({
    onSuccess: async (result) => {
      await utils.googleCalendar.status.invalidate();
      feedback.success(
        result.revoked
          ? "Conta desvinculada e autorização revogada no Google."
          : "Conta desvinculada.",
      );
    },
    onError: (error) => feedback.error(error.message),
  });

  const syncNow = trpc.googleCalendar.syncNow.useMutation({
    onSuccess: async (result) => {
      await utils.googleCalendar.status.invalidate();
      const touched = result.created + result.updated + result.deleted;
      // Zero mudanças tem dois significados, e só um é "em dia": sem nada na
      // janela de 92 dias, a mensagem certa é dizer que não havia o que
      // exportar — senão o usuário procura no Google um evento que nunca
      // existiu e conclui que o vínculo está quebrado.
      const imported = result.importedCreated + result.importedUpdated;
      feedback.success(
        imported > 0
          ? `${imported} compromisso${imported === 1 ? "" : "s"} do seu Google ${imported === 1 ? "entrou" : "entraram"} na sua agenda.`
          : result.considered === 0
            ? "Nada para exportar ainda: você não tem plantões nem compromissos nos próximos 92 dias."
            : touched === 0
              ? "Tudo já estava em dia."
              : `Sincronizado: ${result.created} criados, ${result.updated} atualizados, ${result.deleted} removidos.`,
      );
    },
    onError: (error) => feedback.error(error.message),
  });

  const handleDisconnect = useCallback(async () => {
    const confirmed = await feedback.confirmDestructive(
      "Desvincular Google Agenda",
      "Os eventos já exportados permanecem na sua conta do Google. O Escala+ deixa de criar e atualizar eventos.",
      "Desvincular",
    );
    if (!confirmed) return;
    disconnect.mutate();
  }, [feedback, disconnect]);

  if (statusQuery.isLoading) {
    return (
      <ScreenGradient>
        <ScreenContainer>
          <SkeletonList count={3} />
        </ScreenContainer>
      </ScreenGradient>
    );
  }

  if (statusQuery.isError) {
    return (
      <ScreenGradient>
        <ScreenContainer>
          <QueryErrorState
            title="Não foi possível carregar o vínculo"
            error={statusQuery.error}
            onRetry={() => {
              statusQuery.refetch();
            }}
          />
        </ScreenContainer>
      </ScreenGradient>
    );
  }

  const status = statusQuery.data;
  const busy = startLink.isPending || disconnect.isPending || syncNow.isPending;

  return (
    <ScreenGradient scrollable>
      <ScreenContainer>
        <View style={{ gap: theme.space[5], paddingBottom: theme.space[10] }}>
          <View style={{ gap: theme.space[2] }}>
            <Text
              style={{
                fontSize: theme.text.titleLg.fontSize,
                fontWeight: "700",
                color: theme.colors.textPrimary,
              }}
            >
              Google Agenda
            </Text>
            <Text
              style={{
                fontSize: theme.text.body.fontSize,
                lineHeight: theme.text.body.lineHeight,
                color: theme.colors.textSecondary,
              }}
            >
              Seus plantões e compromissos aparecem num calendário dedicado
              chamado &quot;Escala+&quot; na sua conta do Google. E os
              compromissos do seu calendário principal do Google entram na sua
              agenda aqui — para editar ou apagar, use o Google; o Escala+
              acompanha.
            </Text>
          </View>

          {!status?.available ? (
            <View
              style={{
                gap: theme.space[2],
                padding: theme.space[4],
                borderRadius: theme.radius.lg,
                backgroundColor: theme.colors.surfaceAlt,
                borderWidth: 1,
                borderColor: theme.colors.border,
              }}
            >
              <Text
                style={{
                  fontSize: theme.text.bodyLg.fontSize,
                  fontWeight: "600",
                  color: theme.colors.textPrimary,
                }}
              >
                Ainda não disponível
              </Text>
              <Text
                style={{
                  fontSize: theme.text.body.fontSize,
                  color: theme.colors.textSecondary,
                }}
              >
                A integração com o Google não está habilitada nesta instalação.
                Fale com quem administra o Escala+.
              </Text>
            </View>
          ) : (
            <>
              <StateBadge state={status.linkState as ExternalLinkState} />

              {status.accountLabel ? (
                <Text
                  style={{
                    fontSize: theme.text.body.fontSize,
                    color: theme.colors.textSecondary,
                  }}
                >
                  Conta: {status.accountLabel}
                </Text>
              ) : null}

              {status.lastSyncedAt ? (
                <Text
                  style={{
                    fontSize: theme.text.caption.fontSize,
                    color: theme.colors.textMuted,
                  }}
                >
                  Última sincronização:{" "}
                  {new Date(status.lastSyncedAt).toLocaleString("pt-BR")}
                </Text>
              ) : null}

              {status.linkState === EXTERNAL_LINK_STATES.degraded ? (
                <Text
                  style={{
                    fontSize: theme.text.body.fontSize,
                    color: theme.colors.warning,
                    fontWeight: "600",
                  }}
                >
                  O Google não respondeu nas últimas tentativas. Continuamos
                  tentando — você não precisa fazer nada.
                </Text>
              ) : null}

              {status.linkState === EXTERNAL_LINK_STATES.reauthRequired ? (
                <Text
                  style={{
                    fontSize: theme.text.body.fontSize,
                    color: theme.colors.danger,
                    fontWeight: "600",
                  }}
                >
                  O Google pediu uma nova autorização. Reconecte para voltar a
                  sincronizar.
                </Text>
              ) : null}

              <View
                style={{
                  gap: theme.space[2],
                  padding: theme.space[4],
                  borderRadius: theme.radius.lg,
                  backgroundColor: theme.colors.surface,
                  borderWidth: 1,
                  borderColor: theme.colors.border,
                }}
              >
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: theme.space[2],
                  }}
                >
                  <CalendarSync size={18} color={theme.colors.textSecondary} />
                  <Text
                    style={{
                      fontSize: theme.text.titleSm.fontSize,
                      fontWeight: "600",
                      color: theme.colors.textPrimary,
                    }}
                  >
                    Como funciona
                  </Text>
                </View>
                <Text
                  style={{
                    fontSize: theme.text.body.fontSize,
                    lineHeight: theme.text.body.lineHeight,
                    color: theme.colors.textSecondary,
                  }}
                >
                  Plantões vão para o Google só de ida: editar ou apagar o
                  evento lá{" "}
                  <Text style={{ fontWeight: "700" }}>
                    não altera sua escala
                  </Text>
                  . O título leva setor e hospital, nunca informação de
                  paciente.
                </Text>
              </View>

              {status.linkState === EXTERNAL_LINK_STATES.disconnected ? (
                <AppButton
                  title={
                    startLink.isPending ? "Abrindo…" : "Conectar Google Agenda"
                  }
                  onPress={() =>
                    startLink.mutate({
                      returnTarget: Platform.OS === "web" ? "WEB" : "MOBILE",
                    })
                  }
                  variant="primary"
                  fullWidth
                  disabled={busy}
                />
              ) : (
                <>
                  <AppButton
                    title={
                      syncNow.isPending ? "Sincronizando…" : "Sincronizar agora"
                    }
                    onPress={() => syncNow.mutate({ timeZone })}
                    variant="primary"
                    fullWidth
                    disabled={busy}
                  />
                  {status.needsUserAction ? (
                    <AppButton
                      title="Reconectar"
                      onPress={() =>
                        startLink.mutate({
                          returnTarget:
                            Platform.OS === "web" ? "WEB" : "MOBILE",
                        })
                      }
                      variant="secondary"
                      fullWidth
                      disabled={busy}
                    />
                  ) : null}
                  <AppButton
                    title="Desvincular"
                    onPress={handleDisconnect}
                    variant="ghost"
                    fullWidth
                    disabled={busy}
                  />
                </>
              )}
            </>
          )}
        </View>
      </ScreenContainer>
    </ScreenGradient>
  );
}
