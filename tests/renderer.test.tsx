// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/renderer/App";
import type { QuotaStatus } from "../src/shared/contract";
import { mockQuota as mock } from "./fixtures/quota";
import { Profiler } from "react";
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings";

function api(status: QuotaStatus) {
  let settings = { ...DEFAULT_SETTINGS };
  let statusChanged: (value: QuotaStatus) => void = () => {};
  let settingsChanged: (value: Settings) => void = () => {};
  let openSettings = () => {};
  const offStatus = vi.fn();
  const offSettings = vi.fn();
  const offOpenSettings = vi.fn();
  return {
    getStatus: vi.fn(async () => status),
    getAlwaysOnTop: vi.fn(async () => false),
    setAlwaysOnTop: vi.fn(async (value: boolean) => value),
    closeWindow: vi.fn(async () => {}),
    getSettings: vi.fn(async () => settings),
    updateSettings: vi.fn(async (patch: Partial<Settings>) => {
      settings = { ...settings, ...patch };
      return settings;
    }),
    onStatusChanged: vi.fn((listener: (value: QuotaStatus) => void) => {
      statusChanged = listener;
      return offStatus;
    }),
    onSettingsChanged: vi.fn((listener: (value: Settings) => void) => {
      settingsChanged = listener;
      return offSettings;
    }),
    onOpenSettings: vi.fn((listener: () => void) => {
      openSettings = listener;
      return offOpenSettings;
    }),
    emitStatus: (value: QuotaStatus) => statusChanged(value),
    emitSettings: (value: Settings) => settingsChanged(value),
    emitOpenSettings: () => openSettings(),
    offStatus,
    offSettings,
    offOpenSettings,
  };
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("renders unavailable production data with empty quota bars", async () => {
  render(<App api={api({ source: "unavailable" })} />);
  expect(await screen.findByText("Quota source unavailable")).toBeTruthy();
  expect(screen.getAllByText("N/A")).toHaveLength(2);
  expect(screen.queryByText(/mock data/i)).toBeNull();
  expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
});

it("labels mock data and distinguishes remaining from used", async () => {
  render(<App api={api(mock)} />);
  expect(await screen.findByText("Mock data")).toBeTruthy();
  const five = screen.getByRole("region", { name: "5-hour limit" });
  expect(within(five).getByText("68%")).toBeTruthy();
  expect(within(five).getByText("32% used")).toBeTruthy();
  expect(within(five).getByRole("progressbar").getAttribute("value")).toBe(
    "68",
  );
  expect(within(five).getByRole("progressbar").getAttribute("data-tone")).toBe(
    "green",
  );
  expect(
    screen
      .getByRole("region", { name: "Weekly limit" })
      .querySelector("progress")?.dataset.tone,
  ).toBe("yellow");
});

it.each([
  [50, "green"],
  [49, "yellow"],
  [20, "yellow"],
  [19, "red"],
  [0, "red"],
  [100, "green"],
] as const)(
  "uses the remaining threshold for %i percent",
  async (remainingPercent, tone) => {
    render(
      <App
        api={api({
          ...mock,
          fiveHour: { state: "available", remainingPercent, resetsAtMs: null },
        })}
      />,
    );
    await screen.findByText("Mock data");
    const region = screen.getByRole("region", { name: "5-hour limit" });
    expect(
      within(region).getByRole("progressbar").getAttribute("data-tone"),
    ).toBe(tone);
  },
);

it("renders ambiguity, missing values and stale status without fabricating percentages", async () => {
  render(
    <App
      api={api({
        ...mock,
        phase: "stale",
        fiveHour: { state: "ambiguous" },
        weekly: { state: "missing" },
      })}
    />,
  );
  expect(await screen.findByText("Stale")).toBeTruthy();
  expect(screen.getByText("Ambiguous quota window")).toBeTruthy();
  expect(screen.getByText("Quota window unavailable")).toBeTruthy();
  expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
  expect(screen.getByText(/Last updated/)).toBeTruthy();
});

it.each([
  ["connecting", "Connecting"],
  ["error", "Error"],
  ["disconnected", "Disconnected"],
] as const)("renders %s state", async (phase, label) => {
  render(<App api={api({ source: "monitor", phase })} />);
  expect(await screen.findByText(label)).toBeTruthy();
});

it("updates countdown locally and clears its timer on unmount", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const provider = api(mock);
  const view = render(<App api={provider} />);
  await act(async () => {});
  expect(screen.getByText("Resets in 2h 30m")).toBeTruthy();
  expect(
    screen.getAllByText(/Resets /).some((node) => node.tagName === "TIME"),
  ).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(screen.getByText("Resets in 2h 29m")).toBeTruthy();
  expect(provider.getStatus).toHaveBeenCalledOnce();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("shows expired and unknown reset times explicitly", async () => {
  render(
    <App
      api={api({
        ...mock,
        fiveHour: { state: "available", remainingPercent: 0, resetsAtMs: 1 },
        weekly: { state: "available", remainingPercent: 42, resetsAtMs: null },
      })}
    />,
  );
  expect(await screen.findByText("Awaiting quota refresh")).toBeTruthy();
  expect(screen.getByText("Reset time unavailable")).toBeTruthy();
});

it("toggles compact mode and always-on-top, refreshes and closes through the narrow API", async () => {
  const provider = api(mock);
  render(<App api={provider} />);
  await screen.findByText("Mock data");
  fireEvent.click(screen.getByRole("button", { name: "Compact mode" }));
  await act(async () => {});
  expect(
    screen
      .getByRole("button", { name: "Normal mode" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.queryByText("32% used")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Always on top" }));
  await act(async () => {});
  expect(provider.setAlwaysOnTop).toHaveBeenCalledWith(true);
  expect(
    screen
      .getByRole("button", { name: "Always on top" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await act(async () => {});
  expect(provider.getStatus).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Close window" }));
  expect(provider.closeWindow).toHaveBeenCalledOnce();
});

it("sanitizes failed reads and window controls", async () => {
  const provider = api(mock);
  provider.getStatus.mockRejectedValue(new Error("private path"));
  provider.setAlwaysOnTop.mockRejectedValue(new Error("private path"));
  render(<App api={provider} />);
  expect(await screen.findByText("Quota source unavailable")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Always on top" }));
  await act(async () => {});
  expect(screen.getByText("Window control unavailable")).toBeTruthy();
  expect(screen.queryByText(/private path/)).toBeNull();
});

it("receives sanitized status and settings events and unsubscribes on unmount", async () => {
  const provider = api({ source: "unavailable" });
  const view = render(<App api={provider} />);
  await screen.findByText("Quota source unavailable");
  act(() => provider.emitStatus(mock));
  expect(screen.getByText("Mock data")).toBeTruthy();
  act(() =>
    provider.emitSettings({
      ...DEFAULT_SETTINGS,
      compact: true,
      alwaysOnTop: true,
      percentageMode: "used",
    }),
  );
  expect(
    screen
      .getByRole("button", { name: "Normal mode" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    screen
      .getByRole("button", { name: "Always on top" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    within(screen.getByRole("region", { name: "5-hour limit" })).getByText(
      "32%",
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "5-hour limit" }))
      .getByRole("progressbar")
      .getAttribute("value"),
  ).toBe("32");
  expect(
    within(screen.getByRole("region", { name: "5-hour limit" }))
      .getByRole("progressbar")
      .getAttribute("data-tone"),
  ).toBe("green");
  act(() => provider.emitOpenSettings());
  expect(screen.getByRole("region", { name: "Settings" })).toBeTruthy();
  view.unmount();
  expect(provider.offStatus).toHaveBeenCalledOnce();
  expect(provider.offSettings).toHaveBeenCalledOnce();
  expect(provider.offOpenSettings).toHaveBeenCalledOnce();
});

it("persists settings through the narrow API and reports write failures", async () => {
  const provider = api(mock);
  render(<App api={provider} />);
  await screen.findByText("Mock data");
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.change(screen.getByLabelText("Refresh interval"), {
    target: { value: "120" },
  });
  await act(async () => {});
  expect(provider.updateSettings).toHaveBeenLastCalledWith({
    refreshInterval: 120,
  });
  fireEvent.click(screen.getByLabelText("Close to tray"));
  await act(async () => {});
  expect(provider.updateSettings).toHaveBeenLastCalledWith({
    closeToTray: false,
  });
  provider.updateSettings.mockRejectedValueOnce(
    new Error("private settings file path"),
  );
  fireEvent.click(screen.getByLabelText("Low quota notifications"));
  await act(async () => {});
  expect(screen.getByText("Could not save settings")).toBeTruthy();
  expect(screen.queryByText(/private settings file path/)).toBeNull();
});

it("keeps a newer subscription snapshot when an older refresh completes", async () => {
  const provider = api({ source: "unavailable" });
  let finish!: (value: QuotaStatus) => void;
  provider.getStatus.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<App api={provider} />);
  await act(async () => {});
  act(() => provider.emitStatus(mock));
  await act(async () => finish({ source: "unavailable" }));
  expect(screen.getByText("Mock data")).toBeTruthy();
});

it("schedules only the next minute boundary and suspends countdown while hidden", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1001);
  const provider = api(mock);
  const rendered = vi.fn();
  const view = render(
    <Profiler id="dashboard" onRender={rendered}>
      <App api={provider} />
    </Profiler>,
  );
  await act(async () => {});
  const initialRenders = rendered.mock.calls.length;
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(59998);
  });
  expect(rendered).toHaveBeenCalledTimes(initialRenders);
  expect(screen.getByText("Resets in 2h 30m")).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(screen.getByText("Resets in 2h 29m")).toBeTruthy();
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(vi.getTimerCount()).toBe(0);
  vi.setSystemTime(9001001);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(screen.getByText("Awaiting quota refresh")).toBeTruthy();
  expect(provider.getStatus).toHaveBeenCalledOnce();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves a newer settings event during initial loading and writes all preference controls", async () => {
  const provider = api(mock);
  let loaded!: (value: Settings) => void;
  provider.getSettings.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        loaded = resolve;
      }),
  );
  render(<App api={provider} />);
  await screen.findByText("Mock data");
  act(() =>
    provider.emitSettings({
      ...DEFAULT_SETTINGS,
      opacity: 0.7,
      percentageMode: "used",
    }),
  );
  await act(async () => loaded({ ...DEFAULT_SETTINGS }));
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  expect(
    (screen.getByLabelText("Window opacity") as HTMLInputElement).value,
  ).toBe("0.7");
  expect(
    (screen.getByLabelText("Show percentage") as HTMLSelectElement).value,
  ).toBe("used");
  expect(
    (screen.getByLabelText("Launch on Windows startup") as HTMLInputElement)
      .checked,
  ).toBe(false);

  fireEvent.change(screen.getByLabelText("Window opacity"), {
    target: { value: "0.8" },
  });
  await act(async () => {});
  expect(provider.updateSettings).toHaveBeenLastCalledWith({ opacity: 0.8 });
  fireEvent.change(screen.getByLabelText("Show percentage"), {
    target: { value: "used" },
  });
  await act(async () => {});
  expect(provider.updateSettings).toHaveBeenLastCalledWith({
    percentageMode: "used",
  });
  fireEvent.change(screen.getByLabelText("Low quota threshold"), {
    target: { value: "35" },
  });
  await act(async () => {});
  expect(provider.updateSettings).toHaveBeenLastCalledWith({
    lowQuotaThreshold: 35,
  });
  fireEvent.click(screen.getByLabelText("Launch on Windows startup"));
  await act(async () => {});
  expect(provider.updateSettings).toHaveBeenLastCalledWith({
    launchOnStartup: true,
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Always on top" }));
  await act(async () => {});
  expect(provider.updateSettings).toHaveBeenLastCalledWith({
    alwaysOnTop: true,
  });
  fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
  expect(screen.queryByRole("region", { name: "Settings" })).toBeNull();
});

it("uses the earliest quota label boundary and stops scheduling after every reset expires", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const provider = api({
    ...mock,
    fiveHour: { state: "available", remainingPercent: 68, resetsAtMs: 61000 },
    weekly: { state: "available", remainingPercent: 42, resetsAtMs: 31000 },
  });
  const view = render(<App api={provider} />);
  await act(async () => {});
  expect(screen.getAllByText("Resets in 1m")).toHaveLength(2);
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(
    screen.getByRole("region", { name: "Weekly limit" }).textContent,
  ).toContain("Awaiting quota refresh");
  expect(
    screen.getByRole("region", { name: "5-hour limit" }).textContent,
  ).toContain("Resets in 1m");
  await act(async () => vi.advanceTimersByTimeAsync(30000));
  expect(screen.getAllByText("Awaiting quota refresh")).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
  view.unmount();
});

it("does not overwrite a saved preference with an older initial settings read", async () => {
  const provider = api(mock);
  let loaded!: (value: Settings) => void;
  provider.getSettings.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        loaded = resolve;
      }),
  );
  render(<App api={provider} />);
  await screen.findByText("Mock data");
  fireEvent.click(screen.getByRole("button", { name: "Compact mode" }));
  await act(async () => {});
  expect(screen.getByRole("button", { name: "Normal mode" })).toBeTruthy();
  await act(async () => loaded({ ...DEFAULT_SETTINGS }));
  expect(screen.getByRole("button", { name: "Normal mode" })).toBeTruthy();
});

it("disables every settings control until a preference write settles", async () => {
  const provider = api(mock);
  let complete!: (value: Settings) => void;
  provider.updateSettings.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  render(<App api={provider} />);
  await screen.findByText("Mock data");
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.change(screen.getByLabelText("Refresh interval"), {
    target: { value: "120" },
  });
  expect(
    (screen.getByRole("button", { name: "Always on top" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Compact mode" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (
      screen
        .getByLabelText("Refresh interval")
        .closest("fieldset") as HTMLFieldSetElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Always on top" }));
  expect(provider.setAlwaysOnTop).not.toHaveBeenCalled();
  await act(async () =>
    complete({ ...DEFAULT_SETTINGS, refreshInterval: 120 }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Always on top" }));
  await act(async () => {});
  expect(provider.setAlwaysOnTop).toHaveBeenCalledExactlyOnceWith(true);
});

it("disables competing preference writes while a pin change is pending and unlocks after failure", async () => {
  const provider = api(mock);
  let fail!: (error: Error) => void;
  provider.setAlwaysOnTop.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  render(<App api={provider} />);
  await screen.findByText("Mock data");
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Always on top" }));
  expect(
    (screen.getByRole("button", { name: "Compact mode" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (
      screen
        .getByLabelText("Refresh interval")
        .closest("fieldset") as HTMLFieldSetElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Compact mode" }));
  expect(provider.updateSettings).not.toHaveBeenCalled();
  await act(async () => fail(new Error("private detail")));
  expect(screen.getByText("Window control unavailable")).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Compact mode" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Compact mode" }));
  await act(async () => {});
  expect(provider.updateSettings).toHaveBeenCalledExactlyOnceWith({
    compact: true,
  });
});
