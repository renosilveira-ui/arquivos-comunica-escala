import { Redirect } from "expo-router";
import { useTenantState } from "@/lib/tenant-state";
import { UnlinkedAccountProfile } from "@/components/OnboardingDirection";

export default function AccountProfileScreen() {
  const { activeInstitutionId } = useTenantState();
  return activeInstitutionId === null ? (
    <UnlinkedAccountProfile />
  ) : (
    <Redirect href="/(tabs)/profile" />
  );
}
