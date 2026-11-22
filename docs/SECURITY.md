# 安全設計與威脅模型

保護資產包括既有 Codex 認證、帳號隱私、專案與會話內容、主行程權限，以及 UI 額度的完整性。信任根為 Windows、本機已驗證的官方 CLI 與本應用程式安裝內容。Renderer、IPC 輸入及 stdout 皆須驗證。

| 威脅 | MVP 控制與驗收 |
| --- | --- |
| PATH 劫持、偽裝 npm shim、路徑穿越 | Main 僅在已知安裝根及嚴格驗證的絕對 PATH entries 搜尋原生 `codex.exe`，拒絕空／相對項、CWD、網路路徑及逃出可信根的 reparse target。檢查 realpath、檔案型別、簽章信任鏈及允許的 OpenAI publisher。驗證失敗即拒絕。 |
| 命令注入 / 無意執行外部命令 | Node spawn 使用已驗證絕對路徑、固定參數、`shell:false`、`windowsHide:true`、獨立 stdio、固定非專案 cwd。拒絕 `.cmd`、`.bat`、`.ps1` 與未驗證的 helper。封鎖 renderer 指定命令、路徑、參數或 RPC 方法。 |
| Renderer XSS 與特權升級 | 明確啟用 contextIsolation、sandbox、webSecurity，關閉 nodeIntegration。以本機自訂 protocol 提供打包資產，嚴格 CSP（僅本機必要資產，禁止遠端連線、frame、object；禁止 eval 與 inline script）。拒絕 navigation、window open、permission check/request、webview 與下載。Main 驗證每個 IPC 的 webContents、top frame、精確資產 URL、輸入型別和值域。 |
| 偽造 RPC、輸入洪水、掛住或殘留行程 | JSON 分幀驗證、每行上限 1 MiB、固定 pending 上限 1、timeout、忽略未知／過期 ID、拒絕意外 server request。stderr 排空後丟棄。Fatal frame/EOF/exit 進入單一清理流程，測試重連及退出後無殘留。 |
| 認證或個資進入 UI、log 或硬碟 | 只繼承官方 CLI 登入狀態。不存取 auth.json、token、Cookie、Credential Manager、會話或專案檔。只將 quota DTO、狀態 enum 與偏好送過 IPC。原始 RPC、CLI stderr、帳號資料和安裝路徑不進入使用者錯誤訊息或 log。 |
| 錯誤端點、遙測、供應鏈 | App 無外部 HTTP、遠端內容、第三方 API、遙測、上傳與自動更新。CLI 環境用必要項白名單，保留 Windows profile 與所需 Codex home，排除 API key、provider／端點覆寫及遠端 tracing 環境變數。M2 驗證能否以固定 CLI overrides 停用 analytics 與 OTel 三類 exporters，並檢查既有設定或管理政策的影響。CI 鎖依賴、最小權限、Actions 按完整 SHA pin、稽核並記錄風險。 |

## Windows 執行檔方案

- 直接啟動簽章已驗證的原生 EXE 可符合無 shell 要求。npm 發行也可定位架構對應的官方 vendor EXE，避免執行 shim 或載入外部 Node 程式。兩支本機候選檔均回報 Authenticode Valid，簽署者為 OpenAI OpCo, LLC。版本查詢僅用於相容性判斷。 [官方 npm launcher](https://raw.githubusercontent.com/openai/codex/main/codex-cli/bin/codex.js) · [Node Windows shell 限制](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)
- M2 建議優先驗證系統 WinTrust 實作的可維護性。另一方案是發行版維護可信的官方 SHA-256 清單，實作較小但每次 CLI 更新可能需要更新清單。選定前應證明驗證、本機信任策略與封裝兼容，未達要求時拒絕啟動。M0 的 PowerShell Authenticode 查詢僅是本機研究，產品無 shell fallback。
- CLI 行程可依正常官方機制讀取自身配置。Main 的 RPC allowlist 不等同子行程的網路沙箱。M2 應用隔離測試 profile 追蹤啟動及退出副作用，檢查設定覆寫、MCP 或其他啟動背景行為。若無法證明符合網路與資料邊界，暫不開啟真實 CLI 整合。已具同一使用者權限的惡意程式可置換檔案，驗證與啟動之間仍有競態，應縮短驗證到 spawn 的時間並拒絕不明來源。 [Electron 安全準則](https://www.electronjs.org/docs/latest/tutorial/security) · [Codex 遙測設定](https://learn.chatgpt.com/docs/config-file/config-advanced#observability-and-telemetry)

M2 必須同時驗證 Authenticode 信任鏈、預期 OpenAI 發行者，以及實際啟動映像與已驗證檔案的身分一致（包含檔案置換競態）。候選路徑或版本字串不足以識別映像。未能確認時拒絕或立即終止子行程，且不得使用其 stdio。實作及實機驗證留在 M2。

## M1 已實作的邊界

開發與正式入口都使用本機建置產物、同一份 CSP 與相同 Electron sandbox 設定。沒有 dev server 或開發環境專用安全例外。Playwright 只在測試啟動時加上其本機偵錯參數。測試 fixture 只在 tests 目錄，應用程式入口永遠回報來源不可用。
