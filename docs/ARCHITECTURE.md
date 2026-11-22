# 架構

```text
React renderer ←→ sandboxed preload ←→ Electron main
                                            ├─ settings / window / tray / notifications
                                            └─ quota monitor → Codex client → bounded stdio → codex.exe
```

| 邊界 | 職責 |
| --- | --- |
| `src/shared` | IPC DTO、設定與狀態型別、純倒數函式。排除 Electron、Node 和原始 RPC 型別。 |
| `src/main/codex` | 可信執行檔解析、spawn、JSON 行分幀、請求配對、固定方法、握手與 runtime schema 驗證。額度 parser 保留 bucket 身分，再依各自長度正規化視窗。不同 bucket 的相同長度各自保留。 |
| `src/main/services` | Polling、推送協調、重連、Stale、通知去重。依賴可替換的 client 與時間來源。 |
| `src/main` | 組裝服務與生命週期。持有視窗、Tray、設定持久化、啟動項與 IPC 驗證。 |
| `src/preload`、`src/renderer` | Preload 暴露固定 API，事件回傳取消訂閱。React 只處理顯示、互動及視窗可見時的本機倒數。 |

## 更新與生命週期

- Main 持有唯一 monitor，存取正規化後的 quota DTO、最近成功時間和狀態。狀態區分 Connecting、Connected、Disconnected、缺 CLI、需登入、不支援帳號及不相容 CLI。已有成功值而後續失敗時附加 Stale，保留原成功時間。
- 用自排程 timeout，在任務結束後安排下一次。預設 60 秒，提供 30／60／120／300。手動更新共用在途 promise，推送共用排程且連發合併。初始建議為每 RPC 10 秒、退避 2／4／8／16／30 秒上限。達上限後以設定的正常間隔再試。成功即清除失敗計數。缺 CLI 或不相容狀態等待下次手動 refresh 或重新啟動。
- 正常 polling 使用同一子行程。Crash 或 timeout 先結束舊連線並清空 pending，再建立新行程及重做握手。Quit 停止排程、清除 IPC 訂閱與計時器，關閉 stdin，限時等待退出，必要時終止並驗證回收。隱藏到 Tray 時保持 polling。

## 桌面與本機狀態

- 無框可拖曳、可 resize 的小型深色視窗。一般模式顯示剩餘與已用標籤、實際重置時間、倒數、狀態及最後成功時間。Compact 保留額度、進度條、倒數與操作入口，Stale 仍可辨識。進度條以剩餘量著色，≥50 綠、≥20 黃、<20 紅、未知灰。
- 使用 Electron DIP 和各 display 的 work area 修正保存的視窗 bounds。啟動及 display 新增、移除或 DPI 變更時重算。設定原子寫入每使用者的 `userData`，讀取時逐欄驗證。Windows 開機啟動預設關閉，portable 啟動項需指向穩定的外層 EXE。
- Tray 支援顯示／隱藏、刷新、置頂、Compact、設定、退出，tooltip 可顯示已知剩餘量。視窗最小化轉 Tray，關閉轉 Tray 由設定控制。置頂、透明度與百分比模式由 Main 套用或發送同一份設定快照。
- 低額度通知以 Canonical bucket、視窗長度與有效 reset timestamp 作區間鍵。只對新鮮、可識別區間通知一次，重置後新區間可再通知。允許持久化兩個非敏感去重鍵，使重開也不會重複，同一區間百分比反彈不解除去重。

## M1 來源隔離

正式入口只組裝正式來源。M1 無正式 quota provider，顯示來源不可用。測試 fixture 只能由測試入口引入，禁止透過執行環境或 IPC 在正式入口切換為 mock。
