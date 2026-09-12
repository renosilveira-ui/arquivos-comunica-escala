import { QueryErrorState } from "@/components/ui/QueryErrorState";
import { useState, type ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { Redirect, useRouter } from "expo-router";
import { useAuth } from "@/hooks/use-auth";
import { useLogoutAction } from "@/hooks/use-logout-action";
import { trpc } from "@/lib/trpc";
import { useTenantState } from "@/lib/tenant-state";
import {
  managementDirection,
  operationalEntryDirection,
} from "@/lib/onboarding-direction";
import { theme } from "@/lib/theme";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { ScreenContainer } from "@/components/ui/ScreenContainer";
import { Surface } from "@/components/ui/Surface";
import { AppButton } from "@/components/ui/AppButton";

function AccountPage({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <ScreenGradient scrollable>
      <ScreenContainer>
        <View
          style={{
            width: "100%",
            maxWidth: theme.spacing.contentMaxWidth / 2,
            alignSelf: "center",
            gap: theme.space[5],
          }}
        >
          <Text
            accessibilityRole="header"
            style={{ ...theme.text.title, color: theme.colors.textPrimary }}
          >
            {title}
          </Text>
          {children}
        </View>
      </ScreenContainer>
    </ScreenGradient>
  );
}

function Message({ children }: { children: ReactNode }) {
  return (
    <Text
      accessibilityLiveRegion="polite"
      style={{ ...theme.text.body, color: theme.colors.textSecondary }}
    >
      {children}
    </Text>
  );
}

function useManagementDirection() {
  const { user } = useAuth();
  const { activeInstitutionId } = useTenantState();
  const query = trpc.professionals.getMyCapabilities.useQuery(undefined, {
    enabled: !!user && activeInstitutionId !== null,
    staleTime: 0,
    refetchOnMount: "always",
  });
  return {
    direction: managementDirection({
      institutionId: activeInstitutionId,
      fetching: query.isLoading || query.isFetching,
      error: query.isError,
      capabilities: query.data,
    }),
    retry: () => {
      void query.refetch();
    },
  };
}

export function OnboardingDirectionScreen() {
  const router = useRouter();
  const { activeInstitutionId } = useTenantState();
  const { direction, retry } = useManagementDirection();
  const [showManagementHelp, setShowManagementHelp] = useState(false);
  return (
    <AccountPage title="Como você quer começar?">
      <Message>
        Seu cadastro está pronto. Escolha o próximo passo para participar de uma
        escala.
      </Message>
      <Surface
        level="raised"
        style={{ padding: theme.space[5], gap: theme.space[3] }}
      >
        <AppButton
          title="Criar ou gerenciar uma escala"
          fullWidth
          disabled={direction === "LOADING" || direction === "UNAVAILABLE"}
          onPress={() => {
            if (direction === "CREATE") router.push("/create-shift");
            else setShowManagementHelp(true);
          }}
        />
        <Message>
          Para quem será responsável pela organização da escala.
        </Message>
        {direction === "LOADING" ? (
          <ActivityIndicator
            accessibilityLabel="Verificando acesso à gestão"
            color={theme.colors.primary}
          />
        ) : null}
        {direction === "UNAVAILABLE" ? (
          <QueryErrorState
            title="Não foi possível verificar seu acesso à gestão"
            onRetry={retry}
          />
        ) : null}
        {showManagementHelp && direction === "ADMIN_REQUIRED" ? (
          <Message>
            A gestão precisa ser liberada pela administração responsável pela
            instituição. Entre em contato com ela para solicitar a configuração
            da escala e seu acesso. Ainda não é possível enviar essa solicitação
            pelo aplicativo. Nenhum pedido foi enviado.
          </Message>
        ) : null}
      </Surface>
      <Surface
        level="raised"
        style={{ padding: theme.space[5], gap: theme.space[3] }}
      >
        <AppButton
          title="Entrar em uma escala existente"
          variant="secondary"
          fullWidth
          onPress={() => router.push("/join-schedule")}
        />
        <Message>
          Use o convite recebido por e-mail. Se ainda não recebeu, peça ao
          gestor da escala que envie para o e-mail da sua conta.
        </Message>
      </Surface>
      <AppButton
        title="Meu perfil"
        variant="secondary"
        onPress={() =>
          router.push(
            activeInstitutionId === null
              ? "/account-profile"
              : "/(tabs)/profile",
          )
        }
      />
      {activeInstitutionId !== null ? (
        <AppButton
          title="Ir para a agenda"
          variant="secondary"
          onPress={() => router.replace("/(tabs)/agenda")}
        />
      ) : null}
    </AccountPage>
  );
}

/** Account-only profile; never mounts tenant queries for an unlinked account. */
export function UnlinkedAccountProfile() {
  const { user } = useAuth();
  const router = useRouter();
  const { isLoggingOut, requestLogout } = useLogoutAction({
    scope: "UnlinkedProfile",
  });
  return (
    <AccountPage title="Meu perfil">
      <Surface style={{ padding: theme.space[5], gap: theme.space[3] }}>
        <Message>{user?.name}</Message>
        <Message>{user?.email}</Message>
        <Message>
          Sua conta ainda não tem vínculo ativo com uma instituição.
        </Message>
      </Surface>
      <AppButton
        title="Começar em uma escala"
        onPress={() => router.push("/onboarding")}
      />
      <AppButton
        title="Alterar senha"
        variant="secondary"
        onPress={() => router.push("/change-password")}
      />
      <AppButton
        title={isLoggingOut ? "Saindo…" : "Sair"}
        disabled={isLoggingOut}
        variant="secondary"
        onPress={requestLogout}
      />
    </AccountPage>
  );
}

/** Root navigation checks this before mounting create-shift, including direct URLs. */
export function CreateShiftAccessBoundary({
  children,
}: {
  children: ReactNode;
}) {
  const { direction, retry } = useManagementDirection();
  if (direction === "LOADING")
    return (
      <AccountPage title="Verificando acesso">
        <ActivityIndicator color={theme.colors.primary} />
      </AccountPage>
    );
  if (direction === "UNAVAILABLE")
    return (
      <AccountPage title="Acesso à gestão">
        <QueryErrorState
          title="Não foi possível verificar seu acesso"
          onRetry={retry}
        />
      </AccountPage>
    );
  if (direction !== "CREATE") return <Redirect href="/onboarding" />;
  return <>{children}</>;
}

/** Home entry only: existing contexts keep the usual agenda destination. */
export function OperationalEntry() {
  const query = trpc.scheduleContexts.listMine.useQuery(undefined, {
    staleTime: 0,
    refetchOnMount: "always",
  });
  const direction = operationalEntryDirection({
    fetching: query.isLoading || query.isFetching,
    error: query.isError,
    contextCount: query.data?.length,
  });
  if (direction === "LOADING")
    return (
      <AccountPage title="Verificando suas escalas">
        <ActivityIndicator color={theme.colors.primary} />
      </AccountPage>
    );
  if (direction === "UNAVAILABLE")
    return (
      <AccountPage title="Suas escalas">
        <QueryErrorState
          title="Não foi possível carregar suas escalas"
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      </AccountPage>
    );
  return (
    <Redirect
      href={direction === "ONBOARDING" ? "/onboarding" : "/(tabs)/agenda"}
    />
  );
}
