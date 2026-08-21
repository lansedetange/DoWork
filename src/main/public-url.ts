import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type DnsResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIpv4(mapped[1]) : false;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? isPrivateIpv4(address) : family === 6 ? isPrivateIpv6(address) : true;
}

const defaultResolver: DnsResolver = async (hostname) => lookup(hostname, { all: true });

export async function assertPublicHttpsUrl(
  rawUrl: string,
  resolver: DnsResolver = defaultResolver,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("网页地址无效。");
  }
  if (url.protocol !== "https:") throw new Error("只允许读取 HTTPS 网页。");
  if (url.username || url.password) throw new Error("网页地址不能包含登录凭据。");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("不能读取本机或内网地址。");
  }
  const literalFamily = isIP(hostname);
  if (literalFamily > 0) {
    if (isPrivateAddress(hostname)) throw new Error("不能读取本机或内网地址。");
    return url;
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new Error("无法解析网页域名。");
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("网页域名解析到了内网地址，读取已阻止。");
  }
  return url;
}
