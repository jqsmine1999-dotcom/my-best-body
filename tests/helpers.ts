import { expect, type Page, type TestInfo } from "@playwright/test";

export const BASE = "http://localhost:8788";
export const ORIGIN = { origin: BASE };

export function uname(info: TestInfo, tag: string) {
  return `${info.project.name.split("-")[0]}-${tag}-${info.workerIndex}-${Date.now() % 100000}`;
}

export function localDate(offset = 0) {
  const d = new Date(Date.now() + 9 * 3600000 + offset * 86400000);
  return d.toISOString().slice(0, 10);
}

export async function devLogin(page: Page, name: string) {
  await page.goto(`/dev/login?as=${name}&next=none`);
}

export async function setupProfile(page: Page, opts: { weight?: number; target?: number } = {}) {
  const res = await page.request.put("/api/profile", {
    headers: ORIGIN,
    data: {
      sex: "male", birth_year: 1990, height_cm: 172, current_weight: opts.weight ?? 78, target_weight: opts.target ?? 72,
      target_date: localDate(120), activity: "low", today: localDate(),
      meal_times: { breakfast: "07:30", lunch: "12:00", dinner: "19:00" },
    },
  });
  expect(res.status()).toBe(200);
}

export async function noHorizontalScroll(page: Page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, "横スクロールが発生していないこと").toBeLessThanOrEqual(cw);
}
