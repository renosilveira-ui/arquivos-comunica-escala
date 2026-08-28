// Load environment variables with proper priority (system > .env)
import "./scripts/load-env.js";
import type { ExpoConfig } from "expo/config";

// App identity. Bundle ID definitivo: com.comunicamais.escalas
// (padrão do ecossistema Comunica+ — decisão do PO em 2026-08-18,
// registrada para o app record do App Store Connect/TestFlight).
//
// Constraints honored by the current values:
//   - Bundle ID: only letters, numbers and dots; each dot-separated
//     segment starts with a letter (Android requirement).
//   - Slug: lowercase, hyphenated, used by EAS for project lookup.
//   - Scheme: deep-link prefix; must be unique per app variant on a
//     device (so staging and prod cannot share the same scheme).
const env = {
  appName: "Escalas Hospitalares",
  appSlug: "escalas-hospitalares",
  scheme: "escalas",
  iosBundleId: "com.comunicamais.escalas",
  androidPackage: "com.comunicamais.escalas",
};

const config: ExpoConfig = {
  name: env.appName,
  slug: env.appSlug,
  version: "1.0.1",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: env.scheme,
  // Travado em "light": o design system é light-only (docs/design/
  // ui-system.md). Com "automatic", iPhones em dark mode pintavam
  // componentes nativos (TextInput, Alert, pickers) com paleta escura
  // sobre nossos fundos claros — texto ilegível/camuflado (reportado
  // no primeiro teste iOS, 2026-08-06). Reverter só quando houver
  // dark mode de verdade no design system.
  userInterfaceStyle: "light",
  newArchEnabled: true,
  ios: {
    supportsTablet: true,
    bundleIdentifier: env.iosBundleId,
    // Marca (PO, 2026-08-18): o ícone do app é o calendário navy contornado
    // sobre branco; o tile navy "E+" é o favicon — e, no iOS 18+, a variante
    // "dark" do ícone (só aparece se o usuário escolher ícones escuros na
    // tela inicial). Gerados por scripts/brand/generate-icons.py.
    icon: {
      light: "./assets/images/icon.png",
      dark: "./assets/images/icon-dark.png",
      tinted: "./assets/images/icon-tinted.png",
    },
    "infoPlist": {
        "ITSAppUsesNonExemptEncryption": false,
        // Permite consultar/abrir o app nativo do Comunica+ (Fase 3 do SSO).
        "LSApplicationQueriesSchemes": ["comunicamais"],
        // Exigido pela App Store Connect (erro 90683, build 8): expo-image
        // (PhotoLibraryAssetLoader) e expo-file-system referenciam a API
        // de fotos mesmo sem uso no app — a purpose string é obrigatória.
        "NSPhotoLibraryUsageDescription":
          "O Escala+ só acessa suas fotos se você optar por anexar uma imagem (por exemplo, foto de perfil).",
      }
  },
  android: {
    adaptiveIcon: {
      backgroundColor: "#FFFFFF",
      foregroundImage: "./assets/images/android-icon-foreground.png",
      backgroundImage: "./assets/images/android-icon-background.png",
      monochromeImage: "./assets/images/android-icon-monochrome.png",
    },
    edgeToEdgeEnabled: true,
    predictiveBackGestureEnabled: false,
    package: env.androidPackage,
    permissions: ["POST_NOTIFICATIONS"],
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [
          {
            scheme: env.scheme,
            host: "*",
          },
        ],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  web: {
    bundler: "metro",
    output: "static",
    favicon: "./assets/images/favicon.png",
  },
  plugins: [
    "expo-router",
    [
      "expo-secure-store",
      {
        // Sem o plugin o Auto Backup do Android restaura EncryptedSharedPreferences
        // sem a chave do Keystore — o token some e o app pede login de novo.
        configureAndroidBackup: true,
      },
    ],
    [
      "expo-notifications",
      {
        // Sem este plugin o binário TestFlight/Play não recebe APNs/FCM:
        // o JS registra token, o SO não entrega o push.
        color: "#01304A",
        defaultChannel: "escalas-default",
        enableBackgroundRemoteNotifications: true,
      },
    ],
    [
      "expo-speech-recognition",
      {
        microphonePermission: "O Escala+ usa o microfone para comandos de voz (ex.: solicitar troca de plantão).",
        speechRecognitionPermission: "O Escala+ usa o reconhecimento de fala para entender seus comandos de voz.",
      },
    ],
    [
      "expo-audio",
      {
        microphonePermission: "Allow $(PRODUCT_NAME) to access your microphone.",
      },
    ],
    [
      "expo-video",
      {
        supportsBackgroundPlayback: true,
        supportsPictureInPicture: true,
      },
    ],
    [
      "expo-splash-screen",
      {
        // Wordmark oficial ESCALA+ (fundo transparente, tinta navy) sobre
        // branco. Sem variante dark: o app é light-only (userInterfaceStyle)
        // e a tinta navy sumiria num fundo escuro.
        image: "./assets/images/logo.png",
        imageWidth: 280,
        resizeMode: "contain",
        backgroundColor: "#ffffff",
      },
    ],
    [
      "expo-build-properties",
      {
        android: {
          buildArchs: ["armeabi-v7a", "arm64-v8a"],
          minSdkVersion: 24,
        },
      },
    ],
  ],
  experiments: {
    typedRoutes: true,
    // reactCompiler DESLIGADO em 2026-08-18: compilador experimental
    // rodando em build de produção é suspeito nº 1 da instabilidade
    // reportada pelo PO no primeiro build TestFlight. Reavaliar quando
    // sair de experimental.
    reactCompiler: false,
  },
  // Vínculo com o projeto EAS (@renosilveira/escalas-hospitalares).
  // Necessário para eas build; criado via `eas init` em 2026-08-06.
  owner: "renosilveira",
  extra: {
    eas: {
      projectId: "8b135be7-ee5e-4406-9703-ad696d3689e9",
    },
  },
};

export default config;
