// 分场编排 E2E：建时段/摊位 → 分批 → 清单/均衡 → 跨场借用 → 同场撞面拦截 → 导出/打印对照
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = resolve(HERE, '../../public/samples/riddles.csv');
const TOTAL = 53;

async function importSample(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.setInputFiles('input[type=file]', SAMPLE);
  await page.click('button:has-text("确认导入")');
  await expect(page.locator('.page-head h1')).toContainText(`${TOTAL} 条`);
}

test.describe('分场编排', () => {
  test('建时段与摊位', async ({ page }) => {
    await importSample(page);
    await page.click('nav >> text=分场编排');
    await expect(page.getByRole('heading', { name: /分场编排/ })).toBeVisible();

    // 两个时段
    await page.fill('.inline-form input[placeholder*="场次名"]', '午场');
    await page.fill('.inline-form input[type=time] >> nth=0', '13:00');
    await page.click('button:has-text("添加时段")');
    await page.fill('.inline-form input[placeholder*="场次名"]', '晚场');
    await page.fill('.inline-form input[type=time] >> nth=0', '18:30');
    await page.click('button:has-text("添加时段")');
    await expect(page.locator('.schedule-table', { hasText: '午场' })).toBeVisible();
    await expect(page.locator('.schedule-table', { hasText: '晚场' })).toBeVisible();

    // 两个摊位 + 负责人
    await page.fill('.booth-form input[placeholder*="摊位名"]', 'A 区字谜摊');
    await page.fill('.booth-form input[placeholder="负责人"]', '张三');
    await page.click('button:has-text("添加摊位")');
    await page.fill('.booth-form input[placeholder*="摊位名"]', 'B 区成语摊');
    await page.fill('.booth-form input[placeholder="负责人"]', '李四');
    await page.click('button:has-text("添加摊位")');
    await expect(page.locator('.schedule-table', { hasText: '张三' })).toBeVisible();
    await expect(page.locator('.schedule-table', { hasText: '李四' })).toBeVisible();
  });

  test('自动分批：轮询均衡落位、每条只属一场', async ({ page }) => {
    await importSample(page);
    await page.click('nav >> text=分场编排');
    // 建两场
    for (const [name, t] of [['午场', '13:00'], ['晚场', '18:30']] as const) {
      await page.fill('.inline-form input[placeholder*="场次名"]', name);
      await page.fill('.inline-form input[type=time] >> nth=0', t);
      await page.click('button:has-text("添加时段")');
    }
    await page.click('.tab:has-text("分批编排")');
    await page.click('button:has-text("自动分批")');
    await page.click('button:has-text("生成方案")');
    await expect(page.locator('.plan-preview')).toContainText(`方案共 ${TOTAL} 条`);
    await page.click('button:has-text("确认应用")');
    await expect(page.locator('.notice')).toContainText('自动分批完成');

    // 场次清单 tab：两场条数应均衡（相差不超过 1）
    await page.click('.tab:has-text("场次清单")');
    const counts = await page.locator('.tab-count').allTextContents();
    const [a, b] = counts.map((s) => parseInt(s.trim(), 10));
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
    expect(a + b).toBe(TOTAL);
  });

  test('单条分配到已有同谜面场次：弹确认拦截；改到空场则直接成功', async ({ page }) => {
    // CSV 导入会对同谜面去重，改走「新建谜条」造两条同谜面（谜库查重只提示不拦截）
    await page.goto('/#/riddle/new');
    await page.fill('textarea', '测试撞面谜面');
    await page.fill('.edit-grid input.input >> nth=0', '答甲');
    await page.click('button:has-text("添加到谜库")');
    await expect(page.getByText('已保存')).toBeVisible();
    await page.goto('/#/riddle/new');
    await page.fill('textarea', '测试撞面谜面！');
    await page.fill('.edit-grid input.input >> nth=0', '答乙');
    await page.click('button:has-text("添加到谜库")');
    await expect(page.getByText('已保存')).toBeVisible();

    await page.goto('/#/schedule');
    await page.fill('.inline-form input[placeholder*="场次名"]', '午场');
    await page.fill('.inline-form input[type=time] >> nth=0', '13:00');
    await page.click('button:has-text("添加时段")');
    await page.fill('.inline-form input[placeholder*="场次名"]', '晚场');
    await page.fill('.inline-form input[type=time] >> nth=0', '18:30');
    await page.click('button:has-text("添加时段")');

    await page.click('.tab:has-text("分批编排")');
    await page.uncheck('.toolbar .check-inline input[type=checkbox]'); // 取消「只看未编排」，保证两行始终在
    await page.fill('.toolbar .search', '撞面');
    const firstRowSelect = page.locator('.riddle-table tbody tr').first().locator('select.input-sm');
    await firstRowSelect.selectOption({ label: '午场' });
    // 第二条（同谜面归一化后相同）也分到午场 → confirm 弹窗，取消
    page.once('dialog', (d) => { expect(d.message()).toContain('重复谜面'); d.dismiss(); });
    const secondRowSelect = page.locator('.riddle-table tbody tr').nth(1).locator('select.input-sm');
    await secondRowSelect.selectOption({ label: '午场' });
    // 取消后第二条仍未编排
    await expect(page.locator('.riddle-table tbody tr').nth(1)).toContainText('未编排');
    // 分到晚场则不拦截
    await page.locator('.riddle-table tbody tr').nth(1).locator('select.input-sm').selectOption({ label: '晚场' });
    await expect(page.locator('.riddle-table tbody tr').nth(1)).toContainText('晚场');
  });

  test('跨场借用：登记 → 两场清单可见 → 归还', async ({ page }) => {
    await importSample(page);
    await page.click('nav >> text=分场编排');
    for (const [name, t] of [['午场', '13:00'], ['晚场', '18:30']] as const) {
      await page.fill('.inline-form input[placeholder*="场次名"]', name);
      await page.fill('.inline-form input[type=time] >> nth=0', t);
      await page.click('button:has-text("添加时段")');
    }
    await page.click('.tab:has-text("分批编排")');
    await page.fill('.toolbar .search', '一口咬掉牛尾巴');
    await page.locator('.riddle-table tbody tr').first().locator('select.input-sm').selectOption({ label: '午场' });

    // 到场次清单 → 借到晚场
    await page.click('.tab:has-text("场次清单")');
    await page.click('button:has-text("借到别场")');
    await expect(page.locator('.modal')).toBeVisible();
    await page.selectOption('.modal select.input >> nth=0', { label: '晚场（18:30）' });
    await page.fill('.modal input[placeholder*="午场字谜"]', '晚场字谜不够');
    await page.click('.modal button:has-text("登记借用")');
    await expect(page.locator('.modal')).toHaveCount(0);

    // 午场清单仍保留该谜条并标「借给晚场」；tab 角标显示借用中 1
    await expect(page.locator('.booth-list', { hasText: '借给「晚场」' })).toBeVisible();
    await expect(page.locator('.tab:has-text("借用记录")')).toContainText('1');
    // 切到晚场：出现借入标记
    await page.locator('.tab:has-text("晚场")').click();
    await expect(page.locator('.booth-list', { hasText: '借自「午场」' })).toBeVisible();

    // 借用记录 tab → 归还
    await page.click('.tab:has-text("借用记录")');
    await expect(page.locator('.schedule-table', { hasText: '晚场字谜不够' })).toBeVisible();
    await page.click('button:has-text("归还")');
    await expect(page.locator('h3:has-text("借用中")')).toContainText('0');
    await expect(page.locator('.panel', { hasText: '历史记录' })).toContainText('一口咬掉牛尾巴');

    // 刷新后仍持久化
    await page.reload();
    await page.click('.tab:has-text("借用记录")');
    await expect(page.locator('.panel', { hasText: '历史记录' })).toContainText('已归还');
  });

  test('导出分场清单 CSV（UTF-8 BOM，含场次/摊位/负责人列）', async ({ page }) => {
    await importSample(page);
    await page.click('nav >> text=分场编排');
    await page.fill('.inline-form input[placeholder*="场次名"]', '午场');
    await page.fill('.inline-form input[type=time] >> nth=0', '13:00');
    await page.click('button:has-text("添加时段")');
    await page.fill('.booth-form input[placeholder*="摊位名"]', 'A 字谜摊');
    await page.fill('.booth-form input[placeholder="负责人"]', '张三');
    await page.click('button:has-text("添加摊位")');
    await page.click('.tab:has-text("分批编排")');
    // 批量把全部筛选结果（全部 53 条）分到午场 + A 摊
    await page.locator('.batch-bar select.input >> nth=1').selectOption({ label: 'A 字谜摊' });
    await page.click('button:has-text("全部分配当前筛选")');
    await expect(page.locator('.notice')).toContainText('已分配 53 条');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('.page-head button:has-text("导出清单")'),
    ]);
    const buf = readFileSync((await download.path())!);
    expect([buf[0], buf[1], buf[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const text = buf.toString('utf8');
    expect(text).toContain('摊位负责人');
    expect(text).toContain('午场');
    expect(text).toContain('A 字谜摊');
    expect(text).toContain('张三');
    expect(text).toContain('一口咬掉牛尾巴');
  });

  test('打印对照表：汇总表 + 每场次每摊位清单（打印域 DOM 完整）', async ({ page }) => {
    await importSample(page);
    await page.click('nav >> text=分场编排');
    await page.fill('.inline-form input[placeholder*="场次名"]', '午场');
    await page.fill('.inline-form input[type=time] >> nth=0', '13:00');
    await page.click('button:has-text("添加时段")');
    await page.fill('.booth-form input[placeholder*="摊位名"]', 'A 字谜摊');
    await page.fill('.booth-form input[placeholder="负责人"]', '张三');
    await page.click('button:has-text("添加摊位")');
    await page.click('.tab:has-text("分批编排")');
    await page.locator('.batch-bar select.input >> nth=1').selectOption({ label: 'A 字谜摊' });
    await page.click('button:has-text("全部分配当前筛选")');
    // 打印对照 DOM（屏幕隐藏、打印时显示）：汇总表 + 场次标题 + 摊位负责人 + 谜条行
    const print = page.locator('[data-testid=schedule-print]');
    await expect(print).toContainText('分场编排对照表');
    await expect(print.locator('.sp-session-title')).toContainText('午场');
    await expect(print.locator('.sp-booth-head')).toContainText('张三');
    expect(await print.locator('tbody tr', { hasText: '一口咬掉牛尾巴' }).count()).toBeGreaterThan(0);
    // 打印样式：对照表横向 A4、屏幕 display:none
    const display = await print.evaluate((el) => getComputedStyle(el).display);
    expect(display).toBe('none');
  });
});
