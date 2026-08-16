import { test, expect } from "@playwright/test";

test("create a workflow in the editor, run it, and see the result", async ({ page, request }) => {
  const name = `e2e create-and-run ${Date.now()}`;

  await page.goto("/workflows/new");
  await page.fill('input[placeholder="Workflow name"]', name);

  await page.click('button:has-text("+ transform")');
  await page.waitForSelector(".editor-panel");
  await page.fill('.editor-panel input[type="text"] >> nth=0', "double");
  await page.fill(".editor-panel textarea", "input.n * 2");

  await page.click('button:has-text("Create workflow")');
  await page.waitForURL(/\/workflows\/[0-9a-f-]+$/);

  const workflowUrl = page.url();
  const workflowId = workflowUrl.split("/").pop()!;

  await expect(page.locator(".react-flow__node")).toHaveCount(1);

  await page.fill(".trigger-card textarea", '{"n": 21}');
  await page.click('button:has-text("Run now")');

  // The job loop processes asynchronously; the detail page polls the
  // selected run every 1.2s while it's pending/running.
  await expect(page.locator(".run-row").first()).toContainText(/succeeded/i, { timeout: 15_000 });

  await page.click('.react-flow__node[data-id="double"]');
  await expect(page.locator(".node-inspector")).toContainText("42");

  await request.delete(`/api/workflows/${workflowId}`);
});
