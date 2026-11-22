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
import type { QuotaApi, QuotaStatus } from "../src/shared/contract";
import { mockQuota as mock } from "./fixtures/quota";

function api(status: QuotaStatus) {
  return {
    getStatus: vi.fn(async () => status),
    getAlwaysOnTop: vi.fn(async () => false),
    setAlwaysOnTop: vi.fn(async (value: boolean) => value),
    closeWindow: vi.fn(async () => {}),
  } satisfies QuotaApi;
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
