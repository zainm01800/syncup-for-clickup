/* global globalThis */
// AES-256-GCM encryption using the Web Crypto API (globalThis.crypto.subtle).
// Available in Node.js 19+ and modern browsers — requires no node: imports,
// which avoids Vite's commonjs--resolver flagging this as a server-only module
// during the client build's static analysis phase.

const ALGORITHM = "AES-GCM";
const ENC_PREFIX = "enc:";
const IV_BYTES = 12;

function hexToBytes(hex) {
  const buf = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    buf[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return buf;
}

function bytesToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getKeyBytes() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY env var must be a 64-character hex string (32 bytes). " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }
  return hexToBytes(hex);
}

async function importKey() {
  return globalThis.crypto.subtle.importKey(
    "raw",
    getKeyBytes(),
    { name: ALGORITHM },
    false,
    ["encrypt", "decrypt"]
  );
}

// Returns "enc:{ivHex}:{combinedCiphertextAndTagHex}"
export async function encryptToken(plaintext) {
  const key = await importKey();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipherBuf = await globalThis.crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `${ENC_PREFIX}${bytesToHex(iv)}:${bytesToHex(cipherBuf)}`;
}

export async function decryptToken(data) {
  if (!data || !data.startsWith(ENC_PREFIX)) {
    // Legacy plaintext token — return as-is so existing connections keep working.
    return data;
  }
  const parts = data.slice(ENC_PREFIX.length).split(":");
  if (parts.length !== 2) {
    // Old 3-part format from previous node:crypto implementation.
    // Can't decrypt without node:crypto; return null to trigger reconnection.
    return null;
  }
  const key = await importKey();
  const iv = hexToBytes(parts[0]);
  const combined = hexToBytes(parts[1]);
  const decrypted = await globalThis.crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    key,
    combined
  );
  return new TextDecoder().decode(decrypted);
}
