// 実際に操作するデモ動画を iPhone 15 相当の解像度（1178×2556。H.264 の都合で幅は偶数）の MP4 で録画する
//   npm run demo                         ローカルに専用サーバーを立て、開発用ログインで一連の操作を録画
//   DEMO_BASE_URL=https://... npm run demo  公開ページ（ログイン画面・/about）だけを録画
import { webkit, devices } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync, renameSync } from "node:fs";
import ffmpeg from "ffmpeg-static";

const OUT_DIR = "demo";
const PORT = 8789;
const STATE = ".wrangler/demo-state";
const remote = process.env.DEMO_BASE_URL;
const base = remote ?? `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jstDate(offset = 0) {
  return new Date(Date.now() + 9 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
}

async function startServer() {
  rmSync(STATE, { recursive: true, force: true });
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "my-best-body-db", "--local", "--persist-to", STATE], { stdio: "ignore" });
  const proc = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", STATE, "--var", "DEV_LOGIN:1"], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${base}/about`)).ok) return proc; } catch {}
    await sleep(1000);
  }
  throw new Error("dev server did not start");
}

async function seed(page) {
  const h = { origin: base };
  await page.goto(`${base}/dev/login?as=demo&next=none`);
  await page.request.put(`${base}/api/profile`, {
    headers: h,
    data: { sex: "male", birth_year: 1990, height_cm: 172, current_weight: 78.6, target_weight: 72, target_date: jstDate(100), activity: "low", today: jstDate(),
      meal_times: { breakfast: "07:30", lunch: "12:00", dinner: "19:00" } },
  });
  // 2週間前から始めた想定で体重の推移を入れる
  execFileSync("npx", ["wrangler", "d1", "execute", "my-best-body-db", "--local", "--persist-to", STATE, "--command",
    `UPDATE profiles SET start_date = '${jstDate(-14)}', start_weight = 79.8`], { stdio: "ignore" });
  const ws = [79.8, 79.6, 79.7, 79.3, 79.4, 79.1, 79.0, 79.2, 78.9, 78.8, 78.9, 78.6, 78.5, 78.6];
  for (let i = 0; i < ws.length; i++) await page.request.put(`${base}/api/weights`, { headers: h, data: { date: jstDate(i - 14), kg: ws[i] } });
  await page.request.post(`${base}/api/meals`, { headers: h, data: { date: jstDate(), slot: "breakfast", text: "納豆ごはん、味噌汁、卵1個" } });
}

async function type(page, locator, text) {
  await locator.click();
  for (const ch of text) { await locator.pressSequentially(ch); await sleep(60); }
}

// ホーム画面から開いた PWA と同じ全画面（393×852pt）で録画する
const iphone = { ...devices["iPhone 15"], viewport: { width: 393, height: 852 } };
const VIDEO = { width: 393, height: 852 };
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
let video;
const server = remote ? null : await startServer();
const browser = await webkit.launch();
try {
  const context = await browser.newContext({
    ...iphone, locale: "ja-JP", timezoneId: "Asia/Tokyo", colorScheme: "light",
    recordVideo: { dir: OUT_DIR, size: VIDEO },
  });
  const page = await context.newPage();
  video = page.video();
  if (remote) {
    await page.goto(base); await sleep(2500);
    await page.goto(`${base}/about`); await sleep(1500);
    await page.evaluate((y) => window.scrollBy({ top: y, behavior: "smooth" }), 600); await sleep(2000);
  } else {
    await seed(page);
    await page.goto(base); await sleep(3500);
    await page.evaluate((y) => window.scrollBy({ top: y, behavior: "smooth" }), 500); await sleep(2000);
    const w = page.getByTestId("weight");
    await w.getByRole("button", { name: "0.1kg減らす" }).click(); await sleep(500);
    await w.getByRole("button", { name: /記録|更新/ }).click(); await sleep(2500);

    await page.locator('.tabbar [data-tab="meal"]').click(); await sleep(1200);
    await page.locator('[data-seg="slot"] button', { hasText: "昼食" }).click(); await sleep(600);
    await type(page, page.getByLabel("食べたもの"), "サラダチキン1個、おにぎり2個、ヨーグルト");
    await page.getByTestId("add-meal").click();
    await page.getByTestId("meal").nth(1).waitFor({ timeout: 40000 }); await sleep(2500);

    await page.locator('.tabbar [data-tab="exercise"]').click(); await sleep(1200);
    await type(page, page.getByLabel("運動内容"), "ジョギング5km 35分");
    await page.getByTestId("add-exercise").click();
    await page.getByTestId("exercise").first().waitFor({ timeout: 40000 }); await sleep(2000);

    await page.locator('.tabbar [data-tab="home"]').click(); await sleep(4500);
    await page.evaluate((y) => window.scrollBy({ top: y, behavior: "smooth" }), 400); await sleep(1500);
    await page.locator('.tabbar [data-tab="settings"]').click(); await sleep(1500);
    await page.evaluate((y) => window.scrollBy({ top: y, behavior: "smooth" }), 900); await sleep(1800);
  }
  await context.close();
} finally {
  await browser.close();
  server?.kill();
}

const webm = await video.path();
const mp4 = `${OUT_DIR}/mybestbody-demo.mp4`;
execFileSync(ffmpeg, ["-y", "-i", webm, "-vf", "scale=1178:2556:flags=lanczos,fps=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", mp4], { stdio: "inherit" });
renameSync(webm, `${OUT_DIR}/raw.webm`);
console.log(`saved ${mp4}`);
