// 本番の Workers AI（REST API）に、アプリと同じプロンプト・検証ロジックで投げて品質を確認する
// 使い方: npm run ai-eval   （wrangler にログイン済みであること）
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const out = join(mkdtempSync(join(tmpdir(), "mbb-eval-")), "ai.mjs");
await build({ entryPoints: ["src/ai.ts", "src/coach.ts"], bundle: true, format: "esm", platform: "neutral", outdir: out.replace(/ai\.mjs$/, ""), outExtension: { ".js": ".mjs" } });
const ai = await import(pathToFileURL(out).href);

const token = execSync("npx wrangler auth token", { encoding: "utf8" }).trim().split("\n").at(-1);
const account = process.env.CF_ACCOUNT_ID ?? "8779ee33d4856911eeb8fe103a73cd82";
const env = {
  AI: {
    async run(model, input) {
      const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(input),
      });
      const j = await r.json();
      if (!j.success) throw new Error(JSON.stringify(j.errors));
      return j.result;
    },
  },
};

const meals = [
  "朝: トースト1枚にバター、ブラックコーヒー",
  "セブンのサラダチキン1個とおにぎり2個（鮭・ツナマヨ）",
  "ランチは同僚の田中さんと焼肉定食 ご飯大盛り",
  "プロテイン1杯、バナナ1本",
  "夜 ビール2缶、枝豆、唐揚げ5個",
  "親子丼",
  "11/3 ギリシャヨーグルト200g、ハチミツ小さじ1",
];
const exercises = ["朝ジョギング5km 35分", "ジムで筋トレ45分とトレッドミル早歩き20分", "ヨガ1時間", "階段のぼり 10分", "犬の散歩 40分", "スクワット"];

for (const t of meals) {
  const s = Date.now();
  const r = await ai.parseMeal(env, t);
  console.log(`\n[食事] ${t}  (${r.source}, ${Date.now() - s}ms)`);
  for (const i of r.items) console.log(`  - ${i.name} | 数量:"${i.quantity}" | ${i.grams ?? "-"}g | ${i.kcal}kcal P${i.p} F${i.f} C${i.c}${i.assumed ? " (量は推定)" : ""}`);
}
for (const t of exercises) {
  const r = await ai.parseExercise(env, t);
  console.log(`\n[運動] ${t}  (${r.source})`);
  if (!r.list.length) console.log("  → 記録不可（時間が無いため）");
  for (const e of r.list) console.log(`  - ${e.name} ${e.minutes}分 ${e.met}METs 根拠:"${e.source}"`);
}

const facts = {
  今日の目標kcal: 1800, 今日の摂取kcal: 1320, 運動消費kcal: 0, 残りkcal: 480, たんぱく質目標g: 120, たんぱく質摂取g: 58,
  現在体重kg: 76.8, 直近7日平均kg: 77.1, 計画上の今日の体重kg: 76.2, 計画との差kg: 0.9, 目標体重kg: 70, 目標まで残りkg: 7.1,
  目標日まで残り日数: 84, 直近平均摂取kcal: 2050, 判定: "遅れ",
};
const cands = [
  "たんぱく質があと62g。次の食事で62g（鶏むね肉270g相当）を目安にしてください。",
  "直近の平均摂取は2050kcalで目標より250kcal多めです。1日250kcal減らすと計画に戻せます。",
];
for (let i = 0; i < 2; i++) {
  const lines = await ai.writeAdvice(env, facts, cands);
  console.log(`\n[アドバイス ${i + 1}] ${lines ? "AI" : "フォールバック"}`);
  for (const l of lines ?? cands) console.log("  - " + l);
}
