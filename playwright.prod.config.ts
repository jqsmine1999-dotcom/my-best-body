import { defineConfig, devices } from "@playwright/test";

// 本番 URL に対する確認（npm run test:prod）
export default defineConfig({
  testDir: "tests-prod",
  timeout: 45_000,
  reporter: [["list"]],
  use: { baseURL: process.env.PROD_URL ?? "https://my-best-body.jqsmine1999.workers.dev", locale: "ja-JP", timezoneId: "Asia/Tokyo" },
  projects: [
    { name: "iphone-webkit", use: { ...devices["iPhone 15"] } },
    { name: "android-chromium", use: { ...devices["Pixel 7"] } },
  ],
});
