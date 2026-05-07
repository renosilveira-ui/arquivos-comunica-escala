// Load environment variables with proper priority (system > .env)
import "./scripts/load-env.js";
import type { ExpoConfig } from "expo/config";

// App identity for the staging build. Bundle ID and scheme are
// provisional ("app.escalas.staging") — they MUST be changed to a
// production-owned domain (e.g. "br.com.unimedfortaleza.escalas")
// before publishing to the App Store / Play Store. See
// docs/operations/mobile-deploy.md for the migration checklist.
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
  iosBundleId: "app.escalas.staging",
  androidPackage: "app.escalas.staging",
};

const config: ExpoConfig = {
  name: env.appName,
  slug: env.appSlug,
  version: "1.0.0",
  orientation: "portrait",
  icon: "./assets/images/icon.png",
  scheme: env.scheme,
  userInterfaceStyle: "automatic",
  newArchEnabled: true,
  ios: {
    supportsTablet: true,
    bundleIdentifier: env.iosBundleId,
    "infoPlist": {
        "ITSAppUsesNonExemptEncryption": false
      }
  },
  android: {
    adaptiveIcon: {
      backgroundColor: "#E6F4FE",
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
        // Logo oficial Escala+ — PNG horizontal (~16:9) com fundo
        // branco/light que se mistura ao backgroundColor do splash.
        // resizeMode "contain" preserva aspect ratio.
        image: "./assets/images/logo.png",
        imageWidth: 320,
        resizeMode: "contain",
        backgroundColor: "#ffffff",
        dark: {
          backgroundColor: "#0B1F3A",
        },
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
    reactCompiler: true,
  },
};

export default config;
