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
import { ScreenGradient } from "@/components/ui/ScreenGradient";
import { TintedGlassCard } from "@/components/ui/TintedGlassCard";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { useAuth } from "@/hooks/use-auth";
import * as Auth from "@/lib/_core/auth";
import { Lock, Plus, Pencil, Users, X } from "lucide-react-native";
import { theme } from "@/lib/theme";
import { useFocusEffect } from "expo-router";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type UserRole = "admin" | "manager" | "doctor" | "nurse" | "tech";

interface AdminUser {
  id: number;
  name: string | null;
  email: string | null;
  role: UserRole;
  createdAt: string;
  professional: { id: number; userRole: string } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBaseUrl(): string {
  const envUrl = process.env.EXPO_PUBLIC_API_URL;
  if (envUrl) return envUrl;
  if (Platform.OS === "android") return "http://10.0.2.2:3000";
  return "http://localhost:3000";
}

async function adminFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<{ ok: boolean; data: T | null }> {
  const url = getBaseUrl() + path;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options?.headers as Record<string, string>),
  };
  if (Platform.OS !== "web") {
    const token = await Auth.getSessionToken();
    if (token) headers["Authorization"] = "Bearer " + token;
  }
  const res = await fetch(url, {
    ...options,
    headers,
    credentials: Platform.OS === "web" ? "include" : undefined,
  });
  let data: T | null = null;
  try {
    data = await res.json();
  } catch {}
  return { ok: res.ok, data };
}

const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Administrador",
  manager: "Gestor",
  doctor: "Médico",
  nurse: "Enfermeiro(a)",
  tech: "Técnico(a)",
};

const ROLE_BADGE: Record<UserRole, BadgeVariant> = {
  admin: "critical",
  manager: "warning",
  doctor: "info",
  nurse: "success",
  tech: "neutral",
};

const ROLES: UserRole[] = ["admin", "manager", "doctor", "nurse", "tech"];

// ---------------------------------------------------------------------------
// CreateUserModal
// ---------------------------------------------------------------------------

function CreateUserModal({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<UserRole>("doctor");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const reset = () => {
    setName("");
    setEmail("");
    setPassword("");
    setRole("doctor");
    setError("");
  };

  const handleCreate = async () => {
    if (!name.trim() || !email.trim() || !password.trim()) {
      setError("Preencha todos os campos");
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
          role,
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
          backgroundColor: "rgba(0,0,0,0.6)",
        }}
      >
        <View
          style={{
            width: "90%",
            maxWidth: 420,
            backgroundColor: theme.colors.cardBg,
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
              backgroundColor: theme.colors.inputBg,
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
              backgroundColor: theme.colors.inputBg,
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
            placeholder="Min. 6 caracteres"
            placeholderTextColor={theme.colors.textMuted}
            secureTextEntry
            style={{
              backgroundColor: theme.colors.inputBg,
              color: theme.colors.textPrimary,
              borderRadius: theme.borderRadius.input,
              padding: 12,
              fontSize: 16,
              marginBottom: 14,
            }}
          />

          {/* Role selector */}
          <Text
            style={{
              color: theme.colors.textSecondary,
              fontSize: 14,
              marginBottom: 6,
            }}
          >
            Cargo
          </Text>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: 20,
            }}
          >
            {ROLES.map((r) => (
              <TouchableOpacity
                key={r}
                onPress={() => setRole(r)}
                style={{
                  backgroundColor:
                    role === r ? theme.colors.primary : theme.colors.inputBg,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 8,
                }}
              >
                <Text
                  style={{
                    color:
                      role === r ? "#FFFFFF" : theme.colors.textSecondary,
                    fontSize: 14,
                    fontWeight: "600",
                  }}
                >
                  {ROLE_LABELS[r]}
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
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text
                style={{ color: "#FFFFFF", fontSize: 16, fontWeight: "700" }}
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
  onClose,
  onUpdated,
}: {
  visible: boolean;
  user: AdminUser | null;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<UserRole>("doctor");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Populate when modal opens or editUser changes
  useFocusEffect(
    useCallback(() => {
      if (visible && editUser) {
        setName(editUser.name ?? "");
        setEmail(editUser.email ?? "");
        setRole(editUser.role);
        setError("");
      }
    }, [visible, editUser]),
  );

  const handleUpdate = async () => {
    if (!editUser) return;
    if (!name.trim() || !email.trim()) {
      setError("Nome e e-mail são obrigatórios");
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
          role,
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
          backgroundColor: "rgba(0,0,0,0.6)",
        }}
      >
        <View
          style={{
            width: "90%",
            maxWidth: 420,
            backgroundColor: theme.colors.cardBg,
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
              backgroundColor: theme.colors.inputBg,
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
              backgroundColor: theme.colors.inputBg,
              color: theme.colors.textPrimary,
              borderRadius: theme.borderRadius.input,
              padding: 12,
              fontSize: 16,
              marginBottom: 14,
            }}
          />

          {/* Role selector */}
          <Text
            style={{
              color: theme.colors.textSecondary,
              fontSize: 14,
              marginBottom: 6,
            }}
          >
            Cargo
          </Text>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 8,
              marginBottom: 20,
            }}
          >
            {ROLES.map((r) => (
              <TouchableOpacity
                key={r}
                onPress={() => setRole(r)}
                style={{
                  backgroundColor:
                    role === r ? theme.colors.primary : theme.colors.inputBg,
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 8,
                }}
              >
                <Text
                  style={{
                    color:
                      role === r ? "#FFFFFF" : theme.colors.textSecondary,
                    fontSize: 14,
                    fontWeight: "600",
                  }}
                >
                  {ROLE_LABELS[r]}
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
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text
                style={{ color: "#FFFFFF", fontSize: 16, fontWeight: "700" }}
              >
                Salvar Alterações
              </Text>
            )}
          </TouchableOpacity>
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
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Modals
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<AdminUser | null>(null);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await adminFetch<{ users: AdminUser[] }>("/api/admin/users");
      console.log("[AdminScreen] fetchUsers response:", res.ok, "count:", res.data?.users?.length);
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

  useFocusEffect(
    useCallback(() => {
      fetchUsers();
    }, [fetchUsers]),
  );

  const handleRefresh = () => {
    setRefreshing(true);
    fetchUsers();
  };

  // Filter users by search
  const filtered = searchQuery.trim()
    ? users.filter(
        (u) =>
          (u.name ?? "").toLowerCase().includes(searchQuery.toLowerCase()) ||
          (u.email ?? "").toLowerCase().includes(searchQuery.toLowerCase()) ||
          ROLE_LABELS[u.role].toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : users;

  // Guards
  if (!user) {
    return (
      <ScreenGradient scrollable={false}>
        <View
          style={{ flex: 1, justifyContent: "center", alignItems: "center" }}
        >
          <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 16 }}>
            Faça login para continuar
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  if (user.role !== "admin") {
    return (
      <ScreenGradient scrollable={false}>
        <View
          style={{
            flex: 1,
            justifyContent: "center",
            alignItems: "center",
            gap: 16,
          }}
        >
          <Lock size={48} color="rgba(255,255,255,0.5)" />
          <Text style={{ color: "rgba(255,255,255,0.7)", fontSize: 16 }}>
            Acesso restrito a administradores
          </Text>
        </View>
      </ScreenGradient>
    );
  }

  // Render
  return (
    <ScreenGradient
      scrollable
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={handleRefresh}
          tintColor="#FFFFFF"
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
          <View
            style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
          >
            <Users size={28} color="#FFFFFF" />
            <Text
              style={{ color: "#FFFFFF", fontSize: 26, fontWeight: "800" }}
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
            <Plus size={18} color="#FFFFFF" />
            <Text
              style={{ color: "#FFFFFF", fontSize: 14, fontWeight: "700" }}
            >
              Novo
            </Text>
          </TouchableOpacity>
        </View>

        {/* Search */}
        <View
          style={{
            backgroundColor: theme.colors.inputBg,
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
                style={{ color: theme.colors.textSecondary, fontSize: 13 }}
              >
                Total de Usuários
              </Text>
              <Text
                style={{
                  color: "#FFFFFF",
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
                style={{ color: theme.colors.textSecondary, fontSize: 13 }}
              >
                Administradores
              </Text>
              <Text
                style={{
                  color: "#FFFFFF",
                  fontSize: 28,
                  fontWeight: "800",
                  marginTop: 4,
                }}
              >
                {users.filter((u) => u.role === "admin").length}
              </Text>
            </TintedGlassCard>
          </View>
        </View>

        {/* User list */}
        {loading ? (
          <View style={{ alignItems: "center", paddingVertical: 40 }}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </View>
        ) : filtered.length === 0 ? (
          <TintedGlassCard>
            <View style={{ alignItems: "center", paddingVertical: 32 }}>
              <Users size={48} color="rgba(255,255,255,0.3)" />
              <Text
                style={{
                  color: "rgba(255,255,255,0.5)",
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
                        color: "#FFFFFF",
                        fontSize: 17,
                        fontWeight: "700",
                      }}
                    >
                      {u.name ?? "Sem nome"}
                    </Text>
                    <Text
                      style={{
                        color: theme.colors.textSecondary,
                        fontSize: 14,
                      }}
                    >
                      {u.email ?? "\u2014"}
                    </Text>
                  </View>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <Badge variant={ROLE_BADGE[u.role]}>
                      {ROLE_LABELS[u.role]}
                    </Badge>
                    <TouchableOpacity
                      onPress={() => setEditTarget(u)}
                      hitSlop={10}
                      style={{
                        backgroundColor: "rgba(59,130,246,0.15)",
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
        onClose={() => setShowCreate(false)}
        onCreated={fetchUsers}
      />
      <EditUserModal
        visible={!!editTarget}
        user={editTarget}
        onClose={() => setEditTarget(null)}
        onUpdated={fetchUsers}
      />
    </ScreenGradient>
  );
}
