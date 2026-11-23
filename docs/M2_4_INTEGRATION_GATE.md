# M2.4 最終整合門檻

審查基線 `6c27d8a`。本文件定義單次 live smoke 及後續 dashboard 接線兩個獨立驗收階段。目前正式入口仍回傳 `source: unavailable`。此次執行 mock／單元測試，未啟動真實 App Server，也未讀取帳號、憑證或會話記錄。

## 現行執行路徑與啟動前核對

1. 生產 adapter `startWindowsCodex()` 在 Windows 上使用 `C:\Windows`，verifier 支援 x64／ARM64。依序探索 LocalAppData 的 OpenAI Codex bin（直接路徑及至多 16 個依字串倒序的十六進位 revision），再查 LocalAppData Programs、Program Files、至多 64 個合格 PATH 根目錄與對應架構的 npm vendor 路徑。候選須為 `codex.exe`，位於系統磁碟，canonical 路徑須等於原路徑。拒絕以目前工作目錄及其子路徑為探索根目錄，並排除非本機路徑及連結。revision 順序不代表版本順序。
2. 固定 Windows PowerShell 使用 `-NoProfile -NonInteractive` 和固定 verifier 腳本。路徑、架構及 PID 經 stdin 傳遞。先以 `Add-Type` 載入驗證輔助程式，拒絕不支援的 PE、架構、磁碟或 reparse 路徑。持有禁止刪除共享的父目錄 handle 與僅允許讀取共享的 EXE handle，要求 Authenticode Valid、簽署者 CN 與組織皆為 OpenAI OpCo, LLC，並記錄檔案 ID 和 SHA-256 供映像比對。
3. 以固定 cwd `C:\Windows\System32`、三個 stdio pipes、無 shell 啟動。環境限 Windows 系統路徑及必要使用者／暫存目錄。spawn 後查 PID 的 MainModule 映像路徑、volume、file ID、SHA-256 及行程存活狀態。全部通過且 verifier 關閉後，才建立 RPC transport。核對失敗即回收，禁止寫入 RPC。既有鎖與比對減少置換風險，原生初始化仍可在 spawn 與比對之間發生。
4. 首次 smoke 前，列出解析後的唯一絕對 EXE 路徑、版本、發行者及 SHA-256，讓操作者核准該身分。一般 discovery 模式會依序尋找通過信任檢查的候選。未來 smoke 入口須選擇已實作的單一候選模式。該模式在 verifier 持鎖時核對核准的 digest，並拒絕候選回退。路徑或 digest 變動、PowerShell／Add-Type 遭阻擋、無法核對實際映像時停止，完整保留既有信任條件。
5. 固定 argv 為下列 JSON 陣列。已於前一輪用 Authenticode Valid 的本機 `0.171.0-alpha.13` 核對 `--help`、離線 `generate-ts` 與該版配置 schema。Launcher mock 驗證完整順序與額外環境設定不會注入 argv。下次須以核准的版本重做相同離線核對並確認管理政策未覆蓋配置。詳見 [協定紀錄](PROTOCOL.md#m24-launcher-離線複核) 與 [安全設計](SECURITY.md)。

```json
["app-server","--listen","stdio://","-c","features.plugins=false","-c","analytics.enabled=false","-c","otel.exporter=\"none\"","-c","otel.trace_exporter=\"none\"","-c","otel.metrics_exporter=\"none\""]
```

## 精確 RPC 順序

每個物件獨佔一行 UTF-8，沒有 `jsonrpc` 欄位。收到並驗證 id 1 的回覆後才送第 2、3 行。只有 id 2 回覆分類為 ChatGPT 才送第 4 行。每個 request 只發一次，預設 10 秒逾時及 1 MiB 單訊息上限，沒有並行請求。ID 或回覆結構不符時不得採用資料。

```jsonl
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"codex_quota_monitor","title":"Codex Quota Monitor","version":"0.1.0"},"capabilities":null}}
{"method":"initialized"}
{"id":2,"method":"account/read","params":{"refreshToken":false}}
{"id":3,"method":"account/rateLimits/read","params":{"excludeResetCreditDetails":true}}
```

Transport 內部白名單同時比對方法與精確參數。現行程式忽略無關通知及非預期回覆 ID，遇到有 id 的 server request 或無效 envelope 則中止。額度推送只驗證結構與桶，smoke 不訂閱更新來觸發讀取。禁止其他 RPC、推論、對話、登入登出、重置點數或讀取設定。

## 單次 smoke 的授權、網路與回收

1. 先在獨立 Windows VM 與專用標準使用者環境完成無帳號基線。由環境負責人提供 OS／外部閘道有效政策及正反向證據。指定 Windows EXE 和整個子行程樹均無法向未允許位址、DNS 或替代 IPv4／IPv6 路徑外連，必要官方帳號／額度 TLS 服務、DNS 和憑證驗證仍可用。確認沒有不明 Git、plugin、telemetry 或更新目的地。測試僅觀察目的地類別、程序及時序，避免 TLS 攔截與敏感 payload。版本或端點政策未驗證即停止。[威脅模型與隔離證據要求](M2_4_THREAT_MODEL.md)
2. 只有上述證據齊全且使用者另外明確核准指定 VM、帳號使用範圍、commit、EXE 身分、允許目的地政策及單次操作，才可執行。操作者在專用環境自行用官方方式準備登入。自動測試及 CI 只接觸注入的 mock 或本機 fixture，不可匯入 live entry 或取得具登入狀態的 profile。未來單次 runner 為非預設、不打包、不納入 npm／CI job 的人工入口，只能接受操作者在互動終端逐次確認的審查資料。拒絕腳本環境旗標、設定檔、Renderer IPC、重導 stdin 或 `CI` 觸發真實模式。實際技術邊界為隔離 VM 的帳號與網路存取權僅交給被核准操作者，CLI 文字確認只是防止誤觸。完成或失敗均消耗本次核准，重跑需另行授權。
3. 使用核准的單一候選及現有 `createCodexQuotaProvider`，以 `open(signal)` 完成握手及帳號檢查。成功才呼叫一次 `session.read()`。外層設一次性中止期限，驗證中止後晚到的 launcher／session 也會關閉。首測避開 `QuotaMonitor.start()`，因其會輪詢、依通知刷新及重試。拒絕並行 runner 與自動重跑。
4. 預期應用程式至 App Server 只用 stdio。外連依版本可能包括核准的官方 TLS 服務、DNS 與 Windows 憑證鏈／撤銷查詢。任何出乎預期的程序或網路活動都先中止調查。plugins 與遙測設定只控制各自功能，網路強制依賴隔離措施。即使目的地吻合，仍有簽署程式缺陷、核准端點接收額外資訊、登入狀態存取及 spawn 核對空窗等風險。
5. 在 `finally` await `session.close()`，關閉 transport、取消計時器與訂閱、關閉 stdin；現有 Codex shutdown 等 250 ms 再終止，最多再等 5 秒。另核對 verifier 及所有觀察到的子行程退出。現有 Node kill 針對直接子行程，完整樹需由外部監看證明。任何未確認退出都算失敗，停止後續啟動，將隔離 VM 停機並依環境負責人的流程清理該次快照或專用 profile。保留脫敏證據後才處理專用環境。
6. 報告只記錄簽章／映像核對結果、認證分類、窗長與桶數及隔離結果、missing／ambiguous、parser 成敗、請求延遲、目的地及子行程類別與回收結果。原始 stdout、stderr、RPC、實際配額、帳號識別資料及憑證不得寫入報告或日誌。缺少預期窗口時如實記為缺少，禁止補值或重試。

## 帳號與額度狀態

| 情況 | 首次 smoke／後續顯示 |
| --- | --- |
| 未登入或服務確認登入失效 | 若 `account/read` 回報 `account: null`，直接結束。後續 dashboard 應暫停自動讀取並請使用者自行在官方 CLI 恢復登入。不得發送 refresh 或自動登入。 |
| API key、Bedrock 或 GCP | 現行 transport 分類為 unsupported，provider 不讀額度。未知帳號型別屬不相容回覆，停下核對 schema。 |
| 額度不可取得或逾時 | 現行 provider 將 RPC error、驗證失敗和傳輸問題歸為 transport failure。首測停止。若日後 schema 有可辨識的登入失效或額度不可用代碼，先以 mock 測試按代碼分類，禁止解析敏感錯誤訊息或從一般失敗推測登入狀態。後續一般暫時故障可顯示有時間標記的 stale 值，明確登入失效或帳號不支援要清除舊值。 |
| 缺窗、重複時長或不同桶 | 以 `rateLimitsByLimitId` 的 key 分桶，拒絕 key 與內嵌 ID 衝突。只有 map 缺席時採 legacy。單桶內依 300／10080 分鐘分類，同桶同長為 ambiguous，未知長度不猜測。map 優先使用 `codex` 桶，沒有它且存在其他桶則保留 ambiguous。不同桶同時長不能合併。只呈現 selected 桶的已驗證窗口。 |

## 允許接線的條件與回退

- **先驗收單次 smoke。** 映像確認、初始化、帳號分類、各一次唯讀 request、實際窗口映射和桶隔離、網路與完整回收均須有證據。缺少窗口可以是正確結果，但缺少實際證據的窗口須留待另一次核准測試，不能標成已驗證。安全或協定異常須先修正，獨立審查批准後才開始接線。
- **Main-only 最小接線。** 經核准後，由 Main 的單一 app owner 建立 `QuotaMonitor(createCodexQuotaProvider(launcher))`。入口仍預設不可用，另行核准的生產 opt-in 才啟動。Launcher 應透過 AbortSignal 及可等待的回收處理 timeout／quit 競態。監控啟動與讀取使用獨立期限。期限與回收協議已用 mock 驗證，仍須確認核准環境的實際時序。逾時後不得遺留未被追蹤的行程或放寬 unreaped 隔離。
- **狀態與生命週期。** `QuotaMonitor` 目前只有 status getter，需增加最小的 Main-only 狀態通知，讓自動輪詢或錯誤也能更新 Renderer。沿用 `quotaDisplayStatus`、`sanitizedStatus` 和既有 IPC／Tray refresh，偏好成功提交後更新 poll interval。bucket ID 與通知去重留 Main，避免 stale 數值觸發通知。Main 的 before-quit 要在第二次 quit 前 await `monitor.stop()`，並解除訂閱及計時器。載入失敗或退出競態也要回收。
- **實作驗收。** 先以 mock 驗證預設入口與 CI 零真實 spawn，並覆蓋單一 provider、手動刷新／輪詢合併、帳號分類、bucket 隔離、stale／missing、啟動取消、late open、cleanup quarantine 和退出。Renderer 只能收到現有的脫敏 DTO。再跑 lint、typecheck、test、coverage、Electron E2E、build；凡有封裝入口變更也須重跑 Portable 驗證。將證據交付審查，取得與單次 smoke 分開的 dashboard 接線／啟用核准。
- **回退。** 關閉生產 opt-in 並等待 monitor 停止，丟棄記憶體 snapshot，恢復 `unavailable`。必要時 revert 接線提交，保留已審查的 verifier、allowlist 和封裝強化。不得切換到 mock、沿用未確認的行程或更改使用者 Codex 設定。

本次基線驗證為 18 個測試檔、231 項通過，涵蓋 launcher、transport、provider、monitor 與 mock 整合。此結果支持準備計畫，live smoke 與生產接線仍需各自審查和核准。

## F-17／F-18 mock preflight

| 範圍 | 期限與取消行為 |
| --- | --- |
| Windows discovery 至映像與 verifier 核對 | 共 20 秒。取消後晚到的 filesystem 結果不會啟動 verifier。候選驗證及核對 PID 的各次 verifier exchange 分別上限 10 秒，皆受外層期限限制。 |
| Codex spawn | 收到 spawn 事件最多 5 秒。中止後先回收子行程，不再核對或寫入 RPC。 |
| RPC 啟動握手 | 初始化及帳號分類共享 10 秒。中止時關閉 transport，忽略晚到的回覆。仍未交付 session 時，先等待所持有程序的回收。 |
| Provider 整體啟動 | 最多 30 秒後停止啟動。若 launcher 尚未交還所有權，額外等待最多 16 秒確認回收。逾期回報不可重試的 cleanup failure，同一 provider 拒絕再開啟，晚到結果仍安排關閉。 |
| Windows 清理 | Codex 和 verifier 各先關 stdin、等 250 ms，再執行終止。終止後分別最多等 5 秒與 10 秒。清理等待獨立於啟動期限，無法確認回收就是失敗。 |

`startWindowsCodex(signal, { path, sha256 })` 是內部單一候選模式。要求正規的本機絕對 `codex.exe` 路徑及 64 字元十六進位 SHA-256。只解析指定候選，不執行 discovery 列舉或 fallback。Windows verifier 在持有檔案鎖時核對核准 digest，通過既有 PE、Authenticode、發行者條件後才回應 verified。實際啟動映像仍須匹配路徑、volume、file ID 與雜湊；完成前不建立 transport。Renderer 和 IPC 沒有此入口。這次測試以替身驗證資料傳遞、拒絕、逾時及回收，未以真實 Codex 驗證映像。

保留人工入口 `scripts/m2-4-live-smoke.mjs`。目前直接執行也會以失敗結束，入口沒有 launcher 或 RPC import。npm、CI、E2E、正式應用與 Portable 都不接線。環境旗標、設定檔或命令列參數無法啟用。要加入 live 能力，仍須完成隔離證據與獨立授權，並另行審查 runner 實作。

在接線前仍需實測核准環境的 Windows preflight 時序與程序樹退出。Monitor 會在所有權未確認時保持隔離。首次 authenticated smoke 仍須另行核准執行檔、隔離環境、外連政策及單次 RPC 範圍。

## F-20／F-21 跨層生命週期

- Monitor 與 provider 共用 30 秒 session establishment 上限。既有 Windows 20 秒總期限、每次 verifier exchange 10 秒、spawn 5 秒及初始化／帳號分類共用 10 秒的階段上限持續適用。成功建立 session 後，另起獨立 10 秒 quota read deadline，未使用的啟動時間不轉給讀取。
- 若啟動逾時或使用者停止，Monitor 傳遞取消後最多等 17 秒確認回收。此值包含 provider 的 16 秒晚到 launcher 回收期限及 1 秒交接緩衝。確認回收後，啟動逾時可依既有 backoff 重試，手動停止可稍後重新啟動。等待中合併 refresh 並拒絕新開啟。逾期或回收失敗永久隔離該 Monitor，晚到的程序或 session 仍安排關閉。
- verifier 和 Codex 各先關 stdin，正常等待 250 ms 後請求終止，再分別最多等 10 秒及 5 秒。映像拒絕時可立即要求終止。若終止 API 失敗，仍等待 close 證據；未確認時只回報不可重試的 cleanup，保留晚到 close 觀察，禁止候選回退與 session 交付。Renderer DTO 不帶程序細節或內部錯誤原因。
- Mock 覆蓋啟動晚於 10 秒、讀取獨立逾時、取消 verification／handshake、確認與未確認的回收、乾淨重啟及禁止重複 session。這些結果不構成實際 Windows 子行程樹的回收保證。真實程序若遭 OS 阻擋而無法退出，停止驗收並由隔離環境操作人員確認清理。Authenticated smoke 與 Production Wiring 仍未啟用。
