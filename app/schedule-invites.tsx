import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  Share,
  Text,
  View,
} from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { Surface } from "@/components/ui/Surface";
import { AppButton } from "@/components/ui/AppButton";
import { QueryErrorState } from "@/components/ui/QueryErrorState";
import { theme } from "@/lib/theme";
import { trpc } from "@/lib/trpc";
import { uiAlert } from "@/lib/ui/alert";

export default function ScheduleInvitesScreen() {
  const utils = trpc.useUtils();
  const scales = trpc.scheduleInvites.listManageableScales.useQuery();
  const active = trpc.scheduleInvites.listActive.useQuery();
  const create = trpc.scheduleInvites.create.useMutation();
  const revoke = trpc.scheduleInvites.revoke.useMutation();
  const [freshCode, setFreshCode] = useState<string | null>(null);
  const [freshLabel, setFreshLabel] = useState<string | null>(null);

  const handleCreate = async (hospitalId: number, sectorId: number) => {
    try {
      const created = await create.mutateAsync({ hospitalId, sectorId });
      setFreshCode(created.code);
      setFreshLabel(`${created.hospitalName} — ${created.sectorName}`);
      await utils.scheduleInvites.listActive.invalidate();
    } catch (error) {
      uiAlert(
        "Não foi possível gerar o convite",
        error instanceof Error ? error.message : "Tente novamente.",
      );
    }
  };

  const handleShare = async () => {
    if (!freshCode || !freshLabel) return;
    await Share.share({
      message: `Convite Escala+ para ${freshLabel}: ${freshCode}`,
    });
  };

  return (
    <ScreenGradient scrollable>
      <ScreenContainer>
        <Text
          style={{
            ...theme.text.title,
            fontWeight: theme.weight.bold,
            color: theme.colors.textPrimary,
            marginBottom: theme.space[2],
          }}
        >
          Convites da escala
        </Text>
        <Text
          style={{
            ...theme.text.body,
            color: theme.colors.textSecondary,
            marginBottom: theme.space[5],
          }}
        >
          Gere um código e envie aos médicos do seu setor. Eles se cadastram e
          colam o código. Um código vale por 14 dias e até 40 entradas.
        </Text>

        {freshCode ? (
          <Surface style={{ marginBottom: theme.space[5], padding: theme.space[4] }}>
            <Text style={{ ...theme.text.caption, color: theme.colors.textMuted }}>
              {freshLabel}
            </Text>
            <Text
              selectable
              style={{
                ...theme.text.title,
                fontWeight: theme.weight.bold,
                color: theme.colors.brand,
                marginVertical: theme.space[2],
                letterSpacing: 1,
              }}
            >
              {freshCode}
            </Text>
            <AppButton title="Enviar convite" onPress={handleShare} fullWidth />
          </Surface>
        ) : null}

        <Text
          style={{
            ...theme.text.titleSm,
            fontWeight: theme.weight.semibold,
            marginBottom: theme.space[2],
          }}
        >
          Suas escalas
        </Text>
        {scales.isLoading ? <ActivityIndicator color={theme.colors.primary} /> : null}
        {scales.isError ? (
          <QueryErrorState
            title="Não foi possível carregar suas escalas"
            onRetry={() => scales.refetch()}
          />
        ) : null}
        {!scales.isLoading && !scales.isError && (scales.data ?? []).length === 0 ? (
          <Text style={{ ...theme.text.body, color: theme.colors.textMuted }}>
            Você ainda não gerencia nenhuma escala. O coordenador precisa
            cadastrá-lo como gestor daquele setor.
          </Text>
        ) : null}
        {(scales.data ?? []).map((scale) => (
          <Pressable
            key={`${scale.hospitalId}:${scale.sectorId}`}
            onPress={() => handleCreate(scale.hospitalId, scale.sectorId)}
            disabled={create.isPending}
            style={{
              backgroundColor: theme.colors.surface,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: theme.colors.border,
              padding: theme.space[4],
              marginBottom: theme.space[2],
              opacity: create.isPending ? 0.7 : 1,
            }}
          >
            <Text style={{ fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>
              {scale.hospitalName} — {scale.sectorName}
            </Text>
            <Text style={{ ...theme.text.caption, color: theme.colors.textMuted }}>
              Toque para gerar um convite
            </Text>
          </Pressable>
        ))}

        <Text
          style={{
            ...theme.text.titleSm,
            fontWeight: theme.weight.semibold,
            marginTop: theme.space[5],
            marginBottom: theme.space[2],
          }}
        >
          Convites ativos
        </Text>
        {active.isError ? (
          <QueryErrorState
            title="Não foi possível carregar os convites ativos"
            onRetry={() => active.refetch()}
          />
        ) : null}
        {!active.isLoading && !active.isError && (active.data ?? []).length === 0 ? (
          <Text style={{ ...theme.text.body, color: theme.colors.textMuted }}>
            Nenhum convite ativo. Gere um acima e envie aos médicos.
          </Text>
        ) : null}
        {(active.data ?? []).map((invite) => (
          <View
            key={invite.id}
            style={{
              backgroundColor: theme.colors.surface,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: theme.colors.border,
              padding: theme.space[4],
              marginBottom: theme.space[2],
            }}
          >
            <Text style={{ fontWeight: theme.weight.semibold }}>
              {invite.hospitalName} — {invite.sectorName}
            </Text>
            <Text style={{ ...theme.text.caption, color: theme.colors.textMuted }}>
              {invite.redeemedCount}/{invite.maxRedemptions} usados · válido até{" "}
              {new Date(invite.expiresAt).toLocaleDateString("pt-BR")}
            </Text>
            <AppButton
              title="Encerrar convite"
              variant="danger"
              onPress={() =>
                revoke
                  .mutateAsync({ inviteId: invite.id })
                  .then(() => utils.scheduleInvites.listActive.invalidate())
              }
              size="md"
              disabled={revoke.isPending}
              style={{ marginTop: theme.space[2], alignSelf: "flex-start" }}
            />
          </View>
        ))}
      </ScreenContainer>
    </ScreenGradient>
  );
}
