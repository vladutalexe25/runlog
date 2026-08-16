import { test, expect } from "@playwright/test";

test("trigger a workflow via its webhook URL and see a completed run", async ({ request, page }) => {
  const createResp = await request.post("/api/workflows", {
    data: {
      name: `e2e webhook ${Date.now()}`,
      nodes: [
        {
          id: "double",
          type: "transform",
          name: "Double",
          config: { expression: "input.n * 2" },
          positionX: 100,
          positionY: 100,
        },
      ],
      edges: [],
    },
  });
  expect(createResp.ok()).toBeTruthy();
  const workflow = await createResp.json();

  const webhookResp = await request.post(`/webhooks/${workflow.id}`, { data: { n: 10 } });
  expect(webhookResp.status()).toBe(202);
  const { runId } = await webhookResp.json();

  await expect
    .poll(
      async () => {
        const r = await request.get(`/api/runs/${runId}`);
        const body = await r.json();
        return body.run.status;
      },
      { timeout: 10_000, intervals: [500] },
    )
    .toBe("succeeded");

  const finalRun = await (await request.get(`/api/runs/${runId}`)).json();
  expect(finalRun.run.triggerType).toBe("webhook");
  expect(finalRun.nodeExecutions[0].output).toBe(20);

  // Also visible from the UI's run history, not just the API directly.
  await page.goto(`/workflows/${workflow.id}`);
  await expect(page.locator(".run-row").first()).toContainText(/succeeded/i);
  await expect(page.locator(".run-row").first()).toContainText("webhook");

  await request.delete(`/api/workflows/${workflow.id}`);
});
