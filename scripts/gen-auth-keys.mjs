// Generates a JWT RS256 key pair in the exact format Convex Auth expects,
// then prints them as JSON. Throw away after use.
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

const keys = await generateKeyPair("RS256", { extractable: true });
const privateKey = await exportPKCS8(keys.privateKey);
const publicJwk = await exportJWK(keys.publicKey);
const jwks = JSON.stringify({ keys: [{ use: "sig", ...publicJwk }] });

process.stdout.write(
  JSON.stringify({
    JWT_PRIVATE_KEY: privateKey.trimEnd().replace(/\n/g, " "),
    JWKS: jwks,
  }),
);
