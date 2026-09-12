import { useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { Text } from "@/components/ui/Text";
import {
  PROFESSION_DEFINITION_LIST,
  getProfessionDefinition,
  type ProfessionCode,
} from "@/lib/profession-definitions";
import { AppButton } from "@/components/ui/AppButton";
import { theme } from "@/lib/theme";

export function ProfessionPicker({
  value,
  onChange,
  disabled,
}: {
  value: ProfessionCode | null;
  onChange: (value: ProfessionCode) => void;
  disabled?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <View style={{ gap: theme.space[2] }}>
      <Text style={{ ...theme.text.body, color: theme.colors.textPrimary }}>
        Profissão *
      </Text>
      <AppButton
        title={
          value
            ? getProfessionDefinition(value)!.label
            : "Selecione sua profissão"
        }
        variant="secondary"
        disabled={disabled}
        onPress={() => setVisible(true)}
        fullWidth
      />
      <Modal
        visible={visible}
        transparent
        animationType="fade"
        onRequestClose={() => setVisible(false)}
      >
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            backgroundColor: theme.colors.overlay,
            padding: theme.space[5],
          }}
        >
          <View
            accessibilityViewIsModal
            style={{
              width: "100%",
              maxWidth: theme.spacing.contentMaxWidth / 2,
              maxHeight: "85%",
              alignSelf: "center",
              backgroundColor: theme.colors.surface,
              borderRadius: theme.radius.lg,
              padding: theme.space[4],
              gap: theme.space[3],
            }}
          >
            <Text
              accessibilityRole="header"
              style={{ ...theme.text.title, color: theme.colors.textPrimary }}
            >
              Sua profissão
            </Text>
            <ScrollView>
              {PROFESSION_DEFINITION_LIST.map((profession) => (
                <Pressable
                  key={profession.code}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: value === profession.code }}
                  onPress={() => {
                    onChange(profession.code);
                    setVisible(false);
                  }}
                  style={{
                    padding: theme.space[4],
                    minHeight: theme.space[12],
                    borderRadius: theme.radius.md,
                    backgroundColor:
                      value === profession.code
                        ? theme.colors.background
                        : theme.colors.surface,
                  }}
                >
                  <Text
                    style={{
                      ...theme.text.body,
                      color: theme.colors.textPrimary,
                    }}
                  >
                    {profession.label}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <AppButton
              title="Fechar"
              variant="secondary"
              onPress={() => setVisible(false)}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}
