import { expect, test, type Page } from "@playwright/test";
import { fund, injectWallet, testAccount } from "./wallet";

const USDG = "0x4ae46a509F6b1D9056937BA4500cb143933D2dc8" as const;

async function openBasket(page: Page, name: RegExp) {
  await page.goto("/");
  const card = page.getByTestId("basket-card").filter({ hasText: name }).first();
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.getByTestId("basket-name")).toBeVisible();
}

test.describe("read only", () => {
  test("home lists the stock and crypto baskets with NAV, TVL and status", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /tokenized stocks/i }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tokenized stock baskets" })).toBeVisible();
    await expect(page.getByTestId("basket-card").first()).toBeVisible();
    expect(await page.getByTestId("basket-card").count()).toBeGreaterThanOrEqual(1);
    await expect(page.getByTestId("session").first()).toContainText(/US stocks (open|closed)/);
    await expect(page.getByTestId("breaker").first()).toBeVisible();
  });

  test("basket page shows composition against targets and a trade panel", async ({ page }) => {
    await openBasket(page, /Blue Chip|US Tech/);
    await expect(page.getByTestId("composition")).toBeVisible();
    expect(await page.getByTestId("composition").locator("tbody tr").count()).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId("trade-panel")).toBeVisible();
    await page.getByTestId("amount").fill("25");
    await expect(page.getByTestId("quote")).not.toHaveText("—");
  });

  test("circuits page: on-chain policy circuit equals circuits/src and agrees with the browser", async ({ page }) => {
    await page.goto("/circuits");
    await expect(page.getByTestId("circuit-card")).toHaveCount(2);
    await expect(page.getByText("byte for byte").first()).toBeVisible();
    await expect(page.getByTestId("policy-match")).toHaveText("Browser and chain agree.");
    await page.getByRole("switch", { name: "Sequencer up" }).click();
    await expect(page.getByTestId("policy-verdict")).toContainText("refuse");
    await expect(page.getByTestId("policy-match")).toHaveText("Browser and chain agree.");
    await page.getByTestId("sweep").click();
    await expect(page.getByTestId("sweep-result")).toContainText("All 16,384 match");
    await expect(page.getByTestId("breakers").locator("tbody tr").first()).toBeVisible();
  });

  test("studio builds a methodology circuit live", async ({ page }) => {
    await page.goto("/studio");
    await page.getByTestId("asset-wNVDAx").click();
    await page.getByTestId("asset-xBTC").click();
    await expect(page.getByTestId("weight-sum")).toContainText("100");
    await expect(page.getByTestId("gate-count")).toContainText("gates");
    await expect(page.getByTestId("truth-table").locator("tbody tr")).toHaveCount(16);
    await expect(page.getByTestId("truth-table").locator(".check.ko")).toHaveCount(0);
    await page.getByTestId("weight-wNVDAx").fill("70");
    await expect(page.getByTestId("weight-sum")).toContainText("120");
  });
});

test.describe("with a wallet", () => {
  test("buy a crypto basket, then verify every leg on the proof page", async ({ page }) => {
    const seed = `darwin-e2e-buy-${Date.now()}`;
    const acct = testAccount(seed);
    await fund(acct.address, USDG, 1_000n * 10n ** 6n);
    await injectWallet(page, seed);
    await openBasket(page, /Blue Chip/);
    await page.getByTestId("connect").first().click();
    await page.getByTestId("wallet-market.darwin.test").click();
    await expect(page.getByTestId("account")).toBeVisible();

    await page.getByTestId("amount").fill("100");
    await page.getByTestId("approve").click();
    await expect(page.getByTestId("submit")).toBeVisible();
    await expect(page.getByText(/Simulated on chain/)).toBeVisible();
    await page.getByTestId("submit").click();
    await expect(page.getByTestId("trade-done")).toBeVisible({ timeout: 90_000 });
    await page.getByTestId("proof-link").click();
    await expect(page.getByTestId("proof-summary")).toContainText(/All \d+ legs verified/);
    expect(await page.getByTestId("leg").count()).toBeGreaterThanOrEqual(3);
    await expect(page.getByTestId("leg-match").first()).toContainText("Match");

    await page.goto("/portfolio");
    await expect(page.getByTestId("positions")).toContainText("Blue Chip");
  });

  test("launch a strategy from the studio", async ({ page }) => {
    const seed = `darwin-e2e-studio-${Date.now()}`;
    await fund(testAccount(seed).address);
    await injectWallet(page, seed);
    await page.goto("/studio");
    await page.getByTestId("connect").first().click();
    await page.getByTestId("wallet-market.darwin.test").click();
    await page.getByTestId("asset-wSPYx").click();
    await page.getByTestId("asset-xBTC").click();
    await page.getByTestId("name").fill("E2E Stocks and Bitcoin");
    await page.getByTestId("symbol").fill(`E2E${Date.now() % 10000}`);
    await page.getByTestId("launch").click();
    await expect(page.getByTestId("launched")).toBeVisible({ timeout: 90_000 });
    await page.getByRole("link", { name: "Open the basket →" }).click();
    await expect(page.getByTestId("basket-name")).toHaveText("E2E Stocks and Bitcoin");
  });
});
