# App Server 協定

## M0 證據

2026-11-22，本機桌面版附帶的原生 CLI 為 `0.171.0-alpha.13`，全域 npm 套件內的 Windows x64 原生 CLI 為 `0.171.0`。兩支皆以絕對路徑執行 `--version` 與 `app-server generate-ts --out <暫存目錄>`，兩次 schema 生成皆成功，未加 `--experimental`。下列五個方法在兩份 generated unions 皆存在。初始化、帳號讀取、額度讀取、推送與額度視窗的九個相關型別檔逐檔比對 SHA-256，結果相同。另查閱 CLI help 以確認 stdio 選項。此階段未啟動 App Server session 或發送 RPC。 [OpenAI App Server 文件](https://learn.chatgpt.com/docs/app-server) · [官方 account 型別來源](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/account.rs)

QuotaTray 原始碼只用於研究。其客戶端同樣透過帳號讀取、額度讀取及推送，以及 duration 與 reset timestamp 解析額度。其登入與 session 掃描超出本專案範圍。未執行其程式或腳本。 [QuotaTray 客戶端原始碼](https://github.com/ukr8b3g-cmyk/QuotaTray/blob/main/src/QuantaTrain.Infrastructure/CodexAccountClient.cs)

## 傳輸與固定方法

App Server 為長駐子行程，固定使用 `app-server --listen stdio://`。stdin/stdout 採 UTF-8，每行單一 JSON 訊息。官方 wire envelope 省略 `jsonrpc` 欄位。要求和回覆以同型別 ID 配對，schema 支援字串或數字，本客戶端只發遞增整數。回覆具 `result` 或 `error`，通知無 ID。握手成功後才允許帳號操作。 [官方 wire format 與初始化](https://learn.chatgpt.com/docs/app-server#initialization)

| 方向 | 方法 | MVP 參數與用途 |
| --- | --- | --- |
| 發出 request | `initialize` | 每個新行程一次。精確參數 `{"clientInfo":{"name":"codex_quota_monitor","title":"Codex Quota Monitor","version":"0.1.0"},"capabilities":null}`。驗證回覆結構後丟棄 metadata。 |
| 發出 notification | `initialized` | 成功收到初始化回覆後送出，無 id 或 params。 |
| 發出 request | `account/read` | `{ "refreshToken": false }`。只保留帳號狀態 enum。空帳號、非 ChatGPT 帳號、傳輸錯誤分別處理，UI 的未登入指引只指向官方 CLI。 |
| 發出 request | `account/rateLimits/read` | 精確參數 `{"excludeResetCreditDetails":true}`。 |
| 接收 notification | `account/rateLimits/updated` | `params.rateLimits` 為單 bucket 的 sparse 更新。M2 驗證並輸出正規化事件。 |

發送端只接受上表四個固定建構器。未知通知直接忽略，伺服器主動 request 不執行也不回傳資料，結束該連線並回報安全的狀態。對版本差異採結構驗證及 RPC 錯誤分類。握手回覆未提供可用的協定版本號，不能把 userAgent 當作協定協商。

M2 預設 RPC timeout 10 秒，最多一個在途 RPC、16 個通知訂閱者，單行上限 1 MiB。stdout 按 LF 分幀後才嚴格解碼 UTF-8。非預期、重複與逾時 ID 不結算任何請求。壞資料、超限、意外 server request、EOF 或行程錯誤會關閉 transport 並清理待處理請求；上層 owner 負責回收子行程。僅回傳正規化 domain 資料及帳號狀態 enum。

## 額度映射

- 完整讀取回覆含 `rateLimits` 舊版單 bucket 及可為 null 的 `rateLimitsByLimitId`。非 null 的 map 為權威資料，最多 64 個 bucket，保留 map key 並核對非 null 的 limitId，矛盾時拒絕回覆。各 bucket 保留自己的視窗，相同長度跨 bucket 並存。當 map 存在，預設只選 `codex`，空 map 為 missing，其餘缺少 `codex` 為 ambiguous。只有 map 缺少或為 null 時才採用 legacy，明確的非 codex ID 為 ambiguous，無 ID 標作 legacy。
- `primary`、`secondary` 可為 null。掃描兩者，精確以 `windowDurationMins` 的 300／10080 分鐘識別 5 小時／每週。未知長度、缺少長度、同一 bucket 內同長度出現兩筆互相衝突的資料，對應項顯示 N/A。
- `usedPercent` 必須是有限且介於 0–100 的 number，剩餘量為 `100 - usedPercent`。越界或 malformed 欄位拒絕回覆。Reset 為可空的 Unix 秒，須是 0 至 253402300799 的整數，再轉毫秒。未知視窗保留為 unknown，無 reset 保留 null。M2 不更新倒數。
- 丟棄帳號 ID、email、plan、點數、banner 等欄位。區分有效回覆缺少指定額度（N/A）與讀取失敗（保留最近成功值並標 Stale）。
- M3 只使用有效的 `codex` 或無 ID 推送做刷新訊號。各來源相同的正規化推送會在 session 內去重。這些推送不覆寫快照，在途通知合併為最多一次後續刷新，並尊重最小間隔與恢復退避。完整查詢仍是快照資料源。

Schema 可表達兩種 duration，也可表達只有一個視窗或都缺少。實際帳號是否回傳 300／10080、哪些狀況會產生推送，以及未登入/不支援方案的實際錯誤，仍需另行驗證。 [官方 Rate limits 欄位說明](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)
