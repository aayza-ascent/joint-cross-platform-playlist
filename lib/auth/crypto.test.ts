import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import sodium from "libsodium-wrappers";
import { seal, open } from "./crypto";

function setRandomKey() {
  const key = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.from(key).toString("base64");
}

describe("token vault crypto", () => {
  beforeAll(async () => {
    await sodium.ready;
  });

  beforeEach(() => {
    setRandomKey();
  });

  it("round-trips a string", async () => {
    const plain = "BQ-fake-spotify-access-token-abcdef0123456789";
    const sealed = await seal(plain);
    expect(sealed.ciphertext).toBeInstanceOf(Buffer);
    expect(sealed.nonce.length).toBe(24);
    expect(sealed.ciphertext).not.toEqual(Buffer.from(plain));
    const opened = await open(sealed);
    expect(opened).toBe(plain);
  });

  it("round-trips empty and unicode", async () => {
    for (const plain of ["", "🎵 αβ ñ", "ya29." + "x".repeat(2048)]) {
      const opened = await open(await seal(plain));
      expect(opened).toBe(plain);
    }
  });

  it("rejects tampered ciphertext", async () => {
    const sealed = await seal("hello");
    sealed.ciphertext[0] ^= 0xff;
    await expect(open(sealed)).rejects.toThrow();
  });

  it("rejects ciphertext under a different key", async () => {
    const sealed = await seal("hello");
    setRandomKey();
    await expect(open(sealed)).rejects.toThrow();
  });

  it("rejects a wrong-length key", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = Buffer.from("too-short").toString(
      "base64",
    );
    await expect(seal("x")).rejects.toThrow(/32 bytes/);
  });
});
