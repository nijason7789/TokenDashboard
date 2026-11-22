# 實作計畫

## M0 — 研究與可行性

檢查日期 2026-11-22。工作目錄起初為空，`git status` 與 `git rev-parse` 均確認無 Git repository。本機 Windows 10 x64，build 19045，PowerShell 7.6.9、Node.js 24.18.0、npm 11.16.0、Git 2.37.1.windows.1。全域 npm 提供 PowerShell 與 cmd shim，另有兩支通過簽章查詢的原生 CLI。CLI 版本與離線 schema 實測見 [協定](PROTOCOL.md)。

驗收已具備環境清單、來源交叉驗證、讀取策略、[架構](ARCHITECTURE.md)、[威脅模型](SECURITY.md) 及下列驗收條件。現階段的可行性結論為本機靜態 schema 支援唯讀設計。帳號行為與 Windows 產品整合留待後續驗證。M0 審查有條件核准 M1。先納入審查要求並建立獨立基線 commit，M1 另行提交。

## M1 — 專案基礎

建立 Git 基線（若工作目錄仍無 repository）、Electron／React／TypeScript strict／Vite npm 專案，設定 ESLint、Prettier、Vitest、React Testing Library、Playwright for Electron 與 Windows CI。使用既有技術堆疊，不加狀態庫、資料庫或後端。

驗收：提交 lockfile，`npm ci` 可重現，lint、typecheck、test、test:coverage、build 各有 script。另有 Windows Electron E2E job，CI 預設最小權限，外部 Actions pin 完整 SHA、無認證資料。打包入口載入本機資產，安全 preferences、CSP 與 IPC sender 驗證有測試，測試 fixture 與正式入口隔離，正式啟動顯示來源不可用，禁止自動回退至 mock。

## M2 — Codex App Server

先以 TDD 建 fixture、可控 mock 子行程、可信 EXE resolver、方法限制、分幀 transport、握手與純 parser。以本機可重新產生的 schema 校對，最小化產品所匯入的型別，避免 raw payload 穿越邊界。

驗收：unit 覆蓋百分比、維度交換與缺少、時間戳、未知 bucket、壞資料、allowlist、ID、分割 chunk、多訊息、超限與 timeout。integration 覆蓋成功握手、額度讀取、推送、無執行檔、未登入、壞回覆、協定不相容、crash／restart、掛住及乾淨 shutdown。測試相同長度跨 bucket 不碰撞，並驗證預期發行者及實際映像與已驗證檔案的身分一致。確認兩個 CLI 版本在隔離 profile 的握手、startup 預設行為、固定 overrides、安裝路徑解析與信任驗證，測試環境不接觸真實帳號。

M2.1–M2.3 完成 Windows 執行檔驗證及生命週期、stdio transport、bucket parser 和隔離 mock。自動重啟由 M3 處理。正式入口仍回報來源不可用。

### M2.4 提議的 live smoke test

以下只供安全審查，必須取得單獨明確授權。候選為先前離線核對的桌面原生 CLI `%LOCALAPPDATA%\OpenAI\Codex\bin\31fb36cfc4b38f05\codex.exe`（研究時為 `0.171.0-alpha.13`）。執行前核對展開後的絕對路徑、版本、發行者與檔案 SHA-256。若候選已更新、路徑不符或信任無法確認，停止並重新核准候選。由目前版本的 launcher 使用固定 cwd 與最小環境，執行以下精確參數序列。

```json
["app-server", "--listen", "stdio://", "-c", "analytics.enabled=false", "-c",
 "otel.exporter=\"none\"", "-c", "otel.trace_exporter=\"none\"", "-c",
 "otel.metrics_exporter=\"none\""]
```

1. 在已核准的本機 Windows 使用者環境，以外部監看確認程式本身只走本機 stdio。先用無帳號 profile 排除意外啟動流量。已核准真實測試時，預期只有官方子行程向 OpenAI 帳號／額度服務使用 TLS，Windows 憑證驗證可產生信任鏈或撤銷查詢。第三方目的地、遙測或不明啟動流量立即停止。既有 CLI 設定與管理政策的影響須記錄。
2. 依 [協定](PROTOCOL.md) 依序送一次 `initialize`、`initialized`、`account/read`。只有 ChatGPT 狀態才送一次 `account/rateLimits/read`。有推送則只驗證結構。任何不符、逾時或 server request 都結束測試。
3. 報告只記錄退出狀態、方法成功與否、已驗證 duration 是否出現與網路目的地類別，禁止保留百分比、原始 stdout、stderr、email、帳號 ID、憑證資料、Codex home 或完整本機路徑。
4. 在 finally 關閉 transport 與 stdin。等待 250 ms 後仍未退出則終止，最多再等 5 秒。驗證子行程與驗證程序都已收回，並確認無憑證或 payload 留在測試產物。

## M3 — 監控服務

組合 polling、手動與推送刷新，加入單一在途 request、退避、重連、Stale 保留及純倒數函式。

驗收：fake timers 驗證四種間隔、timeout、退避上限、請求去重、事件 coalescing、重連及取消排程。錯誤保留資料與取得時間，成功回覆才清除 Stale。倒數更新無額外 RPC，退出後無 timer 或 listener。

## M4 — 桌面 UI

建立可拖曳 resize 的無框暗色面板與 Compact 版。顯示雙額度、百分比語意、重置時間、倒數、連線與最後成功時間。以測試資料驗收顏色門檻、N/A 和 Stale。

驗收：React Testing Library 驗證標籤、缺額度與互動。Playwright 驗證 app launch、雙額度渲染、手動刷新、Compact、錯誤與恢復。Windows 手動驗收非 Compact 的實際 reset time、拖曳、resize、高 DPI 和可讀性。

## M5 — Tray 與設定

完成 Tray 菜單、顯示／隱藏、關閉行為、透明度、置頂、多螢幕、低額度通知、所有設定及 Windows 開機啟動。

驗收：無效設定安全回落、重啟保存、去重跨區間並涵蓋未知 reset、default startup off。E2E 驗證 persistence 及 visibility。Windows 手動 checklist 涵蓋 Tray、置頂、最小化、關閉轉 Tray、portable 啟動項、顯示器拔除及 DPI 改變。

## M6 — 安全審查與發行

執行全套 unit、component、integration 與 Windows E2E。核心 branch coverage 目標 ≥90%，overall 目標 ≥80%，記錄未覆蓋的安全路徑。檢查 renderer、IPC、子行程、網路、持久化與依賴稽核，記錄 advisory 和影響，禁止盲目 force fix。

驗收：electron-builder 產出 Windows portable EXE 與 SHA-256，實際於 Windows 10／11 以非管理員啟動。附 README、已支援版本、手動驗收清單與測試結果。量測 App 行程群和 Codex 子行程的 CPU 及記憶體，記錄機型、版本、取樣間隔、時長、前景／隱藏及退避環境，檢查退出後無殘留，交代未測項目。真實帳號 smoke test 獨立、預設關閉，待明確同意才執行。

## 未決事項

| 事項 | 驗證方式 |
| --- | --- |
| 真實帳號是否具有兩類窗口，推送的時機及實際錯誤 | 經同意後做獨立 smoke，僅記錄遮罩後的狀態與 duration。 |
| 跨 CLI 版本與安裝通道支援範圍、簽章驗證方案 | M2 以原生 stable 為優先候選，桌面 alpha 作兼容案例，補驗候選架構、shim-only、簽章失敗、路徑置換及不相容 schema。 |
| 官方子行程啟動副作用、遙測與自訂端點覆寫 | M2 以無真實認證的隔離 profile 驗證配置及網路邊界，明確記錄各支援版本的行為。 |
| Windows 11、portable startup、Tray、DPI、效能 | M4–M6 以實機及 Windows CI 複驗，公布實測與未測範圍。 |
