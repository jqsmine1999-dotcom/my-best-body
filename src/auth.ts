// Google ログイン（Authorization Code + PKCE + state）と HttpOnly Cookie セッション
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { b64u } from "./push";
import type { Env } from "./index";

const SESSION_DAYS = 60;
const enc = new TextEncoder();

export const isSecure = (c: Context) => new URL(c.req.url).protocol === "https:";
export const sessionCookieName = (c: Context) => (isSecure(c) ? "__Host-mbb_sid" : "mbb_sid");
const oauthCookieName = (c: Context) => (isSecure(c) ? "__Host-mbb_oauth" : "mbb_oauth");

function randomToken(bytes = 32) {
  return b64u(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256(s: string) {
  return b64u(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function isDevLoginAllowed(c: Context<{ Bindings: Env }>) {
  const host = new URL(c.req.url).hostname;
  return c.env.DEV_LOGIN === "1" && (host === "localhost" || host === "127.0.0.1");
}

export async function createSession(c: Context<{ Bindings: Env }>, userId: string) {
  const token = randomToken();
  const expires = Date.now() + SESSION_DAYS * 86400000;
  await c.env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), userId, expires).run();
  setCookie(c, sessionCookieName(c), token, {
    httpOnly: true, secure: isSecure(c), sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400,
  });
}

export async function currentUser(c: Context<{ Bindings: Env }>): Promise<{ id: string; email: string; name: string | null } | null> {
  const token = getCookie(c, sessionCookieName(c));
  if (!token) return null;
  const row = await c.env.DB.prepare(
    "SELECT u.id, u.email, u.name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?",
  ).bind(await sha256(token)).first<{ id: string; email: string; name: string | null; expires_at: number }>();
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, email: row.email, name: row.name };
}

export async function destroySession(c: Context<{ Bindings: Env }>) {
  const token = getCookie(c, sessionCookieName(c));
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256(token)).run();
  deleteCookie(c, sessionCookieName(c), { path: "/", secure: isSecure(c) });
}

export async function upsertUser(env: Env, sub: string, email: string, name: string | null): Promise<string> {
  const existing = await env.DB.prepare("SELECT id FROM users WHERE google_sub = ?").bind(sub).first<{ id: string }>();
  if (existing) {
    await env.DB.prepare("UPDATE users SET email = ?, name = ? WHERE id = ?").bind(email, name, existing.id).run();
    return existing.id;
  }
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO users (id, google_sub, email, name, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, sub, email, name, Date.now()).run();
  return id;
}

const redirectUri = (c: Context) => new URL("/auth/callback", c.req.url).toString();

export async function startGoogle(c: Context<{ Bindings: Env }>) {
  if (!c.env.GOOGLE_CLIENT_ID) return c.text("Google ログインの設定がまだ完了していません。", 503);
  const state = randomToken(16);
  const verifier = randomToken(48);
  const challenge = await sha256(verifier);
  setCookie(c, oauthCookieName(c), `${state}.${verifier}`, {
    httpOnly: true, secure: isSecure(c), sameSite: "Lax", path: "/", maxAge: 600,
  });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(c),
    response_type: "code",
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  }).toString();
  return c.redirect(url.toString(), 302);
}

function decodeJwtPayload(jwt: string): any {
  const part = jwt.split(".")[1] ?? "";
  const json = atob(part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(json, (ch) => ch.charCodeAt(0))));
}

export async function googleCallback(c: Context<{ Bindings: Env }>) {
  const saved = getCookie(c, oauthCookieName(c));
  deleteCookie(c, oauthCookieName(c), { path: "/", secure: isSecure(c) });
  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? "";
  if (!saved || !state || !code) return c.text("ログインに失敗しました（state がありません）。もう一度お試しください。", 400);
  const [savedState, verifier] = saved.split(".");
  if (!timingSafeEqual(savedState, state)) return c.text("ログインに失敗しました（state が一致しません）。", 400);
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) return c.text("Google ログインの設定がまだ完了していません。", 503);

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(c),
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!res.ok) return c.text("ログインに失敗しました（トークン取得エラー）。", 400);
  const tok = (await res.json()) as { id_token?: string };
  if (!tok.id_token) return c.text("ログインに失敗しました。", 400);
  // id_token は Google のトークンエンドポイントから TLS で直接受け取ったもの（OIDC Core 3.1.3.7）
  const claims = decodeJwtPayload(tok.id_token);
  const issOk = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  if (!issOk || claims.aud !== c.env.GOOGLE_CLIENT_ID || claims.exp * 1000 < Date.now() || !claims.email_verified) {
    return c.text("ログインに失敗しました（トークン検証エラー）。", 400);
  }
  const userId = await upsertUser(c.env, String(claims.sub), String(claims.email), claims.name ?? null);
  await createSession(c, userId);
  return c.redirect("/", 302);
}
