const encoder = new TextEncoder();

export const sha256Hex = async (text: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
};

export const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

export const randomToken = (): string => base64Url(crypto.getRandomValues(new Uint8Array(32)));

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const sameSecret = (a: string, b: string): boolean => {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  return left.byteLength === right.byteLength && crypto.subtle.timingSafeEqual(left, right);
};
