// app/ui-preview.tsx — galeria do sistema de UI (só em desenvolvimento).
//
// Renderiza os componentes de base com dados de exemplo, sem servidor nem
// login, para verificação visual (tamanhos, tons, contraste, alvos de
// toque) no navegador em largura de celular e no desktop. Em produção a
// rota redireciona para o login.

import { Redirect } from "expo-router";
import { RefreshControl, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { Surface, type SurfaceLevel, type SurfaceTone } from "@/components/ui/Surface";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Skeleton, SkeletonList } from "@/components/ui/Skeleton";
import { ShiftStatusBadge } from "@/components/ui/ShiftStatusBadge";
import { AppButton } from "@/components/ui/AppButton";
import { Badge } from "@/components/ui/Badge";
import { NextShiftCard } from "@/components/agenda/NextShiftCard";
import { MonthAgenda } from "@/components/agenda/MonthAgenda";
import { PanoramicAgenda } from "@/components/agenda/PanoramicAgenda";
import { ShiftRowCard } from "@/components/agenda/ShiftRowCard";
import { CalendarFrame, CalendarLegend, DayNumeral, DayRule } from "@/components/agenda/CalendarSheet";
import { ListRow } from "@/components/ui/ListRow";
import { ArrowRightLeft, Briefcase, CalendarDays, Inbox, KeyRound, LayoutDashboard, LogOut, User } from "lucide-react-native";
import { VoiceTabTrigger } from "@/components/ui/VoiceTabTrigger";
import { useActionFeedback } from "@/hooks/use-action-feedback";
import { BootScreen } from "@/components/BootScreen";
import { theme } from "@/lib/theme";

const NOW = new Date("2026-09-09T15:00:00-03:00");
const at = (d: string, h: string) => new Date(`${d}T${h}:00-03:00`);

// Semanas de exemplo para a folha de mês e a grade (hoje = qua, 09/09).
type SampleShift = { id: number; label: string; startAt: Date; endAt: Date; status: string; modality: string; coverageType: string | null; professionalNames: string[]; isMine: boolean };
const sh = (id: number, d: string, label: string, from: string, to: string, status: string, names: string[], isMine = false): SampleShift => ({
  id, label, startAt: at(d, from), endAt: at(label === "Noite" ? nextDay(d) : d, to), status, modality: "PLANTAO", coverageType: null, professionalNames: names, isMine,
});
function nextDay(d: string): string { const x = new Date(`${d}T12:00:00-03:00`); x.setDate(x.getDate() + 1); return x.toISOString().slice(0, 10); }
function sampleWeek(weekStart: string, plan: Record<number, SampleShift[]>, sector = "Centro Cirúrgico", hospital = "Hospital São Carlos", ids = [1, 1]) {
  const days = Array.from({ length: 7 }, (_, i) => {
    const x = new Date(`${weekStart}T12:00:00-03:00`); x.setDate(x.getDate() + i);
    const date = x.toISOString().slice(0, 10);
    const shifts = plan[i] ?? [];
    return { date, dow: x.getDay(), groups: shifts.length ? [{ hospitalId: ids[0], hospitalName: hospital, sectorId: ids[1], sectorName: sector, shifts }] : [] };
  });
  return { weekStart, days };
}
const SAMPLE_WEEKS = [
  sampleWeek("2026-08-31", {
    0: [sh(101, "2026-08-31", "Manhã", "07:00", "13:00", "OCUPADO", ["T. Guedes"])],
    2: [sh(102, "2026-09-02", "Noite", "19:00", "07:00", "PENDENTE", ["N. Taketomi"])],
    5: [sh(103, "2026-09-05", "Tarde", "13:00", "19:00", "VAGO", [])],
  }),
  sampleWeek("2026-09-07", {
    0: [sh(111, "2026-09-07", "Manhã", "07:00", "13:00", "OCUPADO", ["G. Barreto"])],
    2: [sh(112, "2026-09-09", "Manhã", "07:00", "13:00", "OCUPADO", ["Você"], true), sh(113, "2026-09-09", "Tarde", "13:00", "19:00", "PENDENTE", ["N. Taketomi"]), sh(114, "2026-09-09", "Noite", "19:00", "07:00", "VAGO", []), sh(115, "2026-09-09", "Noite", "19:00", "07:00", "OCUPADO", ["L. Alencar"])],
    3: [sh(116, "2026-09-10", "Dia", "07:00", "19:00", "OCUPADO", ["T. Guedes"]), sh(117, "2026-09-10", "Noite", "19:00", "07:00", "VAGO", [])],
    5: [sh(118, "2026-09-12", "Noite", "19:00", "07:00", "OCUPADO", ["G. Barreto", "L. Alencar"])],
    6: [sh(119, "2026-09-13", "Manhã", "07:00", "13:00", "OCUPADO", ["Você"], true)],
  }),
];
const SAMPLE_OFFERS = [{ id: 1, fromProfessionalName: "T. Guedes", shiftLabel: "Noite", date: "2026-09-09", timeRange: "19:00–07:00" }];
const noRefresh = <RefreshControl refreshing={false} onRefresh={() => {}} />;

export default function UiPreviewScreen() {
  if (!__DEV__) return <Redirect href="/login" />;
  return <Gallery />;
}

function Gallery() {
  const feedback = useActionFeedback();
  const { width } = useWindowDimensions();
  const isWide = width >= 1024;
  const levels: SurfaceLevel[] = ["card", "raised", "floating"];
  const tones: SurfaceTone[] = ["default", "primary", "success", "warning", "danger", "muted"];

  return (
    <ScreenGradient>
      <ScrollView contentContainerStyle={{ gap: theme.space[8], paddingBottom: theme.space[20] }} showsVerticalScrollIndicator={false}>
        <SectionHeader size="page" eyebrow="Sistema de UI" title="Galeria de componentes" subtitle="Só em desenvolvimento. Dados de exemplo." />

        <View style={{ gap: theme.space[3] }}>
          <SectionHeader title="Próximo plantão" subtitle="Compacto (Agenda): futuro com confirmação, em andamento, futuro, sem plantão — e a variante full" />
          <NextShiftCard
            now={NOW}
            needsConfirmation
            shift={{ id: 1, label: "Noite", startAt: at("2026-09-09", "19:00"), endAt: at("2026-09-10", "07:00"), status: "OCUPADO", sectorName: "Centro Cirúrgico", hospitalName: "Hospital São Carlos" }}
            onConfirm={() => feedback.success("Plantão confirmado.")}
            onSwap={() => feedback.info("Abrir pedido de troca.")}
          />
          <NextShiftCard
            now={at("2026-09-09", "21:00")}
            shift={{ id: 2, label: "Noite", startAt: at("2026-09-09", "19:00"), endAt: at("2026-09-10", "07:00"), status: "OCUPADO", sectorName: "Centro Cirúrgico" }}
            onOpenComunica={() => feedback.info("Abrindo Comunica+…")}
          />
          <NextShiftCard
            now={NOW}
            shift={{ id: 3, label: "Manhã", startAt: at("2026-09-11", "07:00"), endAt: at("2026-09-11", "13:00"), status: "PENDENTE", sectorName: "UTI" }}
            onPress={() => feedback.info("Detalhe do plantão.")}
          />
          <NextShiftCard now={NOW} shift={null} />
          <NextShiftCard
            variant="full"
            now={NOW}
            needsConfirmation
            shift={{ id: 1, label: "Noite", startAt: at("2026-09-09", "19:00"), endAt: at("2026-09-10", "07:00"), status: "OCUPADO", sectorName: "Centro Cirúrgico", hospitalName: "Hospital São Carlos" }}
            onConfirm={() => feedback.success("Plantão confirmado.")}
            onSwap={() => feedback.info("Abrir pedido de troca.")}
          />
        </View>

        <View style={{ gap: theme.space[3] }}>
          <SectionHeader title="Agenda · lista dia-a-dia" subtitle="Régua do dia com o numeral circulado (hoje = navy), plantões com barra de 4 px e fundo tinted pelo traje, dia vazio como linha fina" />
          <View style={{ gap: theme.space[2] }}>
            <DayRule day={9} title="qua, 9 set" isToday />
            <Text style={{ ...theme.text.eyebrow, fontSize: 10.5, fontWeight: theme.weight.bold, textTransform: "uppercase", color: theme.colors.textSecondary, paddingHorizontal: theme.space[3] - 1 }}>
              Hospital São Carlos · Centro Cirúrgico
            </Text>
            {SAMPLE_WEEKS[1].days[2].groups[0].shifts.map((shift) => (
              <ShiftRowCard key={shift.id} shift={shift} context="actionable" onPress={() => feedback.info(`Plantão ${shift.id}`)} />
            ))}
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: theme.space[3] - 1, minHeight: 36, borderBottomWidth: 1, borderBottomColor: theme.colors.borderStrong }}>
              <Text style={{ ...theme.text.caption, fontWeight: theme.weight.semibold, color: theme.colors.textSecondary }}>sex, 11 set</Text>
              <Text style={{ ...theme.text.caption, color: theme.colors.textDisabled }}>Sem plantões</Text>
            </View>
            <DayRule day={12} title="sáb, 12 set" isToday={false} />
            <ShiftRowCard shift={SAMPLE_WEEKS[1].days[5].groups[0].shifts[0]} context="listing" onPress={() => feedback.info("Plantão 118")} />
          </View>
        </View>

        <View style={{ gap: theme.space[3] }}>
          <SectionHeader title="Folha de mês" subtitle="Moldura navy com os dois furos, legenda dentro, hoje circulado, selecionado tingido, traços por plantão (até 3, depois +n)" />
          <MonthAgenda weeks={SAMPLE_WEEKS} monthKey="2026-09" todayKey="2026-09-09" offers={SAMPLE_OFFERS} refreshControl={noRefresh} embedInPage onShiftPress={(id) => feedback.info(`Plantão ${id}`)} onOfferPress={() => feedback.info("Oferta")} />
        </View>

        <View style={{ gap: theme.space[3] }}>
          <SectionHeader title="Panorama hospital × dia" subtitle="Desktop: cabeçalho navy com o numeral do dia, hospital escrito uma vez, malha de 1 px, fim de semana rebaixado (no celular rola na horizontal)" />
          <PanoramicAgenda weeks={[SAMPLE_WEEKS[1]]} todayKey="2026-09-09" isDesktop={isWide} refreshControl={noRefresh} onShiftPress={(id) => feedback.info(`Plantão ${id}`)} />
        </View>

        <View style={{ gap: theme.space[3] }}>
          <SectionHeader title="Peças da folha" subtitle="DayNumeral nas ênfases (hoje sobre navy, hoje, comum, meu, fora do mês) e a moldura com legenda" />
          <View style={{ flexDirection: "row", alignItems: "center", gap: theme.space[3], flexWrap: "wrap" }}>
            <View style={{ backgroundColor: theme.colors.brand, padding: theme.space[2], borderRadius: theme.radius.md }}><DayNumeral day={9} emphasis="todayOnDark" /></View>
            <DayNumeral day={9} emphasis="today" />
            <DayNumeral day={10} emphasis="default" />
            <DayNumeral day={13} emphasis="mine" />
            <DayNumeral day={12} emphasis="plain" />
            <DayNumeral day={30} emphasis="muted" />
          </View>
          <CalendarFrame>
            <CalendarLegend items={[{ label: "Ocupado", color: theme.colors.statusOcupado }, { label: "Pendente", color: theme.colors.statusPendente }, { label: "Vago", color: theme.colors.statusVagoActionable }]} />
            <View style={{ padding: theme.space[3] }}><Text style={{ ...theme.text.caption, color: theme.colors.textSecondary }}>Conteúdo da folha</Text></View>
          </CalendarFrame>
        </View>

        <View style={{ gap: theme.space[3] }}>
          <SectionHeader title="ListRow" subtitle="Linha de lista dentro de Surface padded={false}: ícone · título · subtítulo · terminador (chevron, valor, switch)" />
          <Surface padded={false}>
            <ListRow title="Painel" subtitle="Próximos 7 dias" Icon={LayoutDashboard} tone="brand" divided={false} onPress={() => feedback.info("Painel")} />
            <ListRow title="Solicitações" subtitle="Aguardando sua aprovação" Icon={Inbox} tone="warning" value="7" valueTone="count" onPress={() => feedback.info("Solicitações")} />
            <ListRow title="Instituição ativa" subtitle="Hospital São Carlos" Icon={LayoutDashboard} value="Alterar" valueTone="action" onPress={() => feedback.info("Instituição")} />
            <ListRow title="Minhas ofertas" Icon={Inbox} value="2 abertas" onPress={() => feedback.info("Ofertas")} />
            <ListRow title="Alterar senha" Icon={KeyRound} onPress={() => feedback.info("Senha")} />
            <ListRow title="Lembrete de plantão" subtitle="30 minutos antes" Icon={KeyRound} toggle={{ value: true, onValueChange: () => feedback.info("toggle") }} />
            <ListRow title="Sair da conta" Icon={LogOut} tone="danger" onPress={() => feedback.info("Sair")} />
          </Surface>
        </View>

        <View style={{ gap: theme.space[3] }}>
          <SectionHeader title="Superfícies" subtitle="3 níveis × 6 tons" />
          {levels.map((level) => (
            <View key={level} style={{ gap: theme.space[2] }}>
              <Text style={{ ...theme.text.eyebrow, textTransform: "uppercase", color: theme.colors.textMuted, fontWeight: theme.weight.bold }}>{level}</Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space[2] }}>
                {tones.map((tone) => (
                  <Surface key={tone} level={level} tone={tone} padded="compact" style={{ minWidth: 100 }}>
                    <Text style={{ ...theme.text.caption, color: theme.colors.textPrimary }}>{tone}</Text>
                  </Surface>
                ))}
              </View>
            </View>
          ))}
        </View>

        <View style={{ gap: theme.space[3] }}>
          <SectionHeader title="Status de plantão" subtitle="Texto + ícone; VAGO é vermelho só onde dá para agir" action={<Badge variant="primary">Badge</Badge>} />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: theme.space[2] }}>
            <ShiftStatusBadge status="VAGO" context="actionable" />
            <ShiftStatusBadge status="VAGO" context="listing" />
            <ShiftStatusBadge status="PENDENTE" />
            <ShiftStatusBadge status="OCUPADO" />
            <ShiftStatusBadge status="cancelada" />
            <ShiftStatusBadge status="OCUPADO" size="sm" />
          </View>
        </View>

        <View style={{ gap: theme.space[3] }}>
          <SectionHeader title="Botões" subtitle="md = 44pt (padrão), sm = 36pt + hitSlop, lg = 48pt" />
          <AppButton title="Primário md" onPress={() => feedback.success("Ação concluída.")} />
          <AppButton title="Secundário md" variant="secondary" onPress={() => feedback.error("Algo deu errado.", { retry: () => feedback.success("Tentou de novo.") })} />
          <View style={{ flexDirection: "row", gap: theme.space[2] }}>
            <AppButton title="sm" size="sm" fullWidth={false} onPress={() => feedback.info("sm")} />
            <AppButton title="lg" size="lg" fullWidth={false} onPress={() => feedback.info("lg")} />
            <AppButton title="perigo" variant="danger" fullWidth={false} onPress={() => feedback.info("danger")} />
          </View>
        </View>

        <View style={{ gap: theme.space[3] }}>
          <SectionHeader title="Barra inferior" subtitle="Quatro abas; microfone sobreposto no centro, sem quinto botão" />
          <Surface padded={false}>
            <View style={{ position: "relative" }}>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingTop: theme.space[2],
                  paddingBottom: theme.space[2],
                  borderTopWidth: 1,
                  borderTopColor: theme.colors.border,
                }}
              >
                {(
                  [
                    { label: "Agenda", Icon: CalendarDays, focused: true },
                    { label: "Trocas", Icon: ArrowRightLeft, focused: false },
                    { label: "Vagas", Icon: Briefcase, focused: false },
                    { label: "Perfil", Icon: User, focused: false },
                  ] as const
                ).map((item) => (
                  <View
                    key={item.label}
                    style={{
                      flex: 1,
                      alignItems: "center",
                      gap: theme.space[1],
                      minHeight: theme.space[10] + theme.space[1],
                      justifyContent: "center",
                    }}
                  >
                    <item.Icon
                      size={22}
                      color={item.focused ? theme.colors.primary : theme.colors.textMuted}
                    />
                    <Text
                      style={{
                        ...theme.text.caption,
                        fontWeight: item.focused ? theme.weight.bold : theme.weight.medium,
                        color: item.focused ? theme.colors.primary : theme.colors.textMuted,
                      }}
                    >
                      {item.label}
                    </Text>
                  </View>
                ))}
              </View>
              <View
                pointerEvents="box-none"
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: theme.space[1],
                  alignItems: "center",
                }}
              >
                <VoiceTabTrigger onPress={() => feedback.info("Comando de voz")} />
              </View>
            </View>
          </Surface>
        </View>

        <View style={{ gap: theme.space[3] }}>
          <SectionHeader title="Abertura do app" subtitle="BootScreen: só enquanto usuário/instituição são desconhecidos; o aviso aparece após 2,5 s" />
          <Surface padded={false} style={{ height: 320, overflow: "hidden" }}>
            <BootScreen />
          </Surface>
          <SectionHeader title="Carregando" subtitle="Skeleton no lugar do spinner central" />
          <SkeletonList count={2} />
          <Skeleton width="60%" height={theme.space[6]} />
        </View>
      </ScrollView>
    </ScreenGradient>
  );
}
