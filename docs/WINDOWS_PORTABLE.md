# Windows Portable 本機封裝

以 Node.js 24、npm 和 Windows x64 執行：

```powershell
npm ci
npm run package:windows
npm run verify:package
./scripts/smoke-portable.ps1
Get-FileHash release/CodexQuotaMonitor-0.1.0-windows-x64-portable.exe -Algorithm SHA256
Get-AuthenticodeSignature release/CodexQuotaMonitor-0.1.0-windows-x64-portable.exe
```

封裝指令建置 Windows x64 Portable 目標並固定使用 `--publish never`。首次建置需下載 Electron、NSIS 與 7-Zip 工具。受限開發環境可將 `ELECTRON_BUILDER_CACHE` 與 `ELECTRON_CACHE` 指向可寫入的本機目錄。

`release/` 是本機輸出。交付候選是 `CodexQuotaMonitor-0.1.0-windows-x64-portable.exe` 與旁邊的 `.sha256`。校驗值用於比對同一檔案的完整性。驗證腳本拒絕 ASAR 中的未知檔案、缺少的 bundle、symlink 或 unpacked 項目，並檢查內層 EXE 的六個 Electron fuses。允許項目只有主進程、Preload、Renderer HTML、各一個雜湊命名的 JS 和 CSS 及套件 manifest。測試、fixture、開發設定、原始碼、憑證和會話記錄均在 allowlist 之外。Electron Builder 開啟 Windows 內嵌 ASAR 完整性校驗並停用 ASAR 之外的 app 載入路徑。ASAR 外的 resources 只允許封裝器附帶的 NSIS `elevate.exe`。Portable schema 未提供移除該 helper 的設定，啟動器仍使用 `RequestExecutionLevel user`。參見 [Electron fuses 設定](https://www.electron.build/docs/tutorials/adding-electron-fuses/)與 [ASAR 完整性](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)。

Portable 以目前使用者權限解包至每次啟動獨立的暫存目錄，父程序等待 Electron 結束後清除解包目錄。偏好使用 Electron 的 Windows `userData`，預設在目前使用者 roaming AppData 下的應用程式目錄。Windows 的寫入權限取決於 DACL 繼承。請在自己的使用者目錄執行，且在共用或重新導向的 AppData 環境先檢查 ACL。[Electron userData 路徑](https://www.electronjs.org/docs/latest/api/app#appgetpathname)。Portable 使用 `PORTABLE_EXECUTABLE_FILE` 標記，Main 拒絕變更 Windows 登入啟動設定，直到外層路徑語意獲獨立驗證。

Smoke 腳本須從可以顯示視窗的 Windows 工作階段執行。它用獨立暫存 userData、比對執行中抽出的 EXE 和 ASAR 與已驗證的 staging payload、檢查 ACL 和偏好寫入，再正常關閉視窗及核對程序和解包目錄清理。ACL 檢查查找 Everyone、Authenticated Users 和本機 Users 群組的廣泛寫入許可，其範圍限於測試目錄、偏好檔及執行時解包目錄。Electron 設定與安全邊界另由既有 Playwright 和單元測試覆蓋。

## 公開發行前人工驗收

- 在獨立 Windows 10 和 11 標準使用者環境執行封裝與 smoke。用預設 userData 啟動、重開並確認偏好留在使用者 AppData，檢查檔案與目錄 ACL、登錄啟動項，以及重啟後解包清理。
- 在一個含空格的唯讀目錄執行，移動和重新命名外層 EXE 後重試。驗證單一執行個體、Tray 退出、混合 DPI 和 Windows 通知。
- 發行前確認外層 Portable 與內層改寫後 EXE 的 Authenticode 與預期簽署者，並在簽署後重算 SHA-256。此本機組建明確停用簽署，僅供本機驗證。
- 額度整合仍受 [M2.4 安全可行性與驗收條件](M2_4_THREAT_MODEL.md) 約束。無帳號的封裝測試可獨立重現。

## 本機驗證結果

- Windows 10 x64 build 19045，Node 24.18.0，Electron 45.4.1。Portable 封裝與獨立驗證通過。外層檔案 110,386,593 bytes，SHA-256 為 `b900e8d76aa2b14de63d5c0225bad3690d81510f3af8dc32c400b10d6fed4ab1`。外、內層 Authenticode 均為 `NotSigned`。
- 外層 EXE 成功開啟視窗。執行中解包的 EXE、ASAR、NSIS helper 雜湊與 staging 相符。隔離 userData 與解包目錄通過廣泛寫入 ACL 檢查，視窗 bounds 寫入偏好檔，launcher 正常退出。清理曾在 launcher 結束後短暫尚未可見，最終 smoke 以 10 秒為觀察上限並通過。當前 roaming AppData 父目錄也未發現上述群組的廣泛寫入許可。獨立 Windows 11、預設 profile 下的實際偏好寫入和企業重新導向 ACL 仍待人工驗證。
- 通過 lint、typecheck、231 項單元／整合測試（含 6 項新 ASAR 測試）、3 項 Playwright Electron E2E、build 和完整／production npm audit。現有應用程式 coverage 範圍為 `src/`，行覆蓋率 94.57%，分支 87.76%。
- 封裝工具原帶有 [minimatch glob 放大 DoS](https://github.com/advisories/GHSA-g3hv-75wg-m249)。建置依賴的 9.x／10.x 請求使用 npm override 鎖定至 11.0.9，並以實際 Windows 封裝驗證。兩個 audit 均回報零漏洞。安裝仍有上游 deprecated 工具與未執行的 Squirrel install script 提示，本次只建置 Portable。
