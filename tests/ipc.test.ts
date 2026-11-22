import { describe, expect, it, vi } from "vitest";
import { createStatusHandler } from "../src/main/ipc";
import { IPC_CHANNELS, RENDERER_URL } from "../src/shared/contract";

const mainFrame = { url: RENDERER_URL };
const owner = { mainFrame };
const read = vi.fn(() => ({ source: "unavailable" as const }));
const handle = createStatusHandler(owner, read);

describe("status IPC", () => {
  it("accepts only the owning top frame, exact URL and zero arguments", () => {
    expect(IPC_CHANNELS).toEqual({ status: "quota:status" });
    expect(handle({ sender: owner, senderFrame: mainFrame })).toEqual({
      source: "unavailable",
    });
  });

  it.each([
    [{ sender: { mainFrame }, senderFrame: mainFrame }, []],
    [{ sender: owner, senderFrame: null }, []],
    [{ sender: owner, senderFrame: { url: RENDERER_URL } }, []],
    [
      { sender: { mainFrame: { url: RENDERER_URL } }, senderFrame: mainFrame },
      [],
    ],
    [{ sender: owner, senderFrame: mainFrame }, [undefined]],
    [{ sender: owner, senderFrame: mainFrame }, [{ command: "test" }]],
  ] as const)("rejects invalid IPC", (event, args) => {
    read.mockClear();
    expect(() => handle(event, ...args)).toThrow("Unauthorized quota request");
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    "https://example.invalid/",
    RENDERER_URL + "#extra",
    RENDERER_URL + "?extra=1",
  ])("rejects a top frame at %s", (url) => {
    const frame = { url };
    const sender = { mainFrame: frame };
    expect(() =>
      createStatusHandler(sender, read)({ sender, senderFrame: frame }),
    ).toThrow();
  });
});
