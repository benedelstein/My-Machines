import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@repo/shared";
import { decrypt, encrypt, readStoredCredentialJson } from "../../src/shared/utils/crypto";
import { OpenAICodexAuthService } from "../../src/modules/ai-auth/services/openai-codex-auth.service";
import type { Env } from "../../src/shared/types";

function createLogger(): Logger {
  return {
    log() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    scope() {
      return this;
    },
  };
}

function createEnv(): Env {
  return {
    DB: {} as D1Database,
    TOKEN_ENCRYPTION_KEY: btoa("12345678901234567890123456789012"),
  } as Env;
}

function createService() {
  const env = createEnv();
  const service = new OpenAICodexAuthService(env, createLogger());
  return { env, service };
}

function getAttemptRepository(service: OpenAICodexAuthService) {
  return (service as unknown as {
    providerAuthAttemptRepository: {
      upsert: (...args: unknown[]) => Promise<void>;
      getByIdAndUserId: (...args: unknown[]) => Promise<unknown>;
      deleteById: (...args: unknown[]) => Promise<void>;
    };
  }).providerAuthAttemptRepository;
}

function getCredentialRepository(service: OpenAICodexAuthService) {
  return (service as unknown as {
    userProviderCredentialRepository: {
      upsert: (...args: unknown[]) => Promise<void>;
      getByUserProviderAndMethod: (...args: unknown[]) => Promise<unknown>;
      markRequiresReauth: (...args: unknown[]) => Promise<void>;
    };
  }).userProviderCredentialRepository;
}

describe("OpenAICodexAuthService", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts device authorization with the Codex device-auth endpoint", async () => {
    const { env, service } = createService();
    const attemptRepository = getAttemptRepository(service);
    const upsertSpy = vi.spyOn(attemptRepository, "upsert").mockResolvedValue();

    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      device_auth_id: "device-auth-123",
      user_code: "ABCD-1234",
      interval: "7",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await service.startDeviceAuthorization("user-1");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.userCode).toBe("ABCD-1234");
    expect(result.value.intervalSeconds).toBe(7);
    expect(result.value.verificationUrl).toBe("https://auth.openai.com/codex/device");
    expect(upsertSpy).toHaveBeenCalledOnce();

    const [{ encryptedContextJson }] = upsertSpy.mock.calls[0];
    const decryptedContext = JSON.parse(
      await decrypt(
        encryptedContextJson as string,
        env.TOKEN_ENCRYPTION_KEY,
      ),
    ) as {
      deviceAuthId: string;
      userCode: string;
      intervalSeconds: number;
      verificationUrl: string;
    };

    expect(decryptedContext).toEqual({
      deviceAuthId: "device-auth-123",
      userCode: "ABCD-1234",
      intervalSeconds: 7,
      verificationUrl: "https://auth.openai.com/codex/device",
    });
  });

  it("returns a clear provider error when device auth is disabled at start", async () => {
    const { service } = createService();
    vi.spyOn(getAttemptRepository(service), "upsert").mockResolvedValue();

    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      message: "Device auth is disabled",
    }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await service.startDeviceAuthorization("user-1");

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.status).toBe(403);
    expect(result.error.message).toBe("Device auth is disabled");
  });

  it("returns pending while device authorization is still waiting for approval", async () => {
    const { env, service } = createService();
    const attemptRepository = getAttemptRepository(service);
    const deleteSpy = vi.spyOn(attemptRepository, "deleteById").mockResolvedValue();
    vi.spyOn(attemptRepository, "getByIdAndUserId").mockResolvedValue({
      encryptedContextJson: await encrypt(JSON.stringify({
        deviceAuthId: "device-auth-123",
        intervalSeconds: 5,
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      }), env.TOKEN_ENCRYPTION_KEY),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      message: "Not approved yet",
    }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await service.pollDeviceAuthorization("user-1", "attempt-1");

    expect(result).toEqual({ status: "pending" });
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("keeps the attempt pending when the upstream poll fails transiently", async () => {
    const { env, service } = createService();
    const attemptRepository = getAttemptRepository(service);
    const deleteSpy = vi.spyOn(attemptRepository, "deleteById").mockResolvedValue();
    vi.spyOn(attemptRepository, "getByIdAndUserId").mockResolvedValue({
      encryptedContextJson: await encrypt(JSON.stringify({
        deviceAuthId: "device-auth-123",
        intervalSeconds: 5,
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      }), env.TOKEN_ENCRYPTION_KEY),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("fetch failed"));

    const result = await service.pollDeviceAuthorization("user-1", "attempt-1");

    expect(result).toEqual({ status: "pending" });
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it("completes device authorization after exchanging the returned authorization code", async () => {
    const { env, service } = createService();
    const attemptRepository = getAttemptRepository(service);
    const credentialRepository = getCredentialRepository(service);
    vi.spyOn(attemptRepository, "getByIdAndUserId").mockResolvedValue({
      encryptedContextJson: await encrypt(JSON.stringify({
        deviceAuthId: "device-auth-123",
        intervalSeconds: 5,
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
      }), env.TOKEN_ENCRYPTION_KEY),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const deleteSpy = vi.spyOn(attemptRepository, "deleteById").mockResolvedValue();
    const upsertSpy = vi.spyOn(credentialRepository, "upsert").mockResolvedValue();

    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authorization_code: "authorization-code-123",
        code_verifier: "code-verifier-123",
        code_challenge: "code-challenge-123",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "access-token-123",
        refresh_token: "refresh-token-123",
        id_token: "id-token-123",
        expires_in: 3600,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));

    const result = await service.pollDeviceAuthorization("user-1", "attempt-1");

    expect(result).toEqual({ status: "completed" });
    expect(deleteSpy).toHaveBeenCalledWith("attempt-1");
    expect(upsertSpy).toHaveBeenCalledOnce();

    const [{ encryptedCredentials }] = upsertSpy.mock.calls[0];
    const storedCredentialsJson = await readStoredCredentialJson(
      encryptedCredentials as string,
      env.TOKEN_ENCRYPTION_KEY,
    );
    expect(JSON.parse(storedCredentialsJson)).toMatchObject({
      accessToken: "access-token-123",
      refreshToken: "refresh-token-123",
      idToken: "id-token-123",
    });
  });

  it("cleans up expired attempts before polling OpenAI", async () => {
    const { service } = createService();
    const attemptRepository = getAttemptRepository(service);
    vi.spyOn(attemptRepository, "getByIdAndUserId").mockResolvedValue({
      encryptedContextJson: "unused",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    const deleteSpy = vi.spyOn(attemptRepository, "deleteById").mockResolvedValue();

    const result = await service.pollDeviceAuthorization("user-1", "attempt-1");

    expect(result).toEqual({ status: "expired" });
    expect(deleteSpy).toHaveBeenCalledWith("attempt-1");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes stored credentials with the refresh token flow", async () => {
    const { env, service } = createService();
    const credentialRepository = getCredentialRepository(service);
    vi.spyOn(credentialRepository, "getByUserProviderAndMethod").mockResolvedValue({
      encryptedCredentials: await encrypt(JSON.stringify({
        accessToken: "expired-access-token",
        refreshToken: "refresh-token-123",
        idToken: "existing-id-token",
        expiresAt: "2000-01-01T00:00:00.000Z",
      }), env.TOKEN_ENCRYPTION_KEY),
      requiresReauth: false,
    });
    vi.spyOn(credentialRepository, "markRequiresReauth").mockResolvedValue();
    const upsertSpy = vi.spyOn(credentialRepository, "upsert").mockResolvedValue();

    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      access_token: "fresh-access-token",
      refresh_token: "fresh-refresh-token",
      expires_in: 3600,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await service.refreshCredentialsIfNeeded("user-1");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.accessToken).toBe("fresh-access-token");
    expect(result.value.refreshToken).toBe("fresh-refresh-token");
    expect(result.value.idToken).toBe("existing-id-token");
    expect(upsertSpy).toHaveBeenCalledOnce();
  });

  it("requires reauth when stored credentials are missing a refresh token even before expiry", async () => {
    const { env, service } = createService();
    const credentialRepository = getCredentialRepository(service);
    vi.spyOn(credentialRepository, "getByUserProviderAndMethod").mockResolvedValue({
      encryptedCredentials: await encrypt(JSON.stringify({
        accessToken: "current-access-token",
        refreshToken: null,
        idToken: "id-token-123",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }), env.TOKEN_ENCRYPTION_KEY),
      requiresReauth: false,
    });
    const markRequiresReauthSpy = vi.spyOn(credentialRepository, "markRequiresReauth").mockResolvedValue();

    const result = await service.refreshCredentialsIfNeeded("user-1");

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("OPENAI_CODEX_REAUTH_REQUIRED");
    expect(result.error.message).toBe("OpenAI Codex refresh token is unavailable. Reconnect OpenAI Codex.");
    expect(markRequiresReauthSpy).toHaveBeenCalledWith("user-1", "openai-codex", "oauth");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires reauth when stored credentials are missing an id token even before expiry", async () => {
    const { env, service } = createService();
    const credentialRepository = getCredentialRepository(service);
    vi.spyOn(credentialRepository, "getByUserProviderAndMethod").mockResolvedValue({
      encryptedCredentials: await encrypt(JSON.stringify({
        accessToken: "current-access-token",
        refreshToken: "refresh-token-123",
        idToken: null,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }), env.TOKEN_ENCRYPTION_KEY),
      requiresReauth: false,
    });
    const markRequiresReauthSpy = vi.spyOn(credentialRepository, "markRequiresReauth").mockResolvedValue();

    const result = await service.refreshCredentialsIfNeeded("user-1");

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("OPENAI_CODEX_REAUTH_REQUIRED");
    expect(result.error.message).toBe("OpenAI Codex ID token is unavailable. Reconnect OpenAI Codex.");
    expect(markRequiresReauthSpy).toHaveBeenCalledWith("user-1", "openai-codex", "oauth");
    expect(fetch).not.toHaveBeenCalled();
  });
});
