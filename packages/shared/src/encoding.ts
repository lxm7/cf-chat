const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Returns a `Uint8Array<ArrayBuffer>` rather than the `Uint8Array<ArrayBufferLike>`
 * the Workers runtime types declare. TextEncoder always allocates a fresh,
 * non-shared ArrayBuffer, so the narrowing is sound, and doing it once here
 * keeps every WebCrypto call site (which requires `BufferSource`, resolving to
 * `ArrayBufferView<ArrayBuffer>`) free of casts.
 */
export function utf8(value: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(value) as Uint8Array<ArrayBuffer>;
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Length-independent comparison. Returns false for differing lengths without leaking where they diverge. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}
