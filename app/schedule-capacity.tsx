import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { theme } from "@/lib/theme";
import { trpc } from "@/lib/trpc";
import { MAX_SHIFT_CAPACITY } from "@/lib/shift-capacity";
import { useTenantState } from "@/lib/tenant-state";

const DAYS = [
  "Domingo",
  "Segunda",
  "Terça",
  "Quarta",
  "Quinta",
  "Sexta",
  "Sábado",
];

export default function ScheduleCapacityScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ scheduleContextId: string }>();
  const scheduleContextId = Number(params.scheduleContextId);
  const { activeInstitutionId } = useTenantState();
  const utils = trpc.useUtils();
  const rules = trpc.scheduleCapacity.capacityRules.useQuery(
    {
      scheduleContextId,
      expectedInstitutionId: activeInstitutionId ?? undefined,
    },
    {
      enabled:
        !!activeInstitutionId &&
        Number.isSafeInteger(scheduleContextId) &&
        scheduleContextId > 0,
    },
  );
  const save = trpc.scheduleCapacity.saveCapacityRule.useMutation({
    onSuccess: async () => {
      await utils.scheduleCapacity.capacityRules.invalidate({
        scheduleContextId,
      });
    },
  });
  const [templateId, setTemplateId] = useState<number>();
  const [values, setValues] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const selected = rules.data?.find((template) => template.id === templateId);
  useEffect(() => {
    setTemplateId(undefined);
    setValues([]);
    setMessage("");
  }, [scheduleContextId, activeInstitutionId]);
  useEffect(() => {
    if (selected) setValues(selected.capacities.map(String));
  }, [selected]);

  async function submit() {
    if (!selected || save.isPending) return;
    const capacities = values.map(Number);
    if (
      capacities.length !== 7 ||
      capacities.some(
        (value) =>
          !Number.isSafeInteger(value) ||
          value < 1 ||
          value > MAX_SHIFT_CAPACITY,
      )
    ) {
      setMessage(
        `Informe de 1 a ${MAX_SHIFT_CAPACITY} profissionais em cada dia.`,
      );
      return;
    }
    setMessage("");
    try {
      await save.mutateAsync({
        scheduleContextId,
        expectedInstitutionId: activeInstitutionId ?? undefined,
        shiftTemplateId: selected.id,
        capacities,
      });
      setMessage("Capacidade salva. Será usada nos próximos turnos gerados.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Não foi possível salvar.",
      );
    }
  }
  return (
    <ScreenGradient scrollable>
      <View
        style={{
          padding: 24,
          gap: 18,
          width: "100%",
          maxWidth: 640,
          alignSelf: "center",
        }}
      >
        <Pressable onPress={() => router.back()} accessibilityRole="button">
          <Text style={{ color: theme.colors.primary }}>Voltar</Text>
        </Pressable>
        <Text
          style={{
            fontSize: 24,
            fontWeight: "700",
            color: theme.colors.textPrimary,
          }}
        >
          Capacidade semanal
        </Text>
        <Text style={{ color: theme.colors.textSecondary }}>
          Defina quantos profissionais são necessários em cada turno. A regra
          será usada na criação e na abertura de novos meses. Turnos já montados
          mantêm sua capacidade.
        </Text>
        {rules.isLoading ? <ActivityIndicator /> : null}
        {rules.error ? (
          <Text
            accessibilityRole="alert"
            style={{ color: theme.colors.danger }}
          >
            {rules.error.message}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
          {rules.data?.length === 0 && !rules.error ? (
            <Text style={{ color: theme.colors.textSecondary }}>
              Esta escala ainda não tem modelos de horário ativos. Configure os
              horários antes da capacidade semanal.
            </Text>
          ) : null}
          {rules.data?.map((template) => (
            <Pressable
              key={template.id}
              disabled={save.isPending}
              accessibilityRole="button"
              accessibilityState={{ selected: templateId === template.id }}
              onPress={() => {
                setTemplateId(template.id);
                setMessage("");
              }}
              style={{
                padding: 12,
                borderWidth: 1,
                borderColor:
                  templateId === template.id
                    ? theme.colors.primary
                    : theme.colors.border,
                borderRadius: 8,
              }}
            >
              <Text style={{ color: theme.colors.textPrimary }}>
                {template.name} ({template.startTime.slice(0, 5)}–
                {template.endTime.slice(0, 5)})
              </Text>
            </Pressable>
          ))}
        </View>
        {selected ? (
          <>
            {DAYS.map((day, index) => (
              <View
                key={day}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <Text style={{ color: theme.colors.textPrimary }}>{day}</Text>
                <TextInput
                  accessibilityLabel={`${day}: profissionais necessários`}
                  editable={!save.isPending}
                  keyboardType="number-pad"
                  value={values[index] ?? ""}
                  onChangeText={(value) =>
                    setValues((current) =>
                      current.map((old, i) => (i === index ? value : old)),
                    )
                  }
                  style={{
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                    borderRadius: 8,
                    padding: 12,
                    width: 90,
                    color: theme.colors.textPrimary,
                  }}
                />
              </View>
            ))}
            <Pressable
              disabled={save.isPending || rules.isFetching}
              onPress={submit}
              accessibilityRole="button"
              style={{
                padding: 16,
                borderRadius: 8,
                backgroundColor: theme.colors.primary,
              }}
            >
              <Text style={{ color: "white", textAlign: "center" }}>
                {save.isPending ? "Salvando..." : "Salvar regra deste turno"}
              </Text>
            </Pressable>
          </>
        ) : null}
        {message ? (
          <Text
            accessibilityRole="alert"
            style={{ color: theme.colors.textPrimary }}
          >
            {message}
          </Text>
        ) : null}
      </View>
    </ScreenGradient>
  );
}
