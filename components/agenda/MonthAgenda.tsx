// components/agenda/MonthAgenda.tsx — visão "Panorama" da Agenda.
//
// Pedido do PO (2026-08-19): "ver o calendário inteiro, pra poder
// selecionar o dia e ver o detalhe do dia (plantonistas, ofertas,
// vagas etc)".
//
// Layout: grade do mês (7 colunas, SEG→DOM) com indicadores por dia
// (pontos: verde=ocupado, âmbar=pendente, vermelho=vago) → tocar num
// dia seleciona → detalhe do dia abaixo da grade: grupos
// hospital+setor com os plantões (plantonistas, sobreaviso, vagas) e
// as ofertas de troca disponíveis naquele dia.

import { useMemo, useState, useEffect, type ReactElement } from "react";
import {
  ScrollView,
  Text,
  TouchableOpacity,
  View,
  type RefreshControlProps,
} from "react-native";
import { ArrowRightLeft } from "lucide-react-native";
import { theme } from "@/lib/theme";

type AgendaShift = {
  id: number;
  label: string;
  startAt: string | Date;
  endAt: string | Date;
  status: string;
  modality: string;
  coverageType: string | null;
  professionalNames: string[];
  isMine: boolean;
};

type AgendaGroupRow = {
  hospitalId: number;
  hospitalName: string;
  sectorId: number;
  sectorName: string;
  shifts: AgendaShift[];
};

type AgendaDay = {
  date: string;
  dow: number;
  groups: AgendaGroupRow[];
};

type AgendaWeek = {
  weekStart: string;
  days: AgendaDay[];
};

export type DayOffer = {
  id: number;
  fromProfessionalName: string;
  shiftLabel: string;
  date: string; // YYYY-MM-DD do turno ofertado
  timeRange: string;
};

const WEEKDAY_HEADERS = ["SEG", "TER", "QUA", "QUI", "SEX", "SÁB", "DOM"] as const;
const MONTHS_PT = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
] as const;
const WEEKDAYS_PT = [
  "domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado",
] as const;

function formatTimeRange(startAt: Date | string, endAt: Date | string): string {
  const s = new Date(startAt);
  const e = new Date(endAt);
  const f = (n: number) => String(n).padStart(2, "0");
  return `${f(s.getHours())}:${f(s.getMinutes())}–${f(e.getHours())}:${f(e.getMinutes())}`;
}

function formatSelectedDay(dateKey: string): string {
  const d = new Date(`${dateKey}T12:00:00`);
  return `${WEEKDAYS_PT[d.getDay()]}, ${d.getDate()} de ${MONTHS_PT[d.getMonth()]}`;
}

function shiftBorderColor(status: string): string {
  if (status === "OCUPADO") return theme.colors.success;
  if (status === "PENDENTE") return theme.colors.warning;
  return theme.colors.danger; // VAGO chama atenção no detalhe
}

function statusChip(status: string): { label: string; bg: string; fg: string } | null {
  if (status === "VAGO") {
    return { label: "VAGO", bg: theme.colors.dangerSoft, fg: theme.palette.danger[600] };
  }
  if (status === "PENDENTE") {
    return { label: "Pendente", bg: theme.colors.warningSoft ?? theme.colors.surfaceAlt, fg: theme.colors.warning };
  }
  return null;
}

export function MonthAgenda({
  weeks,
  monthKey,
  todayKey,
  offers,
  refreshControl,
  embedInPage = false,
  onShiftPress,
  onOfferPress,
}: {
  weeks: AgendaWeek[];
  /** "YYYY-MM" do mês exibido — dias fora dele ficam esmaecidos. */
  monthKey: string;
  todayKey: string;
  offers: DayOffer[];
  refreshControl: ReactElement<RefreshControlProps>;
  /** Desktop: a página rola por inteiro — sem ScrollView interno aqui. */
  embedInPage?: boolean;
  onShiftPress: (id: number) => void;
  onOfferPress: () => void;
}) {
  const dayByKey = useMemo(() => {
    const map = new Map<string, AgendaDay>();
    for (const w of weeks) for (const d of w.days) map.set(d.date, d);
    return map;
  }, [weeks]);

  // Dia selecionado: hoje quando pertence ao mês, senão dia 1.
  const [selected, setSelected] = useState<string>(() =>
    todayKey.startsWith(monthKey) ? todayKey : `${monthKey}-01`,
  );
  useEffect(() => {
    setSelected(todayKey.startsWith(monthKey) ? todayKey : `${monthKey}-01`);
  }, [monthKey, todayKey]);

  const selectedDay = dayByKey.get(selected);
  const selectedOffers = useMemo(
    () => offers.filter((o) => o.date === selected),
    [offers, selected],
  );

  const inner = (
    <>
      {/* Cabeçalho dos dias da semana */}
      <View style={{ flexDirection: "row", marginBottom: theme.space[1] }}>
        {WEEKDAY_HEADERS.map((h) => (
          <Text
            key={h}
            style={{
              flex: 1,
              textAlign: "center",
              fontSize: 11,
              fontWeight: "700",
              color: theme.colors.textMuted,
              letterSpacing: 0.4,
            }}
          >
            {h}
          </Text>
        ))}
      </View>

      {/* Grade do mês */}
      {weeks.map((week) => (
        <View key={week.weekStart} style={{ flexDirection: "row" }}>
          {week.days.map((day) => {
            const inMonth = day.date.startsWith(monthKey);
            const isToday = day.date === todayKey;
            const isSelected = day.date === selected;
            const shifts = day.groups.flatMap((g) => g.shifts);
            const nOcupado = shifts.filter((s) => s.status === "OCUPADO").length;
            const nPendente = shifts.filter((s) => s.status === "PENDENTE").length;
            const nVago = shifts.filter((s) => s.status === "VAGO").length;
            const hasOffer = offers.some((o) => o.date === day.date);
            const dayNum = parseInt(day.date.slice(8, 10), 10);

            return (
              <TouchableOpacity
                key={day.date}
                onPress={() => setSelected(day.date)}
                activeOpacity={0.7}
                style={{
                  flex: 1,
                  aspectRatio: 0.82,
                  margin: 1.5,
                  borderRadius: theme.radius.md,
                  backgroundColor: isSelected
                    ? theme.colors.primary
                    : isToday
                      ? theme.colors.primarySoft
                      : theme.colors.surface,
                  borderWidth: 1,
                  borderColor: isSelected
                    ? theme.colors.primary
                    : isToday
                      ? theme.colors.primary
                      : theme.colors.border,
                  alignItems: "center",
                  paddingTop: 6,
                  opacity: inMonth ? 1 : 0.35,
                }}
              >
                <Text
                  style={{
                    fontSize: 14,
                    fontWeight: isToday || isSelected ? "800" : "600",
                    color: isSelected
                      ? theme.colors.onDark.text
                      : theme.colors.textPrimary,
                  }}
                >
                  {dayNum}
                </Text>
                <View
                  style={{
                    flexDirection: "row",
                    gap: 2,
                    marginTop: 3,
                    flexWrap: "wrap",
                    justifyContent: "center",
                    paddingHorizontal: 2,
                  }}
                >
                  {nOcupado > 0 && (
                    <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: isSelected ? theme.colors.onDark.text : theme.colors.success }} />
                  )}
                  {nPendente > 0 && (
                    <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: isSelected ? theme.colors.onDark.text : theme.colors.warning }} />
                  )}
                  {nVago > 0 && (
                    <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: isSelected ? theme.colors.onDark.text : theme.colors.danger }} />
                  )}
                  {hasOffer && (
                    <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: isSelected ? theme.colors.onDark.text : theme.colors.primary }} />
                  )}
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      ))}

      {/* Legenda */}
      <View
        style={{
          flexDirection: "row",
          gap: theme.space[3],
          justifyContent: "center",
          marginTop: theme.space[2],
          marginBottom: theme.space[4],
          flexWrap: "wrap",
        }}
      >
        {[
          { c: theme.colors.success, l: "Ocupado" },
          { c: theme.colors.warning, l: "Pendente" },
          { c: theme.colors.danger, l: "Vago" },
          { c: theme.colors.primary, l: "Oferta" },
        ].map((item) => (
          <View key={item.l} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: item.c }} />
            <Text style={{ fontSize: 11, color: theme.colors.textMuted }}>{item.l}</Text>
          </View>
        ))}
      </View>

      {/* Detalhe do dia selecionado */}
      <Text
        style={{
          fontSize: 16,
          fontWeight: "800",
          color: theme.colors.textPrimary,
          marginBottom: theme.space[3],
          textTransform: "capitalize",
        }}
      >
        {formatSelectedDay(selected)}
      </Text>

      {/* Ofertas de troca do dia */}
      {selectedOffers.length > 0 && (
        <View style={{ marginBottom: theme.space[3] }}>
          {selectedOffers.map((offer) => (
            <TouchableOpacity
              key={offer.id}
              onPress={onOfferPress}
              activeOpacity={0.8}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: theme.space[3],
                backgroundColor: theme.colors.primarySoft,
                borderRadius: theme.radius.md,
                borderWidth: 1,
                borderColor: theme.colors.primary,
                padding: theme.space[3],
                marginBottom: theme.space[2],
              }}
            >
              <ArrowRightLeft size={18} color={theme.colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: "700", color: theme.colors.primary }}>
                  Oferta de troca — {offer.shiftLabel}
                </Text>
                <Text style={{ fontSize: 12, color: theme.colors.textSecondary }}>
                  {offer.fromProfessionalName} · {offer.timeRange} · toque para responder
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {!selectedDay || selectedDay.groups.length === 0 ? (
        <View
          style={{
            paddingVertical: theme.space[8],
            alignItems: "center",
            backgroundColor: theme.colors.surfaceAlt,
            borderRadius: theme.radius.md,
          }}
        >
          <Text style={{ color: theme.colors.textMuted }}>
            Nenhum plantão neste dia.
          </Text>
        </View>
      ) : (
        selectedDay.groups.map((group) => (
          <View
            key={`${group.hospitalId}-${group.sectorId}`}
            style={{ marginBottom: theme.space[3] }}
          >
            <View
              style={{
                backgroundColor: theme.colors.primarySoft,
                paddingHorizontal: theme.space[3],
                paddingVertical: theme.space[2],
                borderRadius: theme.radius.sm,
                marginBottom: theme.space[1],
              }}
            >
              <Text
                style={{
                  fontSize: 12,
                  fontWeight: "700",
                  color: theme.palette.primary[900],
                  textTransform: "uppercase",
                  letterSpacing: 0.3,
                }}
              >
                {group.hospitalName} – {group.sectorName}
              </Text>
            </View>
            {group.shifts.map((shift) => {
              const chip = statusChip(shift.status);
              return (
                <TouchableOpacity
                  key={shift.id}
                  onPress={() => onShiftPress(shift.id)}
                  activeOpacity={0.75}
                  style={{
                    borderLeftWidth: 3,
                    borderLeftColor: shiftBorderColor(shift.status),
                    backgroundColor: theme.colors.surface,
                    borderRadius: theme.radius.sm,
                    paddingHorizontal: theme.space[3],
                    paddingVertical: theme.space[2],
                    marginBottom: theme.space[1],
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{
                        fontSize: 14,
                        fontWeight: "600",
                        color: theme.colors.textPrimary,
                      }}
                      numberOfLines={1}
                    >
                      {shift.professionalNames.length > 0
                        ? shift.professionalNames.join(", ")
                        : "— sem plantonista —"}
                    </Text>
                    <Text style={{ fontSize: 12, color: theme.colors.textSecondary }}>
                      {formatTimeRange(shift.startAt, shift.endAt)} · {shift.label}
                    </Text>
                  </View>
                  {chip && (
                    <View
                      style={{
                        backgroundColor: chip.bg,
                        borderRadius: theme.radius.sm,
                        paddingHorizontal: theme.space[2],
                        paddingVertical: 3,
                        marginLeft: theme.space[2],
                      }}
                    >
                      <Text style={{ fontSize: 11, fontWeight: "700", color: chip.fg }}>
                        {chip.label}
                      </Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        ))
      )}
    </>
  );

  if (embedInPage) {
    return <View style={{ paddingBottom: theme.space[10] }}>{inner}</View>;
  }
  return (
    <ScrollView
      style={{ flex: 1 }}
      refreshControl={refreshControl}
      contentContainerStyle={{ paddingBottom: theme.space[10] }}
      showsVerticalScrollIndicator={false}
    >
      {inner}
    </ScrollView>
  );
}
