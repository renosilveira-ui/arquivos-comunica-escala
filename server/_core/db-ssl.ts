// server/_core/db-ssl.ts
//
// Shared resolution of MySQL TLS configuration. Used by both runtime
// (server/db.ts) and tooling (drizzle.config.ts). Driven by the
// DATABASE_SSL env var:
//
//   require   → enable TLS, validate cert against system trust store
//                (for production with publicly-signed certs).
//   insecure  → enable TLS, do NOT validate cert (acceptable for staging
//                fallback when the managed provider uses a self-signed CA;
//                NOT acceptable for production — a MITM could intercept).
//   unset / empty / "false" / "disable" / "off"
//             → no TLS (local dev, test, single-host setups).
//
// Any other value throws at parse time so a typo in the deploy env does
// not silently downgrade encryption posture.

export interface MysqlSslOptions {
  rejectUnauthorized: boolean;
}

export function resolveSslConfig(
  env: NodeJS.ProcessEnv = process.env,
): MysqlSslOptions | undefined {
  const raw = (env.DATABASE_SSL ?? "").trim().toLowerCase();
  if (raw === "" || raw === "false" || raw === "disable" || raw === "off") {
    return undefined;
  }
  if (raw === "require" || raw === "true" || raw === "on") {
    return { rejectUnauthorized: true };
  }
  if (raw === "insecure" || raw === "allow") {
    return { rejectUnauthorized: false };
  }
  throw new Error(
    `Invalid DATABASE_SSL=${env.DATABASE_SSL}. Expected one of: require, insecure, false, or unset.`,
  );
}
