import { test, expect } from "@playwright/test";
import { webcrypto as crypto, createECDH, createHmac, createDecipheriv } from "node:crypto";
import { encryptPayload, b64u } from "../src/push";

// RFC 8291 の受信側の手順で復号できることを確かめる（ブラウザ非依存なので1プロジェクトだけで実行）
test("Web Push 暗号化 (aes128gcm) を受信側の手順で復号できる", async ({}, info) => {
  test.skip(info.project.name !== "android-chromium");
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const body = Buffer.from(await encryptPayload(b64u(ua.getPublicKey()), b64u(auth), JSON.stringify({ title: "朝食" })));

  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const cipher = body.subarray(21 + idlen);
  const hmac = (k: Buffer | Uint8Array, d: Buffer) => createHmac("sha256", k).update(d).digest();
  const ecdh = ua.computeSecret(asPublic);
  const prkKey = hmac(auth, ecdh);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic, Buffer.from([1])])).subarray(0, 32);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(cipher.subarray(cipher.length - 16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
  expect(plain[plain.length - 1]).toBe(2);
  expect(JSON.parse(plain.subarray(0, -1).toString())).toEqual({ title: "朝食" });
});
