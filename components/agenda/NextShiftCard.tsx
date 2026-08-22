// components/agenda/NextShiftCard.tsx — a pergunta nº 1 do plantonista:
// "quando é o meu próximo plantão?" — respondida no topo da Agenda.
//
// Componente puro (dados por props, `now` injetável) para ser testável e
// renderizável na rota de preview sem servidor. Dois estados:
//   - em andamento: "Termina às 19:00" + ações (Comunica+)
//   - futuro: "Começa em 3 h" / "amanhã às 07:00" + ações (Confirmar/Trocar)
//
// Variantes:
//   - "compact" (padrão, usada na Agenda): UMA faixa — quando · horário ·
//     setor + uma única ação (Confirmar / Comunica+) ou a seta de detalhe.
//     O PO pediu (2026-08-22) o card bem menor para não roubar a visão
//     panorâmica da escala; trocar plantão fica no detalhe.
//   - "full": card grande com título, local e botões empilhados.

import { Text, View } from "react-native";
import { ArrowRightLeft, CheckCircle2, ChevronRight, Clock, ExternalLink, MapPin, PlayCircle } from "lucide-react-native";
import { theme } from "@/lib/theme";
import { Surface, tonedText } from "@/components/ui/Surface";
import { AppButton } from "@/components/ui/AppButton";
import { ShiftStatusBadge } from "@/components/ui/ShiftStatusBadge";

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
  shift: NextShiftCardShift | null | undefined;
  /** Relógio injetável (testes/preview). */
  now?: Date;
  /** Há pedido de confirmação pendente para este plantão. */
  needsConfirmation?: boolean;
  onConfirm?: () => void;
  onSwap?: () => void;
  onOpenComunica?: () => void;
  onPress?: () => void;
  /** "compact" (padrão): faixa de uma linha. "full": card grande. */
  variant?: "compact" | "full";
}

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

function fmtTime(d: Date): string {
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
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
  shift,
  now = new Date(),
  needsConfirmation = false,
  onConfirm,
  onSwap,
  onOpenComunica,
  onPress,
  variant = "compact",
}: NextShiftCardProps) {
  if (variant === "compact") {
    return (
      <CompactNextShift
        shift={shift}
        now={now}
        needsConfirmation={needsConfirmation}
        onConfirm={onConfirm}
        onOpenComunica={onOpenComunica}
        onPress={onPress}
      />
    );
  }

  if (!shift) {
    return (
      <Surface level="card" tone="muted" accessibilityLabel="Sem próximo plantão">
        <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[3] }}>
          <Clock size={20} color={theme.colors.textMuted} />
          <View style={{ flex: 1 }}>
            <Text style={{ ...theme.text.titleSm, fontWeight: theme.weight.semibold, color: theme.colors.textPrimary }}>
              Nenhum plantão agendado
            </Text>
            <Text style={{ ...theme.text.body, color: theme.colors.textSecondary }}>
              Quando você for alocado, ele aparece aqui.
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

type CompactProps = Pick<NextShiftCardProps, "shift" | "needsConfirmation" | "onConfirm" | "onOpenComunica" | "onPress"> & {
  now: Date;
};

/** Faixa de uma linha: ~56pt. Só UMA ação à direita (a que importa agora). */
function CompactNextShift({ shift, now, needsConfirmation, onConfirm, onOpenComunica, onPress }: CompactProps) {
  const rowStyle = { flexDirection: "row", alignItems: "center", gap: theme.space[3] } as const;
  const compactSurface = { paddingVertical: theme.space[2], paddingHorizontal: theme.space[3] };

  if (!shift) {
    return (
      <Surface level="card" tone="muted" style={compactSurface} accessibilityLabel="Sem próximo plantão">
        <View style={rowStyle}>
          <Clock size={18} color={theme.colors.textMuted} />
          <Text style={{ flex: 1, ...theme.text.body, color: theme.colors.textSecondary }} numberOfLines={1}>
            Nenhum plantão agendado
          </Text>
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
  const headline = inProgress ? `Em andamento · termina às ${fmtTime(end)}` : `Próximo · ${describeStart(start, now)}`;
  const detail = `${shift.label} ${fmtTime(start)}–${fmtTime(end)}${where ? ` · ${where}` : ""}`;

  // Uma ação só: Comunica+ durante o plantão; Confirmar quando pendente;
  // senão, a seta de detalhe (o card inteiro já é tocável).
  const action =
    inProgress && onOpenComunica ? (
      <AppButton title="Comunica+" onPress={onOpenComunica} size="sm" fullWidth={false} />
    ) : !inProgress && needsConfirmation && onConfirm ? (
      <AppButton title="Confirmar" onPress={onConfirm} size="sm" fullWidth={false} />
    ) : onPress ? (
      <ChevronRight size={18} color={colors.soft} />
    ) : null;

  return (
    <Surface
      level="card"
      tone={tone}
      onPress={onPress}
      style={compactSurface}
      accessibilityLabel={`${inProgress ? "Plantão em andamento" : "Próximo plantão"}: ${shift.label}, ${headline}`}
    >
      <View style={rowStyle}>
        {inProgress ? <PlayCircle size={18} color={colors.strong} /> : <Clock size={18} color={colors.strong} />}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ ...theme.text.body, fontWeight: theme.weight.semibold, color: colors.strong }}>
            {headline}
          </Text>
          <Text numberOfLines={1} style={{ ...theme.text.caption, color: colors.soft, fontVariant: ["tabular-nums"] }}>
            {detail}
          </Text>
        </View>
        {action}
      </View>
    </Surface>
  );
}
