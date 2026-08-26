import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
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
  const [selectedScale, setSelectedScale] = useState<{
    hospitalId: number;
    sectorId: number;
    label: string;
  } | null>(null);
  const [nameSearch, setNameSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>([]);

  const appliedLooksLikeEmail = appliedSearch.includes("@");
  const candidates = trpc.scheduleInvites.listCandidates.useQuery(
    selectedScale
      ? {
          hospitalId: selectedScale.hospitalId,
          sectorId: selectedScale.sectorId,
          name:
            appliedLooksLikeEmail || !appliedSearch
              ? undefined
              : appliedSearch,
          email: appliedLooksLikeEmail ? appliedSearch : undefined,
        }
      : { hospitalId: 1, sectorId: 1 },
    { enabled: selectedScale !== null },
  );

  const toggleUser = (userId: number) => {
    setSelectedUserIds((current) =>
      current.includes(userId)
        ? current.filter((id) => id !== userId)
        : [...current, userId],
    );
  };

  const handleSend = async () => {
    if (!selectedScale || selectedUserIds.length === 0) {
      uiAlert("Convite", "Selecione pelo menos um médico.");
      return;
    }
    try {
      const result = await create.mutateAsync({
        hospitalId: selectedScale.hospitalId,
        sectorId: selectedScale.sectorId,
        userIds: selectedUserIds,
      });
      setSelectedUserIds([]);
      await Promise.all([
        utils.scheduleInvites.listActive.invalidate(),
        utils.scheduleInvites.listCandidates.invalidate(),
      ]);
      const failedNote =
        result.failed.length > 0
          ? ` ${result.failed.length} não saíram.`
          : "";
      uiAlert(
        "Convites enviados",
        `${result.sent.length} convite(s) de 24 horas saíram por e-mail.${failedNote}`,
      );
    } catch (error) {
      uiAlert(
        "Não foi possível enviar",
        error instanceof Error ? error.message : "Tente novamente.",
      );
    }
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
          Convite desta escala — hospital e setor que você selecionar abaixo.
          Quem criou conta e ainda espera uma escala já aparece na lista.
          Cada convite vale 24 horas, de uso único, no e-mail da conta.
        </Text>

        <Text
          style={{
            ...theme.text.titleSm,
            fontWeight: theme.weight.semibold,
            marginBottom: theme.space[2],
          }}
        >
          Sua escala
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
        {(scales.data ?? []).map((scale) => {
          const selected =
            selectedScale?.hospitalId === scale.hospitalId &&
            selectedScale?.sectorId === scale.sectorId;
          return (
            <Pressable
              key={`${scale.hospitalId}:${scale.sectorId}`}
              onPress={() => {
                setSelectedScale({
                  hospitalId: scale.hospitalId,
                  sectorId: scale.sectorId,
                  label: `${scale.hospitalName} — ${scale.sectorName}`,
                });
                setSelectedUserIds([]);
                setAppliedSearch("");
                setNameSearch("");
              }}
              style={{
                backgroundColor: theme.colors.surface,
                borderRadius: theme.radius.md,
                borderWidth: 1,
                borderColor: selected ? theme.colors.primary : theme.colors.border,
                padding: theme.space[4],
                marginBottom: theme.space[2],
                minHeight: 44,
              }}
            >
              <Text style={{ fontWeight: theme.weight.bold, color: theme.colors.textPrimary }}>
                {scale.hospitalName} — {scale.sectorName}
              </Text>
            </Pressable>
          );
        })}

        {selectedScale ? (
          <>
            <Text
              style={{
                ...theme.text.titleSm,
                fontWeight: theme.weight.semibold,
                marginTop: theme.space[5],
                marginBottom: theme.space[2],
              }}
            >
              Médicos para {selectedScale.label}
            </Text>
            <Text
              style={{
                ...theme.text.caption,
                color: theme.colors.textMuted,
                marginBottom: theme.space[2],
              }}
            >
              A sala de espera já está abaixo. Digite o nome para filtrar.
            </Text>
            <TextInput
              value={nameSearch}
              onChangeText={setNameSearch}
              autoCapitalize="words"
              autoCorrect={false}
              placeholder="Buscar por nome"
              placeholderTextColor={theme.colors.textMuted}
              style={{
                backgroundColor: theme.colors.surface,
                borderRadius: theme.radius.md,
                borderWidth: 1,
                borderColor: theme.colors.border,
                paddingHorizontal: theme.space[4],
                paddingVertical: theme.space[3],
                color: theme.colors.textPrimary,
                marginBottom: theme.space[2],
                minHeight: 44,
              }}
            />
            <AppButton
              title="Buscar por nome"
              variant="secondary"
              onPress={() => {
                setAppliedSearch(nameSearch.trim());
                setSelectedUserIds([]);
              }}
              style={{ marginBottom: theme.space[3], alignSelf: "flex-start" }}
            />
            {candidates.isLoading ? (
              <ActivityIndicator color={theme.colors.primary} />
            ) : null}
            {candidates.isError ? (
              <QueryErrorState
                title="Não foi possível carregar os médicos"
                onRetry={() => candidates.refetch()}
              />
            ) : null}
            {!candidates.isLoading &&
            !candidates.isError &&
            (candidates.data ?? []).length === 0 ? (
              <Text style={{ ...theme.text.body, color: theme.colors.textMuted }}>
                Nenhum médico elegível nesta lista. Confira se a especialidade
                combina com a escala ou refine a busca pelo nome.
              </Text>
            ) : null}
            {(candidates.data ?? []).map((candidate) => {
              const checked = selectedUserIds.includes(candidate.userId);
              return (
                <Pressable
                  key={candidate.userId}
                  onPress={() => toggleUser(candidate.userId)}
                  style={{
                    backgroundColor: theme.colors.surface,
                    borderRadius: theme.radius.md,
                    borderWidth: 1,
                    borderColor: checked ? theme.colors.primary : theme.colors.border,
                    padding: theme.space[4],
                    marginBottom: theme.space[2],
                    minHeight: 44,
                  }}
                >
                  <Text style={{ fontWeight: theme.weight.semibold, color: theme.colors.textPrimary }}>
                    {candidate.name ?? "Médico"}
                  </Text>
                  <Text style={{ ...theme.text.caption, color: theme.colors.textMuted }}>
                    {candidate.specialtyLabel ?? "Especialidade não informada"}
                    {checked ? " · selecionado" : ""}
                  </Text>
                </Pressable>
              );
            })}
            <AppButton
              title={
                create.isPending
                  ? "Enviando..."
                  : `Enviar convite (${selectedUserIds.length})`
              }
              onPress={() => {
                void handleSend();
              }}
              disabled={create.isPending || selectedUserIds.length === 0}
              fullWidth
              style={{ marginTop: theme.space[2] }}
            />
          </>
        ) : null}

        <Text
          style={{
            ...theme.text.titleSm,
            fontWeight: theme.weight.semibold,
            marginTop: theme.space[5],
            marginBottom: theme.space[2],
          }}
        >
          Convites enviados
        </Text>
        {active.isError ? (
          <QueryErrorState
            title="Não foi possível carregar os convites enviados"
            onRetry={() => active.refetch()}
          />
        ) : null}
        {!active.isLoading && !active.isError && (active.data ?? []).length === 0 ? (
          <Text style={{ ...theme.text.body, color: theme.colors.textMuted }}>
            Nenhum convite ativo. Selecione os médicos e envie o e-mail.
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
              {invite.invitedName ?? "Médico convidado"}
            </Text>
            <Text style={{ ...theme.text.caption, color: theme.colors.textMuted }}>
              {invite.hospitalName} — {invite.sectorName}
            </Text>
            <Text style={{ ...theme.text.caption, color: theme.colors.textMuted }}>
              {invite.redeemedCount >= invite.maxRedemptions
                ? "Já utilizado"
                : `Válido até ${new Date(invite.expiresAt).toLocaleString("pt-BR")}`}
            </Text>
            {invite.redeemedCount < invite.maxRedemptions ? (
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
            ) : null}
          </View>
        ))}
      </ScreenContainer>
    </ScreenGradient>
  );
}
