# Portable 封裝審查 F-13 至 F-15

## F-13 產物信任

| 證據 | 能驗證的事項 | 仍需單獨驗證 |
| --- | --- | --- |
| ASAR 白名單、fuses、Portable smoke | staging 應用內容、內層 EXE 強化，以及實際解包的 EXE、ASAR、NSIS helper 和 staging 的一致性 | 外層 EXE 的發布者與建置來源 |
| SHA-256 | EXE 是否逐位元組符合獨立取得的預期 digest | 同一來源可替換 EXE 和 sidecar。信任來自校驗值散布渠道或所驗證的 attestation |
| Authenticode | Windows 簽章有效且簽署憑證符合預期發行者 | 應另外核對建置來源與 commit。本機 Portable 外、內層 EXE 均未簽署 |
| GitHub artifact attestation | digest 是否綁定到預期 repository、workflow、commit、事件與 runner 資訊 | Windows publisher 身分、原始碼安全和可重現性仍須各自確認 |

建議以手動 `workflow_dispatch` 試行 provenance，只允許經審查的 `main` ref。Windows build job 使用 `contents: read`，checkout 停用憑證保存，所有第三方 action 固定完整 SHA。用 `npm ci`、audit、Portable 封裝驗證和 smoke 建出指定檔名，只將 EXE 和 SHA-256 sidecar 上傳至同次 Actions run 的短期 artifact。獨立 attestation job 只下載該次 build 的 immutable artifact，獨立驗證 SHA-256，對同一 EXE 產生 provenance。該 job 才授予 `id-token: write`、`attestations: write` 和所需的 `contents: read`。現有 PR CI 維持唯讀，無需 `contents: write`、`packages: write`、簽署密鑰或發行步驟。 [GitHub artifact attestation 指南](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)

啟用前確認 repository 可見性與 plan。GitHub 的 private/internal attestation 需要 Enterprise Cloud。公開 repository 的 Actions artifact 可能可由具存取權的訪客下載，啟用上傳前須先確認散布範圍。驗收需用 `gh attestation verify <exe> --repo nijason7789/TokenDashboard` 搭配 `--signer-workflow`、`--source-ref refs/heads/main`、`--source-digest` 鎖定預期 workflow、ref 與 commit，另用副本驗證 digest 不符會被拒絕。此次只完成方案評估，尚無 attestation、遠端 workflow 執行或發布。 [Attestation 信任模型](https://docs.github.com/en/actions/concepts/security/artifact-attestations)

## F-14 Smoke profile 清理

Smoke 只建立由腳本命名的 GUID 暫存目錄。子行程回收後，由 `finally` 核對絕對路徑、直屬暫存父目錄及根目錄 reparse 屬性，再由下往上刪除。遇到巢狀 junction 時只移除連結本身。沒有自訂 profile 路徑或刪除舊 profile 的入口。只保留例外與驗證結果供診斷。若清理遭鎖定或根目錄被置換，驗證回報失敗，不嘗試改用其他路徑。清理回歸驗證成功、失敗及 junction 目標保持完整。

## F-15 minimatch override

`app-builder-lib@26.18.0` 的檔案 matcher 要求 minimatch 10.x，`@electron/universal@2.0.3` 要求 9.x。這兩個 major 的既有解析落在 [glob 放大 DoS 公告範圍](https://github.com/advisories/GHSA-g3hv-75wg-m249)，鎖檔透過 npm overrides 讓兩條路徑都使用 11.0.9。舊的 3.x、5.x 不在該 override 範圍。Windows 封裝實際執行 `Minimatch`，打包後驗證允許及排除項目。Universal 的 macOS 路徑使用 `minimatch()`，Windows 驗證未覆蓋該路徑。

查詢到的 v26 更新 `26.18.1` 仍指定 minimatch `^10.2.5` 與 `@electron/universal@2.0.3`，後者仍指定 minimatch `^9.0.3`。只有上游宣告範圍能在無 override 的乾淨鎖檔解析到公告修補版本，且兩條路徑的實際版本、完整 audit、Windows 封裝白名單、fuses 與 Portable smoke 都通過時，才移除 override。若未來新增 macOS universal 產物，還需驗證其打包流程。此次保留現有修補和鎖檔。

## 本機驗證

Windows 10 x64 的 lint、typecheck、231 項單元與整合測試、coverage、3 項 Electron E2E、build、Portable 封裝、ASAR／六項 fuses 驗證及標準／production npm audit 都通過。行覆蓋率 94.57%，分支 87.76%。在本機以錯誤 digest 驗證，`verify:package` 正確失敗且保留原樣的 sidecar。真實 Portable 視窗正常啟停，實際解包檔案比對通過，退出後未剩下本次新建的 profile。重建 EXE 的 SHA-256 為 `8952e3afe911c10094167f4d47c3588a2a27d21b5e6cb04499b1df0403c72301`。
