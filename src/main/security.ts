import { basename, extname, normalize, sep } from "node:path";

const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "secrets.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

const SENSITIVE_EXTENSIONS = new Set([".key", ".pem", ".p12", ".pfx", ".keystore"]);

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\bAIza[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["']?)[^\s"']{8,}/gi,
  /(Bearer\s+)[A-Za-z0-9._-]{8,}/gi,
];

export function isSensitivePath(path: string): boolean {
  const normalized = normalize(path).toLowerCase();
  const segments = normalized.split(sep).filter(Boolean);
  const name = basename(normalized);
  if (SENSITIVE_BASENAMES.has(name) || SENSITIVE_EXTENSIONS.has(extname(name))) return true;
  if (name.startsWith(".env.")) return true;
  return segments.some((segment) => segment === ".ssh" || segment === ".aws" || segment === ".gnupg");
}

export function containsLikelySecret(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

export function redactSensitiveText(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, (match, prefix?: string) => {
      if (typeof prefix === "string" && prefix) return `${prefix}[REDACTED]`;
      return "[REDACTED]";
    });
  }
  return text;
}
