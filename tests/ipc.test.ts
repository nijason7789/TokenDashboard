import { describe, expect, it, vi } from "vitest";
import { createStatusHandler, createWindowHandler } from "../src/main/ipc";
import { IPC_CHANNELS, RENDERER_URL } from "../src/shared/contract";

const mainFrame = { url: RENDERER_URL };
const owner = { mainFrame };
const read = vi.fn(() => ({ source: "unavailable" as const }));
const handle = createStatusHandler(owner, read);

describe("status IPC", () => {
  it("accepts only the owning top frame, exact URL and zero arguments", () => {
    expect(IPC_CHANNELS).toEqual({
      status: "quota:status",
      getAlwaysOnTop: "window:get-always-on-top",
      setAlwaysOnTop: "window:set-always-on-top",
      closeWindow: "window:close",
    });
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

it("requires one boolean for the pin operation and rejects untrusted senders", () => {
  const action = vi.fn();
  const handle = createWindowHandler(
    owner,
    action,
    (args) => args.length === 1 && typeof args[0] === "boolean",
  );
  const event = { sender: owner, senderFrame: mainFrame };
  handle(event, true);
  expect(action).toHaveBeenCalledExactlyOnceWith(true);
  for (const args of [[], [1], ["true"], [false, true], [null]]) {
    expect(() => handle(event, ...args)).toThrow();
  }
  expect(() =>
    handle({ sender: { mainFrame }, senderFrame: mainFrame }, true),
  ).toThrow();
  expect(action).toHaveBeenCalledOnce();
});
