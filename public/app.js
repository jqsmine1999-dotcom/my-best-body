// MyBestBody フロントエンド（ビルド不要の ES Module）
const $app = document.getElementById("app");
const SLOTS = [["breakfast", "朝食"], ["lunch", "昼食"], ["dinner", "夕食"], ["snack", "間食"]];
const SLOT_LABEL = Object.fromEntries(SLOTS);
const STATUS_LABEL = { on_track: "順調", behind: "遅れ気味", ahead: "先行", no_data: "データ不足" };
const ISSUES_URL = "https://github.com/jqsmine1999-dotcom/my-best-body/issues";

const state = { me: null, tab: "home", date: today(), slot: null, day: null, recent: null };

// ---------- ユーティリティ ----------
function today() { return fmtDate(new Date()); }
function fmtDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function shift(date, n) { const d = new Date(date + "T12:00:00"); d.setDate(d.getDate() + n); return fmtDate(d); }
function label(date) {
  const d = new Date(date + "T12:00:00");
  const w = "日月火水木金土"[d.getDay()];
  const rel = date === today() ? "今日 " : date === shift(today(), -1) ? "昨日 " : "";
  return `${rel}${d.getMonth() + 1}/${d.getDate()}(${w})`;
}
function nowMinutes() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const r1 = (n) => Math.round(n * 10) / 10;
const fmt = (n) => Math.round(n).toLocaleString("ja-JP");

function defaultSlot() {
  const mt = state.me?.profile?.meal_times;
  if (!mt) return "breakfast";
  const toMin = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };
  const now = nowMinutes();
  // 次の食事時刻との中間を境目にする
  const b = toMin(mt.breakfast), l = toMin(mt.lunch), d = toMin(mt.dinner);
  if (now < (b + l) / 2) return "breakfast";
  if (now < (l + d) / 2) return "lunch";
  if (now < d + 180) return "dinner";
  return "snack";
}

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers: opts.body ? { "content-type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !opts.allow401) { renderLogin(); throw new ApiError(401, "ログインが必要です"); }
  if (!res.ok) throw new ApiError(res.status, data.error || "通信に失敗しました");
  return data;
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function busy(btn, on, text) {
  if (on) {
    btn.dataset.label = btn.innerHTML;
    btn.classList.add("busy");
    btn.innerHTML = `<span class="spinner"></span>${text ?? ""}`;
  } else if (btn.dataset.label) {
    btn.classList.remove("busy");
    btn.innerHTML = btn.dataset.label;
  }
}

function countUp(el, to, dur = 900) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = fmt(to); return; }
  const from = Number(el.dataset.v ?? 0);
  el.dataset.v = to;
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min((t - t0) / dur, 1);
    const e = 1 - Math.pow(1 - k, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function sheet(html, onMount) {
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  const el = document.createElement("div");
  el.className = "sheet glass";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.innerHTML = html;
  document.body.append(scrim, el);
  const close = () => {
    scrim.classList.add("out");
    el.classList.add("out");
    setTimeout(() => { scrim.remove(); el.remove(); }, 280);
  };
  scrim.addEventListener("click", close);
  el.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", close));
  onMount?.(el, close);
  return close;
}

function seg(name, options, value) {
  return `<div class="seg" data-seg="${name}" role="group">
    <span class="knob"></span>
    ${options.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${v === value}">${l}</button>`).join("")}
  </div>`;
}

function wireSeg(root, name, onChange) {
  const el = root.querySelector(`[data-seg="${name}"]`);
  const btns = [...el.querySelectorAll("button")];
  const knob = el.querySelector(".knob");
  const place = () => {
    const i = Math.max(btns.findIndex((b) => b.getAttribute("aria-pressed") === "true"), 0);
    knob.style.width = `calc((100% - 8px) / ${btns.length})`;
    knob.style.transform = `translateX(${i * 100}%)`;
  };
  btns.forEach((b) => b.addEventListener("click", () => {
    btns.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    place();
    onChange?.(b.dataset.v);
  }));
  place();
  return () => btns.find((b) => b.getAttribute("aria-pressed") === "true")?.dataset.v;
}

// ---------- 起動 ----------
async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get("tab")) state.tab = params.get("tab");
  if (params.get("slot")) state.slot = params.get("slot");
  if (params.size) history.replaceState(null, "", "/");
  try {
    state.me = await api("/api/me", { allow401: true });
  } catch (e) {
    if (e.status === 401) return renderLogin();
    return renderError(e);
  }
  if (!state.me.profile) return renderOnboarding();
  renderTabbar();
  go(state.tab);
}

function renderError(e) {
  $app.innerHTML = `<div class="screen"><section class="glass card"><h2>読み込みに失敗しました</h2><p class="small">${esc(e.message)}</p>
    <button class="btn primary block" id="retry">再読み込み</button></section></div>`;
  $app.querySelector("#retry").onclick = () => location.reload();
}

function done() { $app.removeAttribute("aria-busy"); }

// ---------- ログイン ----------
function renderLogin() {
  document.querySelector(".tabbar")?.remove();
  document.body.classList.remove("has-composer");
  document.querySelector(".composer")?.remove();
  $app.innerHTML = `<div class="login screen">
    <img src="/icons/icon-192.png" alt="" width="96" height="96">
    <h1>MyBestBody</h1>
    <a class="btn primary block gbtn" href="/auth/google" data-testid="google-login">
      <svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
      Googleでログイン
    </a>
    <nav class="links"><a href="/about">このアプリについて</a><a href="/privacy">プライバシーポリシー</a><a href="/terms">利用規約</a></nav>
  </div>`;
  done();
}

// ---------- プロフィール ----------
function profileForm(p) {
  const v = p ?? { sex: "male", birth_year: 1990, height_cm: "", start_weight: "", target_weight: "", target_date: shift(today(), 90), activity: "low", meal_times: { breakfast: "07:30", lunch: "12:00", dinner: "19:00" }, notify: 1 };
  const current = state.progress?.analysis?.current ?? v.start_weight;
  return `<form id="profile" class="glass card" novalidate>
    <div class="field"><span>性別（基礎代謝の計算に使います）</span>${seg("sex", [["male", "男性"], ["female", "女性"]], v.sex)}</div>
    <div class="grid2" style="margin-top:12px">
      <label class="field"><span>生まれ年</span><input class="input" name="birth_year" type="number" inputmode="numeric" value="${esc(v.birth_year)}" required></label>
      <label class="field"><span>身長 (cm)</span><input class="input" name="height_cm" type="number" inputmode="decimal" step="0.1" value="${esc(v.height_cm)}" required></label>
      <label class="field"><span>現在の体重 (kg)</span><input class="input" name="current_weight" type="number" inputmode="decimal" step="0.1" value="${esc(current)}" required></label>
      <label class="field"><span>目標体重 (kg)</span><input class="input" name="target_weight" type="number" inputmode="decimal" step="0.1" value="${esc(v.target_weight)}" required></label>
    </div>
    <label class="field" style="margin-top:12px"><span>目標日</span><input class="input" name="target_date" type="date" value="${esc(v.target_date)}" required></label>
    <div class="field" style="margin-top:12px"><span>日常の活動量（運動は別に記録するので含めない）</span>
      ${seg("activity", [["low", "座り中心"], ["mid", "よく歩く"], ["high", "立ち仕事"]], v.activity)}</div>
    <div class="field" style="margin-top:12px"><span>食事の通知時刻</span>
      <div class="grid3">
        <label class="field"><span>朝食</span><input class="input" name="breakfast" type="time" value="${esc(v.meal_times.breakfast)}"></label>
        <label class="field"><span>昼食</span><input class="input" name="lunch" type="time" value="${esc(v.meal_times.lunch)}"></label>
        <label class="field"><span>夕食</span><input class="input" name="dinner" type="time" value="${esc(v.meal_times.dinner)}"></label>
      </div>
    </div>
    <button class="btn primary block" style="margin-top:16px" type="submit" data-testid="save-profile">${p ? "保存" : "はじめる"}</button>
  </form>`;
}

function wireProfile(root, existing, after) {
  const form = root.querySelector("#profile");
  const getSex = wireSeg(form, "sex");
  const getAct = wireSeg(form, "activity");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const n = (k) => (f.get(k) === "" ? NaN : Number(f.get(k)));
    const body = {
      sex: getSex(), activity: getAct(),
      birth_year: n("birth_year"), height_cm: n("height_cm"), current_weight: n("current_weight"), target_weight: n("target_weight"),
      target_date: f.get("target_date"), today: today(),
      meal_times: { breakfast: f.get("breakfast"), lunch: f.get("lunch"), dinner: f.get("dinner") },
      notify: existing ? existing.notify !== 0 : true,
    };
    const btn = form.querySelector("[type=submit]");
    busy(btn, true);
    try {
      const r = await api("/api/profile", { method: "PUT", body });
      state.me.profile = r.profile;
      toast("保存しました");
      after();
    } catch (err) {
      toast(err.message);
    } finally { busy(btn, false); }
  });
}

function renderOnboarding() {
  document.querySelector(".tabbar")?.remove();
  $app.innerHTML = `<div class="screen">
    <header class="top"><h1>目標を設定</h1></header>
    ${profileForm(null)}
  </div>`;
  wireProfile($app, null, () => { renderTabbar(); go("home"); });
  done();
}

// ---------- タブ ----------
const TABS = [
  ["home", "ホーム", '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/>'],
  ["meal", "食事", '<path d="M7 3v8a2 2 0 0 0 2 2v8"/><path d="M11 3v8a2 2 0 0 1-2 2"/><path d="M17 21V3c-2 1.5-3 4-3 7s1 4 3 4"/>'],
  ["exercise", "運動", '<circle cx="14" cy="4.5" r="1.8"/><path d="m6 21 4-7 3 3v5"/><path d="M8 9.5 11 7l3 2.5 2.5 3H20"/><path d="m11 7-1.5 6"/>'],
  ["settings", "設定", '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>'],
];

function renderTabbar() {
  document.querySelector(".tabbar")?.remove();
  const nav = document.createElement("nav");
  nav.className = "tabbar glass";
  nav.setAttribute("aria-label", "メニュー");
  nav.innerHTML = `<span class="pill"></span>` + TABS.map(([id, l, icon]) =>
    `<button type="button" data-tab="${id}"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>${l}</button>`).join("");
  nav.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => go(b.dataset.tab)));
  document.body.append(nav);
}

function go(tab) {
  if (!TABS.some(([id]) => id === tab)) tab = "home";
  state.tab = tab;
  const nav = document.querySelector(".tabbar");
  const i = TABS.findIndex(([id]) => id === tab);
  nav.querySelector(".pill").style.transform = `translateX(${i * 100}%)`;
  nav.querySelectorAll("button").forEach((b) => (b.dataset.tab === tab ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  document.querySelector(".composer")?.remove();
  document.body.classList.remove("has-composer");
  window.scrollTo({ top: 0 });
  ({ home: renderHome, meal: renderMeal, exercise: renderExercise, settings: renderSettings })[tab]();
}

// ---------- ホーム ----------
function homeSkeleton() {
  return `<div class="screen">
    <header class="top"><h1>${label(today())}</h1></header>
    <section class="glass card"><div class="ring-wrap"><div class="sk circle"></div><div><div class="sk line w80"></div><div class="sk line w60"></div><div class="sk line w80"></div></div></div><div class="sk line"></div><div class="sk line"></div></section>
    <section class="glass card"><div class="sk line w40"></div><div class="sk line"></div><div class="sk line w80"></div></section>
    <section class="glass card"><div class="sk line w40"></div><div class="sk block"></div></section>
  </div>`;
}

function ringSvg(ratio, over) {
  const r = 60, c = 2 * Math.PI * r;
  return `<svg viewBox="0 0 148 148" aria-hidden="true">
    <circle class="track" cx="74" cy="74" r="${r}"/>
    <circle class="bar${over ? " over" : ""}" cx="74" cy="74" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c}" data-target="${c * (1 - Math.min(ratio, 1))}"/>
  </svg>`;
}

function meterRow(cls, name, val, target) {
  const pct = target ? Math.min((val / target) * 100, 100) : 0;
  const over = val > target * 1.1;
  return `<div><div class="name"><span>${name}</span><span><b>${r1(val)}</b> / ${target} g</span></div>
    <div class="meter ${cls}"><i data-w="${pct}" class="${over ? "over" : ""}"></i></div></div>`;
}

async function renderHome() {
  $app.innerHTML = homeSkeleton();
  const date = today();
  let day, prog;
  try {
    [day, prog] = await Promise.all([api(`/api/day?date=${date}`), api(`/api/progress?date=${date}`)]);
  } catch (e) { if (e.status !== 401) renderError(e); return; }
  if (state.tab !== "home") return;
  state.progress = prog;
  const t = day.targets;
  const budget = t.kcal + day.exercise;
  const remain = budget - day.intake.kcal;
  const a = prog.analysis;
  $app.innerHTML = `<div class="screen">
    <header class="top"><h1>${label(date)}</h1><span class="sub">目標 ${t.kcal} kcal</span></header>
    <section class="glass card" style="--i:1" data-testid="summary">
      <div class="ring-wrap">
        <div class="ring">${ringSvg(budget ? day.intake.kcal / budget : 0, remain < 0)}
          <div class="center"><span class="lbl">${remain >= 0 ? "残り" : "超過"}</span><span class="big" data-count="${Math.abs(remain)}">0</span><span class="lbl">kcal</span></div>
        </div>
        <div class="kv">
          <div><span>摂取</span><b>${fmt(day.intake.kcal)}</b></div>
          <div><span>運動</span><b>+${fmt(day.exercise)}</b></div>
          <div><span>目標</span><b>${fmt(t.kcal)}</b></div>
        </div>
      </div>
      <div class="pfc">
        ${meterRow("p", "たんぱく質", day.intake.p, t.p)}
        ${meterRow("f", "脂質", day.intake.f, t.f)}
        ${meterRow("c", "炭水化物", day.intake.c, t.c)}
      </div>
    </section>
    <section class="glass card" style="--i:2" data-testid="coach">
      <h2>コーチ <span class="chip ${a.status}" id="status">${STATUS_LABEL[a.status]}</span></h2>
      <div id="advice"><div class="sk line"></div><div class="sk line w80"></div><div class="sk line w60"></div></div>
    </section>
    <section class="glass card" style="--i:3" data-testid="weight">
      <h2>体重</h2>
      <div class="weight-in">
        <button class="btn sq" type="button" data-d="-0.1" aria-label="0.1kg減らす">−</button>
        <input class="input" id="kg" type="number" inputmode="decimal" step="0.1" value="${esc(day.weight ?? a.current)}" aria-label="今日の体重">
        <button class="btn sq" type="button" data-d="0.1" aria-label="0.1kg増やす">＋</button>
      </div>
      <button class="btn primary block" id="saveKg" style="margin-top:10px">${day.weight == null ? "今日の体重を記録" : "更新"}</button>
      ${chartSvg(prog)}
      <div class="stats">
        <div class="stat"><b>${Math.abs(a.toGo)}<small>kg</small></b><span>目標まで</span></div>
        <div class="stat"><b>${a.daysLeft}<small>日</small></b><span>残り</span></div>
        <div class="stat"><b>${a.weeklyRate == null ? "—" : (a.weeklyRate > 0 ? "+" : "") + a.weeklyRate}</b><span>kg/週</span></div>
      </div>
    </section>
    <section class="grid2" style="--i:4">
      <button class="btn block glass" data-go="meal">食事を記録</button>
      <button class="btn block glass" data-go="exercise">運動を記録</button>
    </section>
  </div>`;
  done();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $app.querySelectorAll(".ring .bar").forEach((b) => b.style.strokeDashoffset = b.dataset.target);
    $app.querySelectorAll(".meter i").forEach((m) => m.style.width = m.dataset.w + "%");
    $app.querySelectorAll("[data-count]").forEach((el) => countUp(el, Number(el.dataset.count)));
  }));
  $app.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));
  const kg = $app.querySelector("#kg");
  $app.querySelectorAll("[data-d]").forEach((b) => b.addEventListener("click", () => {
    kg.value = r1((Number(kg.value) || a.current) + Number(b.dataset.d)).toFixed(1);
  }));
  $app.querySelector("#saveKg").addEventListener("click", async (e) => {
    const v = Number(kg.value);
    busy(e.currentTarget, true);
    try {
      await api("/api/weights", { method: "PUT", body: { date, kg: v } });
      toast("体重を記録しました");
      renderHome();
    } catch (err) { toast(err.message); busy(e.currentTarget, false); }
  });
  loadAdvice(date);
}

async function loadAdvice(date) {
  try {
    const r = await api(`/api/advice?date=${date}&minutes=${nowMinutes()}`);
    const box = document.getElementById("advice");
    if (!box) return;
    box.innerHTML = r.lines.length
      ? `<ul class="advice">${r.lines.map((l, i) => `<li style="--i:${i}">${esc(l)}</li>`).join("")}</ul>`
      : `<p class="muted">記録が増えるとアドバイスが表示されます。</p>`;
    const chip = document.getElementById("status");
    chip.className = `chip ${r.status}`;
    chip.textContent = STATUS_LABEL[r.status];
  } catch (e) {
    const box = document.getElementById("advice");
    if (box) box.innerHTML = `<p class="muted">アドバイスを取得できませんでした。</p>`;
  }
}

function chartSvg(prog) {
  const W = 320, H = 120, P = 8;
  const { plan, weights } = prog;
  const t0 = Date.parse(plan.start_date), t1 = Date.parse(plan.target_date);
  const pts = weights.filter((w) => w.date >= plan.start_date);
  const ys = [plan.start_weight, plan.target_weight, ...pts.map((w) => w.kg)];
  const lo = Math.min(...ys) - 0.5, hi = Math.max(...ys) + 0.5;
  const x = (d) => P + ((Date.parse(d) - t0) / Math.max(t1 - t0, 1)) * (W - 2 * P);
  const y = (v) => P + ((hi - v) / (hi - lo)) * (H - 2 * P - 12);
  const act = pts.map((w) => `${x(w.date).toFixed(1)},${y(w.kg).toFixed(1)}`).join(" ");
  const last = pts.at(-1);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="体重の推移と計画">
    <line class="plan" x1="${x(plan.start_date)}" y1="${y(plan.start_weight)}" x2="${x(plan.target_date)}" y2="${y(plan.target_weight)}"/>
    ${pts.length > 1 ? `<polyline class="act" points="${act}"/>` : ""}
    ${last ? `<circle class="dot" cx="${x(last.date)}" cy="${y(last.kg)}" r="4"/>` : ""}
    <text x="${P}" y="${H - 2}">${plan.start_date.slice(5).replace("-", "/")}</text>
    <text x="${W - P}" y="${H - 2}" text-anchor="end">目標 ${plan.target_weight}kg</text>
  </svg>`;
}

// ---------- 日付バー ----------
function dateBar() {
  return `<div class="datebar glass" style="padding:4px;border-radius:22px">
    <button type="button" data-shift="-1" aria-label="前の日">‹</button>
    <b>${label(state.date)}</b>
    <button type="button" data-shift="1" aria-label="次の日" ${state.date >= today() ? "disabled" : ""}>›</button>
  </div>`;
}
function wireDateBar(rerender) {
  $app.querySelectorAll("[data-shift]").forEach((b) => b.addEventListener("click", () => {
    const next = shift(state.date, Number(b.dataset.shift));
    if (next > today()) return;
    state.date = next;
    rerender();
  }));
}

function listSkeleton(n = 2) {
  return Array.from({ length: n }, () => `<div class="glass entry"><div class="sk line w60"></div><div class="sk line"></div><div class="sk line w40"></div></div>`).join("");
}

// ---------- 食事 ----------
function mealCard(m) {
  return `<article class="glass entry" data-id="${m.id}" data-testid="meal">
    <div class="head"><div class="title">${esc(m.text)}</div><div class="kcal">${fmt(m.kcal)} kcal</div></div>
    <ul class="items">${m.items.map((i) => `<li><span>${esc(i.name)}${i.quantity ? ` <small>${esc(i.quantity)}</small>` : ""}${i.unknown ? '<span class="tag warn">不明</span>' : i.assumed ? '<span class="tag">量は推定</span>' : ""}</span><span>${fmt(i.kcal)}</span></li>`).join("")}</ul>
    <div class="foot">
      <span class="pfcline"><b class="p">P</b> ${r1(m.p)} <b class="f">F</b> ${r1(m.f)} <b class="c">C</b> ${r1(m.c)}${m.source === "fallback" ? ' <span class="tag">簡易計算</span>' : ""}</span>
      <span><button class="linkbtn" data-edit="${m.id}">編集</button><button class="linkbtn" data-del="${m.id}">削除</button></span>
    </div>
  </article>`;
}

async function renderMeal() {
  if (!state.slot) state.slot = defaultSlot();
  $app.innerHTML = `<div class="screen">
    <header class="top"><h1>食事</h1></header>
    ${dateBar()}
    <section class="glass card" id="dayTotal"><div class="sk line"></div></section>
    <div class="list" id="meals">${listSkeleton()}</div>
  </div>`;
  wireDateBar(renderMeal);
  mountMealComposer();
  done();
  const date = state.date;
  try {
    const [day, recent] = await Promise.all([api(`/api/day?date=${date}`), api("/api/meals/recent")]);
    if (state.tab !== "meal" || state.date !== date) return;
    state.day = day;
    state.recent = recent.meals;
    paintMeals();
  } catch (e) { if (e.status !== 401) toast(e.message); }
}

function paintMeals() {
  const day = state.day;
  const t = day.targets;
  const budget = t.kcal + day.exercise;
  const mini = (cls, n, v, tg) => `<div><div class="name"><span>${n}</span><span>${Math.round(v)}/${tg}</span></div><div class="meter ${cls}"><i data-w="${Math.min((v / tg) * 100, 100)}" class="${v > tg * 1.1 ? "over" : ""}"></i></div></div>`;
  const box = document.getElementById("dayTotal");
  box.innerHTML = `<div class="totals"><div class="kc"><span class="muted">摂取</span><span><b data-testid="meal-total">${fmt(day.intake.kcal)}</b> <span class="muted">/ ${fmt(budget)} kcal</span></span></div>
    <div class="mini">${mini("p", "P", day.intake.p, t.p)}${mini("f", "F", day.intake.f, t.f)}${mini("c", "C", day.intake.c, t.c)}</div></div>`;
  requestAnimationFrame(() => requestAnimationFrame(() => box.querySelectorAll(".meter i").forEach((m) => (m.style.width = m.dataset.w + "%"))));
  const list = document.getElementById("meals");
  if (!day.meals.length) { list.innerHTML = `<div class="empty">まだ記録がありません</div>`; }
  else {
    list.innerHTML = SLOTS.map(([s, l]) => {
      const ms = day.meals.filter((m) => m.slot === s);
      return ms.length ? `<div class="slot-h">${l}</div>${ms.map(mealCard).join("")}` : "";
    }).join("");
  }
  list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => removeEntry(b, `/api/meals/${b.dataset.del}`, renderMealData)));
  list.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => editMeal(day.meals.find((m) => m.id === b.dataset.edit))));
  const chips = document.getElementById("recent");
  if (chips) {
    chips.innerHTML = (state.recent ?? []).map((m) => `<button type="button" data-copy="${m.id}">${esc(m.text)}</button>`).join("");
    chips.hidden = !state.recent?.length;
    chips.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true;
      try {
        await api(`/api/meals/${b.dataset.copy}/copy`, { method: "POST", body: { date: state.date, slot: state.slot } });
        toast(`${SLOT_LABEL[state.slot]}に記録しました`);
        await renderMealData();
      } catch (e) { toast(e.message); }
      b.disabled = false;
    }));
  }
}

async function renderMealData() {
  const day = await api(`/api/day?date=${state.date}`);
  state.day = day;
  if (state.tab === "meal") paintMeals();
}

function mountMealComposer() {
  document.querySelector(".composer")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "composer";
  wrap.innerHTML = `<form class="glass" id="mealForm">
    ${seg("slot", SLOTS, state.slot)}
    <div class="chips" id="recent" hidden></div>
    <div class="row">
      <textarea class="input" name="text" rows="1" maxlength="300" placeholder="例: 納豆ごはん、卵1個" aria-label="食べたもの" required></textarea>
      <button class="btn primary" type="submit" data-testid="add-meal">記録</button>
    </div>
  </form>`;
  document.body.append(wrap);
  document.body.classList.add("has-composer");
  wireSeg(wrap, "slot", (v) => { state.slot = v; });
  const form = wrap.querySelector("form");
  const ta = form.querySelector("textarea");
  autoGrow(ta);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) return ta.focus();
    const btn = form.querySelector("[type=submit]");
    busy(btn, true);
    const list = document.getElementById("meals");
    list.querySelector(".empty")?.remove();
    list.insertAdjacentHTML("afterbegin", `<div id="pending">${listSkeleton(1)}</div>`);
    try {
      await api("/api/meals", { method: "POST", body: { date: state.date, slot: state.slot, text } });
      ta.value = "";
      ta.style.height = "";
      toast(`${SLOT_LABEL[state.slot]}を記録しました`);
      const recent = await api("/api/meals/recent");
      state.recent = recent.meals;
      await renderMealData();
    } catch (err) {
      toast(err.message);
      document.getElementById("pending")?.remove();
    } finally { busy(btn, false); }
  });
  submitOnEnter(ta, form);
}

function autoGrow(ta) {
  ta.addEventListener("input", () => { ta.style.height = ""; ta.style.height = Math.min(ta.scrollHeight, 120) + "px"; });
}
function submitOnEnter(ta, form) {
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
}

async function removeEntry(btn, url, reload) {
  const card = btn.closest(".entry");
  const ok = await confirmSheet("この記録を削除しますか？", "削除");
  if (!ok) return;
  try {
    await api(url, { method: "DELETE" });
    card.classList.add("leaving");
    setTimeout(reload, 300);
  } catch (e) { toast(e.message); }
}

function confirmSheet(msg, okLabel) {
  return new Promise((resolve) => {
    let result = false;
    const close = sheet(`<h3>${esc(msg)}</h3><div class="actions">
      <button class="btn danger block" data-ok>${esc(okLabel)}</button>
      <button class="btn block" data-close>キャンセル</button></div>`, (el, close) => {
      el.querySelector("[data-ok]").addEventListener("click", () => { result = true; close(); });
    });
    const obs = new MutationObserver(() => { if (!document.querySelector(".sheet")) { obs.disconnect(); resolve(result); } });
    obs.observe(document.body, { childList: true });
    void close;
  });
}

function editMeal(m) {
  sheet(`<h3>${esc(m.text)}</h3>
    <form id="editForm">
      ${seg("eslot", SLOTS, m.slot)}
      <div id="eitems">${m.items.map((i, n) => `<div class="edit-item" data-n="${n}">
        <input class="input" name="name" value="${esc(i.name)}" aria-label="品名">
        <div class="grid4">
          <label>kcal<input class="input" name="kcal" type="number" inputmode="decimal" value="${i.kcal}"></label>
          <label>P<input class="input" name="p" type="number" inputmode="decimal" step="0.1" value="${i.p}"></label>
          <label>F<input class="input" name="f" type="number" inputmode="decimal" step="0.1" value="${i.f}"></label>
          <label>C<input class="input" name="c" type="number" inputmode="decimal" step="0.1" value="${i.c}"></label>
        </div></div>`).join("")}</div>
      <div class="actions"><button class="btn primary block" type="submit">保存</button><button class="btn block" type="button" data-close>閉じる</button></div>
    </form>`, (el, close) => {
    const getSlot = wireSeg(el, "eslot");
    el.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const items = [...el.querySelectorAll(".edit-item")].map((row) => {
        const orig = m.items[Number(row.dataset.n)];
        const v = (k) => Number(row.querySelector(`[name=${k}]`).value || 0);
        return { ...orig, name: row.querySelector("[name=name]").value, kcal: v("kcal"), p: v("p"), f: v("f"), c: v("c") };
      });
      try {
        await api(`/api/meals/${m.id}`, { method: "PATCH", body: { slot: getSlot(), items } });
        toast("保存しました");
        close();
        renderMealData();
      } catch (err) { toast(err.message); }
    });
  });
}

// ---------- 運動 ----------
const QUICK_EX = ["ウォーキング30分", "ランニング30分", "筋トレ30分", "ストレッチ15分"];

async function renderExercise() {
  $app.innerHTML = `<div class="screen">
    <header class="top"><h1>運動</h1></header>
    ${dateBar()}
    <section class="glass card" id="exTotal"><div class="sk line"></div></section>
    <div class="list" id="exs">${listSkeleton()}</div>
  </div>`;
  wireDateBar(renderExercise);
  mountExerciseComposer();
  done();
  await loadExercises();
}

async function loadExercises() {
  const date = state.date;
  try {
    const day = await api(`/api/day?date=${date}`);
    if (state.tab !== "exercise" || state.date !== date) return;
    document.getElementById("exTotal").innerHTML = `<div class="row between"><span>消費</span><b data-testid="ex-total">${fmt(day.exercise)} kcal</b></div>`;
    const list = document.getElementById("exs");
    list.innerHTML = day.exercises.length ? day.exercises.map((x) => `<article class="glass entry" data-testid="exercise">
      <div class="head"><div class="title">${esc(x.name)} <small class="muted">${esc(x.text)}</small></div><div class="kcal">${fmt(x.kcal)} kcal</div></div>
      <div class="foot"><span class="pfcline">${Math.round(x.minutes)}分・${x.met} METs${x.source === "fallback" ? ' <span class="tag">簡易計算</span>' : ""}</span>
      <button class="linkbtn" data-del="${x.id}">削除</button></div></article>`).join("") : `<div class="empty">まだ記録がありません</div>`;
    list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => removeEntry(b, `/api/exercises/${b.dataset.del}`, loadExercises)));
  } catch (e) { if (e.status !== 401) toast(e.message); }
}

function mountExerciseComposer() {
  document.querySelector(".composer")?.remove();
  const wrap = document.createElement("div");
  wrap.className = "composer";
  wrap.innerHTML = `<form class="glass" id="exForm">
    <div class="chips">${QUICK_EX.map((q) => `<button type="button" data-q="${q}">${q}</button>`).join("")}</div>
    <div class="row">
      <textarea class="input" name="text" rows="1" maxlength="200" placeholder="例: ランニング30分" aria-label="運動内容" required></textarea>
      <button class="btn primary" type="submit" data-testid="add-exercise">記録</button>
    </div>
  </form>`;
  document.body.append(wrap);
  document.body.classList.add("has-composer");
  const form = wrap.querySelector("form");
  const ta = form.querySelector("textarea");
  autoGrow(ta);
  submitOnEnter(ta, form);
  const send = async (text, btn) => {
    busy(btn, true);
    const list = document.getElementById("exs");
    list.querySelector(".empty")?.remove();
    list.insertAdjacentHTML("afterbegin", `<div id="pending">${listSkeleton(1)}</div>`);
    try {
      const r = await api("/api/exercises", { method: "POST", body: { date: state.date, text } });
      ta.value = "";
      toast(`${fmt(r.exercises.reduce((a, x) => a + x.kcal, 0))} kcal を記録しました`);
      await loadExercises();
    } catch (err) {
      toast(err.message);
      document.getElementById("pending")?.remove();
    } finally { busy(btn, false); }
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) return ta.focus();
    send(text, form.querySelector("[type=submit]"));
  });
  wrap.querySelectorAll("[data-q]").forEach((b) => b.addEventListener("click", () => send(b.dataset.q, b)));
}

// ---------- 設定 ----------
function urlB64ToUint8(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function pushState() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager?.getSubscription();
  return sub ? "on" : "off";
}

async function renderSettings() {
  const p = state.me.profile;
  const iosBrowser = /iPhone|iPad/.test(navigator.userAgent) && !navigator.standalone;
  $app.innerHTML = `<div class="screen">
    <header class="top"><h1>設定</h1></header>
    <h2 class="slot-h">目標とプロフィール</h2>
    ${profileForm(p)}
    <section class="glass card" data-testid="notify">
      <h2>食事の通知</h2>
      <p class="small muted" id="pushNote">${iosBrowser ? "iPhone では、共有メニューの「ホーム画面に追加」から開くと通知を使えます。" : "設定した時刻に、その食事が未記録なら通知します。"}</p>
      <div class="grid2"><button class="btn block" id="pushToggle">確認中…</button><button class="btn block" id="pushTest">テスト通知</button></div>
    </section>
    <section class="glass card">
      <h2>アカウント</h2>
      <p class="small">${esc(state.me.user.email)}</p>
      <div class="grid2"><button class="btn block" id="logout">ログアウト</button><button class="btn block danger" id="delete" data-testid="delete-account">アカウント削除</button></div>
    </section>
    <nav class="links"><a href="/about">このアプリについて</a><a href="/privacy">プライバシーポリシー</a><a href="/terms">利用規約</a><a href="${ISSUES_URL}" target="_blank" rel="noopener">お問い合わせ</a></nav>
  </div>`;
  done();
  wireProfile($app, p, () => go("home"));
  const toggle = $app.querySelector("#pushToggle");
  const paint = async () => {
    const s = await pushState();
    toggle.textContent = s === "on" ? "通知をオフ" : "通知をオン";
    toggle.disabled = s === "unsupported" || !state.me.vapidPublicKey;
  };
  paint();
  toggle.addEventListener("click", async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await sub.unsubscribe();
        await api("/api/push/subscribe", { method: "DELETE" });
        toast("通知をオフにしました");
      } else {
        const perm = await Notification.requestPermission();
        if (perm !== "granted") return toast("通知が許可されていません");
        const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(state.me.vapidPublicKey) });
        await api("/api/push/subscribe", { method: "POST", body: s.toJSON() });
        toast("通知をオンにしました");
      }
    } catch (e) { toast(e.message || "通知を設定できませんでした"); }
    paint();
  });
  $app.querySelector("#pushTest").addEventListener("click", async () => {
    try { const r = await api("/api/push/test", { method: "POST" }); toast(r.sent ? "送信しました" : "通知が有効な端末がありません"); }
    catch (e) { toast(e.message); }
  });
  $app.querySelector("#logout").addEventListener("click", async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    renderLogin();
  });
  $app.querySelector("#delete").addEventListener("click", deleteAccount);
}

async function deleteAccount() {
  // 1段階目: 内容の確認
  const ok = await confirmSheet("アカウントと、すべての食事・運動・体重の記録を削除します。元に戻せません。", "次へ");
  if (!ok) return;
  // 2段階目: 「削除」と入力して確定
  sheet(`<h3>最終確認</h3><p class="small">確認のため「削除」と入力してください。</p>
    <form id="delForm"><input class="input" name="confirm" autocomplete="off" aria-label="確認入力" data-testid="delete-confirm">
    <div class="actions"><button class="btn danger block" type="submit" data-testid="delete-final" disabled>完全に削除</button><button class="btn block" type="button" data-close>キャンセル</button></div></form>`,
  (el, close) => {
    const input = el.querySelector("input");
    const btn = el.querySelector("[type=submit]");
    input.addEventListener("input", () => { btn.disabled = input.value.trim() !== "削除"; });
    el.querySelector("form").addEventListener("submit", async (e) => {
      e.preventDefault();
      busy(btn, true);
      try {
        await api("/api/account", { method: "DELETE", body: { confirm: input.value.trim() } });
        try {
          const reg = await navigator.serviceWorker?.getRegistration();
          await (await reg?.pushManager?.getSubscription())?.unsubscribe();
        } catch { /* 通知の購読が無い環境では何もしない */ }
        close();
        toast("アカウントを削除しました");
        renderLogin();
      } catch (err) { toast(err.message); busy(btn, false); }
    });
  });
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
document.querySelector("[data-skeleton-tabbar]")?.remove();
boot();
