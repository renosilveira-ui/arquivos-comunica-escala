import { describe, expect, it } from "vitest";
import {
  ProductionBootError,
  assertProductionSecrets,
  collectProductionSecretIssues,
} from "../server/_core/env-validation";

const VALID_PRODUCTION_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "production",
  COOKIE_SECRET: "z".repeat(48),
  DATABASE_URL: "mysql://app:realpass@db.prod.internal:3306/escalas",
  COMUNICA_PLUS_URL: "https://comunicamais.example.com",
  COMUNICA_PLUS_SYSTEM_EMAIL: "system.escalas@hospital.example",
  COMUNICA_PLUS_SYSTEM_PASSWORD: "a-real-strong-password",
  COMUNICA_PLUS_SYSTEM_PIN: "847362",
  HOSPITAL_ALERT_URL: "https://hospital-alert.example.com",
  EXPO_PUBLIC_API_URL: "https://api.escalas.example.com",
};

describe("Frente 2.1 - production boot validation", () => {
  describe("non-production environments", () => {
    it("returns no issues in development even with placeholder secrets", () => {
      expect(
        collectProductionSecretIssues({
          env: {
            NODE_ENV: "development",
            COOKIE_SECRET: "dev-secret-change-in-production",
            DATABASE_URL: "mysql://root:root@127.0.0.1:3306/escalas_test",
            COMUNICA_PLUS_SYSTEM_PASSWORD: "system123",
            COMUNICA_PLUS_SYSTEM_PIN: "9999",
          },
        }),
      ).toEqual([]);
    });

    it("returns no issues in test environment", () => {
      expect(
        collectProductionSecretIssues({
          env: { NODE_ENV: "test", COOKIE_SECRET: "" },
        }),
      ).toEqual([]);
    });

    it("returns no issues when NODE_ENV is unset", () => {
      expect(
        collectProductionSecretIssues({
          env: { COOKIE_SECRET: "" },
        }),
      ).toEqual([]);
    });
  });

  describe("production environment - happy path", () => {
    it("accepts a fully valid production configuration", () => {
      expect(
        collectProductionSecretIssues({ env: VALID_PRODUCTION_ENV }),
      ).toEqual([]);
    });

    it("assertProductionSecrets does not throw with valid config", () => {
      expect(() =>
        assertProductionSecrets({ env: VALID_PRODUCTION_ENV }),
      ).not.toThrow();
    });
  });

  describe("production environment - missing secrets", () => {
    it("flags missing COOKIE_SECRET", () => {
      const issues = collectProductionSecretIssues({
        env: { ...VALID_PRODUCTION_ENV, COOKIE_SECRET: "" },
      });
      expect(issues).toContain(
        "COOKIE_SECRET is required in production but is empty or unset",
      );
    });

    it("flags missing DATABASE_URL", () => {
      const issues = collectProductionSecretIssues({
        env: { ...VALID_PRODUCTION_ENV, DATABASE_URL: "" },
      });
      expect(issues).toContain(
        "DATABASE_URL is required in production but is empty or unset",
      );
    });

    it("flags missing Comunica+ credentials", () => {
      const issues = collectProductionSecretIssues({
        env: {
          ...VALID_PRODUCTION_ENV,
          COMUNICA_PLUS_URL: "",
          COMUNICA_PLUS_SYSTEM_EMAIL: "",
          COMUNICA_PLUS_SYSTEM_PASSWORD: "",
          COMUNICA_PLUS_SYSTEM_PIN: "",
        },
      });
      expect(issues).toContain(
        "COMUNICA_PLUS_URL is required in production but is empty or unset",
      );
      expect(issues).toContain(
        "COMUNICA_PLUS_SYSTEM_EMAIL is required in production but is empty or unset",
      );
      expect(issues).toContain(
        "COMUNICA_PLUS_SYSTEM_PASSWORD is required in production but is empty or unset",
      );
      expect(issues).toContain(
        "COMUNICA_PLUS_SYSTEM_PIN is required in production but is empty or unset",
      );
    });
  });

  describe("production environment - placeholder/default values", () => {
    it("rejects the dev cookie secret placeholder", () => {
      const issues = collectProductionSecretIssues({
        env: {
          ...VALID_PRODUCTION_ENV,
          COOKIE_SECRET: "dev-secret-change-in-production",
        },
      });
      expect(issues).toContain(
        "COOKIE_SECRET must not be the development placeholder value (set a real secret)",
      );
    });

    it("rejects the changeme cookie secret placeholder", () => {
      const issues = collectProductionSecretIssues({
        env: {
          ...VALID_PRODUCTION_ENV,
          COOKIE_SECRET: "changeme_min_32_chars_secret_here",
        },
      });
      expect(issues).toContain(
        "COOKIE_SECRET must not be the development placeholder value (set a real secret)",
      );
    });

    it("rejects the system123 Comunica+ password", () => {
      const issues = collectProductionSecretIssues({
        env: { ...VALID_PRODUCTION_ENV, COMUNICA_PLUS_SYSTEM_PASSWORD: "system123" },
      });
      expect(issues).toContain(
        "COMUNICA_PLUS_SYSTEM_PASSWORD must not be the development placeholder value (set a real secret)",
      );
    });

    it("rejects the 9999 Comunica+ pin", () => {
      const issues = collectProductionSecretIssues({
        env: { ...VALID_PRODUCTION_ENV, COMUNICA_PLUS_SYSTEM_PIN: "9999" },
      });
      expect(issues).toContain(
        "COMUNICA_PLUS_SYSTEM_PIN must not be the development placeholder value (set a real secret)",
      );
    });
  });

  describe("production environment - weak cookie secret length", () => {
    it("rejects a cookie secret shorter than 32 chars", () => {
      const issues = collectProductionSecretIssues({
        env: { ...VALID_PRODUCTION_ENV, COOKIE_SECRET: "short-secret" },
      });
      expect(issues).toContain(
        "COOKIE_SECRET must be at least 32 characters long",
      );
    });

    it("accepts a cookie secret exactly 32 chars", () => {
      const issues = collectProductionSecretIssues({
        env: { ...VALID_PRODUCTION_ENV, COOKIE_SECRET: "a".repeat(32) },
      });
      expect(issues).toEqual([]);
    });
  });

  describe("production environment - localhost URLs", () => {
    it("rejects DATABASE_URL targeting localhost", () => {
      const issues = collectProductionSecretIssues({
        env: {
          ...VALID_PRODUCTION_ENV,
          DATABASE_URL: "mysql://app:pass@localhost:3306/escalas",
        },
      });
      expect(issues).toContain(
        "DATABASE_URL must not point to localhost in production (current value targets a local host)",
      );
    });

    it("rejects DATABASE_URL targeting 127.0.0.1", () => {
      const issues = collectProductionSecretIssues({
        env: {
          ...VALID_PRODUCTION_ENV,
          DATABASE_URL: "mysql://app:pass@127.0.0.1:3306/escalas",
        },
      });
      expect(issues).toContain(
        "DATABASE_URL must not point to localhost in production (current value targets a local host)",
      );
    });

    it("rejects COMUNICA_PLUS_URL targeting localhost", () => {
      const issues = collectProductionSecretIssues({
        env: {
          ...VALID_PRODUCTION_ENV,
          COMUNICA_PLUS_URL: "http://localhost:3001",
        },
      });
      expect(issues).toContain(
        "COMUNICA_PLUS_URL must not point to localhost in production (current value targets a local host)",
      );
    });

    it("rejects HOSPITAL_ALERT_URL targeting localhost", () => {
      const issues = collectProductionSecretIssues({
        env: {
          ...VALID_PRODUCTION_ENV,
          HOSPITAL_ALERT_URL: "http://localhost:3001",
        },
      });
      expect(issues).toContain(
        "HOSPITAL_ALERT_URL must not point to localhost in production (current value targets a local host)",
      );
    });

    it("rejects EXPO_PUBLIC_API_URL targeting localhost", () => {
      const issues = collectProductionSecretIssues({
        env: {
          ...VALID_PRODUCTION_ENV,
          EXPO_PUBLIC_API_URL: "http://localhost:3000",
        },
      });
      expect(issues).toContain(
        "EXPO_PUBLIC_API_URL must not point to localhost in production (current value targets a local host)",
      );
    });

    it("does not flag a hostname that merely contains 'localhost' substring", () => {
      const issues = collectProductionSecretIssues({
        env: {
          ...VALID_PRODUCTION_ENV,
          DATABASE_URL: "mysql://app:pass@notlocalhostsuffix.example.com:3306/escalas",
        },
      });
      expect(issues).not.toContain(
        "DATABASE_URL must not point to localhost in production (current value targets a local host)",
      );
    });
  });

  describe("assertProductionSecrets - throwing behavior", () => {
    it("throws ProductionBootError aggregating all issues", () => {
      let caught: unknown;
      try {
        assertProductionSecrets({
          env: {
            ...VALID_PRODUCTION_ENV,
            COOKIE_SECRET: "dev-secret-change-in-production",
            COMUNICA_PLUS_SYSTEM_PASSWORD: "system123",
            DATABASE_URL: "mysql://root@127.0.0.1:3306/escalas",
          },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProductionBootError);
      const err = caught as ProductionBootError;
      expect(err.issues.length).toBeGreaterThanOrEqual(3);
      expect(err.message).toContain("Refusing to boot in production");
      expect(err.message).toContain("COOKIE_SECRET");
      expect(err.message).toContain("COMUNICA_PLUS_SYSTEM_PASSWORD");
      expect(err.message).toContain("DATABASE_URL");
    });

    it("does not throw in development with placeholder secrets", () => {
      expect(() =>
        assertProductionSecrets({
          env: {
            NODE_ENV: "development",
            COOKIE_SECRET: "dev-secret-change-in-production",
          },
        }),
      ).not.toThrow();
    });
  });
});
