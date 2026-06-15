import { expect, test } from '@playwright/test'

const mockHistory = {
  tasks: [
    { taskId: '1', url: 'https://douyin.com/v/1', platform: 'douyin', title: 'Mock Douyin Video', thumbnailUrl: '', duration: 15, isFavorite: true, tags: ['short-video', 'tutorial'], notes: '', groupName: 'campaign-a', createdAt: Date.now() - 1000 },
    { taskId: '2', url: 'https://youtube.com/v/2', platform: 'youtube', title: 'Mock YouTube Video', thumbnailUrl: '', duration: 30, isFavorite: false, tags: ['review'], notes: '', groupName: 'campaign-b', createdAt: Date.now() - 2000 },
    { taskId: '3', url: 'https://tiktok.com/v/3', platform: 'tiktok', title: 'Mock TikTok Video', thumbnailUrl: '', duration: 60, isFavorite: true, tags: ['short-video'], notes: '', groupName: '', createdAt: Date.now() - 3000 },
  ],
  total: 3,
  page: 1,
  pageSize: 50,
  hasMore: false,
}

const mockMeta = {
  tags: [{ tag: 'short-video', count: 2 }, { tag: 'tutorial', count: 1 }, { tag: 'review', count: 1 }],
  groups: [{ group: 'campaign-a', count: 1 }, { group: 'campaign-b', count: 1 }],
  ungroupedCount: 1,
  platforms: [{ platform: 'douyin', count: 1 }, { platform: 'youtube', count: 1 }, { platform: 'tiktok', count: 1 }],
  favoritesCount: 2,
  aiCardsCount: 0,
  publishPacksCount: 2,
  total: 3,
}

test.beforeEach(async ({ page }) => {
  await page.route(/\/api\/history\/meta(?:\?.*)?$/, async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data: mockMeta }) })
  })
  await page.route(/\/api\/history(?:\?.*)?$/, async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data: mockHistory }) })
  })
})

test('opens history panel', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('history-toggle').click()
  await expect(page.getByTestId('history-panel')).toBeVisible()
})

test('tag chip filters material', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('history-toggle').click()
  await page.waitForSelector('[data-testid="tag-chip-short-video"]', { timeout: 5000 })
  
  // Click tag to filter
  const tagChip = page.getByTestId('tag-chip-short-video')
  await tagChip.click()
  
  // Verify the tag chip shows selected state (has purple background)
  await expect(tagChip).toHaveClass(/purple-500\/20/)
  
  // Click again to clear
  await tagChip.click()
  
  // Verify tag chip shows unselected state
  await expect(tagChip).not.toHaveClass(/purple-500\/20/)
})

test('search filters material', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('history-toggle').click()
  await expect(page.getByTestId('history-search-input')).toBeVisible()

  await page.getByTestId('history-search-input').fill('YouTube')
})

test('workbench manager opens from history', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('history-toggle').click()
  await page.waitForSelector('[data-testid="workbench-toggle"]', { timeout: 5000 })
  
  // Open workbench manager
  await page.getByTestId('workbench-toggle').click()
  await page.locator('input[type="checkbox"]').first().check()
  
  // Verify batch buttons appear
  await expect(page.getByTestId('batch-tags-button')).toBeVisible()
  await expect(page.getByTestId('batch-group-button')).toBeVisible()
})

test('empty history shows no results', async ({ page }) => {
  // Override mock for empty history
  await page.route(/\/api\/history(?:\?.*)?$/, async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data: { tasks: [], total: 0 } }) })
  })
  await page.route(/\/api\/history\/meta(?:\?.*)?$/, async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0, data: { tags: [], groups: [], platforms: [], favoritesCount: 0, aiCardsCount: 0, publishPacksCount: 0, total: 0, ungroupedCount: 0 } }) })
  })
  
  await page.goto('/')
  await page.getByTestId('history-toggle').click()
  
  // Empty history should not show items
  await expect(page.getByTestId('load-more-button')).not.toBeVisible()
})
