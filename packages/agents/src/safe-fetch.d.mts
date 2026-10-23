export class BlockedUrlError extends Error {}
export type Net = {
  lookup(host: string): Promise<string[]>;
  get(url: URL, o: { signal?: AbortSignal }): Promise<{ status: number; location?: string; contentType: string; body: AsyncIterable<Uint8Array>; destroy(): void }>;
};
export const realNet: Net;
export function isPrivateAddress(ip: string): boolean;
export function assertPublicUrl(raw: string, net: Pick<Net, "lookup">): Promise<URL>;
export function safeFetch(raw: string, net?: Net, o?: { maxBytes?: number; timeoutMs?: number; maxRedirects?: number; signal?: AbortSignal }): Promise<{ url: string; status: number; contentType: string; text: string; bytes: Buffer; truncated: boolean }>;
export function wrapUntrusted(source: string, body: string): string;
export function htmlToText(html: string): string;
export function fetchUrlText(url: string, o?: { net?: Net; signal?: AbortSignal; maxChars?: number }): Promise<string>;
export function pdfToText(bytes: Uint8Array): Promise<string>;
