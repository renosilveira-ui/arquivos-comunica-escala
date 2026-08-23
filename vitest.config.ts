import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./"),
      // lib/theme.ts usa Platform.select (fonte mono por plataforma); em
      // Node não há react-native — um stub com só o que a lib toca.
      "react-native": path.resolve(__dirname, "./tests/stubs/react-native.ts"),
      "lucide-react-native": path.resolve(__dirname, "./tests/stubs/lucide-react-native.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    fileParallelism: false,
    setupFiles: ["./tests/setup.ts"],
    env: {
      // TEST_DATABASE_URL permite rodar suítes em paralelo em bancos
      // distintos (um por worktree/agente). Nunca lê DATABASE_URL do
      // shell: o seed apaga dados e .env.local aponta para o staging.
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        "mysql://root:root@127.0.0.1:3306/escalas_test",
      NODE_ENV: "test",
    },
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/app/**",
      "**/components/**",
      "**/hooks/**",
      "**/lib/**",
      "**/.expo/**",
    ],
  },
  define: {
    __DEV__: true,
  },
});
