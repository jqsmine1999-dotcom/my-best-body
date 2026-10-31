// 目標までの進み具合を判定し、根拠つきのアドバイス候補を作る
import { calcTargets, daysBetween, exerciseKcal, type Profile, type Targets } from "./nutrition";

export interface DayTotal { date: string; kcal: number; p: number; f: number; c: number; meals: number; ex: number }
export interface WeightRow { date: string; kg: number }

export type Status = "on_track" | "behind" | "ahead" | "no_data";

export interface Analysis {
  status: Status;
  current: number;
  avg7: number;
  planned: number;
  gap: number;
  weeklyRate: number | null;
  neededWeekly: number;
  daysLeft: number;
  toGo: number;
  loggedDays7: number;
  avgIntake7: number | null;
  lastWeightDaysAgo: number | null;
  targets: Targets;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function plannedWeight(p: Profile, date: string): number {
  const total = Math.max(daysBetween(p.start_date, p.target_date), 1);
  const t = Math.min(Math.max(daysBetween(p.start_date, date) / total, 0), 1);
  return r1(p.start_weight + (p.target_weight - p.start_weight) * t);
}

function slopePerWeek(rows: WeightRow[], today: string): number | null {
  const pts = rows.filter((r) => daysBetween(r.date, today) <= 21 && daysBetween(r.date, today) >= 0);
  if (pts.length < 3) return null;
  const xs = pts.map((r) => -daysBetween(r.date, today));
  const ys = pts.map((r) => r.kg);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  xs.forEach((x, i) => { num += (x - mx) * (ys[i] - my); den += (x - mx) ** 2; });
  if (den === 0) return null;
  return r1((num / den) * 7);
}

export function analyze(p: Profile, weights: WeightRow[], days: DayTotal[], today: string): Analysis {
  const sorted = [...weights].sort((a, b) => a.date.localeCompare(b.date)).filter((w) => w.date <= today);
  const latest = sorted.at(-1);
  const current = latest?.kg ?? p.start_weight;
  const recent = sorted.filter((w) => daysBetween(w.date, today) < 7);
  const avg7 = recent.length ? r1(recent.reduce((a, w) => a + w.kg, 0) / recent.length) : current;
  const planned = plannedWeight(p, today);
  const dir = Math.sign(p.target_weight - p.start_weight) || -1;
  const gap = r1(avg7 - planned);
  const daysLeft = Math.max(daysBetween(today, p.target_date), 0);
  const toGo = r1(p.target_weight - avg7);
  const weeklyRate = slopePerWeek(sorted, today);
  const neededWeekly = r1(daysLeft > 0 ? (toGo / daysLeft) * 7 : toGo);
  const past = days.filter((d) => d.date < today && daysBetween(d.date, today) <= 7 && d.meals > 0);
  const avgIntake7 = past.length ? Math.round(past.reduce((a, d) => a + d.kcal, 0) / past.length) : null;
  let status: Status = "on_track";
  if (!latest && !past.length) status = "no_data";
  else if (gap * -dir > 0.5) status = "behind";
  else if (gap * -dir < -0.5) status = "ahead";
  return {
    status, current, avg7, planned, gap, weeklyRate, neededWeekly, daysLeft, toGo,
    loggedDays7: past.length,
    avgIntake7,
    lastWeightDaysAgo: latest ? daysBetween(latest.date, today) : null,
    targets: calcTargets(p, current, today),
  };
}

// 時刻（分）から、その時点でどの食事まで済んでいるはずかを返す
function mealsDue(p: Profile, minutesNow: number): number {
  const toMin = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
  return [p.meal_times.breakfast, p.meal_times.lunch, p.meal_times.dinner].filter((t) => toMin(t) + 60 <= minutesNow).length;
}

// ウォーキング（3.5 METs）1分あたりの消費 kcal
const walkRate = (kg: number) => (1.05 * 3.5 * kg) / 60;

export function adviceCandidates(p: Profile, a: Analysis, today: DayTotal, minutesNow: number): { facts: Record<string, unknown>; lines: string[] } {
  const t = a.targets;
  const budget = t.kcal + today.ex;
  const remain = Math.round(budget - today.kcal);
  const pRemain = Math.round(t.p - today.p);
  const lines: string[] = [];
  const loss = p.target_weight < p.start_weight;

  if (a.lastWeightDaysAgo === null || a.lastWeightDaysAgo >= 3) {
    lines.push(a.lastWeightDaysAgo === null
      ? "体重がまだ記録されていません。毎朝トイレ後に同じ条件で測って記録してください。"
      : `体重の記録が${a.lastWeightDaysAgo}日空いています。今日の体重を記録してください。`);
  }

  if (remain < 0) {
    const over = -remain;
    const walk = Math.round(over / walkRate(a.current));
    lines.push(`今日は目標を${over}kcal超えています。ウォーキング${walk}分で約${over}kcal消費できます。`);
  } else {
    const due = mealsDue(p, minutesNow);
    const left = Math.max(3 - due, 1);
    if (due >= 1 && today.meals === 0) {
      lines.push("今日の食事がまだ記録されていません。食べたものをまとめて記録してください。");
    } else if (today.meals > 0 && pRemain > 15) {
      const perMeal = Math.round(pRemain / left);
      const chicken = Math.round(((perMeal / 23.3) * 100) / 10) * 10;
      lines.push(`たんぱく質があと${pRemain}g。次の食事で${perMeal}g（鶏むね肉${chicken}g相当）を目安にしてください。`);
    }
  }

  if (a.status === "behind") {
    if (a.avgIntake7 !== null && a.avgIntake7 > t.kcal + 100) {
      const diff = a.avgIntake7 - t.kcal;
      lines.push(`直近の平均摂取は${a.avgIntake7}kcalで目標より${diff}kcal多めです。1日${diff}kcal減らすと計画に戻せます。`);
    } else {
      const extra = exerciseKcal(3.5, a.current, 30);
      lines.push(`計画より${Math.abs(a.gap)}kg遅れています。飲み物・間食・調味料の記録漏れを確認し、30分の散歩（約${extra}kcal）を足してください。`);
    }
  } else if (a.status === "ahead" && loss && a.weeklyRate !== null && a.weeklyRate < -(a.current * 0.01)) {
    lines.push(`減量ペースが週${Math.abs(a.weeklyRate)}kgと速めです。筋肉を落とさないよう、たんぱく質${t.p}gを確保してください。`);
  } else if (a.status === "on_track" || a.status === "ahead") {
    lines.push(`計画どおりのペースです。今日の残りは${remain}kcal、たんぱく質${Math.max(pRemain, 0)}gです。`);
  }

  // 下限（基礎代謝）で止めた分が大きいときは、運動で埋める量を具体的に示す
  const shortfall = t.kcal - t.ideal;
  if (t.clamped && shortfall > 150) {
    const walk = Math.round(shortfall / walkRate(a.current) / 5) * 5;
    lines.push(`目標日に間に合わせるには1日${t.ideal}kcalが必要ですが、基礎代謝を下回らない${t.kcal}kcalにしています。毎日${walk}分のウォーキングで差の${shortfall}kcalを埋められます。`);
  }
  if (a.loggedDays7 > 0 && a.loggedDays7 < 4) {
    lines.push(`直近7日で食事を記録したのは${a.loggedDays7}日です。毎食の記録が判断の精度を上げます。`);
  }

  const facts = {
    今日の目標kcal: t.kcal, 計画に必要なkcal: t.ideal, 今日の摂取kcal: Math.round(today.kcal), 運動消費kcal: Math.round(today.ex), 残りkcal: remain,
    たんぱく質目標g: t.p, たんぱく質摂取g: Math.round(today.p), 脂質摂取g: Math.round(today.f), 炭水化物摂取g: Math.round(today.c),
    現在体重kg: a.current, 直近7日平均kg: a.avg7, 計画上の今日の体重kg: a.planned, 計画との差kg: a.gap,
    目標体重kg: p.target_weight, 目標まで残りkg: Math.abs(a.toGo), 目標日まで残り日数: a.daysLeft,
    週あたり変化kg: a.weeklyRate, 必要な週あたり変化kg: a.neededWeekly, 直近平均摂取kcal: a.avgIntake7,
    判定: { on_track: "順調", behind: "遅れ", ahead: "先行", no_data: "データ不足" }[a.status],
  };
  return { facts, lines: lines.slice(0, 3) };
}
