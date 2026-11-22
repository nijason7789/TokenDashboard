// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/renderer/App";
import { mockQuota } from "./fixtures/quota";

afterEach(cleanup);

it("shows only the unavailable state on a successful production status read", async () => {
  render(<App api={{ getStatus: async () => ({ source: "unavailable" }) }} />);
  expect(await screen.findByText("Quota source unavailable")).toBeTruthy();
  expect(screen.queryByText(/68%|mock/i)).toBeNull();
});

it("labels sample data when a test explicitly injects a fixture", async () => {
  render(<App api={{ getStatus: async () => mockQuota }} />);
  expect(await screen.findByText("Mock data · 68% remaining")).toBeTruthy();
});

it("keeps a failed status read unavailable", async () => {
  render(
    <App
      api={{
        getStatus: vi.fn().mockRejectedValue(new Error("internal details")),
      }}
    />,
  );
  expect(await screen.findByText("Quota source unavailable")).toBeTruthy();
  expect(screen.queryByText(/68%|mock|internal details/i)).toBeNull();
});
