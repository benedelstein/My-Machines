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
  DashboardOperation,
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
    let operation: DashboardOperation = "browser_launch";
    const durations: Partial<DashboardCreateResult["durations"]> = {};
    try {
      const browserStartedAt = this.now();
      browser = await launch(this.browserBinding, { keep_alive: 60_000 });
      durations.browserLaunchMs = this.now() - browserStartedAt;

      operation = "context_create";
      const context = await browser.newContext({
        storageState: parsedStorageState.value,
      });
      operation = "page_create";
      const page = await context.newPage();

      operation = "goto";
      const preflightStartedAt = this.now();
      await page.goto(this.connectorCreateUrl(), {
        waitUntil: "commit",
        timeout: 30_000,
      });
      operation = "form_wait";
      await waitForDashboardRender(page);
      operation = "shape_read";
      const shape = await readDashboardShape(page);
      const shapeResult = validateDashboardShape(shape);
      durations.dashboardPreflightMs = this.now() - preflightStartedAt;
      if (!shapeResult.ok) {
        return failure({
          ...shapeResult.error,
          operation,
          durations,
        });
      }

      operation = "fill";
      await fillNonSecretFields(page, request);
      await page.locator('input[name="access_token"]').fill(request.token);

      operation = "connection_test";
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
      operation = "submit";
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
        operation,
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
    case "browser_launch":
    case "context_create":
    case "page_create":
      return "dashboard_browser_failed";
    case "goto":
      return "dashboard_navigation_failed";
    case "form_wait":
    case "shape_read":
      return "dashboard_drift";
    case "fill":
    case "connection_test":
    case "submit":
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
  await Promise.race([
    page.locator('#custom-api-form input[name="auth_method"]').waitFor({
      state: "attached",
      timeout: 15_000,
    }),
    signInForm(page).waitFor({
      state: "attached",
      timeout: 15_000,
    }),
  ]).catch(() => undefined);
}

async function readDashboardShape(page: Page): Promise<DashboardShapeSnapshot> {
  return await page.evaluate(() => {
    type BrowserElement = {
      value?: string;
      getAttribute: (name: string) => string | null;
      querySelector: (selector: string) => BrowserElement | null;
      querySelectorAll: (selector: string) => Iterable<BrowserElement>;
    };
    const browserGlobal = globalThis as unknown as {
      document: {
        querySelector: (selector: string) => BrowserElement | null;
        querySelectorAll: (selector: string) => { length: number };
      };
      location: { href: string };
    };
    const form = browserGlobal.document.querySelector("#custom-api-form");
    const authMethod = form?.querySelector('input[name="auth_method"]');
    const testButton = browserGlobal.document.querySelector('[phx-click="test_custom_api"]');
    const fieldNames = form === null
      ? []
      : Array.from(form.querySelectorAll("input[name], textarea[name]"))
        .map((element) => element.getAttribute("name"))
        .filter((name): name is string => name !== null);

    return {
      currentUrl: browserGlobal.location.href,
      hasSignInForm: browserGlobal.document.querySelector(
        'form[action*="sign-in"], form[action*="login"], input[name="password"]',
      ) !== null,
      hasLiveViewRoot: browserGlobal.document.querySelectorAll("[data-phx-main]").length === 1,
      authMethodValue: authMethod?.value ?? null,
      formChangeEvent: form?.getAttribute("phx-change") ?? null,
      formSubmitEvent: form?.getAttribute("phx-submit") ?? null,
      fieldNames,
      testEvent: testButton?.getAttribute("phx-click") ?? null,
    };
  });
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
