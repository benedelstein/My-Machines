import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import worker from "../src/index";

const env = {
  API_BASE_URL: "https://api.example.test/",
  DISCORD_PUBLIC_KEY: "",
  INTEGRATION_SESSION_REQUEST_TOKEN: "integration-secret",
};

const successResponse = {
  ok: true,
  sessionId: "9d0c6549-1055-4a9a-8b6c-e4bd32bb2d97",
  title: "Repair authentication",
  repoId: 42,
  repoFullName: "example/my-machines",
  sessionUrl: "https://app.example.test/sessions/9d0c6549-1055-4a9a-8b6c-e4bd32bb2d97",
  routingReason: "Matched the repository name.",
} as const;

interface ObservedHttpRequest {
  url: string;
  init?: RequestInit;
}

let signingKey: CryptoKey;

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    "Ed25519",
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  signingKey = keyPair.privateKey;
  const publicKey = await crypto.subtle.exportKey("raw", keyPair.publicKey) as ArrayBuffer;
  env.DISCORD_PUBLIC_KEY = bytesToHex(publicKey);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Discord interactions worker", () => {
  it("rejects a request without a Discord signature", async () => {
    const externalFetch = vi.fn();
    vi.stubGlobal("fetch", externalFetch);

    const response = await worker.fetch(
      new Request("https://bot.example.test", {
        method: "POST",
        body: JSON.stringify({ type: 1 }),
      }),
      env,
      createExecutionContext().context,
    );

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe("invalid request signature");
    expect(externalFetch).not.toHaveBeenCalled();
  });

  it("responds to a valid signed Discord ping", async () => {
    const response = await worker.fetch(
      await signedRequest({ type: 1 }),
      env,
      createExecutionContext().context,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 1 });
  });

  it("rejects a signed request whose body was changed", async () => {
    const signedPing = await signedRequest({ type: 1 });
    const response = await worker.fetch(
      new Request(signedPing, { body: JSON.stringify({ type: 2 }) }),
      env,
      createExecutionContext().context,
    );

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe("invalid request signature");
  });

  it("defers a valid session command and edits it with the created session", async () => {
    const result = await runSessionCommand(new Response(JSON.stringify(successResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    expect(result.initialResponse).toEqual({
      type: 5,
      data: { flags: 64 },
    });
    expect(result.apiRequest).toEqual({
      url: "https://api.example.test/integrations/session-requests",
      authorization: "Bearer integration-secret",
      body: {
        externalUser: {
          provider: "discord",
          id: "discord-user-1",
          displayName: "Display Name",
          username: "username",
        },
        prompt: "fix authentication",
      },
    });
    expect(result.editedMessage).toEqual({
      content: [
        "Started a My Machines session in example/my-machines (Repair authentication).",
        "https://app.example.test/sessions/9d0c6549-1055-4a9a-8b6c-e4bd32bb2d97",
        "Routing: Matched the repository name.",
      ].join("\n"),
      allowed_mentions: { parse: [] },
    });
  });

  it("reports when the API rejects the session request", async () => {
    const result = await runSessionCommand(new Response("unavailable", { status: 503 }));

    expect(result.editedMessage).toEqual({
      content: "I could not create a My Machines session. The API rejected the request.",
      allowed_mentions: { parse: [] },
    });
  });

  it("reports an unexpected successful API response", async () => {
    const result = await runSessionCommand(Response.json({ ok: true, repoFullName: 42 }));

    expect(result.editedMessage).toEqual({
      content: "I could not create a My Machines session. The API returned an unexpected response.",
      allowed_mentions: { parse: [] },
    });
  });

  it("reports a network failure without leaving the deferred response pending", async () => {
    const result = await runSessionCommand(new Error("network unavailable"));

    expect(result.editedMessage).toEqual({
      content: "I could not create a My Machines session. Something went wrong, please try again.",
      allowed_mentions: { parse: [] },
    });
  });

  it("returns the account-link URL when the Discord user is not linked", async () => {
    const result = await runSessionCommand(Response.json({
      ok: false,
      code: "EXTERNAL_USER_NOT_LINKED",
      message: "Link your account to continue.",
      linkUrl: "https://app.example.test/integrations/link/link-token",
    }));

    expect(result.editedMessage).toEqual({
      content: "Link your account to continue. https://app.example.test/integrations/link/link-token",
      allowed_mentions: { parse: [] },
    });
  });

  it("lists repository candidates when routing is ambiguous", async () => {
    const result = await runSessionCommand(Response.json({
      ok: false,
      code: "AMBIGUOUS_REPO_MATCH",
      message: "Name the repository more precisely.",
      candidates: [
        { repoId: 1, repoFullName: "example/web" },
        { repoId: 2, repoFullName: "example/api" },
      ],
    }));

    expect(result.editedMessage).toEqual({
      content: [
        "I could not create a session: Name the repository more precisely.",
        "Possible repos:",
        "- example/web",
        "- example/api",
      ].join("\n"),
      allowed_mentions: { parse: [] },
    });
  });
});

async function runSessionCommand(apiResult: Response | Error): Promise<{
  initialResponse: unknown;
  apiRequest: {
    url: string;
    authorization: string | null;
    body: unknown;
  };
  editedMessage: unknown;
}> {
  const observedRequests: ObservedHttpRequest[] = [];
  const externalFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    observedRequests.push({ url, init });

    if (url === "https://api.example.test/integrations/session-requests") {
      if (apiResult instanceof Error) {
        throw apiResult;
      }
      return apiResult;
    }

    if (url === "https://discord.com/api/v10/webhooks/application-1/interaction-token/messages/@original") {
      return new Response(null, { status: 204 });
    }

    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", externalFetch);

  const execution = createExecutionContext();
  const response = await worker.fetch(
    await signedRequest({
      type: 2,
      application_id: "application-1",
      token: "interaction-token",
      member: {
        user: {
          id: "discord-user-1",
          username: "username",
          global_name: "Display Name",
        },
      },
      data: {
        name: "session",
        options: [{ name: "prompt", type: 3, value: "  fix authentication  " }],
      },
    }),
    env,
    execution.context,
  );
  const initialResponse = await response.json();
  await execution.drain();

  const apiRequest = observedRequests.find((request) => request.url.startsWith("https://api.example.test/"));
  const discordRequest = observedRequests.find((request) => request.url.startsWith("https://discord.com/"));
  if (!apiRequest || !discordRequest) {
    throw new Error("Expected both the API request and Discord response edit");
  }

  return {
    initialResponse,
    apiRequest: {
      url: apiRequest.url,
      authorization: new Headers(apiRequest.init?.headers).get("Authorization"),
      body: JSON.parse(String(apiRequest.init?.body)),
    },
    editedMessage: JSON.parse(String(discordRequest.init?.body)),
  };
}

async function signedRequest(body: unknown): Promise<Request> {
  const timestamp = "1700000000";
  const serializedBody = JSON.stringify(body);
  const signature = await crypto.subtle.sign(
    "Ed25519",
    signingKey,
    new TextEncoder().encode(`${timestamp}${serializedBody}`),
  );

  return new Request("https://bot.example.test", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature-Ed25519": bytesToHex(signature),
      "X-Signature-Timestamp": timestamp,
    },
    body: serializedBody,
  });
}

function createExecutionContext(): {
  context: ExecutionContext;
  drain: () => Promise<void>;
} {
  const pending: Promise<unknown>[] = [];
  return {
    context: {
      waitUntil(promise) {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
    },
    drain: async () => {
      await Promise.all(pending);
    },
  };
}

function bytesToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
