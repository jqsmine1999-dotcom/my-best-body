// 目標カロリー・PFCの算出と、AIが使えないときの簡易推定（食品表・METs表）

export type Sex = "male" | "female";
export type Activity = "low" | "mid" | "high";

export interface Profile {
  sex: Sex;
  birth_year: number;
  height_cm: number;
  start_weight: number;
  target_weight: number;
  target_date: string;
  start_date: string;
  activity: Activity;
  meal_times: { breakfast: string; lunch: string; dinner: string };
  notify: number;
}

export interface Targets {
  kcal: number;
  p: number;
  f: number;
  c: number;
  bmr: number;
  tdee: number;
  deficit: number;
  clamped: boolean;
  // 目標日に間に合わせるのに必要な摂取カロリー（下限で止める前の値）
  ideal: number;
}

export interface MealItem {
  name: string;
  quantity: string;
  grams: number | null;
  kcal: number;
  p: number;
  f: number;
  c: number;
  assumed: boolean;
  unknown?: boolean;
}

// 運動は別に記録するため、日常生活のみの係数
export const ACTIVITY_FACTOR: Record<Activity, number> = { low: 1.2, mid: 1.375, high: 1.55 };
const KCAL_PER_KG_FAT = 7200;

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

export function bmr(p: Profile, weight: number, year: number): number {
  const age = year - p.birth_year;
  // Mifflin-St Jeor
  return 10 * weight + 6.25 * p.height_cm - 5 * age + (p.sex === "male" ? 5 : -161);
}

export function calcTargets(p: Profile, weight: number, today: string): Targets {
  const year = Number(today.slice(0, 4));
  const b = bmr(p, weight, year);
  const tdee = b * ACTIVITY_FACTOR[p.activity];
  const daysLeft = Math.max(daysBetween(today, p.target_date), 1);
  const toLose = weight - p.target_weight;
  let deficit = (toLose * KCAL_PER_KG_FAT) / daysLeft;
  let clamped = false;
  if (deficit > 1000) { deficit = 1000; clamped = true; }
  if (deficit < -500) { deficit = -500; clamped = true; }
  const ideal = Math.round((tdee - (toLose * KCAL_PER_KG_FAT) / daysLeft) / 10) * 10;
  let kcal = tdee - deficit;
  const floor = Math.max(p.sex === "male" ? 1500 : 1200, b);
  if (kcal < floor) { kcal = floor; clamped = true; deficit = tdee - kcal; }
  kcal = Math.round(kcal / 10) * 10;
  const pG = Math.round(Math.min(Math.max(weight * 1.6, (kcal * 0.15) / 4), (kcal * 0.35) / 4));
  const fG = Math.round((kcal * 0.25) / 9);
  const cG = Math.max(Math.round((kcal - pG * 4 - fG * 9) / 4), 0);
  return { kcal, p: pG, f: fG, c: cG, bmr: Math.round(b), tdee: Math.round(tdee), deficit: Math.round(deficit), clamped, ideal };
}

// ---- 食品表（AIが落ちたとき用。1単位あたり、日本食品標準成分表ベースの概算） ----
interface Food { keys: string[]; unit: string; g: number; kcal: number; p: number; f: number; c: number }
const FOODS: Food[] = [
  { keys: ["納豆ごはん", "納豆ご飯"], unit: "杯", g: 195, kcal: 320, p: 11.2, f: 5, c: 61.1 },
  { keys: ["カレーライス", "カレー"], unit: "皿", g: 450, kcal: 750, p: 18, f: 22, c: 115 },
  { keys: ["牛丼"], unit: "杯", g: 380, kcal: 650, p: 20, f: 22, c: 90 },
  { keys: ["親子丼"], unit: "杯", g: 400, kcal: 630, p: 27, f: 14, c: 95 },
  { keys: ["ラーメン"], unit: "杯", g: 500, kcal: 500, p: 20, f: 15, c: 70 },
  { keys: ["うどん"], unit: "玉", g: 230, kcal: 219, p: 6, f: 0.9, c: 49.7 },
  { keys: ["そば", "蕎麦"], unit: "玉", g: 200, kcal: 260, p: 9.6, f: 1.9, c: 52 },
  { keys: ["パスタ", "スパゲッティ", "スパゲティ"], unit: "皿", g: 250, kcal: 375, p: 14.5, f: 2.3, c: 80 },
  { keys: ["おにぎり", "お握り"], unit: "個", g: 110, kcal: 180, p: 3, f: 0.4, c: 40 },
  { keys: ["玄米"], unit: "杯", g: 150, kcal: 228, p: 4.2, f: 1.5, c: 53.4 },
  { keys: ["ごはん", "ご飯", "白米", "ライス", "米"], unit: "杯", g: 150, kcal: 234, p: 3.8, f: 0.5, c: 55.7 },
  { keys: ["オートミール"], unit: "杯", g: 30, kcal: 105, p: 4.1, f: 1.7, c: 20.7 },
  { keys: ["食パン", "トースト"], unit: "枚", g: 60, kcal: 149, p: 5.3, f: 2.5, c: 26.6 },
  { keys: ["ロールパン"], unit: "個", g: 30, kcal: 93, p: 3, f: 2.7, c: 14.6 },
  { keys: ["パン"], unit: "個", g: 60, kcal: 170, p: 5, f: 4, c: 28 },
  { keys: ["サラダチキン"], unit: "個", g: 110, kcal: 120, p: 26, f: 1.5, c: 0.5 },
  { keys: ["鶏むね", "鶏胸", "むね肉", "胸肉"], unit: "g", g: 100, kcal: 105, p: 23.3, f: 1.9, c: 0.1 },
  { keys: ["ささみ"], unit: "本", g: 50, kcal: 49, p: 12, f: 0.4, c: 0 },
  { keys: ["鶏もも", "もも肉"], unit: "g", g: 100, kcal: 190, p: 16.6, f: 14.2, c: 0 },
  { keys: ["唐揚げ", "からあげ", "から揚げ"], unit: "個", g: 30, kcal: 80, p: 5, f: 5, c: 3 },
  { keys: ["焼き鳥", "焼鳥"], unit: "本", g: 40, kcal: 80, p: 7, f: 4.5, c: 2 },
  { keys: ["とんかつ", "トンカツ"], unit: "枚", g: 150, kcal: 450, p: 25, f: 30, c: 18 },
  { keys: ["ハンバーグ"], unit: "個", g: 150, kcal: 330, p: 20, f: 22, c: 12 },
  { keys: ["餃子", "ぎょうざ"], unit: "個", g: 25, kcal: 45, p: 2, f: 2.2, c: 4.5 },
  { keys: ["豚肉", "豚ロース", "豚こま", "生姜焼き"], unit: "g", g: 100, kcal: 248, p: 19.3, f: 19.2, c: 0.2 },
  { keys: ["牛肉", "ステーキ"], unit: "g", g: 100, kcal: 250, p: 17, f: 20, c: 0.3 },
  { keys: ["鮭", "サーモン", "しゃけ"], unit: "切れ", g: 80, kcal: 107, p: 17.8, f: 3.3, c: 0.1 },
  { keys: ["さば", "サバ", "鯖"], unit: "切れ", g: 80, kcal: 169, p: 16.5, f: 10.7, c: 0.2 },
  { keys: ["ツナ"], unit: "缶", g: 70, kcal: 50, p: 11, f: 0.5, c: 0.1 },
  { keys: ["刺身", "さしみ"], unit: "皿", g: 80, kcal: 100, p: 18, f: 2.5, c: 0.2 },
  { keys: ["ゆで卵", "目玉焼き", "卵", "たまご", "玉子"], unit: "個", g: 50, kcal: 71, p: 6.1, f: 5.1, c: 0.2 },
  { keys: ["納豆"], unit: "パック", g: 45, kcal: 86, p: 7.4, f: 4.5, c: 5.4 },
  { keys: ["豆腐"], unit: "丁", g: 300, kcal: 219, p: 21, f: 14.7, c: 4.8 },
  { keys: ["味噌汁", "みそ汁"], unit: "杯", g: 180, kcal: 40, p: 2.5, f: 1.2, c: 5 },
  { keys: ["サラダ"], unit: "皿", g: 80, kcal: 20, p: 1, f: 0.2, c: 4 },
  { keys: ["ブロッコリー"], unit: "g", g: 100, kcal: 37, p: 5.4, f: 0.6, c: 6.6 },
  { keys: ["バナナ"], unit: "本", g: 100, kcal: 93, p: 1.1, f: 0.2, c: 22.5 },
  { keys: ["りんご", "リンゴ"], unit: "個", g: 250, kcal: 133, p: 0.3, f: 0.5, c: 35 },
  { keys: ["ヨーグルト"], unit: "個", g: 100, kcal: 56, p: 3.6, f: 3, c: 4.9 },
  { keys: ["牛乳"], unit: "杯", g: 200, kcal: 122, p: 6.6, f: 7.6, c: 9.6 },
  { keys: ["豆乳"], unit: "杯", g: 200, kcal: 88, p: 7.2, f: 4, c: 6.2 },
  { keys: ["プロテイン"], unit: "杯", g: 30, kcal: 115, p: 22, f: 1.5, c: 3 },
  { keys: ["チーズ"], unit: "枚", g: 18, kcal: 56, p: 4, f: 4.5, c: 0.2 },
  { keys: ["アボカド"], unit: "個", g: 140, kcal: 250, p: 3, f: 24, c: 8.8 },
  { keys: ["枝豆"], unit: "g", g: 100, kcal: 118, p: 10.3, f: 5.8, c: 7.4 },
  { keys: ["カフェラテ", "ラテ"], unit: "杯", g: 250, kcal: 110, p: 6, f: 6, c: 9 },
  { keys: ["コーヒー", "珈琲", "お茶", "緑茶", "水"], unit: "杯", g: 200, kcal: 4, p: 0.2, f: 0, c: 0.7 },
  { keys: ["ビール"], unit: "缶", g: 350, kcal: 140, p: 1, f: 0, c: 11 },
  { keys: ["ハイボール"], unit: "杯", g: 350, kcal: 100, p: 0, f: 0, c: 0 },
  { keys: ["ポテトチップス", "ポテチ"], unit: "袋", g: 60, kcal: 336, p: 2.8, f: 21, c: 32 },
  { keys: ["チョコレート", "チョコ"], unit: "枚", g: 50, kcal: 279, p: 3.5, f: 17, c: 28 },
];

const NUM = "(\\d+(?:\\.\\d+)?)";
const KANJI_NUM: Record<string, string> = { "一": "1", "二": "2", "三": "3", "四": "4", "五": "5", "半": "0.5" };

export function splitSegments(text: string): string[] {
  return text
    .replace(/[０-９．]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .split(/[、,，・\n\/]|\s+|\+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function round1(n: number) { return Math.round(n * 10) / 10; }

// セグメント内の食品名を長い順・重ならないように拾う（「納豆と卵2個」→ 納豆 / 卵2個）
function findFoods(seg: string) {
  const hits: { at: number; key: string; food: Food }[] = [];
  const taken = new Array(seg.length).fill(false);
  const cands = FOODS.flatMap((food) => food.keys.map((key) => ({ key, food }))).sort((a, b) => b.key.length - a.key.length);
  for (const { key, food } of cands) {
    let from = 0;
    for (;;) {
      const at = seg.indexOf(key, from);
      if (at < 0) break;
      from = at + key.length;
      if (taken.slice(at, at + key.length).some(Boolean)) continue;
      for (let i = at; i < at + key.length; i++) taken[i] = true;
      hits.push({ at, key, food });
    }
  }
  return hits.sort((a, b) => a.at - b.at);
}

export function fallbackParseMeal(text: string): MealItem[] {
  const items: MealItem[] = [];
  for (const seg0 of splitSegments(text)) {
    const hits = findFoods(seg0);
    if (!hits.length) {
      items.push({ name: seg0, quantity: "", grams: null, kcal: 0, p: 0, f: 0, c: 0, assumed: true, unknown: true });
      continue;
    }
    hits.forEach((hit, i) => {
      const part = seg0.slice(i === 0 ? 0 : hit.at, hits[i + 1]?.at ?? seg0.length).replace(/^と|と$/g, "");
      items.push(portion(part, hit.key, hit.food));
    });
  }
  return items;
}

function portion(part: string, key: string, food: Food): MealItem {
  const seg = part.replace(/[一二三四五半](?=[個枚本杯切缶皿玉袋丁膳人つ分])/g, (k) => KANJI_NUM[k]);
  let mult = 1;
  let quantity = "";
  let assumed = true;
  const gm = seg.match(new RegExp(NUM + "\\s*(g|グラム|ml|ミリ)"));
  const cm = seg.match(new RegExp(NUM + "\\s*(個|枚|本|杯|パック|切れ|切|缶|皿|玉|袋|丁|膳|人前|つ)"));
  if (gm) {
    mult = Number(gm[1]) / food.g;
    quantity = gm[0];
    assumed = false;
  } else if (cm) {
    mult = Number(cm[1]);
    quantity = cm[0];
    assumed = false;
  }
  if (/大盛/.test(seg)) { mult *= 1.5; quantity = quantity || "大盛り"; assumed = false; }
  if (/小盛|少な/.test(seg)) { mult *= 0.7; quantity = quantity || "小盛り"; assumed = false; }
  return {
    name: part.replace(quantity, "").trim() || key,
    quantity,
    grams: Math.round(food.g * mult),
    kcal: Math.round(food.kcal * mult),
    p: round1(food.p * mult),
    f: round1(food.f * mult),
    c: round1(food.c * mult),
    assumed,
  };
}

export function sumItems(items: MealItem[]) {
  const t = items.reduce(
    (a, i) => ({ kcal: a.kcal + i.kcal, p: a.p + i.p, f: a.f + i.f, c: a.c + i.c }),
    { kcal: 0, p: 0, f: 0, c: 0 },
  );
  return { kcal: Math.round(t.kcal), p: round1(t.p), f: round1(t.f), c: round1(t.c) };
}

// ---- 運動（METs: 身体活動のメッツ表 2024 を参考） ----
interface Ex { keys: string[]; name: string; met: number }
const EXERCISES: Ex[] = [
  { keys: ["早歩き", "速歩"], name: "早歩き", met: 4.3 },
  { keys: ["ウォーキング", "散歩", "歩"], name: "ウォーキング", met: 3.5 },
  { keys: ["ジョギング", "ジョグ"], name: "ジョギング", met: 7.0 },
  { keys: ["ランニング", "ラン", "走"], name: "ランニング", met: 8.3 },
  { keys: ["エアロバイク", "バイク"], name: "エアロバイク", met: 6.8 },
  { keys: ["自転車", "サイクリング"], name: "自転車", met: 6.8 },
  { keys: ["筋トレ", "筋力トレーニング", "ウエイト", "ウェイト", "ベンチプレス", "デッドリフト"], name: "筋トレ", met: 5.0 },
  { keys: ["スクワット", "腕立て", "腹筋", "自重"], name: "自重トレーニング", met: 3.8 },
  { keys: ["水泳", "スイム", "泳"], name: "水泳", met: 6.0 },
  { keys: ["ヨガ"], name: "ヨガ", met: 2.5 },
  { keys: ["ピラティス"], name: "ピラティス", met: 3.0 },
  { keys: ["ストレッチ"], name: "ストレッチ", met: 2.3 },
  { keys: ["HIIT", "hiit", "サーキット"], name: "HIIT", met: 8.0 },
  { keys: ["縄跳び", "なわとび"], name: "縄跳び", met: 11.8 },
  { keys: ["階段"], name: "階段昇り", met: 8.8 },
  { keys: ["テニス"], name: "テニス", met: 7.3 },
  { keys: ["サッカー", "フットサル"], name: "サッカー", met: 7.0 },
  { keys: ["バスケ"], name: "バスケットボール", met: 6.5 },
  { keys: ["バドミントン"], name: "バドミントン", met: 5.5 },
  { keys: ["卓球"], name: "卓球", met: 4.0 },
  { keys: ["ゴルフ"], name: "ゴルフ", met: 4.8 },
  { keys: ["ダンス"], name: "ダンス", met: 5.0 },
  { keys: ["登山", "ハイキング"], name: "ハイキング", met: 6.0 },
  { keys: ["ボクシング", "キックボクシング"], name: "ボクシング", met: 7.8 },
  { keys: ["掃除", "家事"], name: "家事", met: 3.3 },
];

export function matchExercise(text: string): Ex | undefined {
  let best: Ex | undefined;
  let len = 0;
  for (const ex of EXERCISES) {
    const k = ex.keys.find((kk) => text.includes(kk));
    if (k && k.length > len) { best = ex; len = k.length; }
  }
  return best;
}

// 「30分」「1時間」「1時間半」「1.5h」「1万歩」から分を取り出す。見つからなければ null
export function parseMinutes(text: string): { minutes: number; assumed: boolean } | null {
  const t = text.replace(/[０-９．]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  let m = 0;
  let found = false;
  const h = t.match(new RegExp(NUM + "\\s*(時間|h|hr|hour)"));
  if (h) { m += Number(h[1]) * 60; found = true; if (/時間半/.test(t)) m += 30; }
  const mm = t.match(new RegExp(NUM + "\\s*(分|min|m(?![a-z]))"));
  if (mm) { m += Number(mm[1]); found = true; }
  if (found) return { minutes: m, assumed: false };
  const steps = t.match(/(\d+(?:\.\d+)?)\s*(万)?\s*歩/);
  if (steps) return { minutes: Math.round((Number(steps[1]) * (steps[2] ? 10000 : 1)) / 100), assumed: true };
  return null;
}

export function exerciseKcal(met: number, kg: number, minutes: number): number {
  return Math.round(1.05 * met * kg * (minutes / 60));
}

export function fallbackParseExercise(text: string) {
  const out: { source: string; name: string; minutes: number; met: number; assumed: boolean }[] = [];
  for (const seg of text.split(/[、,，\n]|\s{2,}|と(?=\D)/).map((s) => s.trim()).filter(Boolean)) {
    const ex = matchExercise(seg);
    const mins = parseMinutes(seg);
    if (ex && mins) out.push({ source: seg, name: ex.name, minutes: mins.minutes, met: ex.met, assumed: mins.assumed });
  }
  if (!out.length) {
    const ex = matchExercise(text);
    const mins = parseMinutes(text);
    if (ex && mins) out.push({ source: text, name: ex.name, minutes: mins.minutes, met: ex.met, assumed: mins.assumed });
  }
  return out;
}
