import { useCallback, useMemo, useState } from "react";
import { RefreshControl, Text, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import { CalendarPlus, ChevronLeft, ChevronRight } from "lucide-react-native";

import { PersonalCalendarDaySection } from "@/components/agenda/PersonalCalendarDaySection";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { QueryErrorState } from "@/components/ui/QueryErrorState";
import { SkeletonList } from "@/components/ui/Skeleton";
import { AppButton } from "@/components/ui/AppButton";
import { theme } from "@/lib/theme";
import { trpc } from "@/lib/trpc";
import {
  PERSONAL_CALENDAR_VIEWS,
  PERSONAL_CALENDAR_VIEW_LABELS,
  dayKeyInTimeZone,
  groupOccurrencesByDay,
  resolvePersonalCalendarScreenState,
  shiftAnchor,
  windowForView,
  type PersonalCalendarOccurrenceLike,
  type PersonalCalendarView,
} from "@/lib/personal-calendar-view";

/**
 * Agenda pessoal — recurso da CONTA.
 *
 * Não lê instituição ativa, papel, escala nem `manager_scope`: esta tela
 * acompanha o usuário entre todos os hospitais dele e continua funcionando
 * mesmo sem vínculo institucional nenhum. Por isso ela não vive dentro da
 * aba de escala: misturar as duas superfícies convidaria a confundir
 * autoridade institucional com compromisso privado.
 *
 * Plantão aparece aqui apenas como *conflito* de um compromisso pessoal —
 * informação para o médico decidir, nunca item editável por esta tela.
 */

function deviceTimeZone(): string {
  try {
    return (
      Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo"
    );
  } catch {
    return "America/Sao_Paulo";
  }
}

function ViewToggle({
  value,
  onChange,
}: {
  value: PersonalCalendarView;
  onChange: (next: PersonalCalendarView) => void;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        backgroundColor: theme.colors.surfaceAlt,
        borderRadius: theme.radius.md,
        padding: 2,
      }}
    >
      {PERSONAL_CALENDAR_VIEWS.map((option) => {
        const active = option === value;
        return (
          <TouchableOpacity
            key={option}
            onPress={() => onChange(option)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`Ver por ${PERSONAL_CALENDAR_VIEW_LABELS[option]}`}
            style={{
              minHeight: 36,
              paddingHorizontal: theme.space[4],
              justifyContent: "center",
              borderRadius: theme.radius.sm,
              backgroundColor: active ? theme.colors.surface : "transparent",
            }}
          >
            <Text
              style={{
                fontSize: theme.text.body.fontSize,
                fontWeight: active ? "600" : "500",
                color: active
                  ? theme.colors.textPrimary
                  : theme.colors.textSecondary,
              }}
            >
              {PERSONAL_CALENDAR_VIEW_LABELS[option]}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export default function PersonalCalendarScreen() {
  const router = useRouter();
  const timeZone = useMemo(deviceTimeZone, []);
  const todayKey = useMemo(
    () => dayKeyInTimeZone(new Date(), timeZone),
    [timeZone],
  );
  const [view, setView] = useState<PersonalCalendarView>("WEEK");
  const [anchor, setAnchor] = useState(todayKey);

  const window = useMemo(() => windowForView(view, anchor), [view, anchor]);

  const listQuery = trpc.personalCalendar.listWindow.useQuery(window, {
    // A Agenda pessoal é privada e muda pouco; recarrega ao focar a tela.
    staleTime: 30_000,
  });

  const year = Number(anchor.slice(0, 4));
  const holidaysQuery = trpc.calendarAuxiliary.listHolidays.useQuery(
    { year, countryCode: "BR", stateCode: "CE" },
    { staleTime: 24 * 60 * 60 * 1000 },
  );

  const groups = useMemo(() => {
    if (!listQuery.data) return null;
    return groupOccurrencesByDay({
      fromDate: window.fromDate,
      toDate: window.toDate,
      occurrences: listQuery.data
        .occurrences as unknown as PersonalCalendarOccurrenceLike[],
      holidays: holidaysQuery.data?.holidays,
      timeZone,
      // No mês, dia vazio vira ruído; na semana e no dia, o vazio informa.
      includeEmptyDays: view !== "MONTH",
    });
  }, [
    listQuery.data,
    holidaysQuery.data,
    window.fromDate,
    window.toDate,
    timeZone,
    view,
  ]);

  const state = resolvePersonalCalendarScreenState({
    isLoading: listQuery.isLoading,
    isError: listQuery.isError,
    groups,
  });

  const openEditor = useCallback(
    (occurrence: PersonalCalendarOccurrenceLike) => {
      router.push({
        pathname: "/personal-event",
        params: { itemId: String(occurrence.itemId) },
      });
    },
    [router],
  );

  const createNew = useCallback(() => {
    router.push({
      pathname: "/personal-event",
      params: { dayKey: view === "DAY" ? anchor : todayKey },
    });
  }, [router, view, anchor, todayKey]);

  const periodLabel = useMemo(() => {
    if (view === "DAY") {
      const [y, m, d] = anchor.split("-");
      return `${d}/${m}/${y}`;
    }
    if (view === "WEEK") {
      const [, fm, fd] = window.fromDate.split("-");
      const [, tm, td] = window.toDate.split("-");
      return `${fd}/${fm} – ${td}/${tm}`;
    }
    try {
      return new Intl.DateTimeFormat("pt-BR", {
        timeZone: "UTC",
        month: "long",
        year: "numeric",
      }).format(new Date(`${anchor.slice(0, 7)}-01T00:00:00Z`));
    } catch {
      return anchor.slice(0, 7);
    }
  }, [view, anchor, window.fromDate, window.toDate]);

  return (
    <ScreenGradient>
      <ScreenContainer
        flex
        refreshControl={
          <RefreshControl
            refreshing={listQuery.isRefetching}
            onRefresh={() => {
              listQuery.refetch();
            }}
          />
        }
      >
        <View style={{ gap: theme.space[4], paddingBottom: theme.space[8] }}>
          <View style={{ gap: theme.space[1] }}>
            <Text
              style={{
                fontSize: theme.text.titleLg.fontSize,
                lineHeight: theme.text.titleLg.lineHeight,
                fontWeight: "700",
                color: theme.colors.textPrimary,
              }}
            >
              Minha agenda
            </Text>
            <Text
              style={{
                fontSize: theme.text.body.fontSize,
                color: theme.colors.textSecondary,
              }}
            >
              Compromissos pessoais. Seus plantões continuam na escala.
            </Text>
          </View>

          <ViewToggle value={view} onChange={setView} />

          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: theme.space[2],
            }}
          >
            <TouchableOpacity
              onPress={() => setAnchor(shiftAnchor(view, anchor, -1))}
              accessibilityRole="button"
              accessibilityLabel="Período anterior"
              style={{
                width: 44,
                height: 44,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.surface,
                borderWidth: 1,
                borderColor: theme.colors.border,
              }}
            >
              <ChevronLeft size={20} color={theme.colors.textPrimary} />
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => setAnchor(todayKey)}
              accessibilityRole="button"
              accessibilityLabel={`Período atual: ${periodLabel}. Toque para voltar a hoje.`}
              style={{
                flex: 1,
                alignItems: "center",
                minHeight: 44,
                justifyContent: "center",
              }}
            >
              <Text
                style={{
                  fontSize: theme.text.title.fontSize,
                  fontWeight: "600",
                  color: theme.colors.textPrimary,
                  textTransform: "capitalize",
                }}
              >
                {periodLabel}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => setAnchor(shiftAnchor(view, anchor, 1))}
              accessibilityRole="button"
              accessibilityLabel="Próximo período"
              style={{
                width: 44,
                height: 44,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.surface,
                borderWidth: 1,
                borderColor: theme.colors.border,
              }}
            >
              <ChevronRight size={20} color={theme.colors.textPrimary} />
            </TouchableOpacity>
          </View>

          <AppButton
            title="Novo compromisso"
            onPress={createNew}
            variant="primary"
            fullWidth
          />

          {state.kind === "LOADING" ? <SkeletonList count={4} /> : null}

          {state.kind === "ERROR" ? (
            <QueryErrorState
              title="Não foi possível carregar a agenda"
              error={listQuery.error}
              onRetry={() => {
                listQuery.refetch();
              }}
            />
          ) : null}

          {state.kind === "EMPTY" ? (
            <View
              style={{
                alignItems: "center",
                gap: theme.space[3],
                paddingVertical: theme.space[10],
                paddingHorizontal: theme.space[6],
              }}
            >
              <CalendarPlus size={36} color={theme.colors.textDisabled} />
              <Text
                style={{
                  fontSize: theme.text.bodyLg.fontSize,
                  fontWeight: "600",
                  color: theme.colors.textPrimary,
                  textAlign: "center",
                }}
              >
                Nenhum compromisso neste período
              </Text>
              <Text
                style={{
                  fontSize: theme.text.body.fontSize,
                  color: theme.colors.textSecondary,
                  textAlign: "center",
                }}
              >
                Consultas, lembretes e aniversários que você registrar aqui
                ficam só com você.
              </Text>
            </View>
          ) : null}

          {state.kind === "READY"
            ? state.groups.map((group) => (
                <PersonalCalendarDaySection
                  key={group.dayKey}
                  group={group}
                  timeZone={timeZone}
                  isToday={group.dayKey === todayKey}
                  onSelectOccurrence={openEditor}
                />
              ))
            : null}
        </View>
      </ScreenContainer>
    </ScreenGradient>
  );
}
