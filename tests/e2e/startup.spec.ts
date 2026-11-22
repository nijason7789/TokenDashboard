import { expect, test } from "@playwright/test";
import { _electron as electron } from "playwright";

test("opens the production renderer without a mock provider", async () => {
  const app = await electron.launch({ args: ["."] });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveURL("app://monitor/index.html");
    await expect(
      page.getByRole("heading", { name: "Codex Quota Monitor" }),
    ).toBeVisible();
    await expect(page.getByRole("status")).toHaveText(
      "Quota source unavailable",
    );
    expect(await page.evaluate(() => Object.keys(window.quotaMonitor))).toEqual(
      ["getStatus"],
    );
    expect(
      await page.evaluate(() => typeof Reflect.get(window, "require")),
    ).toBe("undefined");
    expect(
      await page.evaluate(() => typeof Reflect.get(window, "process")),
    ).toBe("undefined");
    expect(await page.evaluate(() => window.open("about:blank") === null)).toBe(
      true,
    );
    expect(
      await page.evaluate(async () => Notification.requestPermission()),
    ).toBe("denied");
    await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "document.body.dataset.inlineScriptRan = 'yes'";
      document.body.append(script);
    });
    expect(
      await page.locator("body").getAttribute("data-inline-script-ran"),
    ).toBeNull();
  } finally {
    await app.close();
  }
});
