// app/ui-preview.tsx — galeria do sistema de UI (só em desenvolvimento).
//
// Renderiza os componentes de base com dados de exemplo, sem servidor nem
// login, para verificação visual (tamanhos, tons, contraste, alvos de
// toque) no navegador em largura de celular e no desktop. Em produção a
// rota redireciona para o login.

import { Redirect } from "expo-router";
import { ScrollView, Text, View } from "react-native";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { Surface, type SurfaceLevel, type SurfaceTone } from "@/components/ui/Surface";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Skeleton, SkeletonList } from "@/components/ui/Skeleton";
import { ShiftStatusBadge } from "@/components/ui/ShiftStatusBadge";
import { AppButton } from "@/components/ui/AppButton";
import { Badge } from "@/components/ui/Badge";
import { NextShiftCard } from "@/components/agenda/NextShiftCard";
import { ListRow } from "@/components/ui/ListRow";
import { Inbox, KeyRound, LayoutDashboard, LogOut } from "lucide-react-native";
import { useActionFeedback } from "@/hooks/use-action-feedback";
import { theme } from "@/lib/theme";

const NOW = new Date("2026-09-09T15:00:00-03:00");
const at = (d: string, h: string) => new Date(`${d}T${h}:00-03:00`);

export default function UiPreviewScreen() {
  if (!__DEV__) return <Redirect href="/login" />;
  return <Gallery />;
}

function Gallery() {
  const feedback = useActionFeedback();
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
          <SectionHeader title="Carregando" subtitle="Skeleton no lugar do spinner central" />
          <SkeletonList count={2} />
          <Skeleton width="60%" height={theme.space[6]} />
        </View>
      </ScrollView>
    </ScreenGradient>
  );
}
