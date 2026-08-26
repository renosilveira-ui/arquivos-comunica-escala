import { extname, basename } from "node:path";
import type { Response } from "express";

const ONE_YEAR_SECONDS = 31_536_000;
const CONTENT_HASH_SEGMENT = /(?:^|[._-])([a-f0-9]{32}|[a-f0-9]{40}|[a-f0-9]{64})(?=(?:@[234]x)?\.[a-z0-9]+$)/i;

export function isContentHashedAsset(filePath: string): boolean {
  if (extname(filePath).toLowerCase() === ".html") return false;
  const match = CONTENT_HASH_SEGMENT.exec(basename(filePath));
  return Boolean(match && /[a-f]/i.test(match[1]));
}

export function cacheControlForStaticFile(filePath: string): string {
  if (extname(filePath).toLowerCase() === ".html") return "no-cache";
  if (isContentHashedAsset(filePath)) {
    return `public, max-age=${ONE_YEAR_SECONDS}, immutable`;
  }
  return "public, max-age=3600";
}

export function setStaticCacheHeaders(response: Response, filePath: string): void {
  response.setHeader("Cache-Control", cacheControlForStaticFile(filePath));
}
