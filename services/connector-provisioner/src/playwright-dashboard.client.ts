import {
  launch,
  type BrowserContextOptions,
  type BrowserWorker,
  type Page,
} from "@cloudflare/playwright";
import { z } from "zod";
import {
  validateDashboardShape,
  type DashboardShapeSnapshot,
} from "./dashboard-shape";
import type {
  DashboardConnectorClient,
  DashboardCreateError,
  DashboardCreateResult,
  MintConnectorRequest,
  Result,
} from "./types";
import { failure, success } from "./types";

const StorageStateSchema = z.object({
  cookies: z.array(z.object({
    name: z.string(),
    value: z.string(),
    domain: z.string(),
    path: z.string(),
    expires: z.number(),
    httpOnly: z.boolean(),
    secure: z.boolean(),
    sameSite: z.enum(["Strict", "Lax", "None"]),
  })),
  origins: z.array(z.object({
    origin: z.string(),
    localStorage: z.array(z.object({
      name: z.string(),
      value: z.string(),
    })),
  })),
});

interface PlaywrightDashboardClientOptions {
  browser: BrowserWorker;
  dashboardUrl: string;
  orgSlug: string;
  storageState: string;
  now?: () => number;
}

type StorageState = Exclude<BrowserContextOptions["storageState"], string | undefined>;
type DashboardOperation = "browser" | "navigation" | "interaction";

export class PlaywrightDashboardClient implements DashboardConnectorClient {
  private readonly browserBinding: BrowserWorker;
  private readonly dashboardUrl: string;
  private readonly orgSlug: string;
  private readonly storageState: string;
  private readonly now: () => number;

  constructor(options: PlaywrightDashboardClientOptions) {
    this.browserBinding = options.browser;
    this.dashboardUrl = options.dashboardUrl.replace(/\/+$/u, "");
    this.orgSlug = options.orgSlug;
    this.storageState = options.storageState;
    this.now = options.now ?? performance.now.bind(performance);
  }

  async createConnector(
    request: MintConnectorRequest,
  ): Promise<Result<DashboardCreateResult, DashboardCreateError>> {
    const operationStartedAt = this.now();
    const parsedStorageState = parseStorageState(this.storageState);
    if (!parsedStorageState.ok) {
      return failure({
        code: "reauthentication_required",
        retryable: false,
        durations: {
          browserLaunchMs: this.now() - operationStartedAt,
        },
      });
    }

    let browser: Awaited<ReturnType<typeof launch>> | undefined;
    let submitAttempted = false;
    let operation: DashboardOperation = "browser";
    const durations: Partial<DashboardCreateResult["durations"]> = {};
    try {
      const browserStartedAt = this.now();
      browser = await launch(this.browserBinding, { keep_alive: 60_000 });
      durations.browserLaunchMs = this.now() - browserStartedAt;

      const context = await browser.newContext({
        storageState: parsedStorageState.value,
      });
      const page = await context.newPage();

      operation = "navigation";
      const preflightStartedAt = this.now();
      await page.goto(this.connectorCreateUrl(), {
        waitUntil: "commit",
        timeout: 30_000,
      });
      await waitForDashboardRender(page);
      const shape = await readDashboardShape(page);
      const shapeResult = validateDashboardShape(shape);
      durations.dashboardPreflightMs = this.now() - preflightStartedAt;
      if (!shapeResult.ok) {
        return failure({
          ...shapeResult.error,
          durations,
        });
      }

      operation = "interaction";
      await fillNonSecretFields(page, request);
      await page.locator('input[name="access_token"]').fill(request.token);

      const testStartedAt = this.now();
      const testResult = await testConnection(page);
      durations.dashboardTestMs = this.now() - testStartedAt;
      if (!testResult) {
        return failure({
          code: "connection_test_failed",
          retryable: true,
          durations,
        });
      }

      const createStartedAt = this.now();
      submitAttempted = true;
      const detailId = await createConnection(page);
      durations.dashboardCreateMs = this.now() - createStartedAt;

      return success({
        ...(detailId === undefined ? {} : { detailId }),
        durations: {
          browserLaunchMs: durations.browserLaunchMs ?? 0,
          dashboardPreflightMs: durations.dashboardPreflightMs ?? 0,
          dashboardTestMs: durations.dashboardTestMs ?? 0,
          dashboardCreateMs: durations.dashboardCreateMs ?? 0,
        },
      });
    } catch {
      return failure({
        code: dashboardFailureCode(operation),
        retryable: true,
        submitAttempted,
        durations,
      });
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  private connectorCreateUrl(): string {
    const orgSlug = encodeURIComponent(this.orgSlug);
    return `${this.dashboardUrl}/${orgSlug}/sprites/connectors/new?type=custom_api`;
  }
}

function dashboardFailureCode(
  operation: DashboardOperation,
): DashboardCreateError["code"] {
  switch (operation) {
    case "browser":
      return "dashboard_browser_failed";
    case "navigation":
      return "dashboard_navigation_failed";
    case "interaction":
      return "dashboard_create_failed";
  }
}

function parseStorageState(storageState: string): Result<StorageState, DashboardCreateError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(storageState);
  } catch {
    return failure({
      code: "reauthentication_required",
      retryable: false,
    });
  }

  const result = StorageStateSchema.safeParse(parsed);
  if (!result.success) {
    return failure({
      code: "reauthentication_required",
      retryable: false,
    });
  }
  return success(result.data);
}

async function waitForDashboardRender(page: Page): Promise<void> {
  if (await signInForm(page).count() > 0) {
    return;
  }
  await page.locator("#custom-api-form").waitFor({
    state: "attached",
    timeout: 15_000,
  }).catch(() => undefined);
}

async function readDashboardShape(page: Page): Promise<DashboardShapeSnapshot> {
  const form = page.locator("#custom-api-form");
  const testButton = page.locator('[phx-click="test_custom_api"]');
  const hasSignInForm = await signInForm(page).count() > 0;
  const hasConnectorForm = await form.count() === 1;

  return {
    currentUrl: page.url(),
    hasSignInForm,
    hasLiveViewRoot: await page.locator("[data-phx-main]").count() === 1,
    authMethodValue: hasConnectorForm
      ? await form.locator('input[name="auth_method"]').inputValue()
      : null,
    formChangeEvent: hasConnectorForm ? await form.getAttribute("phx-change") : null,
    formSubmitEvent: hasConnectorForm ? await form.getAttribute("phx-submit") : null,
    fieldNames: hasConnectorForm
      ? await form.locator("input[name], textarea[name]").evaluateAll((elements) => {
        return elements
          .map((element) => element.getAttribute("name"))
          .filter((name): name is string => name !== null);
      })
      : [],
    testEvent: hasConnectorForm ? await testButton.getAttribute("phx-click") : null,
  };
}

function signInForm(page: Page) {
  return page.locator(
    'form[action*="sign-in"], form[action*="login"], input[name="password"]',
  );
}

async function fillNonSecretFields(page: Page, request: MintConnectorRequest): Promise<void> {
  const authMethod = page.locator('input[name="auth_method"]');
  if (await authMethod.inputValue() !== "header") {
    throw new Error("Unexpected dashboard auth method");
  }

  await page.locator('input[name="base_api_url"]').fill(request.baseApiUrl);
  await page.locator('input[name="name"]').fill(request.name);
  await page.locator('textarea[name="description"]').fill("");
  await page.locator('input[name="auth_header_prefix"]').fill(request.headerPrefix);
  await page.locator('input[name="refresh_token"]').fill("");
  await page.locator('input[name="test_url"]').fill(request.testUrl);
}

async function testConnection(page: Page): Promise<boolean> {
  const testButton = page.locator('[phx-click="test_custom_api"]');
  const createButton = page.getByRole("button", {
    name: "Create Connection",
    exact: true,
  });

  await testButton.click();
  try {
    await page.getByText(/HTTP 2\d\d.*Connection OK/iu).waitFor({
      state: "visible",
      timeout: 45_000,
    });
  } catch {
    return false;
  }

  return await createButton.isEnabled();
}

async function createConnection(page: Page): Promise<string | undefined> {
  const createUrl = page.url();
  const createButton = page.getByRole("button", {
    name: "Create Connection",
    exact: true,
  });

  await createButton.click();
  await page.waitForURL((url) => url.toString() !== createUrl, {
    timeout: 30_000,
  });

  const url = new URL(page.url());
  const segments = url.pathname.split("/").filter(Boolean);
  const connectorsIndex = segments.lastIndexOf("connectors");
  const candidate = connectorsIndex === -1 ? undefined : segments[connectorsIndex + 1];
  return candidate === undefined || candidate === "new" ? undefined : candidate;
}
