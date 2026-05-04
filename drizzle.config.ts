import { defineConfig } from "drizzle-kit";
import { resolveSslConfig } from "./server/_core/db-ssl";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run drizzle commands");
}

const ssl = resolveSslConfig(process.env);

// drizzle-kit's MySQL credentials are a discriminated union: { url } OR
// { host, port, user, password, database, ssl }. They cannot be mixed.
// When TLS is required, we parse the URL into components so we can pass
// the ssl object alongside.
const dbCredentials = ssl
  ? (() => {
      const u = new URL(connectionString);
      return {
        host: u.hostname,
        port: u.port ? Number(u.port) : 3306,
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        database: u.pathname.replace(/^\//, ""),
        ssl,
      };
    })()
  : { url: connectionString };

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "mysql",
  dbCredentials,
});
