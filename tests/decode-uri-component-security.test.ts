import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

type DecodeUriComponent = (value: string) => string;

type QueryStringModule = {
  parse(value: string): Record<string, string | string[] | null>;
  stringify(
    value: Record<string, string | string[] | null>,
    options?: { sort?: boolean },
  ): string;
};

type PackageMetadata = {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
};

const rootRequire = createRequire(import.meta.url);
const expoRouterPackageJson = rootRequire.resolve("expo-router/package.json");
const expoRouterRequire = createRequire(expoRouterPackageJson);
const queryStringEntry = expoRouterRequire.resolve("query-string");
const queryStringRequire = createRequire(queryStringEntry);
const decodeUriComponentEntry = queryStringRequire.resolve(
  "decode-uri-component",
);
const decodeUriComponentRequire = createRequire(decodeUriComponentEntry);

const expoRouterPackage = expoRouterRequire(
  expoRouterPackageJson,
) as PackageMetadata;
const queryStringPackage = queryStringRequire(
  "./package.json",
) as PackageMetadata;
const decodeUriComponentPackage = decodeUriComponentRequire(
  "./package.json",
) as PackageMetadata;
const queryString = queryStringRequire(queryStringEntry) as QueryStringModule;
const decodeUriComponent = decodeUriComponentRequire(
  decodeUriComponentEntry,
) as DecodeUriComponent;

describe("backport de segurança de decode-uri-component", () => {
  it("resolve a cadeia instalada pelo Expo Router sem depender de hoisting", () => {
    expect(expoRouterPackage.name).toBe("expo-router");
    expect(expoRouterPackage.dependencies?.["query-string"]).toBeDefined();
    expect(queryStringPackage).toMatchObject({
      name: "query-string",
      version: "7.1.3",
    });
    expect(
      queryStringPackage.dependencies?.["decode-uri-component"],
    ).toBeDefined();
    expect(decodeUriComponentPackage).toMatchObject({
      name: "decode-uri-component",
      version: "0.2.2",
    });
    expect(typeof decodeUriComponent).toBe("function");
  });

  it.each([
    ["test", "test"],
    ["a+b", "a b"],
    ["%2B", "+"],
    ["%25", "%"],
    ["%2525", "%25"],
    ["st%C3%A5le", "ståle"],
    ["%F0%9F%98%80", "😀"],
    ["%EF%BB%BFtest", "\uFEFFtest"],
    ["%FE%FF", "\uFFFD\uFFFD"],
    ["%C2", "\uFFFD"],
    ["%84%D7%25%88%90", "%84%D7%%88%90"],
    ["%20%20%25%80", "  %%80"],
  ])("preserva a compatibilidade de %s", (input, expected) => {
    expect(decodeUriComponent(input)).toBe(expected);
  });

  it.each([
    ["%F0%9F%98", "%F0%9F%98"],
    ["%E0%80%80", "%E0%80%80"],
    ["%ED%A0%80", "%ED%A0%80"],
    ["%F4%90%80%80", "%F4%90%80%80"],
    ["%80", "%80"],
    ["%G0", "%G0"],
    ["%C3%A5%ab", "å%ab"],
    ["%G0%C3%A5%ab", "%G0å%ab"],
    ["%C2%41", "\uFFFDA"],
  ])("trata entrada malformada %s sem lançar", (input, expected) => {
    expect(decodeUriComponent(input)).toBe(expected);
  });

  it("mantém o contrato de erro para tipos inválidos", () => {
    expect(() => decodeUriComponent(null as unknown as string)).toThrowError(
      "Expected `encodedURI` to be of type `string`, got `object`",
    );
  });

  it("preserva a semântica consumida por query-string", () => {
    const parsed = queryString.parse(
      "token=abc%2B123+xyz&role=medico&role=gestor&missing&empty=",
    );

    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect({ ...parsed }).toEqual({
      empty: "",
      missing: null,
      role: ["medico", "gestor"],
      token: "abc+123 xyz",
    });
    expect(queryString.parse("valid=%C3%A5&invalid=%F0%9F%98")).toMatchObject({
      invalid: "%F0%9F%98",
      valid: "å",
    });
    expect(
      queryString.stringify({ token: "abc+123 xyz" }, { sort: false }),
    ).toBe("token=abc%2B123%20xyz");
  });

  it("conclui o PoC de DoS conhecido em subprocesso limitado", () => {
    // Resolve e executa o parser transitivo real. Isto não afirma que o
    // caminho atual de entrada de deep links do Expo Router use esse parser.
    const childProgram = [
      '"use strict";',
      "const queryString = require(process.argv[1]);",
      'const value = queryString.parse("token=" + "%ab".repeat(1400)).token;',
      "process.stdout.write(String(value.length));",
    ].join("");
    const child = spawnSync(
      process.execPath,
      ["-e", childProgram, queryStringEntry],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 3000,
      },
    );

    expect(child.error, child.stderr).toBeUndefined();
    expect(child.signal, child.stderr).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stderr).toBe("");
    expect(child.stdout).toBe("4200");
  }, 10_000);
});
