import { test, expect } from "@playwright/test";

const noHScroll = async (page: import("@playwright/test").Page) => {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw).toBeLessThanOrEqual(cw);
};

test("トップ: スケルトン入りの HTML → ログイン画面、横スクロールなし", async ({ page, request }) => {
  const html = await (await request.get("/")).text();
  expect(html).toContain("data-skeleton");
  await page.goto("/");
  await expect(page.getByTestId("google-login")).toBeVisible();
  await noHScroll(page);
});

test("公開ページ（/about /privacy /terms）とロゴ", async ({ page, request }) => {
  for (const p of ["/about", "/privacy", "/terms"]) {
    const r = await page.goto(p);
    expect(r?.status()).toBe(200);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator('a[href*="github.com/jqsmine1999-dotcom/my-best-body/issues"]').first()).toBeVisible();
    await noHScroll(page);
  }
  const logo = await (await request.get("/logo-120.png")).body();
  expect([logo.readUInt32BE(16), logo.readUInt32BE(20)]).toEqual([120, 120]);
});

test("本番では開発用ログイン・開発用エンドポイントが無効", async ({ request }) => {
  expect((await request.get("/dev/login?as=x", { maxRedirects: 0 })).status()).toBe(404);
  expect((await request.get("/dev/reminders?at=2026-01-01T00:00:00Z")).status()).toBe(404);
  expect((await request.get("/api/me")).status()).toBe(401);
  expect((await request.get("/api/day?date=2026-11-01")).status()).toBe(401);
});

test("セキュリティヘッダーと CSRF", async ({ request }) => {
  const r = await request.get("/");
  expect(r.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(r.headers()["x-content-type-options"]).toBe("nosniff");
  expect((await request.post("/api/weights", { headers: { origin: "https://evil.example" }, data: {} })).status()).toBe(403);
});

test("Google ログイン開始（設定済みなら PKCE 付きで Google へリダイレクト）", async ({ request }) => {
  const r = await request.get("/auth/google", { maxRedirects: 0 });
  test.skip(r.status() === 503, "GOOGLE_CLIENT_ID が未登録");
  expect(r.status()).toBe(302);
  const loc = new URL(r.headers()["location"]);
  expect(loc.host).toBe("accounts.google.com");
  expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
  expect(loc.searchParams.get("redirect_uri")).toBe("https://my-best-body.jqsmine1999.workers.dev/auth/callback");
  expect(r.headers()["set-cookie"]).toMatch(/__Host-mbb_oauth=.*HttpOnly.*Secure|__Host-mbb_oauth=.*Secure.*HttpOnly/i);
});
