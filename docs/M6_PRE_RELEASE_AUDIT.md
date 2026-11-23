# M6 發行前稽核

基線 `4205794`。範圍為 Windows x64 本機、隔離 Electron userData、無登入模擬測試。正式額度來源維持不可用。此稽核不授權發行或 M2.4。

## 審查結果

| 嚴重度 | 項目 | 結果 |
| --- | --- | --- |
| 中 | F-10 通知狀態提交 | 通知 policy 先計算候選狀態，持久化成功後才更新記憶體及交付通知。偏好儲存也只在 rename 成功後更新已提交的雜湊狀態。失敗後同一尚未過期的窗口在下一次刷新仍可通知。測試涵蓋寫入失敗、同時重試、重啟去重及不同 bucket。 |
| 低 | F-11 Windows 啟動 | 開發版本及標示為 Electron Builder Portable 的行程拒絕修改啟動項。一般封裝版以目前可執行檔的絕對路徑及空參數寫入，並以相同值讀回。測試 mock 開機 API，未寫入實際 Windows 設定。 |
| 低 | F-12 設定競態 | 設定面板與工具列的置頂及 Compact 共用寫入鎖。寫入期間停用衝突控制，完成後恢復。Tray 切換會在序列寫入佇列中依最新設定計算。回歸涵蓋雙向競態、失敗後重新操作及連續 Tray 切換。 |
| 中 | CI Action pin | 原 `setup-node` SHA 不完整。兩個 job 均改用由官方標籤核對的 40 字元 `v6.3.0` SHA，並新增依賴稽核。遠端工作流程未執行。 |
| 中，發行阻擋 | Windows Portable | 儲存庫尚無正式 Portable 封裝配置、產物 allowlist、簽署或發布用檔案校驗流程。本輪的 unpacked 測試與 Vite build 不能驗證 Portable 封裝。 |
| 低，待驗證 | 使用者資料與退出 | `0o600` 不是 Windows DACL 設定。需在安裝環境檢查 userData 繼承權限。讀取偏好後才檢查尺寸，過大的本機檔可造成短暫資源壓力。退出等待本機檔案 I/O，長時間無回應的檔案系統可能延遲退出。 |
| 低，剩餘風險 | 通知交付 | 偏好寫入失敗可在下一次刷新恢復。若程序在原子提交成功後、顯示通知前崩潰，該則通知可能遺失。此順序有意避免重啟後重複提醒。 |

## 邊界與供應鏈

- Main 的本機 asset allowlist、CSP、權限拒絕、導覽及新視窗封鎖持續生效。Renderer 使用 context isolation 和 sandbox，Node integration 關閉。Preload 僅公開固定操作與經驗證、可卸訂的事件，沒有通用 IPC、檔案或行程 API。
- IPC handler 比對目標 WebContents、頂層 frame、精確 URL 及參數。額度 DTO 排除 bucket ID 與原始 RPC metadata。偏好只保存驗證過的設定、DIP bounds 與通知雜湊，與帳號資料分離。
- Tray 單一執行個體、關閉轉隱藏、退出銷毀與 listener 清理均納入測試。Mock App Server 子行程測試覆蓋逾時、崩潰、晚到回覆及 provider 未釋放時禁止替換。應用程式建置入口仍未載入 App Server 或 mock provider。
- Lockfile v3 有 248 個記錄，247 個 resolved 項目均具 integrity，唯一 registry host 為 `registry.npmjs.org`。Electron 鎖定 45.4.1。CI 以 `contents: read`、停用 checkout 憑證持久化、完整 SHA 和無真實帳號資料的 runner 執行。
- 整體覆蓋率達成目前的本機基線，但 CI 尚無覆蓋率門檻。低覆蓋部分包括 Preload 的防禦性分支和舊 Windows verifier adapter，E2E 也不取代逐一檢查不合法 payload 或已安裝環境。

## Portable 人工驗收與發行門檻

1. 在 Windows 10／11 的獨立使用者環境產出並檢查檔案 allowlist、ASAR 內容、Electron fuses、簽署及雜湊。排除測試 fixture、憑證、設定及來源環境資料。確認 userData 權限只依受信任的使用者／系統 ACL 繼承。
2. 若要支援 Portable 登入啟動，確認外層啟動檔身分與固定位置。驗證登錄的完整路徑與參數確實指向外層 executable，不能使用臨時解包路徑。測試預設關閉、啟用後登出／登入、單一 Tray、明確退出與停用後不再啟動。
3. 測試重新命名或移動 Portable executable。驗證舊路徑不會被靜默復用，批准新位置後可重新註冊並再次登入驗證。未完成前 Portable 啟動項維持拒絕。若較舊開發版本曾註冊來源工作目錄，應在人工驗收中確認既有項目已由使用者移除。
4. 在隔離裝置驗證實體混合 DPI、顯示器拔除、Tray 操作、Windows 通知橫幅，以及長時間 idle／使用週期的記憶體與 handle。封裝與手動項目未完成前維持 **NO-GO**。

## 本機驗證

- `npm ci`、`npm run lint`、`npm run typecheck`、`npm run test`、`npm run test:coverage`、`npm run test:e2e`、`npm run build` 與 `npm audit` 通過。Vitest 17 個檔案共 225 個測試，Windows Electron E2E 3 個測試。整體 branch 87.76%、line 94.57%，設定儲存 branch 92.68%、通知 branch 100%。npm audit 回報 0 個已知漏洞。
- 複製鎖定版本 Electron runtime，僅加入 app manifest 與本機 dist 檔案，在臨時 unpacked Windows x64 檔案結構驗證 `app.isPackaged === true`。隔離 userData 中確認啟動項預設關閉、正式來源不可用，未呼叫啟動項寫入。此測試未建立 NSIS Portable 產物。
- 30 秒與 120 秒兩輪取樣各完成 40 次視窗隱藏／恢復、100 次狀態讀取，Electron 各觀察到四個行程。120 秒總 working set 為 307,808–312,432 KiB，最後為 311,296 KiB，主行程 handle 始終為 88，CPU 樣本為 0–1.13%。兩輪皆 exit 0，所有已取樣 PID 均結束，臨時檔案已移除。此結果涵蓋隔離的桌面生命週期，多小時 idle、未取樣的短命行程及真實 Codex 行程仍未驗證。

## Authenticated M2.4 的阻擋條件

Windows active firewall profiles 先前測得預設 AllowOutbound，且沒有驗證能拘束指定 Windows Codex executable 及其子行程的 deny-by-default egress。先前 WSL 隔離測到的是 Linux 同版執行檔。Windows 的 loopback 代理與 `features.plugins=false` 分別驗證路由與插件控制，均不能代替 OS 層隔離。

恢復測試前須在同一隔離的 Windows 環境證明非允許目的地遭拒，且官方帳號與額度端點仍可達。再核對指定 executable 的簽章、發行者、實際啟動映像與固定 `features.plugins=false`，並依當時的帳號授權只進行各一次允許的唯讀請求。未達這些條件時禁止執行。

[官方 setup-node v6.3.0](https://github.com/actions/setup-node/releases/tag/v6.3.0) · [Electron 登入項](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows) · [Electron Builder Portable](https://www.electron.build/docs/nsis/)
