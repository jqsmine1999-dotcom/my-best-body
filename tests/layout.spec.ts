import { test, expect } from "@playwright/test";
import { devLogin, noHorizontalScroll, setupProfile, uname } from "./helpers";

test("JS が届く前から全画面スケルトンを表示する", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/app.js", async (route) => { await gate; await route.continue(); });
  await page.goto("/", { waitUntil: "commit" });
  await expect(page.locator("[data-skeleton] .sk").first()).toBeVisible();
  await expect(page.locator("#app")).toHaveAttribute("aria-busy", "true");
  await noHorizontalScroll(page);
  release();
  await expect(page.getByTestId("google-login")).toBeVisible();
});

test("ログイン画面・静的ページで横スクロールが出ない", async ({ page }) => {
  for (const path of ["/", "/about", "/privacy", "/terms"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await noHorizontalScroll(page);
  }
  await page.goto("/about");
  await expect(page.getByRole("link", { name: "GitHub Issues" })).toHaveAttribute("href", /github\.com\/.+\/issues/);
  await expect(page.locator("body")).not.toContainText("@gmail.com");
});

test("全タブで横スクロールが出ない", async ({ page }, info) => {
  await devLogin(page, uname(info, "layout"));
  await setupProfile(page);
  await page.goto("/");
  await expect(page.getByTestId("summary")).toBeVisible();
  for (const tab of ["home", "meal", "exercise", "settings"]) {
    await page.locator(`.tabbar [data-tab="${tab}"]`).click();
    await expect(page.locator(`.tabbar [data-tab="${tab}"]`)).toHaveAttribute("aria-current", "page");
    await page.waitForTimeout(700);
    await noHorizontalScroll(page);
  }
});

test("PWA: マニフェスト・アイコン・同意画面用ロゴ・Service Worker", async ({ page, request }) => {
  const m = await (await request.get("/manifest.webmanifest")).json();
  expect(m.display).toBe("standalone");
  for (const icon of m.icons) expect((await request.get(icon.src)).status()).toBe(200);
  const logo = await request.get("/logo-120.png");
  expect(logo.headers()["content-type"]).toContain("image/png");
  const buf = await logo.body();
  expect(buf.readUInt32BE(16)).toBe(120);
  expect(buf.readUInt32BE(20)).toBe(120);
  await page.goto("/");
  const ok = await page.evaluate(async () => !!(await navigator.serviceWorker?.ready.then((r) => r.active)));
  expect(ok).toBe(true);
});
