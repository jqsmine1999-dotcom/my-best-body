import { test, expect } from "@playwright/test";
import { devLogin, ORIGIN, uname } from "./helpers";

test.describe("認証フロー", () => {
  test("未ログインならログイン画面を表示し、API は 401", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("google-login")).toBeVisible();
    await expect(page.getByRole("link", { name: "プライバシーポリシー" })).toBeVisible();
    const res = await page.request.get("/api/me");
    expect(res.status()).toBe(401);
  });

  test("Google ログイン開始で PKCE(S256) と state を付けてリダイレクトし、HttpOnly Cookie を発行する", async ({ request }) => {
    const res = await request.get("/auth/google", { maxRedirects: 0 });
    expect(res.status()).toBe(302);
    const loc = new URL(res.headers()["location"]);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(loc.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(loc.searchParams.get("scope")).toBe("openid email profile");
    expect(loc.searchParams.get("redirect_uri")).toBe("http://localhost:8788/auth/callback");
    const cookie = res.headers()["set-cookie"];
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  test("コールバック: Cookie なし・state 不一致は拒否", async ({ request }) => {
    const noCookie = await request.get("/auth/callback?code=x&state=y", { maxRedirects: 0 });
    expect(noCookie.status()).toBe(400);
    const start = await request.get("/auth/google", { maxRedirects: 0 });
    expect(start.status()).toBe(302);
    const bad = await request.get("/auth/callback?code=x&state=wrong-state", { maxRedirects: 0 });
    expect(bad.status()).toBe(400);
    expect(await bad.text()).toContain("state");
  });

  test("開発用ログイン → セッション Cookie は HttpOnly、ログアウトで無効化", async ({ page, context }, info) => {
    await devLogin(page, uname(info, "auth"));
    const me = await page.request.get("/api/me");
    expect(me.status()).toBe(200);
    const sid = (await context.cookies()).find((c) => c.name === "mbb_sid");
    expect(sid?.httpOnly).toBe(true);
    expect(sid?.sameSite).toBe("Lax");
    const out = await page.request.post("/auth/logout", { headers: ORIGIN });
    expect(out.status()).toBe(200);
    expect((await page.request.get("/api/me")).status()).toBe(401);
  });

  test("CSRF: Origin が無い・他サイトからの更新リクエストは 403", async ({ page }, info) => {
    await devLogin(page, uname(info, "csrf"));
    const none = await page.request.post("/api/weights", { data: { date: "2026-10-01", kg: 70 } });
    expect(none.status()).toBe(403);
    const evil = await page.request.post("/api/weights", { headers: { origin: "https://evil.example" }, data: { date: "2026-10-01", kg: 70 } });
    expect(evil.status()).toBe(403);
  });
});
