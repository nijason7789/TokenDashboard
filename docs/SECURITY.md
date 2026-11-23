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

M2.1 選擇 Windows 內建 PowerShell 作獨立驗證程序。固定程式碼以無 profile、非互動方式執行，資料經 stdin 傳入，CLI 由 Node 以固定參數與 `shell:false` 啟動。系統 PowerShell 與 Windows 憑證信任鏈屬於信任邊界。為固定路徑與核對檔案身分，驗證程式以系統 .NET 編譯固定 Win32 互通宣告呼叫 `CreateFileW` 和 `GetFileInformationByHandle`。此方案不需 npm native addon 或隨產品封裝 DLL，但系統政策必須允許 PowerShell `Add-Type`。直接以封裝的原生 helper 呼叫 WinTrust／CreateProcess 可提供更強的啟動前控制，但需維護、簽署及封裝各架構執行檔。固定官方 hash 清單則需隨 CLI 更新，且仍須比對實際映像。

- 直接啟動簽章已驗證的原生 EXE 可符合無 shell 要求。npm 發行也可定位架構對應的官方 vendor EXE，避免執行 shim 或載入外部 Node 程式。兩支本機候選檔均回報 Authenticode Valid，簽署者為 OpenAI OpCo, LLC。版本查詢僅用於相容性判斷。 [官方 npm launcher](https://raw.githubusercontent.com/openai/codex/main/codex-cli/bin/codex.js) · [Node Windows shell 限制](https://nodejs.org/api/child_process.html#spawning-bat-and-cmd-files-on-windows)
- M2.1 由系統 PowerShell 的 `Get-AuthenticodeSignature` 檢查 `Valid` 與 signer certificate。憑證須具預期的 OpenAI OpCo, LLC 主體名稱與組織，允許相同身分的正常憑證輪替。Windows 信任設定和憑證撤銷可用性仍影響判定。驗證程序無結論或逾時時拒絕啟動。
- CLI 行程可依正常官方機制讀取自身配置。Main 的 RPC allowlist 不等同子行程的網路沙箱。M2 應用隔離測試 profile 追蹤啟動及退出副作用，檢查設定覆寫、MCP 或其他啟動背景行為。若無法證明符合網路與資料邊界，暫不開啟真實 CLI 整合。已具同一使用者權限的惡意程式可置換檔案，驗證與啟動之間仍有競態，應縮短驗證到 spawn 的時間並拒絕不明來源。 [Electron 安全準則](https://www.electronjs.org/docs/latest/tutorial/security) · [Codex 遙測設定](https://learn.chatgpt.com/docs/config-file/config-advanced#observability-and-telemetry)

驗證程式從根目錄向下取得不共享 delete 的祖先目錄控制代碼，拒絕 reparse point，再唯讀鎖住 PE 檔案以拒絕寫入及刪除。確認 PE executable bit、排除 DLL 並核對機器架構。保持鎖直到從新行程 PID 查詢 OS 的模組路徑，重開此路徑比對 volume/file index 與 SHA-256。驗證快照失敗時立即終止子行程，stdio 不交給 RPC 層。

此順序縮小 TOCTOU 窗口，但 Node spawn 無暫停載入能力，行程可能在比對前執行初始化。OS 回報的映像路徑與鎖住的磁碟檔驗證並非行程映射區段的原子驗證。仍信任 OS、檔案系統及本機信任庫，無法保護已受控制的 OS 或具有同等帳號權限的行程注入。當前版本限系統根為 `C:\Windows` 的 Windows x64／ARM64，拒絕無法使用系統 PowerShell 或 `Add-Type` 的環境。啟動 cwd 固定為系統目錄，僅繼承驗證過的 profile 與 temp 目錄變數。自訂 CODEX_HOME、PATH、API key、代理或端點環境變數未傳入。

本機非 Codex 驗證使用 Windows 內建二進位，觀察到有效簽章但不同發行者的拒絕。另以只在測試程序中接受該 Microsoft 發行者的腳本副本，確認系統 API 可核對該 fixture 的行程與檔案身分。本機探查僅限系統磁碟，跳過一般 junction，再由驗證程序檢查全部路徑控制代碼。獨立審查後已用空白 profile 驗證官方 CLI 的啟動與身分比對，數據見 [隔離測試紀錄](IMPLEMENTATION_PLAN.md#獨立審查後的未登入隔離測試)。Windows 11 與 ARM64 尚未驗證。 [Microsoft Authenticode 文件](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-authenticodesignature?view=powershell-5.1)

## 獨立審查 F-01 與 F-03

啟動期間保留祖先目錄與映像檔控制代碼，且在驗證 PID 對應的模組路徑、volume/file index 與 SHA-256 後才把 stdio 交給 RPC。任何不符、存取被拒或無法確認均停止，已啟動的行程立即終止。實務上優先使用由受信任使用者或管理員維護、可取得全部控制代碼的本機安裝；候選路徑與雜湊變更時須重新核對。Node 啟動到映像檢查之間仍能執行初始化，檔案鎖也不能防禦已控制作業系統或同帳號行程注入。若部署要求在執行第一條指令前完成映像驗證，需另案評估暫停建立行程或使用 OS 執行政策，本階段維持現有依賴與信任要求。

相容環境為使用 `C:\Windows` 的 Windows x64／ARM64 與內建 Windows PowerShell 5.1，需允許 `Add-Type`、可寫入本機暫存資料夾，且執行帳號需能開啟候選檔與每層祖先目錄。Windows 10 x64 為本機驗證環境，Windows 11／ARM64 尚未驗證。其他系統根會回報驗證不可用。無可用候選時回報找不到執行檔。驗證程式、存取權限、簽章或發行者任何一項失敗，一律回報無法建立信任；啟動後身分不符則回報映像無法驗證。錯誤不附路徑或原始 stderr，也不切換至 shim 或較弱的驗證方式。

## App Server 啟動網路調查（499091b）

- **來源。** 對照已測 Windows CLI 的 `rust-v0.171.0-alpha.13`，App Server 建立 message processor 時會啟動 plugin startup tasks。Plugins 預設啟用，未登入時無可用的遠端全域目錄，因而啟動 `plugins-curated-repo-sync`。該工作先執行 `git ls-remote https://github.com/openai/plugins.git HEAD`，Git 可產生 `git-remote-https`。Git 失敗後嘗試 GitHub API，沒有本機快照時還可嘗試 OpenAI 的 curated export。Git 使用 Codex home 下的暫存 repo。這是該版本官方原始碼中的預設行為，App Server 的帳號與額度協定文件沒有承諾啟動期間不連網。 [App Server 啟動](https://github.com/openai/codex/blob/581161ab41e643d942e1e1b5f561034060bf18e3/codex-rs/app-server/src/message_processor.rs#L591-L610) · [啟動條件](https://github.com/openai/codex/blob/581161ab41e643d942e1e1b5f561034060bf18e3/codex-rs/core-plugins/src/manager.rs#L923-L949) · [Git 與 HTTP fallback](https://github.com/openai/codex/blob/581161ab41e643d942e1e1b5f561034060bf18e3/codex-rs/core-plugins/src/startup_sync.rs#L96-L165)
- **支援的控制。** 空白 profile 的 `config.toml` 使用 `[features]` 下的 `plugins = false`。Launcher 現使用文件支援的單一行程覆寫 `-c features.plugins=false`，不必更動使用者設定。此開關會一起略過 curated sync 與已設定 marketplace 的啟動工作。只關閉 `remote_plugin` 不能阻止本機 curated fallback，遙測與更新設定也各有不同管轄範圍。沒有採用 debug-only flag 或內部環境變數。 [CLI 設定與 feature 選項](https://learn.chatgpt.com/docs/cli/reference) · [版本固定的啟動 gate](https://github.com/openai/codex/blob/581161ab41e643d942e1e1b5f561034060bf18e3/codex-rs/core-plugins/src/manager.rs#L3139-L3163)
- **Windows A/B。** 使用相同的簽章驗證、映像身分檢查、空白 profile、stdio 參數和臨時 Git 設定。測試代理只在 loopback 接收與拒絕 HTTP `CONNECT`，不轉送。預設設定收到對 `github.com:443`、`api.github.com:443` 與 `chatgpt.com:443` 的請求，與原始碼中的回退順序一致。停用 plugins 時觀察窗內未收到代理請求。兩組握手及一次未登入狀態讀取均成功，行程退出碼為 0。前次 `127.0.0.1:1` 是測試指定的代理／端點，不能從該 TCP 位址單獨確定遠端目的地。Windows A/B 驗證的是應用層代理行為，Windows Sandbox 啟動程式不存在，桌面帳號也無管理員防火牆權限。
- **OS 隔離交叉驗證。** Ubuntu WSL 中使用同版官方 Linux x64 App Server 發行檔，下載後先核對發行頁的 SHA-256。以 `unshare` 建立獨立 network 與 PID namespace，只有 loopback、無 IPv4 路由，對 TEST-NET 位址的 probe 由核心回報 `ENETUNREACH`。預設組的臨時 Git Trace2 記錄 3 次 Git 啟動並出現指定 marketplace 查詢，停用 plugins 組為 0 次。兩組均完成未登入握手及帳號狀態查詢，退出碼為 0。只保留計數，測試後刪除臨時資料。此結果覆蓋同版 Linux 發行檔，Windows 實際映像的 OS egress 驗證仍待完成。 [官方發行檔與校驗值](https://github.com/openai/codex/releases/expanded_assets/rust-v0.171.0-alpha.13)
- **額度監視器風險。** 預設啟動的 Git、遠端目錄 HTTP 與快取寫入皆與唯讀額度需求無關。這會增加外連、遠端輸入與子行程的範圍，亦可能受系統 Git 設定、代理或管控政策影響。未觀察到資料傳出或已登入操作。停用 plugins 可縮小已確認的範圍，但 RPC 白名單和 feature flag 都無法強制管制其他背景網路流量。未來若核准正式 launcher，先評估以行程層覆寫停用 plugins，並在可稽核 egress 規則下重新確認 exact Windows binary 的行為。意外連線與管理政策覆寫仍須納入驗收。

## M1 已實作的邊界

開發與正式入口都使用本機建置產物、同一份 CSP 與相同 Electron sandbox 設定。沒有 dev server 或開發環境專用安全例外。Playwright 只在測試啟動時加上其本機偵錯參數。測試 fixture 只在 tests 目錄，應用程式入口永遠回報來源不可用。
