type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseBooleanParam(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function maskEmail(email?: string | null): string | null {
  if (!email) return null;
  const [localRaw, domainRaw] = email.split("@");
  if (!localRaw || !domainRaw) return "***";
  const local = localRaw.length <= 2
    ? `${localRaw[0] ?? "*"}*`
    : `${localRaw.slice(0, 2)}***${localRaw.slice(-1)}`;
  const domainParts = domainRaw.split(".");
  const baseDomain = domainParts[0] ?? "";
  const tld = domainParts.slice(1).join(".") || "com";
  const maskedDomain = baseDomain.length <= 2
    ? `${baseDomain[0] ?? "*"}*`
    : `${baseDomain.slice(0, 2)}***${baseDomain.slice(-1)}`;
  return `${local}@${maskedDomain}.${tld}`;
}

export function maskIp(ip?: string | null): string | null {
  if (!ip) return null;
  if (ip.includes(":")) {
    const parts = ip.split(":");
    if (parts.length <= 2) return "****:****";
    return `${parts.slice(0, 2).join(":")}:****:****`;
  }
  const parts = ip.split(".");
  if (parts.length !== 4) return "***.***.***.***";
  return `${parts[0]}.${parts[1]}.*.*`;
}

function redactStringByKey(key: string, value: string): string {
  const k = key.toLowerCase();
  if (k.includes("email")) return maskEmail(value) ?? "***";
  if (k.includes("password") || k.includes("token") || k.includes("cookie") || k.includes("authorization")) {
    return "[REDACTED]";
  }
  if (k.includes("phone") || k.includes("cpf") || k.includes("openid")) {
    return "[REDACTED]";
  }
  return value;
}

export function redactSensitiveObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveObject);
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const out: PlainObject = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "string") {
      out[key] = redactStringByKey(key, val);
    } else if (isPlainObject(val) || Array.isArray(val)) {
      out[key] = redactSensitiveObject(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

export function sanitizeAuditRows<T extends Record<string, unknown>>(
  rows: T[],
  includeSensitive: boolean,
): T[] {
  if (includeSensitive) return rows;
  return rows.map((row) => ({
    ...row,
    ipAddress: maskIp(typeof row.ipAddress === "string" ? row.ipAddress : null),
    userAgent: row.userAgent ? "[REDACTED]" : row.userAgent,
    metadata: redactSensitiveObject(row.metadata),
  }));
}
