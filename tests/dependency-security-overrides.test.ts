import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

type PackageManifest = {
  name?: string;
  version?: string;
};

type UuidApi = {
  v4: () => string;
};

type XcodeProject = {
  hash: { project: { objects: Record<string, unknown> } };
  generateUuid: () => string;
};

type XcodeApi = {
  project: (filename: string) => XcodeProject;
};

type YamlApi = {
  parse: (source: string) => unknown;
};

type BrowserslistApi = (queries?: string | string[]) => string[];

type QsApi = {
  parse: (source: string, options?: Record<string, unknown>) => unknown;
  stringify: (value: unknown) => string;
};

type EntityReference = {
  nodeName: string;
};

type XmldomApi = {
  DOMImplementation: new () => {
    createDocument: (
      namespace: string | null,
      qualifiedName: string,
      doctype: null,
    ) => {
      createEntityReference: (name: string) => EntityReference;
    };
  };
  XMLSerializer: new () => {
    serializeToString: (
      node: EntityReference,
      isHtml?: boolean,
      nodeFilter?: (node: EntityReference) => EntityReference | null,
      options?: { requireWellFormed?: boolean },
    ) => string;
  };
};

type PlistApi = {
  build: (value: Record<string, unknown>) => string;
  parse: (source: string) => Record<string, unknown>;
};

type FastUriApi = {
  normalize: (source: string) => string;
  parse: (source: string) => { error?: string; host?: string };
  resolve: (base: string, reference: string) => string;
};

const projectRequire = createRequire(import.meta.url);
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BROWSERSLIST_CONSUMERS = [
  "@babel/helper-compilation-targets",
  "@expo/cli",
  "core-js-compat",
] as const;

function requireFrom(packageName: string) {
  return createRequire(projectRequire.resolve(packageName));
}

function resolvedPackageVersion(entryPath: string, expectedName: string) {
  let currentDirectory = dirname(entryPath);

  while (true) {
    const manifestPath = join(currentDirectory, "package.json");

    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(
        readFileSync(manifestPath, "utf8"),
      ) as PackageManifest;

      if (manifest.name === expectedName && manifest.version) {
        return manifest.version;
      }
    }

    const parentDirectory = dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      throw new Error(
        `Package manifest for ${expectedName} was not found from ${entryPath}`,
      );
    }

    currentDirectory = parentDirectory;
  }
}

describe("dependency security overrides", () => {
  it("resolves AJV to fast-uri 3.1.6 and rejects host-confusion inputs", () => {
    const fastUriEntry = projectRequire.resolve("fast-uri");
    const fastUri = projectRequire("fast-uri") as FastUriApi;
    const ajvFastUriEntry = requireFrom("ajv").resolve("fast-uri");

    expect(resolvedPackageVersion(fastUriEntry, "fast-uri")).toBe("3.1.6");
    expect(resolvedPackageVersion(ajvFastUriEntry, "fast-uri")).toBe(
      "3.1.6",
    );

    const malformedIpv6 = "http://[::not-valid]/private";
    expect(fastUri.parse(malformedIpv6).error).toBe("URI host is malformed.");
    expect(fastUri.normalize(malformedIpv6)).toBe(malformedIpv6);

    const encodedLocalhost =
      "http://%256c%256f%2563%2561%256c%2568%256f%2573%2574/";
    expect(fastUri.parse(encodedLocalhost).error).toBeDefined();
    expect(fastUri.normalize(encodedLocalhost)).toBe(encodedLocalhost);

    const encodedScheme = "%2f%2fevil.example:/pwn";
    expect(fastUri.parse(encodedScheme).error).toBe("URI scheme is malformed.");
    expect(fastUri.normalize(encodedScheme)).toBe(encodedScheme);

    const resolvedIdn = fastUri.resolve(
      "https://base.example/a",
      "//münich.example/path",
    );
    expect(resolvedIdn).toBe("https://xn--mnich-kva.example/path");
    expect(fastUri.parse(resolvedIdn).host).toBe("xn--mnich-kva.example");
  });

  it("resolves every xmldom consumer to 0.8.15 and rejects invalid entity references", () => {
    const xmldomEntry = projectRequire.resolve("@xmldom/xmldom");
    const xmldom = projectRequire("@xmldom/xmldom") as XmldomApi;
    const expoPlist = (
      projectRequire("@expo/plist") as { default: PlistApi }
    ).default;

    expect(resolvedPackageVersion(xmldomEntry, "@xmldom/xmldom")).toBe(
      "0.8.15",
    );
    for (const consumer of ["@expo/plist", "plist"] as const) {
      const consumerRequire = requireFrom(consumer);
      const consumerXmldomEntry = consumerRequire.resolve("@xmldom/xmldom");

      expect(
        resolvedPackageVersion(consumerXmldomEntry, "@xmldom/xmldom"),
      ).toBe("0.8.15");
    }
    expect(expoPlist.parse(expoPlist.build({ Name: "Escala+" }))).toEqual({
      Name: "Escala+",
    });

    const document = new xmldom.DOMImplementation().createDocument(
      null,
      "root",
      null,
    );
    expect(() =>
      document.createEntityReference("safe; <injected/> &x"),
    ).toThrow();

    const reference = document.createEntityReference("safe");
    reference.nodeName = "safe; <injected/> &x";
    expect(() =>
      new xmldom.XMLSerializer().serializeToString(
        reference,
        false,
        undefined,
        { requireWellFormed: true },
      ),
    ).toThrow();
  });

  it("resolves every qs consumer to the patched 6.16 line", () => {
    const qsEntry = projectRequire.resolve("qs");
    const qs = projectRequire("qs") as QsApi;

    expect(resolvedPackageVersion(qsEntry, "qs")).toBe("6.16.0");
    for (const consumer of [
      "express",
      "body-parser",
      "superagent",
    ] as const) {
      const consumerRequire = requireFrom(consumer);
      const consumerQsEntry = consumerRequire.resolve("qs");

      expect(resolvedPackageVersion(consumerQsEntry, "qs")).toBe("6.16.0");
    }

    expect(() =>
      qs.parse("a[]=1,2,3,4", {
        comma: true,
        arrayLimit: 3,
        throwOnLimitExceeded: true,
      }),
    ).toThrow(RangeError);
    const parsed = qs.parse("constructor[isBuffer]=not-a-function", {
      plainObjects: true,
    });
    expect(() => qs.stringify(parsed)).not.toThrow();
  });

  it("resolves eslint to the patched humanfs implementation", () => {
    const eslintManifest = projectRequire.resolve("eslint/package.json");
    const humanfsManifest = join(
      dirname(eslintManifest),
      "../@humanfs/node/package.json",
    );

    expect(resolvedPackageVersion(humanfsManifest, "@humanfs/node")).toBe(
      "0.16.8",
    );
  });

  it("resolves browserslist to the audited version for every affected consumer", () => {
    const browserslistEntry = projectRequire.resolve("browserslist");
    const browserslist = projectRequire("browserslist") as BrowserslistApi;

    expect(resolvedPackageVersion(browserslistEntry, "browserslist")).toBe(
      "4.28.7",
    );
    for (const consumer of BROWSERSLIST_CONSUMERS) {
      const consumerRequire = requireFrom(consumer);
      const consumerBrowserslistEntry = consumerRequire.resolve("browserslist");

      expect(
        resolvedPackageVersion(consumerBrowserslistEntry, "browserslist"),
      ).toBe("4.28.7");
    }
    expect(browserslist("last 1 Chrome version")).toHaveLength(1);
  });

  it("resolves ngrok to patched CommonJS uuid and yaml versions", () => {
    const ngrokRequire = requireFrom("@expo/ngrok");
    const uuidEntry = ngrokRequire.resolve("uuid");
    const yamlEntry = ngrokRequire.resolve("yaml");
    const uuid = ngrokRequire("uuid") as UuidApi;
    const yaml = ngrokRequire("yaml") as YamlApi;

    expect(resolvedPackageVersion(uuidEntry, "uuid")).toBe("11.1.1");
    expect(resolvedPackageVersion(yamlEntry, "yaml")).toBe("1.10.3");
    expect(uuid.v4()).toMatch(UUID_V4_PATTERN);
    expect(yaml.parse("tunnels: {}\n")).toEqual({ tunnels: {} });
  });

  it("keeps xcode generateUuid compatible with patched CommonJS uuid", () => {
    const xcodeRequire = requireFrom("xcode");
    const uuidEntry = xcodeRequire.resolve("uuid");
    const uuid = xcodeRequire("uuid") as UuidApi;
    const xcode = projectRequire("xcode") as XcodeApi;
    const project = xcode.project(
      join(tmpdir(), "dependency-security-overrides-not-read.pbxproj"),
    );

    project.hash = { project: { objects: {} } };

    expect(resolvedPackageVersion(uuidEntry, "uuid")).toBe("11.1.1");
    expect(uuid.v4()).toMatch(UUID_V4_PATTERN);
    expect(project.generateUuid()).toMatch(/^[0-9A-F]{24}$/);
  });

  it("preserves the patched yaml 2.x line required by Metro", () => {
    const metroConfigRequire = requireFrom("metro-config");
    const yamlEntry = metroConfigRequire.resolve("yaml");

    expect(resolvedPackageVersion(yamlEntry, "yaml")).toMatch(/^2\./);
  });
});
