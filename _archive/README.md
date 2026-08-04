# _archive — 旧世代（配信対象外）

`.vercelignore` で除外しているため、Vercel には配信されません。
参照用に残しているだけで、いずれも本番では使いません。

| ファイル | 内容 | 使わない理由 |
| --- | --- | --- |
| `src/App.jsx` ほか | React + Vite 版（中間世代） | 時間切れ（放置ペナルティ）とターン制限タイマーが未実装。6ターン構成も持たない |
| `recruit-sim-v2.html` | 単一HTML 旧版（最古） | ランキング未実装・時間切れ未実装 |
| `vite.config.js` / `package-lock.json` | Vite ビルド関連 | 本番は素の静的配信に切り替えたため不要 |
| `CHANGES-v2.md` | 旧版の変更履歴 | 参照用 |

本番は リポジトリ直下の `index.html`（単一HTML・ビルドなし）＋ `api/chat.js` / `api/rank.js`。
