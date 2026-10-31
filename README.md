# MyBestBody

目標体重に向けて、食事の PFC と運動を記録し、進み具合に応じたアドバイスを表示する個人向け PWA です。
iPhone で片手操作することを前提にしています。

- 本番: https://my-best-body.jqsmine1999.workers.dev
- お問い合わせ: [GitHub Issues](https://github.com/jqsmine1999-dotcom/my-best-body/issues)

## 機能

| 機能 | 内容 |
| --- | --- |
| 伴走コーチ | 開始日→目標日の計画線と直近7日の平均体重を比べて「順調 / 遅れ気味 / 先行」を判定。摂取カロリー・たんぱく質・記録状況から、数値つきの行動を最大3行で表示 |
| 食事の PFC 管理 | 「納豆ごはん、卵2個」のように文章で入力すると、品目ごとの kcal・P・F・C を推定して記録。最近の食事はワンタップで再記録。数値は手で修正可能 |
| 運動の管理 | 「ランニング30分」と入力すると、METs × 体重 × 時間 × 1.05 で消費カロリーを算出し、その日の予算に加算 |
| 食事の通知 | 設定した朝・昼・夕の時刻に、その食事が未記録なら Web Push で通知（ホーム画面に追加した PWA で動作） |
| アカウント削除 | 設定画面から2段階確認（内容確認 →「削除」と入力）で、全データを即時削除 |

## 技術選定

| 領域 | 採用 | 理由 |
| --- | --- | --- |
| 実行環境 | Cloudflare Workers | 共通方針。エッジで速く、無料枠で個人利用に十分。Cron・AI・DB を同じ場所で扱える |
| ルーティング | Hono | Workers 向けに設計された軽量フレームワーク。Cookie ヘルパーがあり依存が少ない |
| データベース | Cloudflare D1 (SQLite) | 食事・運動・体重はユーザー単位の関係データで、日付範囲の集計（SUM / GROUP BY）が必要なため KV より SQL が適する |
| 静的配信 | Workers Static Assets | HTML/CSS/JS を Worker と同じデプロイで配信。`run_worker_first` で API と認証だけ Worker を通す |
| AI | Workers AI `llama-3.3-70b-instruct-fp8-fast`（予備: `mistral-small-3.1-24b-instruct`） | 本番で比較し、日本語の食品理解と応答速度（1〜5秒）のバランスが最良。Qwen3 は思考出力で30秒超、Gemma 4 は応答が返らないことがあったため不採用 |
| AI の安全策 | 出力の検証 + 食品表・METs 表 | AI の各品目に「メモ中の根拠文字列」を出させ、メモに無い品目は破棄。数量はメモの表記のみ採用。食品表と35%以上ずれたら表の値を使い、取りこぼした品目は表で補う。運動の時間は必ず本文から読み取り、kcal はコードで計算 |
| フォールバック | 内蔵の食品表（約50品目）と METs 表 | AI が落ちても記録が止まらないようにするため。結果には「簡易計算」と表示 |
| アドバイス | ルールで候補を作り、AI は言い換えのみ | 判定と数値はコードで決め、AI の出力に事実に無い数値が含まれたら破棄してルールの文を使う |
| フロントエンド | ビルド不要の素の JavaScript (ES Modules) | 画面は4つで小規模。依存とビルド工程をなくし、初回表示を軽くする |
| UI | 自作 CSS（Liquid Glass 風: `backdrop-filter`・半透明・ハイライト） | グレー基調・アニメーション多めの要望に合わせて細かく制御するため。`prefers-reduced-motion` で動きを止める |
| スケルトン | `index.html` に直書き | JS 到着前の HTML の段階から全画面スケルトンを出すため |
| PWA | Web App Manifest + Service Worker | ホーム画面に追加して全画面で使え、iOS 16.4 以降で Web Push を受け取れる |
| 通知 | Web Push（VAPID + aes128gcm を WebCrypto で実装）+ Cron Trigger（5分ごと） | 外部サービス・npm 依存なしで Workers 上から送れる |
| 認証 | Google OAuth 2.0（Authorization Code + PKCE S256 + state） | 共通方針。セッションは `__Host-` 付き HttpOnly / Secure / SameSite=Lax Cookie。DB にはトークンの SHA-256 のみ保存 |
| CSRF 対策 | 更新系リクエストで Origin（無ければ Sec-Fetch-Site）を検証 | SameSite=Lax と合わせて二重に防ぐ |
| テスト | Playwright（WebKit = iPhone 15、Chromium = Pixel 7） | 実ブラウザで iOS Safari 相当と Android を両方検証できる |
| デモ録画 | Playwright の録画 + ffmpeg-static | iPhone 解像度の MP4 をコマンド1つで作れる |

## ディレクトリ

```
src/        Worker（index.ts: API、auth.ts: 認証、ai.ts: Workers AI、nutrition.ts: 目標・食品表・METs、coach.ts: 判定とアドバイス、push.ts: Web Push）
public/     画面（index.html / app.js / styles.css / sw.js）、/about /privacy /terms、アイコン、logo-120.png
migrations/ D1 のスキーマ
tests/      Playwright テスト
scripts/    アイコン生成、AI 品質確認、デモ録画
```

## 開発手順

```bash
npm install
npx playwright install webkit chromium
cp .dev.vars.example .dev.vars          # DEV_LOGIN=1 などローカル専用の設定
npm run db:migrate:local
npm run dev                              # http://localhost:8787
```

- ローカルでは `http://localhost:8787/dev/login?as=me` で開発用ログインができます。
  `DEV_LOGIN=1` かつホスト名が `localhost` / `127.0.0.1` のときだけ有効で、本番では 404 になります。
- `.dev.vars` に `AI_DISABLED=1` を書くと Workers AI を呼ばず、食品表・METs 表で計算します。

### テスト

```bash
npm test                                 # WebKit(iPhone) と Chromium(Android) で全件実行
npm run ai-eval                          # 本番 Workers AI で、テストとは別の入力の解析結果を表示
npm run test:prod                        # 本番 URL の公開ページ・認証設定・開発用機能の無効化を確認
```

### アイコン・ロゴの再生成

```bash
npm run icons
```

### デモ動画（iPhone 解像度の MP4）

```bash
npm run demo                             # demo/mybestbody-demo.mp4 を出力（ローカルを開発用ログインで操作）
DEMO_BASE_URL=https://my-best-body.jqsmine1999.workers.dev npm run demo   # 本番の公開ページだけを録画
```

## デプロイ手順

1. 初回のみ: D1 を作成し、`wrangler.jsonc` の `database_id` を設定
   ```bash
   npx wrangler d1 create my-best-body-db
   ```
2. 初回のみ: VAPID 鍵を作成し、公開鍵を `wrangler.jsonc` の `VAPID_PUBLIC_KEY` に、秘密鍵（JWK）をシークレットに登録
   ```bash
   npx wrangler secret put VAPID_PRIVATE_JWK
   ```
3. 初回のみ: Google Cloud Console で OAuth クライアント（ウェブ アプリケーション）を作成
   - 承認済みのリダイレクト URI: `https://my-best-body.jqsmine1999.workers.dev/auth/callback`
   - Cloudflare ダッシュボード → Workers & Pages → my-best-body → 設定 → 変数とシークレット に
     `GOOGLE_CLIENT_ID` と `GOOGLE_CLIENT_SECRET` をシークレットとして登録
4. デプロイ（マイグレーション適用 → Worker 公開）
   ```bash
   npm run deploy
   ```

`wrangler.jsonc` は `keep_vars: true` のため、ダッシュボードで登録した値はデプロイで消えません。
秘密情報はリポジトリに含めません（`.dev.vars` は `.gitignore` 済み）。
