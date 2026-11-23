# M2.4 安全可行性評估

評估日期為 2026-11-23，基線為 `82db9f1`。本文件提供下次安全審查的決策依據，現行 Windows OS 層外連限制與個別帳號授權要求持續有效。此次僅檢查原始碼與官方文件，沒有啟動 Codex、存取帳號、讀取憑證或修改系統網路設定。

## 保護目標與信任範圍

額度監視器須防止 Renderer 或不可信 IPC 變成任意 RPC、命令、檔案或帳號操作。固定的唯讀方法、參數驗證、stdio 與 Electron 邊界直接控制這些風險。官方 App Server 仍是使用者權限下的獨立程式，可能讀取自己的設定、維護認證、寫入本機狀態或執行啟動工作。RPC 白名單無法控制這些內部行為。

若威脅包含「已簽章的 CLI、依賴、使用者設定或啟動工作遭入侵後嘗試任意外傳」，須有獨立於該程式的 OS 或網路控制，才能驗證外連受限。若明確信任官方 CLI 與使用者環境，嚴格目的地白名單可改為額外的縱深防護，但這會擴大被接受的風險。本專案目前仍採前者。變更到後者需要使用者明確核准政策與剩餘風險。

現有簽章、預期發行者、檔案鎖及啟動映像核對可降低偽造 executable 與置換風險。Node 啟動至映像核對之間仍可能執行初始化，且無法防止已控制 OS 的攻擊者或同帳號行程注入。網路控制則可限制目的地，無法保證允許的官方端點不接收超出意圖的資料。既有 [安全設計](SECURITY.md) 與 [固定方法](PROTOCOL.md) 仍須一起成立。

## 可行方案

| 方案 | 可驗證的保護 | 必要條件與限制 | 此專案評估 |
| --- | --- | --- | --- |
| 獨立 Windows VM 與 egress 政策 | 可把指定 Windows binary、其子行程與主機個人檔案隔離。VM 外側的網路閘道能在程式之外阻擋未允許流量。 | VM 本身要限制 host share、剪貼簿及憑證暴露。NAT 或虛擬交換器本身不會自動產生目的地白名單。需驗證 IPv4、IPv6、DNS、代理及子行程均受控。 | 建議作為首次 authenticated smoke 的環境。由受信任操作人員先配置與驗證，App 不要求管理員權限。 |
| 專用標準 Windows 使用者 | 依 Windows ACL 減少主使用者專案、會話與其他資料暴露，可用官方 CLI 在該使用者內獨立登入。 | 標準使用者與 profile 分離本身不限制外連，也不等於 AppContainer。ACL 必須實測。App 不應複製主帳號認證到另一個 profile。 | 可配合 VM 或 egress 政策使用，單獨使用尚不能滿足現行網路條件。 |
| AppContainer／LPAC | OS 依 package SID、capability 與 DACL 限制檔案、registry、行程和網路資源。沒有網路 capability 時可阻擋網路。 | `internetClient` 是網路類別權限，仍需額外目的地控制。CLI、PowerShell verifier、stdio、認證儲存及子行程相容性尚未驗證。需原生建立行程與權限配置，改動顯著。 | 可列為未來研究，當前沒有可交付或已驗證的方案。 |
| 簽章 CLI、固定參數、唯讀 RPC 與最小環境 | 限制本 App 可發送的操作，並驗證將執行的來源及映像。無需新增 VM 或原生 sandbox。 | CLI 仍具該使用者的權限與原生網路能力。簽章不能證明完全無漏洞、無背景流量或無供應鏈風險。 | 對個人用途有實務價值，可作為另一種明確接受信任假設的政策。現行政策未授權此替代。 |
| Windows Sandbox 加網路開關 | 可拋棄測試環境，關閉 networking 可阻擋全部網路。 | 啟用 networking 會接到虛擬網路；開關本身沒有官方端點選擇性允許。預設剪貼簿與映射資料夾也需控制。 | 適合離線啟動測試。Authenticated 額度查詢仍需額外 egress 設計。 |
| HTTP proxy、封包觀察、WSL 或 Job Object | proxy 可限制使用該 proxy 的目的地，觀察可辨認行為，Job Object 可協助行程樹回收。WSL namespace 可隔離 Linux 行程。 | proxy 必須由 OS 強制禁止直接繞過，觀察工具只能提供事件證據。Linux 的測試不涵蓋 Windows 映像。Job Object 不提供目的地白名單。 | 可作為配套證據，不能單獨滿足當前 Windows 網路條件。 |

Microsoft 文件說明 Hyper-V 可使用外部、內部及私人交換器，AppContainer 依能力限制資源，Windows Sandbox 的 networking 設定提供啟用／停用選項。這些機制都需要具體配置與負向測試才能支持本專案的 egress 主張。 [Hyper-V 網路](https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/create-a-virtual-switch-for-hyper-v-virtual-machines) · [AppContainer 建立與能力](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer) · [Windows Sandbox 設定](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)

Job Object 能以一組行程管理資源與終止；子行程預設加入相同 job，breakaway 設定與其他建立方式仍影響覆蓋範圍。若未來加入此機制，需測試完整行程樹的歸屬與回收。 [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

## 建議模型與網路副作用

首次 authenticated smoke 採獨立 Windows VM、專用標準使用者、最少 host 資源共享、受控 egress 閘道，再沿用現有 executable trust 與固定 RPC。政策應針對這個 VM 或完整行程樹，避免只限制主 executable 而允許 helper 繞出。外部閘道可以避免在個人桌面上直接調整防火牆，但其配置仍須由使用者另外核准。

對使用主機的個人長駐監視器，可另外提出「信任已驗證官方 CLI，加上固定唯讀 RPC、停用無關功能、最小環境與可稽核網路觀察」的政策供審查。依目前已知的實作需求，全面目的地白名單不是防止本 App 發送 prompt 的唯一手段；它防護的是更廣的 CLI 內部行為。這項風險取捨應由使用者決定。本文件只提出選項。

已追查的 Git 與 HTTP 活動來自官方 curated plugin startup sync。先前空白 profile A/B 測試以 `features.plugins=false` 消除了觀察期內的相關 Git／proxy 行為。未來必須以 CLI override 停用，避免依賴使用者全域設定。目前 `src/main/codex/process.ts` 的固定參數尚未加入此 override，真實整合仍未接到正式入口，因此需要在 M2.4 審查時先修正並以 mock 驗證精確參數。Telemetry、更新檢查、管理政策、認證刷新或未來版本的新啟動工作仍須逐項核對。 [版本固定的 plugin gate](https://github.com/openai/codex/blob/581161ab41e643d942e1e1b5f561034060bf18e3/codex-rs/core-plugins/src/manager.rs#L3139-L3163) · [官方 CLI feature override](https://learn.chatgpt.com/docs/cli/reference)

若使用 proxy 作 egress 閘道，須同時阻擋直接 TCP／UDP、替代 DNS、IPv6 與非預期 proxy，並允許必要 DNS 與憑證驗證依賴。TLS CONNECT 主機名限制不等同 HTTPS path 限制。共享 CDN IP 也不能單獨證明目的地主機身分。避免為看見 request body 而進行 TLS interception 或保存帶認證 header 的內容。允許目的地應由指定 CLI 版本的官方來源與無帳號基線確立，再以可達性測試確認。Windows 顯式 block 與 allow 的優先序也須驗證，不能假定窄 allow 會覆蓋衝突 block。 [Windows Firewall 規則](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/rules)

## 未來 authenticated smoke 的驗收條件

以下各項均需要實際證據，且不自動授權測試。

1. 使用者核准指定 Windows 測試環境、安全模型及單次帳號操作。操作人員只用官方 CLI 準備登入，監視器、測試腳本及報告不讀取或搬移憑證、Cookie、Credential Manager 或會話記錄。
2. 記錄 CLI 版本、候選檔案 SHA-256、有效 Authenticode、預期 OpenAI publisher 與實際啟動映像核對結果。信任失敗、路徑置換、hash 不符、verifier 失效或身分無法確認時拒絕啟動，已啟動的行程立即回收。
3. 以當時本機產生的 schema 確認方法與參數仍相容。固定 arguments 必須含 `app-server --listen stdio://`、`-c features.plugins=false`、既有 analytics 與三類 OTel exporter 停用值。先驗證無帳號有效配置與精確參數，不修改使用者全域設定。管理政策若覆蓋必要值則停止。
4. 在空白 profile 下先證明 OS／閘道限制存在。相同 Windows executable、所有 helper 與子行程對未允許的外部位址、名稱與替代網路路徑皆無法連線；必要官方服務、DNS 與 TLS 憑證驗證仍可完成。證據應包括 active policy、拒絕測試及實際網路事件。維持 TLS 驗證，無憑證繞過。
5. 此無帳號基線不得出現無法解釋的 Git、plugin、更新、telemetry 或其他背景目的地。任何不符合都先調查，不能以 socket 快照沒有命中宣稱完整封鎖。
6. 經第 1–5 項審查後，依序只執行一次 `initialize` 與 `initialized`，一次 `account/read` 搭配 `refreshToken:false`，一次 `account/rateLimits/read` 搭配 `excludeResetCreditDetails:true`。只在帳號狀態符合預期時讀取額度，無重試、thread、turn、prompt、登入登出、點數重置或任意 server-request 回覆。
7. 只記錄認證狀態分類、bucket 是否可識別、視窗 duration／缺少／歧義、parser 成敗、延遲、非預期行程或目的地類別，以及回收結果。禁止持久化原始 RPC、stderr、實際額度百分比、帳號識別資訊、路徑或 token。只在記憶體處理必要回覆。
8. 成功或失敗均由 finally 關閉 transport 與 stdin，依既有有界終止流程回收 App Server、verifier 與已觀察子行程。驗證沒有待處理 timer、listener 或測試產物中的敏感資料。保留經清理的結果後刪除 VM 快照或測試 profile。

## 尚未驗證與剩餘風險

目前 Windows 的可選擇性 egress 限制、官方端點可達性、AppContainer 相容性、VM 登入及 live quota schema 行為均未完成驗證。已通過的 mock／離線測試不能替代這些條件。網路目的地限制本身也不能消除允許端點上的認證風險、已登入 CLI 的本機資料讀取，或已允許程式的供應鏈缺陷。現行 M2.4 保持暫緩，發行包繼續顯示 quota source unavailable。
