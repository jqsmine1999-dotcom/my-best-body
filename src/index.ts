import { Hono, type Context } from "hono";
import { currentUser, createSession, destroySession, googleCallback, isDevLoginAllowed, startGoogle, upsertUser } from "./auth";
import { parseExercise, parseMeal, writeAdvice } from "./ai";
import { addDays, adviceCandidates, analyze, plannedWeight, type DayTotal } from "./coach";
import { calcTargets, exerciseKcal, sumItems, type MealItem, type Profile } from "./nutrition";
import { sendPush, type Sub } from "./push";

export interface Env {
  DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_JWK?: string;
  VAPID_SUBJECT: string;
  DEV_LOGIN?: string;
  AI_DISABLED?: string;
}

type User = { id: string; email: string; name: string | null };
type C = Context<{ Bindings: Env; Variables: { user: User } }>;

const app = new Hono<{ Bindings: Env; Variables: { user: User } }>();

const SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;
const SLOT_LABEL: Record<string, string> = { breakfast: "朝食", lunch: "昼食", dinner: "夕食", snack: "間食" };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

class BadRequest extends Error {}
const bad = (msg: string): never => { throw new BadRequest(msg); };
const isDate = (v: unknown): v is string => typeof v === "string" && DATE_RE.test(v) && !Number.isNaN(Date.parse(v));
const numIn = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

export function jstNow(now = Date.now()) {
  const d = new Date(now + 9 * 3600000);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

app.onError((err, c) => {
  if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
  console.error(err);
  return c.json({ error: "サーバーでエラーが発生しました" }, 500);
});

// 状態を変えるリクエストは同一オリジンからのみ受け付ける（CSRF 対策）
app.use("*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    const site = c.req.header("sec-fetch-site");
    const self = new URL(c.req.url).origin;
    if (origin ? origin !== self : site !== "same-origin") return c.json({ error: "forbidden" }, 403);
  }
  await next();
  if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
});

// ---------- 認証 ----------
app.get("/auth/google", (c) => startGoogle(c as any));
app.get("/auth/callback", (c) => googleCallback(c as any));
app.post("/auth/logout", async (c) => {
  await destroySession(c as any);
  return c.json({ ok: true });
});

app.get("/dev/login", async (c) => {
  if (!isDevLoginAllowed(c as any)) return c.notFound();
  const as = (c.req.query("as") ?? "dev").replace(/[^a-z0-9_-]/gi, "").slice(0, 20) || "dev";
  const id = await upsertUser(c.env, `dev:${as}`, `${as}@dev.localhost`, `開発用 ${as}`);
  await createSession(c as any, id);
  return c.redirect(c.req.query("next") === "none" ? "/api/me" : "/", 302);
});

app.use("/api/*", async (c, next) => {
  const user = await currentUser(c as any);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
});

// ---------- データ取得ヘルパー ----------
async function getProfile(env: Env, userId: string): Promise<Profile | null> {
  const row = await env.DB.prepare("SELECT * FROM profiles WHERE user_id = ?").bind(userId).first<any>();
  if (!row) return null;
  return { ...row, meal_times: JSON.parse(row.meal_times) } as Profile;
}

async function weightOn(env: Env, userId: string, date: string, fallback: number) {
  const w = await env.DB.prepare("SELECT kg FROM weights WHERE user_id = ? AND date <= ? ORDER BY date DESC LIMIT 1")
    .bind(userId, date).first<{ kg: number }>();
  return w?.kg ?? fallback;
}

async function dayTotals(env: Env, userId: string, from: string, to: string): Promise<DayTotal[]> {
  const meals = await env.DB.prepare(
    "SELECT date, SUM(kcal) kcal, SUM(p) p, SUM(f) f, SUM(c) c, COUNT(*) n FROM meals WHERE user_id = ? AND date BETWEEN ? AND ? GROUP BY date",
  ).bind(userId, from, to).all<any>();
  const ex = await env.DB.prepare("SELECT date, SUM(kcal) kcal FROM exercises WHERE user_id = ? AND date BETWEEN ? AND ? GROUP BY date")
    .bind(userId, from, to).all<any>();
  const map = new Map<string, DayTotal>();
  for (const m of meals.results) map.set(m.date, { date: m.date, kcal: m.kcal, p: m.p, f: m.f, c: m.c, meals: m.n, ex: 0 });
  for (const e of ex.results) {
    const d = map.get(e.date) ?? { date: e.date, kcal: 0, p: 0, f: 0, c: 0, meals: 0, ex: 0 };
    d.ex = e.kcal;
    map.set(e.date, d);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const mealOut = (m: any) => ({ ...m, items: JSON.parse(m.items) });

// ---------- API ----------
app.get("/api/me", async (c) => {
  const user = c.get("user");
  return c.json({ user, profile: await getProfile(c.env, user.id), vapidPublicKey: c.env.VAPID_PUBLIC_KEY || null });
});

app.put("/api/profile", async (c) => {
  const user = c.get("user");
  const b = await c.req.json<any>().catch(() => ({}));
  if (!["male", "female"].includes(b.sex)) bad("性別を選んでください");
  if (!numIn(b.birth_year, 1920, 2015)) bad("生まれ年が正しくありません");
  if (!numIn(b.height_cm, 100, 230)) bad("身長が正しくありません");
  if (!numIn(b.current_weight, 25, 300)) bad("現在の体重が正しくありません");
  if (!numIn(b.target_weight, 25, 300)) bad("目標体重が正しくありません");
  if (!isDate(b.target_date)) bad("目標日が正しくありません");
  if (!["low", "mid", "high"].includes(b.activity)) bad("活動量を選んでください");
  const mt = b.meal_times ?? {};
  if (![mt.breakfast, mt.lunch, mt.dinner].every((t) => typeof t === "string" && TIME_RE.test(t))) bad("食事の時刻が正しくありません");
  const today = isDate(b.today) ? b.today : jstNow().date;
  if (b.target_date <= today) bad("目標日は明日以降にしてください");
  const existing = await getProfile(c.env, user.id);
  // 目標体重・目標日を変えたら、今日を起点に計画を引き直す
  const replan = !existing || existing.target_weight !== b.target_weight || existing.target_date !== b.target_date;
  const startDate = replan ? today : existing!.start_date;
  const startWeight = replan ? b.current_weight : existing!.start_weight;
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO profiles (user_id, sex, birth_year, height_cm, start_weight, target_weight, target_date, activity, meal_times, notify, start_date, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT(user_id) DO UPDATE SET sex=?2, birth_year=?3, height_cm=?4, start_weight=?5, target_weight=?6, target_date=?7,
         activity=?8, meal_times=?9, notify=?10, start_date=?11, updated_at=?12`,
    ).bind(user.id, b.sex, b.birth_year, b.height_cm, startWeight, b.target_weight, b.target_date, b.activity,
      JSON.stringify({ breakfast: mt.breakfast, lunch: mt.lunch, dinner: mt.dinner }), b.notify === false ? 0 : 1, startDate, Date.now()),
    c.env.DB.prepare("INSERT INTO weights (user_id, date, kg) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET kg = excluded.kg")
      .bind(user.id, today, b.current_weight),
  ]);
  return c.json({ profile: await getProfile(c.env, user.id) });
});

async function requireProfile(c: C) {
  const p = await getProfile(c.env, c.get("user").id);
  if (!p) bad("先にプロフィールを設定してください");
  return p!;
}

app.get("/api/day", async (c) => {
  const user = c.get("user");
  const date = c.req.query("date");
  if (!isDate(date)) bad("日付が正しくありません");
  const p = await requireProfile(c);
  const [meals, exercises, weight, kg] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM meals WHERE user_id = ? AND date = ? ORDER BY created_at").bind(user.id, date).all<any>(),
    c.env.DB.prepare("SELECT * FROM exercises WHERE user_id = ? AND date = ? ORDER BY created_at").bind(user.id, date).all<any>(),
    c.env.DB.prepare("SELECT kg FROM weights WHERE user_id = ? AND date = ?").bind(user.id, date).first<{ kg: number }>(),
    weightOn(c.env, user.id, date!, p.start_weight),
  ]);
  const mealRows = meals.results.map(mealOut);
  const intake = sumItems(mealRows.map((m) => ({ kcal: m.kcal, p: m.p, f: m.f, c: m.c } as MealItem)));
  const exKcal = exercises.results.reduce((a: number, e: any) => a + e.kcal, 0);
  return c.json({
    date, meals: mealRows, exercises: exercises.results, weight: weight?.kg ?? null,
    intake, exercise: Math.round(exKcal), targets: calcTargets(p, kg, date!),
  });
});

app.get("/api/meals/recent", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT m.* FROM meals m JOIN (SELECT text, MAX(created_at) t FROM meals WHERE user_id = ?1 GROUP BY text) r
       ON r.text = m.text AND r.t = m.created_at WHERE m.user_id = ?1 ORDER BY m.created_at DESC LIMIT 8`,
  ).bind(c.get("user").id).all<any>();
  return c.json({ meals: rows.results.map(mealOut) });
});

function readMealInput(b: any) {
  if (!isDate(b.date)) bad("日付が正しくありません");
  if (!SLOTS.includes(b.slot)) bad("食事の区分が正しくありません");
}

async function insertMeal(env: Env, userId: string, date: string, slot: string, text: string, items: MealItem[], source: string) {
  const t = sumItems(items);
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO meals (id, user_id, date, slot, text, items, kcal, p, f, c, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id, userId, date, slot, text, JSON.stringify(items), t.kcal, t.p, t.f, t.c, source, Date.now()).run();
  return mealOut(await env.DB.prepare("SELECT * FROM meals WHERE id = ?").bind(id).first());
}

app.post("/api/meals", async (c) => {
  const b = await c.req.json<any>().catch(() => ({}));
  readMealInput(b);
  const text = String(b.text ?? "").trim();
  if (!text || text.length > 300) bad("食事内容を300文字以内で入力してください");
  await requireProfile(c);
  const { items, source } = await parseMeal(c.env, text);
  return c.json({ meal: await insertMeal(c.env, c.get("user").id, b.date, b.slot, text, items, source) });
});

app.post("/api/meals/:id/copy", async (c) => {
  const b = await c.req.json<any>().catch(() => ({}));
  readMealInput(b);
  const user = c.get("user");
  const src = await c.env.DB.prepare("SELECT * FROM meals WHERE id = ? AND user_id = ?").bind(c.req.param("id"), user.id).first<any>();
  if (!src) return c.json({ error: "not found" }, 404);
  return c.json({ meal: await insertMeal(c.env, user.id, b.date, b.slot, src.text, JSON.parse(src.items), src.source) });
});

app.patch("/api/meals/:id", async (c) => {
  const user = c.get("user");
  const b = await c.req.json<any>().catch(() => ({}));
  const row = await c.env.DB.prepare("SELECT * FROM meals WHERE id = ? AND user_id = ?").bind(c.req.param("id"), user.id).first<any>();
  if (!row) return c.json({ error: "not found" }, 404);
  const slot = b.slot ?? row.slot;
  if (!SLOTS.includes(slot)) bad("食事の区分が正しくありません");
  let items: MealItem[] = JSON.parse(row.items);
  if (b.items !== undefined) {
    if (!Array.isArray(b.items) || b.items.length > 30) bad("品目が正しくありません");
    items = b.items.map((i: any) => {
      if (!numIn(i.kcal, 0, 5000) || !numIn(i.p, 0, 500) || !numIn(i.f, 0, 500) || !numIn(i.c, 0, 800)) bad("数値が正しくありません");
      return { name: String(i.name ?? "").slice(0, 40), quantity: String(i.quantity ?? "").slice(0, 20), grams: numIn(i.grams, 0, 5000) ? i.grams : null,
        kcal: Math.round(i.kcal), p: i.p, f: i.f, c: i.c, assumed: false };
    });
  }
  const t = sumItems(items);
  await c.env.DB.prepare("UPDATE meals SET slot = ?, items = ?, kcal = ?, p = ?, f = ?, c = ?, source = ? WHERE id = ? AND user_id = ?")
    .bind(slot, JSON.stringify(items), t.kcal, t.p, t.f, t.c, b.items !== undefined ? "manual" : row.source, row.id, user.id).run();
  return c.json({ meal: mealOut(await c.env.DB.prepare("SELECT * FROM meals WHERE id = ?").bind(row.id).first()) });
});

app.delete("/api/meals/:id", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM meals WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.get("user").id).run();
  if (!r.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

app.post("/api/exercises", async (c) => {
  const user = c.get("user");
  const b = await c.req.json<any>().catch(() => ({}));
  if (!isDate(b.date)) bad("日付が正しくありません");
  const text = String(b.text ?? "").trim();
  if (!text || text.length > 200) bad("運動内容を200文字以内で入力してください");
  const p = await requireProfile(c);
  const kg = await weightOn(c.env, user.id, b.date, p.start_weight);
  const { list, source } = await parseExercise(c.env, text);
  if (!list.length) bad("運動の種類と時間（例: ランニング30分）を入力してください");
  const now = Date.now();
  const rows = list.map((e, i) => ({
    id: crypto.randomUUID(), user_id: user.id, date: b.date, text: e.source, name: e.name, minutes: e.minutes, met: e.met,
    kcal: exerciseKcal(e.met, kg, e.minutes), source, created_at: now + i,
  }));
  await c.env.DB.batch(rows.map((r) =>
    c.env.DB.prepare("INSERT INTO exercises (id, user_id, date, text, name, minutes, met, kcal, source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .bind(r.id, r.user_id, r.date, r.text, r.name, r.minutes, r.met, r.kcal, r.source, r.created_at)));
  return c.json({ exercises: rows.map(({ user_id, ...r }) => r) });
});

app.delete("/api/exercises/:id", async (c) => {
  const r = await c.env.DB.prepare("DELETE FROM exercises WHERE id = ? AND user_id = ?").bind(c.req.param("id"), c.get("user").id).run();
  if (!r.meta.changes) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

app.put("/api/weights", async (c) => {
  const b = await c.req.json<any>().catch(() => ({}));
  if (!isDate(b.date)) bad("日付が正しくありません");
  if (!numIn(b.kg, 25, 300)) bad("体重が正しくありません");
  await c.env.DB.prepare("INSERT INTO weights (user_id, date, kg) VALUES (?, ?, ?) ON CONFLICT(user_id, date) DO UPDATE SET kg = excluded.kg")
    .bind(c.get("user").id, b.date, Math.round(b.kg * 10) / 10).run();
  return c.json({ ok: true });
});

app.get("/api/progress", async (c) => {
  const user = c.get("user");
  const p = await requireProfile(c);
  const today = isDate(c.req.query("date")) ? c.req.query("date")! : jstNow().date;
  const from = addDays(today, -120);
  const weights = await c.env.DB.prepare("SELECT date, kg FROM weights WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date")
    .bind(user.id, from, today).all<{ date: string; kg: number }>();
  const days = await dayTotals(c.env, user.id, addDays(today, -8), today);
  const a = analyze(p, weights.results, days, today);
  return c.json({
    analysis: a,
    weights: weights.results,
    plan: { start_date: p.start_date, start_weight: p.start_weight, target_date: p.target_date, target_weight: p.target_weight, today_planned: plannedWeight(p, today) },
  });
});

async function fingerprint(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d.slice(0, 8)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

app.get("/api/advice", async (c) => {
  const user = c.get("user");
  const p = await requireProfile(c);
  const today = isDate(c.req.query("date")) ? c.req.query("date")! : jstNow().date;
  const minutes = Number(c.req.query("minutes") ?? jstNow().minutes);
  const weights = await c.env.DB.prepare("SELECT date, kg FROM weights WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date")
    .bind(user.id, addDays(today, -30), today).all<{ date: string; kg: number }>();
  const days = await dayTotals(c.env, user.id, addDays(today, -8), today);
  const a = analyze(p, weights.results, days, today);
  const todayTotal = days.find((d) => d.date === today) ?? { date: today, kcal: 0, p: 0, f: 0, c: 0, meals: 0, ex: 0 };
  const { facts, lines } = adviceCandidates(p, a, todayTotal, Number.isFinite(minutes) ? minutes : 720);
  const fp = await fingerprint(JSON.stringify({ facts, lines }));
  const cached = await c.env.DB.prepare("SELECT * FROM advice WHERE user_id = ? AND date = ?").bind(user.id, today).first<any>();
  if (cached && cached.fingerprint === fp) return c.json({ status: a.status, lines: JSON.parse(cached.body), source: cached.source, analysis: a });
  const ai = await writeAdvice(c.env, facts, lines);
  const out = ai ?? lines;
  const source = ai ? "ai" : "fallback";
  await c.env.DB.prepare(
    "INSERT INTO advice (user_id, date, fingerprint, body, source, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id, date) DO UPDATE SET fingerprint=excluded.fingerprint, body=excluded.body, source=excluded.source, created_at=excluded.created_at",
  ).bind(user.id, today, fp, JSON.stringify(out), source, Date.now()).run();
  return c.json({ status: a.status, lines: out, source, analysis: a });
});

app.post("/api/push/subscribe", async (c) => {
  const b = await c.req.json<any>().catch(() => ({}));
  const endpoint = String(b.endpoint ?? "");
  const p256dh = String(b.keys?.p256dh ?? "");
  const auth = String(b.keys?.auth ?? "");
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || !auth) bad("購読情報が正しくありません");
  await c.env.DB.prepare(
    "INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth",
  ).bind(endpoint, c.get("user").id, p256dh, auth, Date.now()).run();
  return c.json({ ok: true });
});

app.delete("/api/push/subscribe", async (c) => {
  await c.env.DB.prepare("DELETE FROM push_subs WHERE user_id = ?").bind(c.get("user").id).run();
  return c.json({ ok: true });
});

app.post("/api/push/test", async (c) => {
  const subs = await c.env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?").bind(c.get("user").id).all<Sub>();
  let sent = 0;
  for (const s of subs.results) {
    const r = await sendPush(c.env, s, { title: "MyBestBody", body: "通知のテストです", url: "/" });
    if (r === "gone") await c.env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(s.endpoint).run();
    if (r === true) sent++;
  }
  return c.json({ sent });
});

app.delete("/api/account", async (c) => {
  const b = await c.req.json<any>().catch(() => ({}));
  if (b.confirm !== "削除") bad("確認のため「削除」と入力してください");
  const id = c.get("user").id;
  await c.env.DB.batch(
    ["advice", "notif_log", "push_subs", "exercises", "meals", "weights", "profiles", "sessions"].map((t) =>
      c.env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(id))
      .concat(c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id)),
  );
  await destroySession(c as any);
  return c.json({ ok: true });
});

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

// ---------- 食事リマインダー（Cron 5分ごと） ----------
export async function dueReminders(env: Env, now = Date.now()) {
  const { date, minutes } = jstNow(now);
  const profiles = await env.DB.prepare("SELECT user_id, meal_times FROM profiles WHERE notify = 1").all<{ user_id: string; meal_times: string }>();
  const due: { userId: string; slot: string }[] = [];
  for (const p of profiles.results) {
    const mt = JSON.parse(p.meal_times) as Record<string, string>;
    for (const slot of ["breakfast", "lunch", "dinner"]) {
      const [h, m] = mt[slot].split(":").map(Number);
      const diff = minutes - (h * 60 + m);
      if (diff < 0 || diff >= 30) continue;
      const done = await env.DB.prepare(
        "SELECT (SELECT COUNT(*) FROM notif_log WHERE user_id=?1 AND date=?2 AND slot=?3) + (SELECT COUNT(*) FROM meals WHERE user_id=?1 AND date=?2 AND slot=?3) n",
      ).bind(p.user_id, date, slot).first<{ n: number }>();
      if (!done?.n) due.push({ userId: p.user_id, slot });
    }
  }
  return { date, due };
}

export async function runReminders(env: Env, now = Date.now()) {
  const { date, due } = await dueReminders(env, now);
  for (const d of due) {
    await env.DB.prepare("INSERT OR IGNORE INTO notif_log (user_id, date, slot) VALUES (?, ?, ?)").bind(d.userId, date, d.slot).run();
    const subs = await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?").bind(d.userId).all<Sub>();
    for (const s of subs.results) {
      const r = await sendPush(env, s, { title: SLOT_LABEL[d.slot], body: `${SLOT_LABEL[d.slot]}を記録してください`, url: `/?tab=meal&slot=${d.slot}`, tag: `meal-${d.slot}` })
        .catch((e) => { console.warn("push error", String(e)); return false as const; });
      if (r === "gone") await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(s.endpoint).run();
    }
  }
  return due;
}

// テスト用: 指定時刻に通知対象になるか確認する（localhost の開発用ログインが有効なときだけ）
app.get("/dev/reminders", async (c) => {
  if (!isDevLoginAllowed(c as any)) return c.notFound();
  const at = Date.parse(String(c.req.query("at")));
  if (Number.isNaN(at)) return c.json({ error: "at が必要です" }, 400);
  return c.json(await dueReminders(c.env, at));
});

export default {
  fetch: app.fetch,
  async scheduled(_e: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runReminders(env));
  },
} satisfies ExportedHandler<Env>;
