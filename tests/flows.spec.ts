import { test, expect } from "@playwright/test";
import { devLogin, localDate, noHorizontalScroll, ORIGIN, setupProfile, uname } from "./helpers";

test("初回: 目標設定 → ホームに目標カロリー・PFC・コーチ・体重が出る", async ({ page }, info) => {
  await devLogin(page, uname(info, "onboard"));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "目標を設定" })).toBeVisible();
  await page.getByLabel("身長 (cm)").fill("170");
  await page.getByLabel("現在の体重 (kg)").fill("75");
  await page.getByLabel("目標体重 (kg)").fill("68");
  await page.getByRole("button", { name: "女性" }).click();
  await page.getByTestId("save-profile").click();
  const summary = page.getByTestId("summary");
  await expect(summary).toContainText("たんぱく質");
  await expect(summary).toContainText("残り");
  await expect(page.locator("header .sub")).toContainText(/目標 \d[\d,]* kcal/);
  await expect(page.getByTestId("coach").locator(".advice li").first()).toBeVisible();
  await expect(page.getByTestId("weight").locator("input")).toHaveValue("75");
  await noHorizontalScroll(page);
});

test("食事: 文章で記録 → 品目・数量・PFC が出る → 編集 → 最近の食事から再記録 → 削除", async ({ page }, info) => {
  await devLogin(page, uname(info, "meal"));
  await setupProfile(page);
  await page.goto("/");
  await page.locator('.tabbar [data-tab="meal"]').click();
  await page.locator('[data-seg="slot"] button', { hasText: "朝食" }).click();
  await page.getByLabel("食べたもの").fill("納豆ごはん、卵2個、鶏むね肉150g");
  await page.getByTestId("add-meal").click();
  const card = page.getByTestId("meal").first();
  await expect(card).toContainText("納豆ごはん");
  // 書かれた数量はそのまま残る
  await expect(card).toContainText("2個");
  await expect(card).toContainText("150g");
  await expect(card).toContainText("kcal");
  await expect(page.locator(".slot-h").first()).toHaveText("朝食");
  const total1 = Number((await page.getByTestId("meal-total").textContent())!.replace(/,/g, ""));
  expect(total1).toBeGreaterThan(400);

  // 1品目の kcal を手で直す
  await card.getByRole("button", { name: "編集" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.locator(".edit-item").first().locator('[name="kcal"]').fill("100");
  await sheet.getByRole("button", { name: "保存" }).click();
  await expect(sheet).toBeHidden();
  await expect.poll(async () => Number((await page.getByTestId("meal-total").textContent())!.replace(/,/g, ""))).toBe(total1 - 320 + 100);

  // 最近の食事チップから昼食にワンタップ記録
  await page.locator('[data-seg="slot"] button', { hasText: "昼食" }).click();
  await page.locator("#recent button").first().click();
  await expect(page.getByTestId("meal")).toHaveCount(2);
  await expect(page.locator(".slot-h")).toHaveText(["朝食", "昼食"]);

  // 削除
  await page.getByTestId("meal").first().getByRole("button", { name: "削除" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "削除" }).click();
  await expect(page.getByTestId("meal")).toHaveCount(1);
  await noHorizontalScroll(page);
});

test("運動: クイック記録と文章入力で消費カロリーを算出 → ホームの予算に反映", async ({ page }, info) => {
  await devLogin(page, uname(info, "ex"));
  await setupProfile(page, { weight: 80 });
  await page.goto("/");
  await page.locator('.tabbar [data-tab="exercise"]').click();
  await page.getByRole("button", { name: "ランニング30分" }).click();
  // 1.05 × 8.3 METs × 80kg × 0.5h = 349
  await expect(page.getByTestId("ex-total")).toHaveText("349 kcal");
  await page.getByLabel("運動内容").fill("筋トレ1時間");
  await page.getByTestId("add-exercise").click();
  // + 1.05 × 5.0 × 80 × 1h = 420
  await expect(page.getByTestId("ex-total")).toHaveText("769 kcal");
  await expect(page.getByTestId("exercise")).toHaveCount(2);
  await page.locator('.tabbar [data-tab="home"]').click();
  await expect(page.getByTestId("summary")).toContainText("+769");
  await noHorizontalScroll(page);
});

test("体重: 記録すると目標までの残りが更新される。前日に移動して記録できる", async ({ page }, info) => {
  await devLogin(page, uname(info, "weight"));
  await setupProfile(page, { weight: 78, target: 72 });
  await page.goto("/");
  const w = page.getByTestId("weight");
  await w.locator("input").fill("77.0");
  await w.getByRole("button", { name: "0.1kg減らす" }).click();
  await expect(w.locator("input")).toHaveValue("76.9");
  await w.getByRole("button", { name: /記録|更新/ }).click();
  await expect(page.getByTestId("weight").locator(".stat").first()).toContainText("4.9");

  await page.locator('.tabbar [data-tab="meal"]').click();
  await page.getByRole("button", { name: "前の日" }).click();
  await expect(page.locator(".datebar b")).toContainText("昨日");
  await page.getByLabel("食べたもの").fill("カレーライス");
  await page.getByTestId("add-meal").click();
  await expect(page.getByTestId("meal")).toHaveCount(1);
  const y = await (await page.request.get(`/api/day?date=${localDate(-1)}`)).json();
  expect(y.meals).toHaveLength(1);
  const t = await (await page.request.get(`/api/day?date=${localDate()}`)).json();
  expect(t.meals).toHaveLength(0);
});

test("アカウント削除: 2段階確認の後、全データが消えてログイン画面に戻る", async ({ page }, info) => {
  const name = uname(info, "del");
  await devLogin(page, name);
  await setupProfile(page);
  await page.request.post("/api/meals", { headers: ORIGIN, data: { date: localDate(), slot: "dinner", text: "ラーメン" } });
  await page.goto("/");
  await page.locator('.tabbar [data-tab="settings"]').click();
  await page.getByTestId("delete-account").click();
  // 1段階目
  await page.getByRole("dialog").getByRole("button", { name: "次へ" }).click();
  // 2段階目: 「削除」と入力するまで押せない
  const final = page.getByTestId("delete-final");
  await expect(final).toBeDisabled();
  await page.getByTestId("delete-confirm").fill("さくじょ");
  await expect(final).toBeDisabled();
  await page.getByTestId("delete-confirm").fill("削除");
  await expect(final).toBeEnabled();
  await final.click();
  await expect(page.getByTestId("google-login")).toBeVisible();
  expect((await page.request.get("/api/me")).status()).toBe(401);
  // 同じ ID で入り直すと新規ユーザー（データなし）
  await devLogin(page, name);
  const me = await (await page.request.get("/api/me")).json();
  expect(me.profile).toBeNull();
});

test("食事通知: 時刻になり未記録の食事だけが通知対象になる", async ({ page }, info) => {
  await devLogin(page, uname(info, "notify"));
  await setupProfile(page);
  const me = await (await page.request.get("/api/me")).json();
  const date = localDate();
  const at = (hhmm: string) => new Date(`${date}T${hhmm}:00+09:00`).toISOString();
  const mine = async (hhmm: string) =>
    (await (await page.request.get(`/dev/reminders?at=${at(hhmm)}`)).json()).due.filter((d: any) => d.userId === me.user.id).map((d: any) => d.slot);
  expect(await mine("07:29")).toEqual([]);
  expect(await mine("07:35")).toEqual(["breakfast"]);
  expect(await mine("08:10")).toEqual([]);
  expect(await mine("12:00")).toEqual(["lunch"]);
  await page.request.post("/api/meals", { headers: ORIGIN, data: { date, slot: "lunch", text: "そば" } });
  expect(await mine("12:05")).toEqual([]);
});

test("コーチ: 目標超過の日は、超過分と消費に必要なウォーキング時間を数値で示す", async ({ page }, info) => {
  await devLogin(page, uname(info, "coach"));
  await setupProfile(page, { weight: 78, target: 72 });
  const date = localDate();
  for (const slot of ["breakfast", "lunch", "dinner"]) {
    await page.request.post("/api/meals", { headers: ORIGIN, data: { date, slot, text: "カレーライス" } });
  }
  const r = await (await page.request.get(`/api/advice?date=${date}&minutes=1260`)).json();
  // 摂取 750×3=2250、目標 1680 → 570kcal 超過。ウォーキング 1.05×3.5×78/60 ≒ 4.78kcal/分 → 119分
  expect(r.source).toBe("fallback");
  expect(r.lines[0]).toContain("570kcal超えています");
  expect(r.lines[0]).toContain("119分");
  await page.goto("/");
  await expect(page.getByTestId("coach").locator(".advice li").first()).toContainText("570kcal");
  await expect(page.getByTestId("summary")).toContainText("超過");
});
