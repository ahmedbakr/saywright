import { expect, test } from '@playwright/test';

test('checkout page loads', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Checkout' })).toBeVisible();
  await expect(page.getByTestId('summary-total')).toContainText('$');
});
