import { describe, expect, it } from "vitest";
import { resolveSslConfig } from "../server/_core/db-ssl";

describe("resolveSslConfig (DATABASE_SSL parsing)", () => {
  describe("disabled / unset", () => {
    it("returns undefined when DATABASE_SSL is missing", () => {
      expect(resolveSslConfig({})).toBeUndefined();
    });

    it.each(["", "  ", "false", "FALSE", "disable", "Disable", "off", "OFF"])(
      "returns undefined for %j",
      (value) => {
        expect(resolveSslConfig({ DATABASE_SSL: value })).toBeUndefined();
      },
    );
  });

  describe("strict TLS (validate cert)", () => {
    it.each(["require", "REQUIRE", "true", "TRUE", "on", "On"])(
      "returns rejectUnauthorized:true for %j",
      (value) => {
        expect(resolveSslConfig({ DATABASE_SSL: value })).toEqual({
          rejectUnauthorized: true,
        });
      },
    );
  });

  describe("loose TLS (skip cert validation, staging only)", () => {
    it.each(["insecure", "INSECURE", "allow", "Allow"])(
      "returns rejectUnauthorized:false for %j",
      (value) => {
        expect(resolveSslConfig({ DATABASE_SSL: value })).toEqual({
          rejectUnauthorized: false,
        });
      },
    );
  });

  describe("invalid values fail loud", () => {
    it.each(["yes", "no", "verify-ca", "REQUIRED", "garbage", "1", "0"])(
      "throws for %j (no silent downgrade)",
      (value) => {
        expect(() => resolveSslConfig({ DATABASE_SSL: value })).toThrow(
          /Invalid DATABASE_SSL/,
        );
      },
    );
  });
});
