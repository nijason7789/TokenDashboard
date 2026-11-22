import { expect, it } from "vitest";
import { visibleBounds } from "../src/main/window-bounds";

const primary = { x: 0, y: 0, width: 1280, height: 720 };
const secondary = { x: -1920, y: -200, width: 1920, height: 1080 };

it("preserves a window on a secondary monitor with negative DIP coordinates", () => {
  const bounds = { x: -1000, y: 0, width: 360, height: 340 };
  expect(visibleBounds(bounds, [primary, secondary])).toEqual(bounds);
});

it("recovers a window after a monitor is removed and clamps its size to the work area", () => {
  expect(
    visibleBounds({ x: -1000, y: -500, width: 2000, height: 1000 }, [primary]),
  ).toEqual(primary);
});

it("uses the nearest work area after DPI or display geometry changes", () => {
  expect(
    visibleBounds({ x: 1200, y: 600, width: 360, height: 340 }, [primary]),
  ).toEqual({
    x: 920,
    y: 380,
    width: 360,
    height: 340,
  });
  expect(visibleBounds(primary, [])).toEqual(primary);
});

it("fits completely inside an unusually small negative work area", () => {
  const tiny = { x: -260, y: -460, width: 160, height: 120 };
  const bounds = { x: -800, y: -900, width: 360, height: 340 };
  expect(visibleBounds(bounds, [primary, tiny])).toEqual(tiny);
});

it("uses the nearest work area when a saved position falls in a gap", () => {
  const right = { x: 1800, y: 100, width: 1440, height: 800 };
  expect(
    visibleBounds({ x: 1510, y: 80, width: 220, height: 250 }, [
      primary,
      right,
      secondary,
    ]),
  ).toEqual({ x: 1800, y: 100, width: 220, height: 250 });
});
