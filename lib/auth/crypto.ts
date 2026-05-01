import sodium from "libsodium-wrappers";

let ready: Promise<void> | null = null;

async function ensureReady() {
  if (!ready) ready = sodium.ready;
  await ready;
}

function loadKey(): Uint8Array {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== sodium.crypto_secretbox_KEYBYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to ${sodium.crypto_secretbox_KEYBYTES} bytes (got ${key.length}). Generate with: openssl rand -base64 32`,
    );
  }
  return key;
}

export type Sealed = { ciphertext: Buffer; nonce: Buffer };

export async function seal(plaintext: string): Promise<Sealed> {
  await ensureReady();
  const key = loadKey();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ct = sodium.crypto_secretbox_easy(
    sodium.from_string(plaintext),
    nonce,
    key,
  );
  return { ciphertext: Buffer.from(ct), nonce: Buffer.from(nonce) };
}

export async function open(sealed: {
  ciphertext: Buffer | Uint8Array;
  nonce: Buffer | Uint8Array;
}): Promise<string> {
  await ensureReady();
  const key = loadKey();
  const pt = sodium.crypto_secretbox_open_easy(
    Uint8Array.from(sealed.ciphertext),
    Uint8Array.from(sealed.nonce),
    key,
  );
  return sodium.to_string(pt);
}
