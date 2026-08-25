import { describe, expect, it } from "vitest";
import {
  cacheControlForStaticFile,
  isContentHashedAsset,
} from "../server/_core/static-cache";

describe("política de cache dos assets web", () => {
  it.each([
    "/web-build/_expo/static/js/web/entry-8f3a9c12d45e67898f3a9c12d45e6789.js",
    "/web-build/assets/0123456789abcdef0123456789abcdef.png",
    "/web-build/assets/inter.abcdef0123456789abcdef0123456789.woff2",
    "/web-build/assets/close-icon.808e1b1b9b53114ec2838071a7e6daa7@2x.png",
    "/web-build/assets/close-icon.808e1b1b9b53114ec2838071a7e6daa7@4x.png",
  ])("marca como imutável somente nome com segmento de hash forte: %s", (filePath) => {
    expect(isContentHashedAsset(filePath)).toBe(true);
    expect(cacheControlForStaticFile(filePath)).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it.each([
    "/web-build/index.html",
    "/web-build/assets/logo.png",
    "/web-build/assets/manual-v20260824.pdf",
    "/web-build/assets/icon-a1b2c3d4.png",
    "/web-build/assets/relatorio-20260824010203.csv",
    "/web-build/assets/relatorio-20260824010203042026082401020304.csv",
  ])("não confunde nomes estáveis ou versionados com content hash: %s", (filePath) => {
    expect(isContentHashedAsset(filePath)).toBe(false);
  });

  it("obriga revalidação para qualquer HTML, inclusive com aparência de hash", () => {
    expect(cacheControlForStaticFile("/index.html")).toBe("no-cache");
    expect(cacheControlForStaticFile("/page-0123456789abcdef.html")).toBe("no-cache");
  });

  it("mantém cache curto para asset sem hash de conteúdo comprovável", () => {
    expect(cacheControlForStaticFile("/assets/logo.png")).toBe(
      "public, max-age=3600",
    );
  });
});
