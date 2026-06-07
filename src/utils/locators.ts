import type { Page } from "playwright";

export async function fillFirstVisible(
  page: Page,
  selectorList: string,
  value: string,
): Promise<void> {
  const selectors = selectorList.split(",").map((s) => s.trim());

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible())) {
      await locator.fill(value);
      return;
    }
  }

  throw new Error(`No visible field found for selectors: ${selectorList}`);
}

export async function clickFirstVisible(
  page: Page,
  selectorList: string,
): Promise<void> {
  const selectors = selectorList.split(",").map((s) => s.trim());

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible())) {
      await locator.click();
      return;
    }
  }

  throw new Error(`No visible button found for selectors: ${selectorList}`);
}

export async function selectFirstVisible(
  page: Page,
  selectorList: string,
  value: string,
): Promise<void> {
  const selectors = selectorList.split(",").map((s) => s.trim());

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible())) {
      await locator.selectOption({ label: value }).catch(async () => {
        await locator.selectOption(value);
      });
      return;
    }
  }

  throw new Error(`No visible select found for selectors: ${selectorList}`);
}
