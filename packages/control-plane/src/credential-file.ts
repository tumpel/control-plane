import { z } from "zod";

const AuthFileSchema = z.object({ tokens: z.object({ access_token: z.string().min(1) }) });
const ClaimsSchema = z.object({ exp: z.number().int() });

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const base64Url = (text: string): string => {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/");
  try {
    return atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
  } catch {
    return "";
  }
};

export const accessTokenExpiry = (authJson: string): string | null => {
  const auth = AuthFileSchema.safeParse(parsed(authJson));
  if (!auth.success) return null;
  const payload = auth.data.tokens.access_token.split(".")[1];
  if (payload === undefined) return null;
  const claims = ClaimsSchema.safeParse(parsed(base64Url(payload)));
  if (!claims.success) return null;
  return new Date(claims.data.exp * 1000).toISOString();
};
