import { useCallback, useState } from "react";
import {
  Text,
  View,
  TouchableOpacity,
  ActivityIndicator,
  TextInput,
  Modal,
  Platform,
  RefreshControl,
  KeyboardAvoidingView,
} from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { useAuth } from "@/hooks/use-auth";
import { apiFetch } from "@/lib/_core/api";
import {
  Lock,
  Plus,
  Pencil,
  Users,
  X,
  UserPlus,
  Check,
  KeyRound,
  Copy,
} from "lucide-react-native";
import { theme } from "@/lib/theme";
import { confirmAction } from "@/lib/ui/confirm";
import {
  ProfessionalQualificationPicker,
  qualificationPayload,
  type ProfessionalQualificationSelection,
} from "@/components/ProfessionalQualificationPicker";
import {
  isMedicalSpecialtyCode,
  isOperationalProfileCode,
} from "@/lib/medical-specialties";
import {
  ScheduleContextAccessPicker,
  compatibleScheduleContextIds,
  type ScheduleContextAccessOption,
} from "@/components/ScheduleContextAccessPicker";
import { formatDateTimeBR } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UserRole = "admin" | "manager" | "doctor" | "nurse" | "tech";
type ProfessionalRole = "doctor" | "nurse" | "tech";
type InstitutionRole = "USER" | "GESTOR_MEDICO" | "GESTOR_PLUS";

interface AdminUser {
  id: number;
  name: string | null;
  email: string | null;
  /** Projeção legada mantida pelo servidor para builds anteriores. */
  role: UserRole;
  globalRole: UserRole;
  roleInInstitution: InstitutionRole;
  createdAt: string;
  professional: {
    id: number;
    userRole: string;
    specialty?: string | null;
    medicalSpecialtyId?: number | null;
    medicalSpecialtyCode?: string | null;
    operationalProfileCode?: string | null;
    scheduleContextIds: number[];
  } | null;
}

/** Conta criada pelo auto-cadastro público, aguardando aprovação. */
interface PendingSignup {
  id: number;
  name: string | null;
  email: string | null;
  createdAt: string;
  institutionId: number | null;
  institutionName: string | null;
  medicalSpecialtyId: number | null;
  medicalSpecialtyCode: string | null;
  operationalProfileCode: string | null;
}

type RecentRegistrationStatus =
  | "PENDING_APPROVAL"
  | "AWAITING_SCALE"
  | "ACTIVE";

interface RecentRegistration {
  id: number;
  name: string | null;
  email: string | null;
  createdAt: string;
  status: RecentRegistrationStatus;
  institutionId: number | null;
  institutionName: string | null;
  medicalSpecialtyId: number | null;
  medicalSpecialtyCode: string | null;
  operationalProfileCode: string | null;
}

const RECENT_STATUS_LABELS: Record<RecentRegistrationStatus, string> = {
  PENDING_APPROVAL: "Aguardando aprovação",
  AWAITING_SCALE: "Aguardando escala",
  ACTIVE: "Ativo",
};

const RECENT_STATUS_BADGE: Record<RecentRegistrationStatus, BadgeVariant> = {
  PENDING_APPROVAL: "warning",
  AWAITING_SCALE: "info",
  ACTIVE: "success",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Fetch REST com URL base, sessão e tenant do app (lib/_core/api.ts).
const adminFetch = apiFetch;

const PROFESSIONAL_ROLE_LABELS: Record<ProfessionalRole, string> = {
  doctor: "Médico",
  nurse: "Enfermeiro(a)",
  tech: "Técnico(a)",
};

const PROFESSIONAL_ROLES: ProfessionalRole[] = ["doctor", "nurse", "tech"];

const INSTITUTION_ROLE_LABELS: Record<InstitutionRole, string> = {
  USER: "Usuário",
  GESTOR_MEDICO: "Gestor médico",
  GESTOR_PLUS: "Gestor+",
};

const INSTITUTION_ROLE_BADGE: Record<InstitutionRole, BadgeVariant> = {
  USER: "info",
  GESTOR_MEDICO: "warning",
  GESTOR_PLUS: "critical",
};

const INSTITUTION_ROLES: InstitutionRole[] = [
  "USER",
  "GESTOR_MEDICO",
  "GESTOR_PLUS",
];

function qualificationFromApi(input: {
  medicalSpecialtyCode?: string | null;
  operationalProfileCode?: string | null;
}): ProfessionalQualificationSelection | null {
  if (
    input.medicalSpecialtyCode &&
    isMedicalSpecialtyCode(input.medicalSpecialtyCode)
  ) {
    return { kind: "MEDICAL_SPECIALTY", code: input.medicalSpecialtyCode };
  }
  if (
    input.operationalProfileCode &&
    isOperationalProfileCode(input.operationalProfileCode)
  ) {
    return {
      kind: "OPERATIONAL_PROFILE",
      code: input.operationalProfileCode,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// CreateUserModal
// ---------------------------------------------------------------------------

function CreateUserModal({
  visible,
  scheduleContexts,
  onClose,
  onCreated,
}: {
  visible: boolean;
  scheduleContexts: ScheduleContextAccessOption[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [professionalRole, setProfessionalRole] =
    useState<ProfessionalRole>("doctor");
  const [roleInInstitution, setRoleInInstitution] =
    useState<InstitutionRole>("USER");
  const [qualification, setQualification] =
    useState<ProfessionalQualificationSelection | null>(null);
  const [scheduleContextIds, setScheduleContextIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const reset = () => {
    setName("");
    setEmail("");
    setPassword("");
    setProfessionalRole("doctor");
    setRoleInInstitution("USER");
    setQualification(null);
    setScheduleContextIds([]);
    setError("");
  };

  const handleCreate = async () => {
    if (!name.trim() || !email.trim() || !password.trim()) {
      setError("Preencha todos os campos");
      return;
    }
    if (password.length < 8 || password.length > 128) {
      setError("A senha deve ter entre 8 e 128 caracteres");
      return;
    }
    if (professionalRole === "doctor" && !qualification) {
      setError("Selecione a especialidade ou o perfil médico generalista");
      return;
    }
    if (professionalRole === "doctor" && scheduleContextIds.length === 0) {
      setError("Selecione ao menos uma escala e setor");
      return;
    }
    setLoading(true);
    setError("");
    const res = await adminFetch<{ user?: unknown; error?: string }>(
      "/api/auth/register",
      {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          password,
          professionalRole,
          roleInInstitution,
          ...qualificationPayload(
            professionalRole === "doctor" ? qualification : null,
          ),
          ...(professionalRole === "doctor" ? { scheduleContextIds } : {}),
        }),
      },
    );
    setLoading(false);
    if (res.ok) {
      reset();
      onCreated();
      onClose();
    } else {
      setError(res.data?.error ?? "Erro ao criar usuário");
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: theme.colors.overlay,
        }}
      >
        <View
          style={{
            width: "90%",
            maxWidth: 420,
            backgroundColor: theme.colors.surface,
            borderRadius: 16,
            padding: 24,
          }}
        >
          {/* Header */}
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 20,
            }}
          >
            <Text
              style={{
                color: theme.colors.textPrimary,
                fontSize: 20,
                fontWeight: "700",
              }}
            >
              Novo Profissional
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <X size={22} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Nome */}
          <Text
            style={{
              color: theme.colors.textSecondary,
              fontSize: 14,
              marginBottom: 6,
            }}
          >
            Nome
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Nome completo"
            placeholderTextColor={theme.colors.textMuted}
            style={{
              backgroundColor: theme.colors.surface,
              color: theme.colors.textPrimary,
              borderRadius: theme.borderRadius.input,
              padding: 12,
              fontSize: 16,
              marginBottom: 14,
            }}
          />

          {/* Email */}
          <Text
            style={{
              color: theme.colors.textSecondary,
              fontSize: 14,
              marginBottom: 6,
            }}
          >
            E-mail
          </Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="email@exemplo.com"
            placeholderTextColor={theme.colors.textMuted}
            keyboardType="email-address"
            autoCapitalize="none"
            style={{
              backgroundColor: theme.colors.surface,
              color: theme.colors.textPrimary,
              borderRadius: theme.borderRadius.input,
              padding: 12,
              fontSize: 16,
              marginBottom: 14,
            }}
          />

          {/* Senha */}
          <Text
            style={{
              color: theme.colors.textSecondary,
              fontSize: 14,
              marginBottom: 6,
            }}
          >
            Senha
          </Text>
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="Mín. 8 caracteres"
            placeholderTextColor={theme.colors.textMuted}
            secureTextEntry
            style={{
              backgroundColor: theme.colors.surface,
              color: theme.colors.textPrimary,
              borderRadius: theme.borderRadius.input,
              padding: 12,
              fontSize: 16,
              marginBottom: 14,
            }}
          />

          {/* Função profissional e autorização são eixos distintos. */}
          <Text
            style={{
              color: theme.colors.textSecondary,
              fontSize: 14,
              marginBottom: 6,
            }}
          >
            Função profissional
          </Text>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: 20,
            }}
          >
            {PROFESSIONAL_ROLES.map((r) => (
              <TouchableOpacity
                key={r}
                onPress={() => {
                  setProfessionalRole(r);
                  if (r !== "doctor") {
                    setQualification(null);
                    setScheduleContextIds([]);
                  }
                }}
                style={{
                  backgroundColor:
                    professionalRole === r
                      ? theme.colors.primary
                      : theme.colors.surface,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 8,
                }}
              >
                <Text
                  style={{
                    color:
                      professionalRole === r
                        ? theme.colors.onDark.text
                        : theme.colors.textSecondary,
                    fontSize: 14,
                    fontWeight: "600",
                  }}
                >
                  {PROFESSIONAL_ROLE_LABELS[r]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {professionalRole === "doctor" ? (
            <View style={{ marginBottom: 20 }}>
              <ProfessionalQualificationPicker
                value={qualification}
                onChange={(value) => {
                  setQualification(value);
                  setScheduleContextIds((current) =>
                    compatibleScheduleContextIds({
                      contexts: scheduleContexts,
                      qualification: value,
                      selectedIds: current,
                    }),
                  );
                }}
                required
              />
              <View style={{ marginTop: 14 }}>
                <ScheduleContextAccessPicker
                  contexts={scheduleContexts}
                  qualification={qualification}
                  selectedIds={scheduleContextIds}
                  onChange={setScheduleContextIds}
                  required
                />
              </View>
            </View>
          ) : null}

          <Text
            style={{
              color: theme.colors.textSecondary,
              fontSize: 14,
              marginBottom: 6,
            }}
          >
            Papel nesta instituição
          </Text>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: 20,
            }}
          >
            {INSTITUTION_ROLES.map((r) => (
              <TouchableOpacity
                key={r}
                onPress={() => setRoleInInstitution(r)}
                style={{
                  backgroundColor:
                    roleInInstitution === r
                      ? theme.colors.primary
                      : theme.colors.surface,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 8,
                }}
              >
                <Text
                  style={{
                    color:
                      roleInInstitution === r
                        ? theme.colors.onDark.text
                        : theme.colors.textSecondary,
                    fontSize: 14,
                    fontWeight: "600",
                  }}
                >
                  {INSTITUTION_ROLE_LABELS[r]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {error ? (
            <Text
              style={{
                color: theme.colors.danger,
                fontSize: 14,
                marginBottom: 12,
              }}
            >
              {error}
            </Text>
          ) : null}

          <TouchableOpacity
            onPress={handleCreate}
            disabled={loading}
            style={{
              backgroundColor: theme.colors.primary,
              borderRadius: theme.borderRadius.button,
              padding: 14,
              alignItems: "center",
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? (
              <ActivityIndicator color={theme.colors.onDark.text} />
            ) : (
              <Text
                style={{
                  color: theme.colors.onDark.text,
                  fontSize: 16,
                  fontWeight: "700",
                }}
              >
                Criar Usuário
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// EditUserModal
// ---------------------------------------------------------------------------

function EditUserModal({
  visible,
  user: editUser,
  scheduleContexts,
  onClose,
  onUpdated,
}: {
  visible: boolean;
  user: AdminUser | null;
  scheduleContexts: ScheduleContextAccessOption[];
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [roleInInstitution, setRoleInInstitution] =
    useState<InstitutionRole>("USER");
  const [qualification, setQualification] =
    useState<ProfessionalQualificationSelection | null>(null);
  const [scheduleContextIds, setScheduleContextIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Senha temporária (frente A3): mostrada UMA vez após "Redefinir senha".
  const [resetting, setResetting] = useState(false);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Populate when modal opens or editUser changes
  useFocusEffect(
    useCallback(() => {
      if (visible && editUser) {
        setName(editUser.name ?? "");
        setEmail(editUser.email ?? "");
        setRoleInInstitution(editUser.roleInInstitution);
        setQualification(
          qualificationFromApi({
            medicalSpecialtyCode: editUser.professional?.medicalSpecialtyCode,
            operationalProfileCode:
              editUser.professional?.operationalProfileCode,
          }),
        );
        setScheduleContextIds(editUser.professional?.scheduleContextIds ?? []);
        setError("");
        setTempPassword(null);
        setCopied(false);
      }
    }, [visible, editUser]),
  );

  const handleResetPassword = async () => {
    if (!editUser) return;
    const confirmed = await confirmAction(
      `Redefinir a senha de ${editUser.name ?? editUser.email ?? "este usuário"}?\n\nA senha atual deixa de valer. Uma senha temporária será exibida uma única vez e o usuário terá que trocá-la no próximo login.`,
    );
    if (!confirmed) return;
    setResetting(true);
    setError("");
    try {
      const res = await adminFetch<{
        temporaryPassword?: string;
        error?: string;
      }>(`/api/admin/users/${editUser.id}/reset-password`, { method: "POST" });
      if (res.ok && res.data?.temporaryPassword) {
        setTempPassword(res.data.temporaryPassword);
        setCopied(false);
      } else {
        setError(res.data?.error ?? "Erro ao redefinir senha");
      }
    } catch {
      setError("Erro ao redefinir senha");
    } finally {
      setResetting(false);
    }
  };

  const handleCopyTempPassword = async () => {
    if (!tempPassword) return;
    // Sem expo-clipboard no projeto: no web usa a Clipboard API; no
    // nativo o texto é selecionável (pressionar e segurar → copiar).
    if (
      Platform.OS === "web" &&
      typeof navigator !== "undefined" &&
      navigator.clipboard
    ) {
      try {
        await navigator.clipboard.writeText(tempPassword);
        setCopied(true);
      } catch {
        setCopied(false);
      }
    }
  };

  const handleUpdate = async () => {
    if (!editUser) return;
    if (!name.trim() || !email.trim()) {
      setError("Nome e e-mail são obrigatórios");
      return;
    }
    const isDoctor = editUser.globalRole === "doctor";
    if (isDoctor && !qualification) {
      setError("Selecione a especialidade ou o perfil médico generalista");
      return;
    }
    if (isDoctor && scheduleContextIds.length === 0) {
      setError("Selecione ao menos uma escala e setor");
      return;
    }
    setLoading(true);
    setError("");
    const res = await adminFetch<{ user?: unknown; error?: string }>(
      `/api/admin/users/${editUser.id}`,
      {
        method: "PUT",
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          roleInInstitution,
          ...qualificationPayload(isDoctor ? qualification : null),
          ...(isDoctor ? { scheduleContextIds } : {}),
        }),
      },
    );
    setLoading(false);
    if (res.ok) {
      onUpdated();
      onClose();
    } else {
      setError(res.data?.error ?? "Erro ao atualizar");
    }
  };

  if (!editUser) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: theme.colors.overlay,
        }}
      >
        <View
          style={{
            width: "90%",
            maxWidth: 420,
            backgroundColor: theme.colors.surface,
            borderRadius: 16,
            padding: 24,
          }}
        >
          {/* Header */}
          <View
            style={{
              flexDirection: "row",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 20,
            }}
          >
            <Text
              style={{
                color: theme.colors.textPrimary,
                fontSize: 20,
                fontWeight: "700",
              }}
            >
              Editar Profissional
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <X size={22} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {/* Nome */}
          <Text
            style={{
              color: theme.colors.textSecondary,
              fontSize: 14,
              marginBottom: 6,
            }}
          >
            Nome
          </Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Nome completo"
            placeholderTextColor={theme.colors.textMuted}
            style={{
              backgroundColor: theme.colors.surface,
              color: theme.colors.textPrimary,
              borderRadius: theme.borderRadius.input,
              padding: 12,
              fontSize: 16,
              marginBottom: 14,
            }}
          />

          {/* Email */}
          <Text
            style={{
              color: theme.colors.textSecondary,
              fontSize: 14,
              marginBottom: 6,
            }}
          >
            E-mail
          </Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="email@exemplo.com"
            placeholderTextColor={theme.colors.textMuted}
            keyboardType="email-address"
            autoCapitalize="none"
            style={{
              backgroundColor: theme.colors.surface,
              color: theme.colors.textPrimary,
              borderRadius: theme.borderRadius.input,
              padding: 12,
              fontSize: 16,
              marginBottom: 14,
            }}
          />

          {editUser.globalRole === "doctor" ? (
            <View style={{ marginBottom: 14, gap: 14 }}>
              <ProfessionalQualificationPicker
                value={qualification}
                onChange={(value) => {
                  setQualification(value);
                  setScheduleContextIds((current) =>
                    compatibleScheduleContextIds({
                      contexts: scheduleContexts,
                      qualification: value,
                      selectedIds: current,
                    }),
                  );
                }}
                required
              />
              <ScheduleContextAccessPicker
                contexts={scheduleContexts}
                qualification={qualification}
                selectedIds={scheduleContextIds}
                onChange={setScheduleContextIds}
                required
              />
            </View>
          ) : null}

          {/* Papel institucional — não altera o papel global da conta. */}
          <Text
            style={{
              color: theme.colors.textSecondary,
              fontSize: 14,
              marginBottom: 6,
            }}
          >
            Papel nesta instituição
          </Text>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: 20,
            }}
          >
            {INSTITUTION_ROLES.map((r) => (
              <TouchableOpacity
                key={r}
                onPress={() => setRoleInInstitution(r)}
                style={{
                  backgroundColor:
                    roleInInstitution === r
                      ? theme.colors.primary
                      : theme.colors.surface,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 8,
                }}
              >
                <Text
                  style={{
                    color:
                      roleInInstitution === r
                        ? theme.colors.onDark.text
                        : theme.colors.textSecondary,
                    fontSize: 14,
                    fontWeight: "600",
                  }}
                >
                  {INSTITUTION_ROLE_LABELS[r]}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {error ? (
            <Text
              style={{
                color: theme.colors.danger,
                fontSize: 14,
                marginBottom: 12,
              }}
            >
              {error}
            </Text>
          ) : null}

          <TouchableOpacity
            onPress={handleUpdate}
            disabled={loading}
            style={{
              backgroundColor: theme.colors.primary,
              borderRadius: theme.borderRadius.button,
              padding: 14,
              alignItems: "center",
              opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? (
              <ActivityIndicator color={theme.colors.onDark.text} />
            ) : (
              <Text
                style={{
                  color: theme.colors.onDark.text,
                  fontSize: 16,
                  fontWeight: "700",
                }}
              >
                Salvar Alterações
              </Text>
            )}
          </TouchableOpacity>

          {/* Redefinir senha (senha temporária + troca obrigatória) */}
          <View
            style={{
              marginTop: theme.space[4],
              paddingTop: theme.space[4],
              borderTopWidth: 1,
              borderTopColor: theme.colors.border,
              gap: theme.space[3],
            }}
          >
            {tempPassword ? (
              <View
                style={{
                  backgroundColor: theme.colors.warningSoft,
                  borderRadius: theme.borderRadius.input,
                  padding: theme.space[3],
                  gap: theme.space[2],
                }}
              >
                <Text
                  style={{
                    ...theme.text.body,
                    color: theme.colors.textSecondary,
                  }}
                >
                  Senha temporária — anote agora, ela não será exibida de novo.
                  O usuário terá que trocá-la no próximo login.
                </Text>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: theme.space[2],
                  }}
                >
                  <Text
                    selectable
                    accessibilityLabel={`Senha temporária: ${tempPassword}`}
                    style={{
                      flex: 1,
                      fontFamily: theme.fontFamily.mono,
                      ...theme.text.title,
                      fontWeight: theme.weight.bold,
                      color: theme.colors.textPrimary,
                      letterSpacing: 1,
                    }}
                  >
                    {tempPassword}
                  </Text>
                  {Platform.OS === "web" ? (
                    <TouchableOpacity
                      onPress={handleCopyTempPassword}
                      accessibilityRole="button"
                      accessibilityLabel="Copiar senha temporária"
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: theme.space[1],
                        backgroundColor: theme.colors.surface,
                        borderWidth: 1,
                        borderColor: theme.colors.border,
                        borderRadius: theme.borderRadius.button,
                        paddingHorizontal: theme.space[3],
                        paddingVertical: theme.space[2],
                      }}
                    >
                      <Copy size={16} color={theme.colors.textSecondary} />
                      <Text
                        style={{
                          ...theme.text.body,
                          fontWeight: theme.weight.semibold,
                          color: theme.colors.textSecondary,
                        }}
                      >
                        {copied ? "Copiado" : "Copiar"}
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              </View>
            ) : (
              <TouchableOpacity
                onPress={handleResetPassword}
                disabled={resetting}
                accessibilityRole="button"
                accessibilityLabel="Redefinir senha do usuário"
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: theme.space[2],
                  borderWidth: 1.5,
                  borderColor: theme.colors.warning,
                  borderRadius: theme.borderRadius.button,
                  padding: theme.space[3],
                  opacity: resetting ? 0.6 : 1,
                }}
              >
                {resetting ? (
                  <ActivityIndicator color={theme.colors.warning} />
                ) : (
                  <>
                    <KeyRound size={16} color={theme.colors.warning} />
                    <Text
                      style={{
                        ...theme.text.body,
                        fontWeight: theme.weight.bold,
                        color: theme.colors.warning,
                      }}
                    >
                      Redefinir senha
                    </Text>
                  </>
                )}
              </TouchableOpacity>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main Screen
// ---------------------------------------------------------------------------

export default function AdminScreen() {
  const { user } = useAuth();
  const router = useRouter();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [recentRegistrations, setRecentRegistrations] = useState<
    RecentRegistration[]
  >([]);
  const [scheduleContexts, setScheduleContexts] = useState<
    ScheduleContextAccessOption[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Modals
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<AdminUser | null>(null);

  // Cadastros pendentes (auto-cadastro público)
  const [pendingSignups, setPendingSignups] = useState<PendingSignup[]>([]);
  const [pendingBusyId, setPendingBusyId] = useState<number | null>(null);
  const [pendingQualifications, setPendingQualifications] = useState<
    Record<number, ProfessionalQualificationSelection | null>
  >({});
  const [pendingScheduleContextIds, setPendingScheduleContextIds] = useState<
    Record<number, number[]>
  >({});
  const [pendingError, setPendingError] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await adminFetch<{ users: AdminUser[] }>("/api/admin/users");
      console.log(
        "[AdminScreen] fetchUsers response:",
        res.ok,
        "count:",
        res.data?.users?.length,
      );
      if (res.ok && res.data?.users) {
        setUsers(res.data.users);
      }
    } catch (err) {
      console.error("[AdminScreen] fetchUsers error:", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const fetchScheduleContexts = useCallback(async () => {
    try {
      const res = await adminFetch<{
        contexts: ScheduleContextAccessOption[];
      }>("/api/admin/schedule-contexts");
      if (res.ok && res.data?.contexts) {
        setScheduleContexts(res.data.contexts);
      }
    } catch (err) {
      console.error("[AdminScreen] fetchScheduleContexts error:", err);
    }
  }, []);

  const fetchRecentRegistrations = useCallback(async () => {
    try {
      const res = await adminFetch<{ registrations: RecentRegistration[] }>(
        "/api/admin/recent-registrations",
      );
      if (res.ok && res.data?.registrations) {
        setRecentRegistrations(res.data.registrations);
      }
    } catch (err) {
      console.error("[AdminScreen] fetchRecentRegistrations error:", err);
    }
  }, []);

  const fetchPendingSignups = useCallback(async () => {
    try {
      const res = await adminFetch<{ pending: PendingSignup[] }>(
        "/api/admin/pending-signups",
      );
      if (res.ok && res.data?.pending) {
        setPendingSignups(res.data.pending);
        setPendingQualifications((current) => {
          const next: Record<
            number,
            ProfessionalQualificationSelection | null
          > = {};
          for (const signup of res.data!.pending) {
            next[signup.id] =
              current[signup.id] ?? qualificationFromApi(signup);
          }
          return next;
        });
      }
    } catch (err) {
      console.error("[AdminScreen] fetchPendingSignups error:", err);
    }
  }, []);

  const handleSignupDecision = useCallback(
    async (
      signupId: number,
      decision: "approve" | "reject",
      qualification?: ProfessionalQualificationSelection | null,
      scheduleContextIds: number[] = [],
    ) => {
      if (decision === "approve" && !qualification) {
        setPendingError(
          "Selecione a qualificação médica antes de aprovar o cadastro.",
        );
        return;
      }
      if (decision === "approve" && scheduleContextIds.length === 0) {
        setPendingError(
          "Selecione ao menos uma escala e setor antes de aprovar.",
        );
        return;
      }
      setPendingError(null);
      setPendingBusyId(signupId);
      try {
        const res = await adminFetch<{ ok?: boolean; error?: string }>(
          `/api/admin/pending-signups/${signupId}/${decision}`,
          {
            method: "POST",
            ...(decision === "approve"
              ? {
                  body: JSON.stringify({
                    ...qualificationPayload(qualification ?? null),
                    scheduleContextIds,
                  }),
                }
              : {}),
          },
        );
        if (res.ok) {
          setPendingSignups((prev) => prev.filter((p) => p.id !== signupId));
          setPendingQualifications((current) => {
            const next = { ...current };
            delete next[signupId];
            return next;
          });
          setPendingScheduleContextIds((current) => {
            const next = { ...current };
            delete next[signupId];
            return next;
          });
          fetchUsers();
        } else {
          setPendingError(
            res.data?.error ?? "Não foi possível concluir a decisão.",
          );
        }
      } finally {
        setPendingBusyId(null);
      }
    },
    [fetchUsers],
  );

  useFocusEffect(
    useCallback(() => {
      fetchUsers();
      fetchScheduleContexts();
      fetchPendingSignups();
      fetchRecentRegistrations();
    }, [
      fetchUsers,
      fetchScheduleContexts,
      fetchPendingSignups,
      fetchRecentRegistrations,
    ]),
  );

  const handleRefresh = () => {
    setRefreshing(true);
    fetchUsers();
    fetchScheduleContexts();
    fetchPendingSignups();
    fetchRecentRegistrations();
  };

  const matchesSearch = useCallback(
    (name: string | null, email: string | null) => {
      const query = searchQuery.trim().toLowerCase();
      if (!query) return true;
      return (
        (name ?? "").toLowerCase().includes(query) ||
        (email ?? "").toLowerCase().includes(query)
      );
    },
    [searchQuery],
  );

  // Filter users by search
  const filtered = users.filter((u) => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return true;
    return (
      (u.name ?? "").toLowerCase().includes(query) ||
      (u.email ?? "").toLowerCase().includes(query) ||
      INSTITUTION_ROLE_LABELS[u.roleInInstitution]
        .toLowerCase()
        .includes(query)
    );
  });

  const filteredRecent = recentRegistrations.filter((registration) =>
    matchesSearch(registration.name, registration.email),
  );

  // Guards
  if (!user) {
    return (
      <ScreenGradient variant="dark" scrollable={false}>
        <View
          style={{ flex: 1, justifyContent: "center", alignItems: "center" }}
        >
          <Text style={{ color: theme.colors.onDark.textMuted, fontSize: 16 }}>
            Faça login para continuar
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  if (user.role !== "admin") {
    return (
      <ScreenGradient variant="dark" scrollable={false}>
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            alignItems: "center",
            gap: 16,
          }}
        >
          <Lock size={48} color={theme.colors.onDark.textDisabled} />
          <Text style={{ color: theme.colors.onDark.textMuted, fontSize: 16 }}>
            Acesso restrito a administradores
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  // Render
  return (
    <ScreenGradient
      variant="dark"
      scrollable
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={handleRefresh}
          tintColor={theme.colors.onDark.text}
        />
      }
    >
      <View style={{ gap: 20 }}>
        {/* Header */}
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Users size={28} color={theme.colors.onDark.text} />
            <Text
              style={{
                color: theme.colors.onDark.text,
                fontSize: 26,
                fontWeight: "800",
              }}
            >
              Administração
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => setShowCreate(true)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              backgroundColor: theme.colors.primary,
              paddingHorizontal: 14,
              paddingVertical: 10,
              borderRadius: theme.borderRadius.button,
            }}
          >
            <Plus size={18} color={theme.colors.onDark.text} />
            <Text
              style={{
                color: theme.colors.onDark.text,
                fontSize: 14,
                fontWeight: "700",
              }}
            >
              Novo
            </Text>
          </TouchableOpacity>
        </View>

        {/* Search */}
        <View
          style={{
            backgroundColor: theme.colors.surface,
            borderRadius: theme.borderRadius.input,
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 14,
          }}
        >
          <Text style={{ color: theme.colors.textMuted, fontSize: 16 }}>
            🔍
          </Text>
          <TextInput
            placeholder="Buscar por nome, e-mail ou cargo..."
            placeholderTextColor={theme.colors.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            style={{
              flex: 1,
              color: theme.colors.textPrimary,
              fontSize: 16,
              paddingVertical: 12,
              paddingHorizontal: 10,
            }}
          />
        </View>

        {/* Stats */}
        <View style={{ flexDirection: "row", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <TintedGlassCard>
              <Text
                style={{ color: theme.colors.onDark.textMuted, fontSize: 13 }}
              >
                Total de Usuários
              </Text>
              <Text
                style={{
                  color: theme.colors.onDark.text,
                  fontSize: 28,
                  fontWeight: "800",
                  marginTop: 4,
                }}
              >
                {users.length}
              </Text>
            </TintedGlassCard>
          </View>
          <View style={{ flex: 1 }}>
            <TintedGlassCard>
              <Text
                style={{ color: theme.colors.onDark.textMuted, fontSize: 13 }}
              >
                Cadastros recentes
              </Text>
              <Text
                style={{
                  color: theme.colors.onDark.text,
                  fontSize: 28,
                  fontWeight: "800",
                  marginTop: 4,
                }}
              >
                {recentRegistrations.length}
              </Text>
            </TintedGlassCard>
          </View>
        </View>

        {/* Cadastros recentes — inclui quem criou conta e ainda aguarda escala */}
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <UserPlus size={20} color={theme.colors.primary} />
            <Text
              style={{
                color: theme.colors.onDark.text,
                fontSize: 18,
                fontWeight: "700",
              }}
            >
              Cadastros recentes
            </Text>
            <Badge variant="info">{String(filteredRecent.length)}</Badge>
          </View>
          <Text
            style={{
              color: theme.colors.onDark.textMuted,
              fontSize: 13,
              lineHeight: 18,
            }}
          >
            Últimos 30 dias. Quem se cadastrou pelo app e ainda não entrou em
            nenhuma escala aparece aqui como &quot;Aguardando escala&quot;.
          </Text>
          {filteredRecent.length === 0 ? (
            <TintedGlassCard>
              <Text
                style={{
                  color: theme.colors.onDark.textMuted,
                  fontSize: 14,
                  textAlign: "center",
                  paddingVertical: 12,
                }}
              >
                {searchQuery.trim()
                  ? "Nenhum cadastro recente encontrado"
                  : "Nenhum cadastro recente nos últimos 30 dias"}
              </Text>
            </TintedGlassCard>
          ) : (
            filteredRecent.map((registration) => (
              <TintedGlassCard key={`recent-${registration.id}`}>
                <View style={{ gap: 8 }}>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "flex-start",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text
                        style={{
                          color: theme.colors.onDark.text,
                          fontSize: 17,
                          fontWeight: "700",
                        }}
                      >
                        {registration.name ?? "Sem nome"}
                      </Text>
                      <Text
                        style={{
                          color: theme.colors.onDark.textMuted,
                          fontSize: 14,
                        }}
                      >
                        {registration.email ?? "—"}
                      </Text>
                      <Text
                        style={{
                          color: theme.colors.onDark.textDisabled,
                          fontSize: 12,
                        }}
                      >
                        Cadastrou em{" "}
                        {formatDateTimeBR(registration.createdAt) || "—"}
                      </Text>
                    </View>
                    <Badge variant={RECENT_STATUS_BADGE[registration.status]}>
                      {RECENT_STATUS_LABELS[registration.status]}
                    </Badge>
                  </View>
                  {registration.status === "AWAITING_SCALE" ? (
                    <TouchableOpacity
                      onPress={() => router.push("/schedule-invites")}
                      activeOpacity={0.8}
                      style={{
                        alignSelf: "flex-start",
                        backgroundColor: theme.colors.primary,
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        borderRadius: theme.borderRadius.button,
                      }}
                    >
                      <Text
                        style={{
                          color: theme.colors.onDark.text,
                          fontSize: 13,
                          fontWeight: "700",
                        }}
                      >
                        Enviar convite da escala
                      </Text>
                    </TouchableOpacity>
                  ) : null}
                </View>
              </TintedGlassCard>
            ))
          )}
        </View>

        {/* Cadastros pendentes (auto-cadastro público) */}
        {pendingSignups.length > 0 && (
          <View style={{ gap: 10 }}>
            <View
              style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
            >
              <UserPlus size={20} color={theme.colors.warning} />
              <Text
                style={{
                  color: theme.colors.onDark.text,
                  fontSize: 18,
                  fontWeight: "700",
                }}
              >
                Cadastros pendentes
              </Text>
              <Badge variant="warning">{String(pendingSignups.length)}</Badge>
            </View>
            {pendingError ? (
              <Text style={{ color: theme.colors.danger, fontSize: 13 }}>
                {pendingError}
              </Text>
            ) : null}
            {pendingSignups.map((p) => (
              <TintedGlassCard key={p.id}>
                <View style={{ gap: 12 }}>
                  <View style={{ gap: 4 }}>
                    <Text
                      style={{
                        color: theme.colors.onDark.text,
                        fontSize: 17,
                        fontWeight: "700",
                      }}
                    >
                      {p.name ?? "Sem nome"}
                    </Text>
                    <Text
                      style={{
                        color: theme.colors.onDark.textMuted,
                        fontSize: 14,
                      }}
                    >
                      {p.email ?? "—"}
                    </Text>
                    {p.institutionName && (
                      <Text
                        style={{
                          color: theme.colors.onDark.textMuted,
                          fontSize: 13,
                        }}
                      >
                        Instituição: {p.institutionName}
                      </Text>
                    )}
                  </View>
                  <ProfessionalQualificationPicker
                    value={pendingQualifications[p.id] ?? null}
                    onChange={(value) => {
                      setPendingQualifications((current) => ({
                        ...current,
                        [p.id]: value,
                      }));
                      setPendingScheduleContextIds((current) => ({
                        ...current,
                        [p.id]: compatibleScheduleContextIds({
                          contexts: scheduleContexts,
                          qualification: value,
                          selectedIds: current[p.id] ?? [],
                        }),
                      }));
                    }}
                    required
                    tone="dark"
                  />
                  <ScheduleContextAccessPicker
                    contexts={scheduleContexts}
                    qualification={pendingQualifications[p.id] ?? null}
                    selectedIds={pendingScheduleContextIds[p.id] ?? []}
                    onChange={(ids) =>
                      setPendingScheduleContextIds((current) => ({
                        ...current,
                        [p.id]: ids,
                      }))
                    }
                    required
                    tone="dark"
                  />
                  <View style={{ flexDirection: "row", gap: 10 }}>
                    <TouchableOpacity
                      onPress={() =>
                        handleSignupDecision(
                          p.id,
                          "approve",
                          pendingQualifications[p.id],
                          pendingScheduleContextIds[p.id] ?? [],
                        )
                      }
                      disabled={
                        pendingBusyId === p.id ||
                        !pendingQualifications[p.id] ||
                        (pendingScheduleContextIds[p.id]?.length ?? 0) === 0
                      }
                      activeOpacity={0.8}
                      style={{
                        flex: 1,
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 6,
                        backgroundColor: theme.colors.success,
                        paddingVertical: 10,
                        borderRadius: theme.borderRadius.button,
                        opacity:
                          pendingBusyId === p.id ||
                          !pendingQualifications[p.id] ||
                          (pendingScheduleContextIds[p.id]?.length ?? 0) === 0
                            ? 0.6
                            : 1,
                      }}
                    >
                      {pendingBusyId === p.id ? (
                        <ActivityIndicator
                          size="small"
                          color={theme.colors.onDark.text}
                        />
                      ) : (
                        <>
                          <Check size={16} color={theme.colors.onDark.text} />
                          <Text
                            style={{
                              color: theme.colors.onDark.text,
                              fontSize: 14,
                              fontWeight: "700",
                            }}
                          >
                            Aprovar
                          </Text>
                        </>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => handleSignupDecision(p.id, "reject")}
                      disabled={pendingBusyId === p.id}
                      activeOpacity={0.8}
                      style={{
                        flex: 1,
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 6,
                        backgroundColor: "transparent",
                        borderWidth: 1.5,
                        borderColor: theme.colors.danger,
                        paddingVertical: 10,
                        borderRadius: theme.borderRadius.button,
                        opacity: pendingBusyId === p.id ? 0.6 : 1,
                      }}
                    >
                      <X size={16} color={theme.colors.danger} />
                      <Text
                        style={{
                          color: theme.colors.danger,
                          fontSize: 14,
                          fontWeight: "700",
                        }}
                      >
                        Recusar
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </TintedGlassCard>
            ))}
          </View>
        )}

        {/* User list */}
        {loading ? (
          <View style={{ alignItems: "center", paddingVertical: 40 }}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </View>
        ) : filtered.length === 0 ? (
          <TintedGlassCard>
            <View style={{ alignItems: "center", paddingVertical: 32 }}>
              <Users size={48} color={theme.colors.onDark.textDisabled} />
              <Text
                style={{
                  color: theme.colors.onDark.textDisabled,
                  fontSize: 16,
                  marginTop: 16,
                }}
              >
                {searchQuery
                  ? "Nenhum resultado encontrado"
                  : "Nenhum usuário cadastrado"}
              </Text>
            </View>
          </TintedGlassCard>
        ) : (
          <View style={{ gap: 10 }}>
            {filtered.map((u) => (
              <TintedGlassCard key={u.id} onPress={() => setEditTarget(u)}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text
                      style={{
                        color: theme.colors.onDark.text,
                        fontSize: 17,
                        fontWeight: "700",
                      }}
                    >
                      {u.name ?? "Sem nome"}
                    </Text>
                    <Text
                      style={{
                        color: theme.colors.onDark.textMuted,
                        fontSize: 14,
                      }}
                    >
                      {u.email ?? "\u2014"}
                    </Text>
                    {u.createdAt ? (
                      <Text
                        style={{
                          color: theme.colors.onDark.textDisabled,
                          fontSize: 12,
                        }}
                      >
                        Cadastrou em {formatDateTimeBR(u.createdAt)}
                      </Text>
                    ) : null}
                  </View>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <Badge
                      variant={INSTITUTION_ROLE_BADGE[u.roleInInstitution]}
                    >
                      {INSTITUTION_ROLE_LABELS[u.roleInInstitution]}
                    </Badge>
                    <TouchableOpacity
                      onPress={() => setEditTarget(u)}
                      hitSlop={10}
                      style={{
                        backgroundColor: theme.colors.onDark.primarySoft,
                        padding: 8,
                        borderRadius: 8,
                      }}
                    >
                      <Pencil size={16} color={theme.colors.primary} />
                    </TouchableOpacity>
                  </View>
                </View>
              </TintedGlassCard>
            ))}
          </View>
        )}

        {/* Bottom spacing */}
        <View style={{ height: 32 }} />
      </View>

      {/* Modals */}
      <CreateUserModal
        visible={showCreate}
        scheduleContexts={scheduleContexts}
        onClose={() => setShowCreate(false)}
        onCreated={fetchUsers}
      />
      <EditUserModal
        visible={!!editTarget}
        user={editTarget}
        scheduleContexts={scheduleContexts}
        onClose={() => setEditTarget(null)}
        onUpdated={fetchUsers}
      />
    </ScreenGradient>
  );
}
