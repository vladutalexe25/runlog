import { defineConfig, devices } from "@playwright/test";

const PORT = process.env.E2E_PORT ?? "4100";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Playwright's own bundled Chromium download is blocked in some
        // sandboxes; set this to a real Chrome/Chromium binary to run
        // locally there instead of downloading one. Unset in CI, where the
        // bundled browser (installed via `npx playwright install`) is used.
        launchOptions: process.env.PLAYWRIGHT_CHROME_PATH
          ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH }
          : {},
      },
    },
  ],
  webServer: {
    command: "npm start",
    url: `http://localhost:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { PORT },
  },
});
