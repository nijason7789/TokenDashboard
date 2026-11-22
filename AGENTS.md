# Codex Quota Monitor

- M4 已授權以 mock 開發，M5 待審查。M2.4 暫緩，未驗證 Windows OS 層外連隔離前禁止真實帳號或 App Server 請求。各里程碑以 [實作計畫](docs/IMPLEMENTATION_PLAN.md) 為準。
- 目標是 Windows 10／11 個人用 Electron 懸浮額度監視器。使用 React、TypeScript strict、Vite、npm 與原生 CSS，維持最少依賴。
- 依 [協定](docs/PROTOCOL.md) 驗證實際 CLI 版本的 schema。僅允許四個固定 outbound 方法，所有認證交由已安裝的官方 Codex。禁止自行讀取憑證、會話、專案資料或改用 HTTP 查詢。
- 依 [安全設計](docs/SECURITY.md) 維持原生執行檔信任驗證、無 shell 啟動、Electron 隔離與 IPC 驗證。遇到重要安全或技術決策，先列方案、影響與建議。
- 依 [架構](docs/ARCHITECTURE.md) 隔離 process、transport、domain 與 UI。核心邏輯先寫測試，時間測試使用 fake timers。CI 與日常測試只用 mock，真實帳號 smoke test 需使用者明確同意。
- 主 agent 負責主要開發、整合及驗證。簡單任務自行處理，只有並行能明顯改善速度或品質時才分派不同範圍。通常每項任務最多兩個 subagents，禁止巢狀委派，除使用者指定外沿用預設模型及推理設定。
- 每個里程碑回報完成項目、變更檔案、實際驗證結果、安全考量、已知問題與下一步。未執行的測試、未量測的效能及未驗證的平台需明確標示。
- 正式入口不可引用測試 fixture 或在錯誤時切換成 mock。保留 bucket 身分，視窗長度只在各 bucket 內分類。
