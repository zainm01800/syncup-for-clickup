// Signs and verifies the OAuth `state` parameter for the ClickUp connect flow.
//
// The shop is bound into an HMAC-signed, time-limited token that is minted ONLY
// inside an authenticated request (the app dashboard loader). Both the connect
// initiation and the OAuth callback derive the shop by verifying this token —
// never from a raw, caller-supplied value — so a forged callback cannot attach
// a ClickUp account to another merchant's store.

const STATE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function b64urlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecodeToString(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacHex(message) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    throw new Error("SHOPIFY_API_SECRET is required to sign OAuth state.");
  }
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );
  return bytesToHex(sig);
}

// Constant-time string comparison to avoid leaking the signature via timing.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

/** Mint a signed state token for `shop`. */
export async function signState(shop) {
  const payload = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ shop, ts: Date.now() }))
  );
  const sig = await hmacHex(payload);
  return `${payload}.${sig}`;
}

/** Returns the shop if `state` is a valid, unexpired token we signed; else null. */
export async function verifyState(state) {
  if (!state || typeof state !== "string" || !state.includes(".")) return null;
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;

  const expected = await hmacHex(payload);
  if (!timingSafeEqual(sig, expected)) return null;

  let data;
  try {
    data = JSON.parse(b64urlDecodeToString(payload));
  } catch {
    return null;
  }
  if (!data || typeof data.shop !== "string" || typeof data.ts !== "number") {
    return null;
  }
  if (Date.now() - data.ts > STATE_TTL_MS) return null;

  return data.shop;
}
