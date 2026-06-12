import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('**/api/history**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { tasks: [], total: 0 } }),
    })
  })
})

test('loads the downloader landing screen', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('app-header')).toBeVisible()
  await expect(page.getByTestId('url-input')).toBeVisible()
})

test('switches language from default locale to English', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('language-menu-button').click()
  await page.getByRole('button', { name: 'English' }).click()
  await expect(page.getByTestId('url-input')).toHaveAttribute('placeholder', /video link/i)
})

test('opens login modal from header', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('login-button').click()
  await expect(page.getByTestId('auth-modal')).toBeVisible()
})

test('extension workbench action opens history panel', async ({ page }) => {
  await page.goto('/?action=workbench')
  await expect(page.getByTestId('history-panel')).toBeVisible()
})

test('extension login and upgrade actions route to the right guest prompts', async ({ page }) => {
  await page.goto('/?action=login')
  await expect(page.getByTestId('auth-modal')).toBeVisible()

  await page.goto('/?action=upgrade')
  await expect(page.getByTestId('auth-modal')).toBeVisible()
})
