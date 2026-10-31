import { defineConfig, devices } from "@playwright/test";

const PORT = 8788;
const STATE = ".wrangler/test-state";

export default defineConfig({
  testDir: "tests",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  },
  projects: [
    { name: "iphone-webkit", use: { ...devices["iPhone 15"] } },
    { name: "android-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command:
      `rm -rf ${STATE} && npx wrangler d1 migrations apply my-best-body-db --local --persist-to ${STATE} >/dev/null && ` +
      `npx wrangler dev --port ${PORT} --ip 127.0.0.1 --persist-to ${STATE} ` +
      `--var DEV_LOGIN:1 --var AI_DISABLED:1 --var GOOGLE_CLIENT_ID:test-client.apps.googleusercontent.com --var GOOGLE_CLIENT_SECRET:test-secret`,
    url: `http://localhost:${PORT}/about`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
