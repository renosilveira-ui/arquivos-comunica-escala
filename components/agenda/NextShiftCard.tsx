// components/agenda/NextShiftCard.tsx — a pergunta nº 1 do plantonista:
// "quando é o meu próximo plantão?" — respondida no topo da Agenda.
//
// Componente puro (dados por props, `now` injetável) para ser testável e
// renderizável na rota de preview sem servidor. A query é um fato separado
// (`queryState`): LOADING / ERROR / EMPTY / SUCCESS. Erro nunca vira
// "nenhum plantão". Com plantão:
//   - em andamento: "Termina às 19:00" + ações (Comunica+)
//   - futuro: "Começa em 3 h" / "amanhã às 07:00" + ações (Confirmar/Trocar)
//
// Variantes:
//   - "compact" (padrão, usada na Agenda): faixa de duas linhas — eyebrow +
//     quando (com a única ação ao lado: Confirmar / Comunica+ / seta) e o
//     detalhe "turno horário · setor" em linha própria. Navy sólido quando
//     é o próximo; verde tinted em andamento. O PO pediu (2026-08-22) o card
//     bem menor para não roubar a visão panorâmica; trocar fica no detalhe.
//   - "full": card grande com título, local e botões empilhados.

import { Pressable, Text, View } from "react-native";
import { AlertCircle, ArrowRightLeft, CheckCircle2, ChevronRight, Clock, ExternalLink, MapPin, PlayCircle } from "lucide-react-native";
import { theme } from "@/lib/theme";
import { formatHospitalTime } from "@/lib/hospital-time";
import { Surface, tonedText } from "@/components/ui/Surface";
import { AppButton } from "@/components/ui/AppButton";
import { ShiftStatusBadge } from "@/components/ui/ShiftStatusBadge";
import { Skeleton } from "@/components/ui/Skeleton";
import {
  NEXT_SHIFT_EMPTY_SUBTITLE,
  NEXT_SHIFT_LOADING_A11Y,
  nextShiftSurface,
  type NextShiftQueryState,
} from "@/lib/next-shift-state";

export interface NextShiftCardShift {
  id: number;
  label: string;
  startAt: string | Date;
  endAt: string | Date;
  status?: string | null;
  sectorName?: string | null;
  hospitalName?: string | null;
}

export interface NextShiftCardProps {
  queryState: NextShiftQueryState;
  shift: NextShiftCardShift | null | undefined;
  /** Relógio injetável (testes/preview). */
  now?: Date;
  /** Há pedido de confirmação pendente para este plantão. */
  needsConfirmation?: boolean;
  onConfirm?: () => void;
  onSwap?: () => void;
  onOpenComunica?: () => void;
  onPress?: () => void;
  /** Retry da query — só faz sentido em ERROR. */
  onRetry?: () => void;
  /** "compact" (padrão): faixa de uma linha. "full": card grande. */
  variant?: "compact" | "full";
}

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

function fmtTime(d: Date): string {
  return formatHospitalTime(d);
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Começa em 45 min", "Começa em 3 h", "amanhã às 07:00", "sexta, 28/08 às 19:00". */
export function describeStart(start: Date, now: Date): string {
  const diffMin = Math.round((start.getTime() - now.getTime()) / 60000);
  if (diffMin <= 0) return "Começa agora";
  if (diffMin < 60) return `Começa em ${diffMin} min`;
  if (diffMin < 12 * 60) {
    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    return m >= 15 ? `Começa em ${h} h ${m} min` : `Começa em ${h} h`;
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameLocalDay(start, tomorrow)) return `Amanhã às ${fmtTime(start)}`;
  if (sameLocalDay(start, now)) return `Hoje às ${fmtTime(start)}`;
  const dd = String(start.getDate()).padStart(2, "0");
  const mm = String(start.getMonth() + 1).padStart(2, "0");
  const weekday = WEEKDAYS[start.getDay()];
  // Título de card: primeira letra maiúscula ("Sexta, 11/09 às 07:00").
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)}, ${dd}/${mm} às ${fmtTime(start)}`;
}

export function NextShiftCard({
  queryState,
  shift,
  now = new Date(),
  needsConfirmation = false,
  onConfirm,
  onSwap,
  onOpenComunica,
  onPress,
  onRetry,
  variant = "compact",
}: NextShiftCardProps) {
  if (variant === "compact") {
    return (
      <CompactNextShift
        queryState={queryState}
        shift={shift}
        now={now}
        needsConfirmation={needsConfirmation}
        onConfirm={onConfirm}
        onOpenComunica={onOpenComunica}
        onPress={onPress}
        onRetry={onRetry}
      />
    );
  }

  if (queryState === "LOADING") {
    return (
      <Surface level="card" tone="muted" accessibilityLabel={NEXT_SHIFT_LOADING_A11Y}>
        <View accessibilityRole="progressbar" style={{ gap: theme.space[2] }}>
          <Skeleton width="40%" height={theme.space[3]} />
          <Skeleton width="70%" height={theme.space[5]} />
          <Skeleton width="55%" height={theme.space[3]} />
        </View>
      </Surface>
    );
  }

  if (queryState === "ERROR") {
    const errorSurface = nextShiftSurface("ERROR");
    return (
      <Surface level="card" tone="muted" accessibilityLabel={errorSurface.title ?? undefined}>
        <View style={{ gap: theme.space[3] }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[3] }}>
            <AlertCircle size={20} color={theme.colors.danger} />
            <Text style={{ flex: 1, ...theme.text.titleSm, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary }}>
              {errorSurface.title}
            </Text>
          </View>
          {onRetry && errorSurface.showRetry && errorSurface.retryLabel ? (
            <AppButton title={errorSurface.retryLabel} onPress={onRetry} size="md" />
          ) : null}
        </View>
      </Surface>
    );
  }

  if (queryState !== "SUCCESS" || !shift) {
    const emptySurface = nextShiftSurface("EMPTY");
    return (
      <Surface level="card" tone="muted" accessibilityLabel={emptySurface.title ?? undefined}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[3] }}>
          <Clock size={20} color={theme.colors.textMuted} />
          <View style={{ flex: 1 }}>
            <Text style={{ ...theme.text.titleSm, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary }}>
              {emptySurface.title}
            </Text>
            <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
              {NEXT_SHIFT_EMPTY_SUBTITLE}
            </Text>
          </View>
        </View>
      </Surface>
    );
  }

  const start = new Date(shift.startAt);
  const end = new Date(shift.endAt);
  const inProgress = start.getTime() <= now.getTime() && now.getTime() < end.getTime();
  const tone = inProgress ? "success" : "primary";
  const colors = tonedText(tone);
  const where = [shift.sectorName, shift.hospitalName].filter(Boolean).join(" · ");

  return (
    <Surface level="raised" tone={tone} onPress={onPress} accessibilityLabel={`${inProgress ? "Plantão em andamento" : "Próximo plantão"}: ${shift.label}`}>
      <View style={{ gap: theme.space[3] }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: theme.space[2] }}>
          <Text
            style={{
              ...theme.text.eyebrow,
              fontWeight: theme.weight.bold,
              textTransform: "uppercase",
              color: colors.soft,
            }}
          >
            {inProgress ? "Plantão em andamento" : "Próximo plantão"}
          </Text>
          {shift.status ? <ShiftStatusBadge status={shift.status} size="sm" /> : null}
        </View>

        <View style={{ gap: theme.space[1] }}>
          <Text style={{ ...theme.text.titleLg, fontWeight: theme.weight.bold, color: colors.strong }}>
            {inProgress ? `Termina às ${fmtTime(end)}` : describeStart(start, now)}
          </Text>
          <Text style={{ ...theme.text.bodyLg, color: colors.strong, fontVariant: ["tabular-nums"] }}>
            {shift.label} · {fmtTime(start)}–{fmtTime(end)}
          </Text>
          {where ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[1] }}>
              <MapPin size={14} color={colors.soft} />
              <Text style={{ ...theme.text.body, color: colors.soft }} numberOfLines={1}>
                {where}
              </Text>
            </View>
          ) : null}
        </View>

        {inProgress && onOpenComunica ? (
          <AppButton title="Abrir Comunica+" onPress={onOpenComunica} size="md" />
        ) : null}
        {!inProgress && (needsConfirmation || onSwap) ? (
          // Empilhados: lado a lado, "Confirmar presença" quebrava linha em 375px.
          <View style={{ gap: theme.space[2] }}>
            {needsConfirmation && onConfirm ? (
              <AppButton title="Confirmar presença" onPress={onConfirm} size="md" />
            ) : null}
            {onSwap ? <AppButton title="Trocar este plantão" variant="secondary" onPress={onSwap} size="md" /> : null}
          </View>
        ) : null}

        {inProgress ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[1] }}>
            <CheckCircle2 size={14} color={colors.soft} />
            <Text style={{ ...theme.text.caption, color: colors.soft }}>Presença registrada para este plantão</Text>
          </View>
        ) : null}
        {!inProgress && !needsConfirmation && !onSwap ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[1] }}>
            <ArrowRightLeft size={14} color={colors.soft} />
            <Text style={{ ...theme.text.caption, color: colors.soft }}>Toque para ver detalhes</Text>
          </View>
        ) : null}
        {inProgress && !onOpenComunica ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[1] }}>
            <ExternalLink size={14} color={colors.soft} />
            <Text style={{ ...theme.text.caption, color: colors.soft }}>Comunica+ disponível no botão abaixo</Text>
          </View>
        ) : null}
      </View>
    </Surface>
  );
}

type CompactProps = Pick<
  NextShiftCardProps,
  "queryState" | "shift" | "needsConfirmation" | "onConfirm" | "onOpenComunica" | "onPress" | "onRetry"
> & {
  now: Date;
};

/**
 * Faixa de DUAS linhas (~78pt; menos da metade da variante "full").
 *
 * Proposta de design 23/08: em uma linha só, a coluna de texto ficava com
 * 184pt entre o ícone e o botão e as strings reais não cabiam — "Próximo ·
 * amanhã às 07:00" perdia o horário e "Manhã 07:00–13:00 · Centro
 * cirúrgico" perdia o setor. A faixa elidia exatamente as duas respostas
 * que ela existe para dar. Agora: eyebrow + horário na primeira linha (com
 * a ação ao lado) e o detalhe em linha própria, de largura cheia, que pode
 * quebrar.
 *
 * Só UMA coisa por tela recebe navy preenchido: a que exige decisão agora.
 * A faixa do próximo plantão é essa coisa — navy sólido. Em andamento, a
 * faixa é verde tinted (nada disputa o primeiro lugar com ela).
 */
function CompactNextShift({
  queryState,
  shift,
  now,
  needsConfirmation,
  onConfirm,
  onOpenComunica,
  onPress,
  onRetry,
}: CompactProps) {
  if (queryState === "LOADING") {
    return (
      <Surface
        level="card"
        tone="muted"
        style={{ paddingVertical: theme.space[3], paddingHorizontal: theme.space[3] }}
        accessibilityLabel={NEXT_SHIFT_LOADING_A11Y}
      >
        <View accessibilityRole="progressbar" style={{ gap: theme.space[2] }}>
          <Skeleton width="36%" height={theme.space[3]} />
          <Skeleton width="72%" height={theme.space[5]} />
        </View>
      </Surface>
    );
  }

  if (queryState === "ERROR") {
    const errorSurface = nextShiftSurface("ERROR");
    return (
      <Surface
        level="card"
        tone="muted"
        style={{ paddingVertical: theme.space[3], paddingHorizontal: theme.space[3] }}
        accessibilityLabel={errorSurface.title ?? undefined}
      >
        <View style={{ gap: theme.space[3] }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[3] }}>
            <AlertCircle size={18} color={theme.colors.danger} />
            <Text style={{ flex: 1, ...theme.text.body, color: theme.colors.textPrimary }}>
              {errorSurface.title}
            </Text>
          </View>
          {onRetry && errorSurface.showRetry && errorSurface.retryLabel ? (
            <Pressable
              onPress={onRetry}
              accessibilityRole="button"
              accessibilityLabel={errorSurface.retryLabel}
              style={({ pressed }) => ({
                minHeight: 44,
                paddingHorizontal: theme.space[4],
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.primary,
                alignItems: "center",
                justifyContent: "center",
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Text style={{ ...theme.text.body, fontWeight: theme.weight.semibold, color: theme.colors.surface }}>
                {errorSurface.retryLabel}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </Surface>
    );
  }

  if (queryState !== "SUCCESS" || !shift) {
    const emptySurface = nextShiftSurface("EMPTY");
    return (
      <Surface
        level="card"
        tone="muted"
        style={{ paddingVertical: theme.space[2], paddingHorizontal: theme.space[3] }}
        accessibilityLabel={emptySurface.title ?? undefined}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[3] }}>
          <Clock size={18} color={theme.colors.textMuted} />
          <Text style={{ flex: 1, ...theme.text.body, color: theme.colors.textSecondary }} numberOfLines={1}>
            {emptySurface.title}
          </Text>
        </View>
      </Surface>
    );
  }

  const start = new Date(shift.startAt);
  const end = new Date(shift.endAt);
  const inProgress = start.getTime() <= now.getTime() && now.getTime() < end.getTime();
  const where = [shift.sectorName, shift.hospitalName].filter(Boolean).join(" · ");
  const headline = inProgress ? `Termina às ${fmtTime(end)}` : describeStart(start, now);
  const detail = `${shift.label} ${fmtTime(start)}–${fmtTime(end)}${where ? ` · ${where}` : ""}`;

  const ink = inProgress
    ? {
        bg: theme.palette.success[50],
        border: theme.palette.success[200],
        bar: theme.palette.success[700],
        eyebrow: theme.palette.success[700],
        headline: theme.palette.success[900],
        detail: theme.palette.success[700],
        icon: theme.palette.success[700],
        buttonBg: theme.palette.success[700],
        buttonFg: theme.colors.onDark.text,
        chevron: theme.palette.success[700],
      }
    : {
        bg: theme.colors.brand,
        border: theme.colors.brand,
        bar: theme.colors.brand,
        eyebrow: theme.colors.onDark.textMuted,
        headline: theme.colors.onDark.text,
        detail: theme.colors.onDark.textSoft,
        icon: theme.colors.onDark.textSoft,
        buttonBg: theme.colors.surface,
        buttonFg: theme.colors.brand,
        chevron: theme.colors.onDark.textSoft,
      };

  // Uma ação só: Comunica+ durante o plantão; Confirmar quando pendente;
  // senão, a seta de detalhe (a faixa inteira já é tocável).
  const actionLabel = inProgress && onOpenComunica ? "Comunica+" : !inProgress && needsConfirmation && onConfirm ? "Confirmar" : null;
  const actionPress = inProgress ? onOpenComunica : onConfirm;

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={`${inProgress ? "Plantão em andamento" : "Próximo plantão"}: ${headline}. ${detail}`}
      style={({ pressed }) => ({
        backgroundColor: ink.bg,
        borderWidth: 1,
        borderColor: ink.border,
        borderLeftWidth: inProgress ? 4 : 1,
        borderLeftColor: ink.bar,
        borderRadius: theme.radius.lg,
        paddingVertical: theme.space[3] - 1,
        paddingHorizontal: theme.space[3] + 1,
        gap: theme.space[2] - 1,
        opacity: pressed ? 0.92 : 1,
        ...(inProgress ? {} : theme.shadow.md),
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[3] - 1 }}>
        {inProgress ? <PlayCircle size={19} color={ink.icon} /> : <Clock size={19} color={ink.icon} />}
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <Text style={{ ...theme.text.eyebrow, fontSize: 10, fontWeight: theme.weight.bold, textTransform: "uppercase", color: ink.eyebrow }}>
            {inProgress ? "Em andamento" : "Próximo plantão"}
          </Text>
          <Text
            numberOfLines={1}
            style={{ fontSize: 17, lineHeight: 22, letterSpacing: -0.25, fontWeight: theme.weight.bold, color: ink.headline, fontVariant: ["tabular-nums"] }}
          >
            {headline}
          </Text>
        </View>
        {actionLabel && actionPress ? (
          <Pressable
            onPress={actionPress}
            accessibilityRole="button"
            accessibilityLabel={actionLabel === "Confirmar" ? "Confirmar presença" : "Abrir Comunica+"}
            hitSlop={6}
            style={({ pressed }) => ({
              minHeight: 38,
              paddingHorizontal: theme.space[3] + 1,
              borderRadius: theme.radius.md,
              backgroundColor: ink.buttonBg,
              alignItems: "center",
              justifyContent: "center",
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Text style={{ ...theme.text.body, fontSize: 13.5, fontWeight: theme.weight.bold, color: ink.buttonFg }}>{actionLabel}</Text>
          </Pressable>
        ) : onPress ? (
          <ChevronRight size={18} color={ink.chevron} />
        ) : null}
      </View>
      <Text style={{ ...theme.text.caption, fontSize: 12.5, lineHeight: 17, fontFamily: theme.fontFamily.mono, fontVariant: ["tabular-nums"], color: ink.detail }}>
        {detail}
      </Text>
    </Pressable>
  );
}
