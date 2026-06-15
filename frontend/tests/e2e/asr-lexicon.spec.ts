import { expect, test } from '@playwright/test'

const token = [
  btoa(JSON.stringify({ alg: 'none', typ: 'JWT' })),
  btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  'signature',
].join('.')

test.beforeEach(async ({ page }) => {
  await page.route('**/api/history**', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data: { tasks: [], total: 0 } }) })
  })
  await page.route('**/api/auth/me', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data: { id: 'u1', email: 'admin@example.com', tier: 'pro', isAdmin: true } }) })
  })
  await page.route('**/api/subscribe/status', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data: { tier: 'pro', subscriptionStatus: 'active', usage: { remaining: -1 } } }) })
  })
  await page.route('**/api/ai/usage', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data: null }) })
  })
  await page.route('**/api/asr/lexicon?**', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data: { terms: ['牛展=牛腱'], items: [{ term: '牛展=牛腱' }] } }) })
  })
  await page.route('**/api/asr/lexicon', async route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON()
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data: { terms: body.terms || [], items: [] } }) })
      return
    }
    await route.fallback()
  })
  await page.addInitScript(([authToken]) => {
    window.localStorage.setItem('orange_token', authToken)
    window.localStorage.setItem('orange_user', JSON.stringify({ id: 'u1', email: 'admin@example.com', tier: 'pro', isAdmin: true }))
  }, [token])
})

test('manages ASR correction lexicon entries', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('user-menu-button').click()
  await page.getByTestId('asr-lexicon-menu-button').click()

  await expect(page.getByText('牛展=牛腱')).toBeVisible()
  await page.getByPlaceholder(/错误词=正确词|wrong=correct/).fill('六一=溜衣')
  await page.getByRole('button', { name: /添加|Add/ }).click()
  await expect(page.getByText('六一=溜衣')).toBeVisible()

  await page.getByText('牛展=牛腱').locator('..').getByRole('button', { name: /删除|Delete/ }).click()
  await expect(page.getByText('牛展=牛腱')).not.toBeVisible()
  await page.getByRole('button', { name: /保存词库|Save Lexicon/ }).click()
  await expect(page.getByText(/已保存|Saved/)).toBeVisible()
})
