import { type JwtCheck, jwtVerifier } from "./jwt";

export type Verification =
  | { ok: true; kind: "Person"; email: string }
  | { ok: true; kind: "ServiceToken"; commonName: string }
  | { ok: false; reason: string };

export type Verify = (assertion: string) => Promise<Verification>;

const REASONS: Record<JwtCheck, string> = {
  token: "the JWT is malformed or not signed with RS256",
  kid: "the JWT is signed by a key the identity proxy does not publish",
  signature: "the JWT signature does not verify",
  iss: "the JWT was issued by another Access team",
  aud: "the JWT is meant for another Access application",
  exp: "the JWT has expired",
  nbf: "the JWT is not valid yet",
};

export const accessVerifier = (issuer: string, audience: string): Verify => {
  const verify = jwtVerifier(`${issuer}/cdn-cgi/access/certs`, issuer, audience);
  return async (assertion) => {
    const verified = await verify(assertion);
    if (!verified.ok) return { ok: false, reason: REASONS[verified.check] };
    const { email, common_name: commonName } = verified.claims;
    if (typeof email === "string" && email.includes("@"))
      return { ok: true, kind: "Person", email: email.toLowerCase() };
    if (typeof commonName === "string" && commonName !== "") return { ok: true, kind: "ServiceToken", commonName };
    return { ok: false, reason: "the JWT names neither a person nor a service token" };
  };
};
