// Workers AI 呼び出し。失敗・不正な出力のときは null を返し、呼び出し側がフォールバックする
import { fallbackParseExercise, fallbackParseMeal, matchExercise, parseMinutes, splitSegments, type MealItem } from "./nutrition";

export const MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/mistralai/mistral-small-3.1-24b-instruct"] as const;

export interface AiEnv { AI: Ai; AI_DISABLED?: string }

function extractJson(text: string): any {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

function responseText(r: any): string {
  if (typeof r === "string") return r;
  if (typeof r?.response === "string") return r.response;
  if (r?.response && typeof r.response === "object") return JSON.stringify(r.response);
  const c = r?.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  return "";
}

async function runJson(env: AiEnv, system: string, user: string, maxTokens = 900): Promise<{ data: any; model: string } | null> {
  if (env.AI_DISABLED === "1" || !env.AI) return null;
  for (const model of MODELS) {
    try {
      const r = await Promise.race([
        env.AI.run(model as any, {
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          max_tokens: maxTokens,
          temperature: 0.1,
        } as any),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000)),
      ]);
      const data = extractJson(responseText(r));
      if (data) return { data, model };
    } catch (e) {
      console.warn("ai error", model, String(e));
    }
  }
  return null;
}

const norm = (s: string) =>
  s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

function num(v: unknown, max: number): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > max) return null;
  return n;
}

const MEAL_SYSTEM = `あなたは日本の管理栄養士です。ユーザーの食事メモを品目ごとに分け、日本食品標準成分表を基準に栄養価を推定します。
厳守するルール:
- メモに書かれている品目だけを出す。書かれていない飲み物・調味料・付け合わせ・ご飯などを足さない。
- 各品目の "source" には、その品目の根拠になったメモ中の文字列をそのまま書き写す。
- "quantity" にはメモに書かれた数量・単位をそのまま残す（例: "2個", "200g", "大盛り"）。書かれていなければ空文字。
- 数量が書かれていない場合は一般的な1人前で推定し "assumed": true にする。
- "grams" は推定重量(g)。kcal, p(たんぱく質g), f(脂質g), c(炭水化物g) はその量での値。
- 出力は次のJSONのみ。説明文は書かない。
{"items":[{"source":"","name":"","quantity":"","grams":0,"kcal":0,"p":0,"f":0,"c":0,"assumed":false}]}`;

export async function parseMeal(env: AiEnv, text: string): Promise<{ items: MealItem[]; source: string }> {
  const res = await runJson(env, MEAL_SYSTEM, `食事メモ: ${text}`);
  const input = norm(text);
  if (res && Array.isArray(res.data.items)) {
    const items: MealItem[] = [];
    const sources: string[] = [];
    for (const it of res.data.items) {
      const src = norm(String(it?.source ?? ""));
      // メモにない品目（推測での追加）は捨てる
      if (!src || !input.includes(src)) continue;
      const kcal = num(it.kcal, 3000), p = num(it.p, 300), f = num(it.f, 300), c = num(it.c, 500);
      if (kcal === null || p === null || f === null || c === null) continue;
      // 書かれた数量はメモの表記を優先して残す
      let quantity = String(it.quantity ?? "");
      if (quantity && !input.includes(norm(quantity))) quantity = "";
      let item: MealItem = {
        name: String(it.name || it.source).slice(0, 40),
        quantity,
        grams: num(it.grams, 3000),
        kcal: Math.round(kcal),
        p: Math.round(p * 10) / 10,
        f: Math.round(f * 10) / 10,
        c: Math.round(c * 10) / 10,
        assumed: Boolean(it.assumed) || !quantity,
      };
      // 食品表にある食品で AI の値が大きく外れていたら、食品表の値を使う
      const table = fallbackParseMeal(`${item.name}${item.quantity}`);
      if (table.length === 1 && !table[0].unknown && table[0].kcal > 0 && Math.abs(item.kcal - table[0].kcal) / table[0].kcal > 0.35) {
        item = { ...table[0], name: item.name, quantity: item.quantity || table[0].quantity };
      }
      items.push(item);
      sources.push(src);
    }
    // AI が取りこぼした部分（例: 「ビール2缶」）は食品表で補い、入力を黙って捨てない
    for (const seg of splitSegments(text)) {
      const n = norm(seg).replace(/^(朝|昼|夜|朝食|昼食|夕食|ランチ|ディナー)[:：は]?/, "");
      if (n.length < 2 || /^\d+\/\d+$/.test(n)) continue;
      const covered = sources.some((s) => s.includes(n) || n.includes(s));
      if (!covered) items.push(...fallbackParseMeal(seg).filter((i) => !i.unknown));
    }
    if (items.length) return { items, source: "ai" };
  }
  return { items: fallbackParseMeal(text), source: "fallback" };
}

const EX_SYSTEM = `あなたは運動生理学の専門家です。ユーザーの運動メモから運動ごとに情報を抜き出します。
厳守するルール:
- メモに書かれている運動だけを出す。書かれていない運動を足さない。
- "source" にはその運動の根拠になったメモ中の文字列をそのまま書き写す。
- "minutes" はメモに書かれた時間を分に換算した値。時間が書かれていなければ null（推測しない）。
- "met" は身体活動のメッツ表に基づく強度。
- 出力は次のJSONのみ。説明文は書かない。
{"activities":[{"source":"","name":"","minutes":0,"met":0}]}`;

export interface ParsedExercise { source: string; name: string; minutes: number; met: number; assumed: boolean }

export async function parseExercise(env: AiEnv, text: string): Promise<{ list: ParsedExercise[]; source: string }> {
  const res = await runJson(env, EX_SYSTEM, `運動メモ: ${text}`, 600);
  const input = norm(text);
  if (res && Array.isArray(res.data.activities)) {
    const list: ParsedExercise[] = [];
    for (const a of res.data.activities) {
      const source = String(a?.source ?? "");
      if (!source || !input.includes(norm(source))) continue;
      // 時間は必ずメモ本文から読み取る（AIの推測値は使わない）
      const mins = parseMinutes(source) ?? parseMinutes(text);
      if (!mins) continue;
      const table = matchExercise(source) ?? matchExercise(String(a.name ?? ""));
      const met = table?.met ?? num(a.met, 15);
      if (!met || met < 1.5) continue;
      list.push({ source, name: table?.name ?? String(a.name).slice(0, 30), minutes: mins.minutes, met, assumed: mins.assumed });
    }
    if (list.length) return { list, source: "ai" };
  }
  return { list: fallbackParseExercise(text), source: "fallback" };
}

const ADVICE_SYSTEM = `あなたはダイエットの伴走コーチです。与えられた「事実」と「候補」だけを根拠に、今日やるべきことを日本語で2〜3行にまとめます。
厳守するルール:
- 候補の内容を重要な順に並べ替え、自然な一文に言い換える。候補にない提案は1行まで、事実に基づくものだけ。
- 数値は事実・候補に書かれたものをそのまま使う。新しい数値を作らない。
- 各行は「〜してください」「〜です」で終わる完全な文で、25〜70字。数値を1つ以上含める。
- 挨拶・励ましの決まり文句・キャッチコピー・絵文字は書かない。
- 出力は次のJSONのみ。
例: {"lines":["直近の平均摂取が目標より250kcal多いため、夕食のご飯を半分にして1日250kcal減らしてください。","たんぱく質があと62g足りないので、夕食に鶏むね肉270g程度を加えてください。"]}`;

export async function writeAdvice(env: AiEnv, facts: Record<string, unknown>, candidates: string[]): Promise<string[] | null> {
  const user = `事実: ${JSON.stringify(facts)}\n候補:\n${candidates.map((c) => "- " + c).join("\n")}`;
  const res = await runJson(env, ADVICE_SYSTEM, user, 500);
  const lines: unknown = res?.data?.lines;
  if (!Array.isArray(lines)) return null;
  const allowed = new Set((JSON.stringify(facts) + candidates.join(" ")).match(/\d+(?:\.\d+)?/g) ?? []);
  const out: string[] = [];
  for (const l of lines.slice(0, 3)) {
    const s = String(l).trim().replace(/^[-・\s]+/, "");
    if (s.length < 20 || s.length > 90 || !/\d/.test(s)) return null;
    // 事実にない数値を含む行があれば AI 出力ごと使わない
    const nums = s.normalize("NFKC").replace(/,/g, "").match(/\d+(?:\.\d+)?/g) ?? [];
    if (nums.some((n) => !allowed.has(n))) return null;
    out.push(s);
  }
  return out.length ? out : null;
}
