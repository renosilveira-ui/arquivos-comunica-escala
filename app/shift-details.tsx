import { useState, useEffect, type ReactNode } from "react";
import { Text, View, TouchableOpacity, ActivityIndicator, StyleSheet, useWindowDimensions, type ViewStyle } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { Badge } from "@/components/ui/Badge";
import { theme } from "@/lib/theme";
import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";
import { useRouter, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";
import { ChevronLeft, Clock, Calendar, Users, CheckCircle2, AlertCircle } from "lucide-react-native";
import { isDemoMode, DEMO_SHIFTS } from "@/lib/demo-mode";
import { formatDateBR } from "@/lib/datetime";

const ICON_BOX_SIZE = theme.space[10] + theme.space[2];
const PRIMARY_COLUMN_MIN_WIDTH = theme.spacing.contentMaxWidth / 2;
const SECONDARY_COLUMN_MIN_WIDTH = theme.spacing.contentMaxWidth / 3;
const FIELD_MIN_WIDTH = theme.spacing.contentMaxWidth / 6;
const ACTION_MIN_WIDTH = theme.spacing.contentMaxWidth / 5;

/**
 * Tela de Detalhes da Escala
 * Mostra informações completas da escala e lista de profissionais alocados
 */
export default function ShiftDetailsScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams();
  const { width } = useWindowDimensions();
  const shiftId = Number(params.id);
  const [isDemo, setIsDemo] = useState(false);

  // Verificar modo demo
  useEffect(() => {
    isDemoMode().then(setIsDemo);
  }, []);

  // Buscar detalhes da escala (API ou demo)
  const { data: apiShiftData, isLoading: apiLoading } = trpc.shifts.get.useQuery(
    { id: shiftId },
    { enabled: !!user?.id && !isDemo }
  );

  // Dados demo
  const demoShiftData = isDemo
    ? DEMO_SHIFTS.find((s) => s.shift.id === shiftId)
    : null;

  const shiftData: any = isDemo
    ? demoShiftData
      ? {
          shift: {
            ...demoShiftData.shift,
            startAt: demoShiftData.shift.startTime,
            endAt: demoShiftData.shift.endTime,
          },
          sector: demoShiftData.sector,
          assignments: (demoShiftData as any).assignments || [],
        }
      : null
    : apiShiftData
      ? {
          shift: apiShiftData,
          sector: {
            name: apiShiftData.sectorName,
            category: apiShiftData.sectorCategory,
            color: apiShiftData.sectorColor,
          },
          assignments: apiShiftData.assignments || [],
        }
      : null;

  const isLoading = isDemo ? false : apiLoading;

  const handleBack = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.back();
  };

  const handleConfirmPresence = () => {
    if (!user) return;
    if (isDemo) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      return; // Modo demo: apenas feedback visual
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // TODO: endpoint de confirmação de presença não existe no router tRPC atual.
    alert("Confirmação de presença ainda não disponível neste ambiente.");
  };

  const handleEdit = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/edit-shift?id=${shiftId}`);
  };

  if (!user && !isDemo) {
    return (
      <ScreenGradient scrollable={false}>
        <View className="flex-1 justify-center items-center">
          <Text className="text-lg" style={{ color: theme.colors.textMuted }}>Faça login para continuar</Text>
        </View>
      </ScreenGradient>
    );
  }

  if (isLoading) {
    return (
      <ScreenGradient scrollable={false}>
        <View className="flex-1 justify-center items-center gap-4">
          <ActivityIndicator size="large" color={theme.colors.primary} />
          <Text className="text-base" style={{ color: theme.colors.textMuted }}>Carregando detalhes...</Text>
        </View>
      </ScreenGradient>
    );
  }

  if (!shiftData?.shift) {
    return (
      <ScreenGradient scrollable={false}>
        <View className="flex-1 justify-center items-center gap-6">
          <AlertCircle size={64} color={theme.colors.textMuted} />
          <Text className="text-lg" style={{ color: theme.colors.textMuted }}>Escala não encontrada</Text>
          <TouchableOpacity
            onPress={handleBack}
            className="rounded-2xl px-8 h-14 justify-center"
            style={{ backgroundColor: theme.colors.primary }}
            activeOpacity={0.7}
          >
            <Text className="text-lg font-semibold" style={{ color: theme.colors.surface }}>Voltar</Text>
          </TouchableOpacity>
        </View>
      </ScreenGradient>
    );
  }

  const { shift, sector, assignments } = shiftData;
  const startDate = new Date(shift.startAt ?? shift.startTime);
  const endDate = new Date(shift.endAt ?? shift.endTime);

  // Verificar se usuário está alocado nesta escala
  const userAssignment = assignments?.find((a: any) => a.professionalId === user?.id || a.userId === user?.id);
  const isUserAssigned = !!userAssignment;

  // Campos de modalidade (PR #61): backend retorna direto no shift_instance.
  // Cast defensivo enquanto o tipo do retorno do tRPC ainda não infere todas as colunas.
  const shiftWithModality = shift as typeof shift & {
    modality?: "PLANTAO" | "SOBREAVISO" | null;
    coverageType?: "URGENCIA_EMERGENCIA" | "ELETIVAS" | null;
    paymentModel?:
      | "FIXO"
      | "FIXO_PRODUTIVIDADE_TETO"
      | "FIXO_PRODUTIVIDADE_SEM_TETO"
      | "PRODUTIVIDADE_PURA"
      | null;
    productivityCapBrl?: string | null;
  };
  const modality = shiftWithModality.modality ?? null;
  const coverageType = shiftWithModality.coverageType ?? null;
  const paymentModel = shiftWithModality.paymentModel ?? null;
  const productivityCapBrl = shiftWithModality.productivityCapBrl ?? null;

  const modalityLabel =
    modality === "PLANTAO" ? "Plantão" : modality === "SOBREAVISO" ? "Sobreaviso" : null;
  const coverageLabel =
    coverageType === "URGENCIA_EMERGENCIA"
      ? "Urgência / Emergência"
      : coverageType === "ELETIVAS"
        ? "Eletivas"
        : null;
  const paymentModelLabel =
    paymentModel === "FIXO"
      ? "Fixo"
      : paymentModel === "FIXO_PRODUTIVIDADE_TETO"
        ? "Fixo + produtividade (com teto)"
        : paymentModel === "FIXO_PRODUTIVIDADE_SEM_TETO"
          ? "Fixo + produtividade (sem teto)"
          : paymentModel === "PRODUTIVIDADE_PURA"
            ? "Produtividade pura"
            : null;
  const showCapacityCap =
    paymentModel === "FIXO_PRODUTIVIDADE_TETO" &&
    productivityCapBrl !== null &&
    productivityCapBrl !== "" &&
    Number.isFinite(Number(productivityCapBrl));
  const formattedCap = showCapacityCap
    ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
        Number(productivityCapBrl),
      )
    : null;
  const hasModalityInfo = !!(modalityLabel || paymentModelLabel);
  const statusVariant =
    (shift.status === "confirmada" || shift.status === "OCUPADO")
      ? "success"
      : shift.status === "cancelada"
        ? "critical"
        : shift.status === "VAGO"
          ? "neutral"
          : "warning";
  const statusLabel =
    (shift.status === "confirmada" || shift.status === "OCUPADO")
      ? "Confirmada"
      : shift.status === "cancelada"
        ? "Cancelada"
        : shift.status === "VAGO"
          ? "Vago"
          : "Pendente";
  const isWide = width >= theme.spacing.contentMaxWidth;
  const timeRange = `${startDate.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  })}–${endDate.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
  const durationHours = Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60));

  return (
    <ScreenGradient scrollable>
      <View style={styles.shell}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={handleBack}
            activeOpacity={0.7}
            style={styles.backButton}
          >
            <ChevronLeft size={28} color={theme.colors.textPrimary} />
          </TouchableOpacity>
          <View style={styles.headerText}>
            <Text style={styles.eyebrow}>Plantão</Text>
            <Text style={styles.title}>Detalhes da Escala</Text>
          </View>
        </View>

        <View style={styles.contentGrid}>
          <View style={styles.primaryColumn}>
            <TintedGlassCard variant="light" style={styles.summaryCard}>
              <View style={styles.summaryHeader}>
                <View style={styles.iconBox}>
                  <Calendar size={24} color={theme.colors.surface} />
                </View>
                <View style={styles.summaryText}>
                  <Text style={styles.label}>Setor</Text>
                  <Text style={styles.sectorTitle}>{sector?.name || "Não definido"}</Text>
                  {sector?.category ? (
                    <Text style={styles.subtleText}>{sector.category}</Text>
                  ) : null}
                </View>
                <View style={styles.statusWrap}>
                  <Badge variant={statusVariant}>{statusLabel}</Badge>
                </View>
              </View>

              <View style={styles.divider} />

              <View style={styles.fieldGrid}>
                <InfoTile label="Data" value={formatDateBR(startDate)} />
                <InfoTile label="Horário" value={timeRange} icon={<Clock size={18} color={theme.colors.textMuted} />} />
                <InfoTile label="Duração" value={`${durationHours} horas`} />
              </View>

              {hasModalityInfo && (
                <>
                  <View style={styles.divider} />
                  <View style={styles.sectionBlock}>
                    <Text style={styles.sectionTitle}>Modalidade</Text>
                    <View style={styles.modalityRow}>
                      {modalityLabel ? <Badge variant="primary">{modalityLabel}</Badge> : null}
                      {modality === "PLANTAO" && coverageLabel ? (
                        <Text style={styles.bodyText}>{coverageLabel}</Text>
                      ) : null}
                    </View>
                    {paymentModelLabel ? (
                      <InfoLine label="Modelo de pagamento" value={paymentModelLabel} />
                    ) : null}
                    {formattedCap ? (
                      <InfoLine label="Teto" value={formattedCap} />
                    ) : null}
                  </View>
                </>
              )}

              {shift.notes ? (
                <>
                  <View style={styles.divider} />
                  <InfoLine label="Observações" value={shift.notes} />
                </>
              ) : null}
            </TintedGlassCard>

            <View style={styles.actionPanel}>
              {shift.status !== "cancelada" && shift.status !== "VAGO" && user ? (
                <ActionButton
                  label="Confirmar Presença"
                  onPress={handleConfirmPresence}
                  icon={<CheckCircle2 size={20} color={theme.colors.surface} />}
                  variant="success"
                />
              ) : null}

              {shift.status !== "cancelada" ? (
                <View style={styles.actionRow}>
                  <ActionButton label="Editar Escala" onPress={handleEdit} variant="secondary" />
                  <ActionButton
                    label="Solicitar Troca de Plantão"
                    onPress={() => {
                      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      router.push(`/request-swap?id=${shiftId}`);
                    }}
                    variant="primarySoft"
                  />
                  {isUserAssigned && !userAssignment?.confirmedAt && !userAssignment?.confirmed ? (
                    <ActionButton label="Confirmar Presença" onPress={handleConfirmPresence} variant="primary" />
                  ) : null}
                </View>
              ) : null}
            </View>
          </View>

          <View style={[styles.secondaryColumn, isWide ? styles.secondaryColumnWide : null]}>
            <View style={styles.sectionHeader}>
              <Users size={22} color={theme.colors.textPrimary} />
              <Text style={styles.sectionHeading}>Profissionais ({assignments?.length || 0})</Text>
            </View>

            {assignments && assignments.length > 0 ? (
              <View style={styles.listStack}>
                {assignments.map((assignment: any, index: number) => (
                  <TintedGlassCard key={index} variant="light" style={styles.personCard}>
                    <View style={styles.personRow}>
                      <View style={styles.personAvatar}>
                        <Users size={18} color={theme.colors.primary} />
                      </View>
                      <View style={styles.personInfo}>
                        <Text style={styles.personName}>
                          {assignment.professionalName || `Profissional #${assignment.userId || assignment.professionalId}`}
                        </Text>
                        {assignment.confirmedAt ? (
                          <Text style={styles.subtleText}>
                            Confirmado em {formatDateBR(assignment.confirmedAt)}
                          </Text>
                        ) : null}
                      </View>
                      {assignment.confirmed || assignment.confirmedAt ? (
                        <Badge variant="success">Confirmado</Badge>
                      ) : (
                        <Badge variant="warning">Pendente</Badge>
                      )}
                    </View>
                  </TintedGlassCard>
                ))}
              </View>
            ) : (
              <TintedGlassCard variant="light" style={styles.emptyCard}>
                <View style={styles.emptyIcon}>
                  <Users size={28} color={theme.colors.textMuted} />
                </View>
                <Text style={styles.emptyTitle}>Nenhum profissional alocado</Text>
                <Text style={styles.emptyCopy}>Este plantão ainda está vago.</Text>
              </TintedGlassCard>
            )}
          </View>
        </View>
      </View>
    </ScreenGradient>
  );
}

function InfoTile({
  label,
  value,
  icon,
}: {
  label: string;
  value: string;
  icon?: ReactNode;
}) {
  return (
    <View style={styles.infoTile}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.valueRow}>
        {icon}
        <Text style={styles.tileValue}>{value}</Text>
      </View>
    </View>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoLine}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.bodyStrong}>{value}</Text>
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  icon,
  variant,
}: {
  label: string;
  onPress: () => void;
  icon?: ReactNode;
  variant: "primary" | "primarySoft" | "secondary" | "success";
}) {
  const buttonStyle: ViewStyle =
    variant === "success"
      ? styles.actionSuccess
      : variant === "primary"
        ? styles.actionPrimary
        : variant === "primarySoft"
          ? styles.actionPrimarySoft
          : styles.actionSecondary;
  const labelColor =
    variant === "primary" || variant === "success"
      ? theme.colors.surface
      : variant === "primarySoft"
        ? theme.colors.primary
        : theme.colors.textPrimary;

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.78} style={[styles.actionButton, buttonStyle]}>
      <View style={styles.actionContent}>
        {icon}
        <Text style={[styles.actionLabel, { color: labelColor }]}>{label}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  shell: {
    width: "100%",
    maxWidth: theme.spacing.contentMaxWidth,
    alignSelf: "center",
    gap: theme.space[6],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space[3],
  },
  backButton: {
    width: theme.space[10],
    height: theme.space[10],
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  headerText: {
    flex: 1,
  },
  eyebrow: {
    ...theme.text.caption,
    color: theme.colors.textMuted,
    fontWeight: theme.weight.semibold,
    textTransform: "uppercase",
  },
  title: {
    ...theme.text.titleLg,
    color: theme.colors.textPrimary,
    fontWeight: theme.weight.bold,
  },
  contentGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.space[6],
    alignItems: "flex-start",
  },
  primaryColumn: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: PRIMARY_COLUMN_MIN_WIDTH,
    minWidth: theme.space[0],
    gap: theme.space[5],
  },
  secondaryColumn: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: SECONDARY_COLUMN_MIN_WIDTH,
    minWidth: theme.space[0],
    gap: theme.space[4],
  },
  secondaryColumnWide: {
    maxWidth: SECONDARY_COLUMN_MIN_WIDTH + theme.space[20],
  },
  summaryCard: {
    gap: theme.space[5],
  },
  summaryHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space[4],
    flexWrap: "wrap",
  },
  iconBox: {
    width: ICON_BOX_SIZE,
    height: ICON_BOX_SIZE,
    borderRadius: theme.radius.xl,
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  summaryText: {
    flex: 1,
    minWidth: FIELD_MIN_WIDTH,
  },
  statusWrap: {
    alignItems: "flex-start",
  },
  label: {
    ...theme.text.caption,
    color: theme.colors.textMuted,
    fontWeight: theme.weight.semibold,
  },
  sectorTitle: {
    ...theme.text.titleLg,
    color: theme.colors.textPrimary,
    fontWeight: theme.weight.bold,
  },
  subtleText: {
    ...theme.text.body,
    color: theme.colors.textSecondary,
  },
  bodyText: {
    ...theme.text.body,
    color: theme.colors.textSecondary,
  },
  bodyStrong: {
    ...theme.text.bodyLg,
    color: theme.colors.textPrimary,
    fontWeight: theme.weight.semibold,
  },
  divider: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
  fieldGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.space[3],
  },
  infoTile: {
    flexGrow: 1,
    flexBasis: FIELD_MIN_WIDTH,
    minWidth: FIELD_MIN_WIDTH,
    padding: theme.space[4],
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceAlt,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: theme.space[2],
  },
  valueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space[2],
  },
  tileValue: {
    ...theme.text.title,
    color: theme.colors.textPrimary,
    fontWeight: theme.weight.bold,
  },
  sectionBlock: {
    gap: theme.space[3],
  },
  sectionTitle: {
    ...theme.text.title,
    color: theme.colors.textPrimary,
    fontWeight: theme.weight.bold,
  },
  modalityRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.space[3],
  },
  infoLine: {
    gap: theme.space[1],
  },
  actionPanel: {
    gap: theme.space[3],
  },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.space[3],
  },
  actionButton: {
    minHeight: theme.space[14],
    minWidth: ACTION_MIN_WIDTH,
    flexGrow: 1,
    borderRadius: theme.radius.lg,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.space[4],
    paddingVertical: theme.space[3],
  },
  actionPrimary: {
    backgroundColor: theme.colors.primary,
  },
  actionSuccess: {
    backgroundColor: theme.colors.success,
  },
  actionPrimarySoft: {
    backgroundColor: theme.colors.primarySoft,
    borderWidth: 1,
    borderColor: theme.colors.primary,
  },
  actionSecondary: {
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actionContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.space[2],
  },
  actionLabel: {
    ...theme.text.bodyLg,
    fontWeight: theme.weight.semibold,
    textAlign: "center",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space[2],
  },
  sectionHeading: {
    ...theme.text.title,
    color: theme.colors.textPrimary,
    fontWeight: theme.weight.bold,
  },
  listStack: {
    gap: theme.space[3],
  },
  personCard: {
    padding: theme.space[4],
  },
  personRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space[3],
    flexWrap: "wrap",
  },
  personAvatar: {
    width: theme.space[10],
    height: theme.space[10],
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.primarySoft,
  },
  personInfo: {
    flex: 1,
    minWidth: FIELD_MIN_WIDTH,
  },
  personName: {
    ...theme.text.bodyLg,
    color: theme.colors.textPrimary,
    fontWeight: theme.weight.semibold,
  },
  emptyCard: {
    alignItems: "center",
    gap: theme.space[3],
    paddingVertical: theme.space[8],
  },
  emptyIcon: {
    width: theme.space[14],
    height: theme.space[14],
    borderRadius: theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceAlt,
  },
  emptyTitle: {
    ...theme.text.bodyLg,
    color: theme.colors.textPrimary,
    fontWeight: theme.weight.semibold,
    textAlign: "center",
  },
  emptyCopy: {
    ...theme.text.body,
    color: theme.colors.textMuted,
    textAlign: "center",
  },
});
