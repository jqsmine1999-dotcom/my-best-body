import { test, expect } from "@playwright/test";
import { devLogin, localDate, ORIGIN, setupProfile, uname } from "./helpers";

test("他人のデータは読めない・変更できない・削除できない", async ({ browser }, info) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  await devLogin(a, uname(info, "owner"));
  await setupProfile(a);
  await devLogin(b, uname(info, "intruder"));
  await setupProfile(b);
  const date = localDate();

  const meal = await (await a.request.post("/api/meals", { headers: ORIGIN, data: { date, slot: "lunch", text: "鮭1切れ、ご飯" } })).json();
  const ex = await (await a.request.post("/api/exercises", { headers: ORIGIN, data: { date, text: "ウォーキング20分" } })).json();
  const mealId = meal.meal.id;
  const exId = ex.exercises[0].id;

  // B からは見えない
  const bDay = await (await b.request.get(`/api/day?date=${date}`)).json();
  expect(bDay.meals).toHaveLength(0);
  expect(bDay.exercises).toHaveLength(0);
  const bRecent = await (await b.request.get("/api/meals/recent")).json();
  expect(bRecent.meals.map((m: any) => m.id)).not.toContain(mealId);

  // B から変更・削除・コピーできない
  expect((await b.request.patch(`/api/meals/${mealId}`, { headers: ORIGIN, data: { slot: "dinner" } })).status()).toBe(404);
  expect((await b.request.delete(`/api/meals/${mealId}`, { headers: ORIGIN })).status()).toBe(404);
  expect((await b.request.post(`/api/meals/${mealId}/copy`, { headers: ORIGIN, data: { date, slot: "dinner" } })).status()).toBe(404);
  expect((await b.request.delete(`/api/exercises/${exId}`, { headers: ORIGIN })).status()).toBe(404);

  // A のデータはそのまま
  const aDay = await (await a.request.get(`/api/day?date=${date}`)).json();
  expect(aDay.meals.map((m: any) => m.id)).toEqual([mealId]);
  expect(aDay.meals[0].slot).toBe("lunch");
  expect(aDay.exercises.map((e: any) => e.id)).toEqual([exId]);

  // B がアカウント削除しても A は影響を受けない
  expect((await b.request.delete("/api/account", { headers: ORIGIN, data: { confirm: "削除" } })).status()).toBe(200);
  expect((await a.request.get(`/api/day?date=${date}`)).status()).toBe(200);
});

test("入力チェック: 不正な値は 400", async ({ page }, info) => {
  await devLogin(page, uname(info, "valid"));
  await setupProfile(page);
  const date = localDate();
  expect((await page.request.post("/api/meals", { headers: ORIGIN, data: { date, slot: "brunch", text: "パン" } })).status()).toBe(400);
  expect((await page.request.post("/api/meals", { headers: ORIGIN, data: { date: "2026/1/1", slot: "lunch", text: "パン" } })).status()).toBe(400);
  expect((await page.request.post("/api/meals", { headers: ORIGIN, data: { date, slot: "lunch", text: "" } })).status()).toBe(400);
  expect((await page.request.put("/api/weights", { headers: ORIGIN, data: { date, kg: 5 } })).status()).toBe(400);
  const noTime = await page.request.post("/api/exercises", { headers: ORIGIN, data: { date, text: "ランニング" } });
  expect(noTime.status()).toBe(400);
  expect((await noTime.json()).error).toContain("時間");
  expect((await page.request.delete("/api/account", { headers: ORIGIN, data: { confirm: "はい" } })).status()).toBe(400);
});
