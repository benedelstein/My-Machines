import type { AuthMethod, Logger, DomainError } from "@repo/shared";
import { type Result, success, failure } from "@repo/shared";
import { decrypt, encrypt, readStoredCredentialJson } from "@/shared/utils/crypto";
import { createLogger } from "@/shared/logging";
import { ProviderAuthAttemptRepository } from "../repositories/provider-auth-attempt.repository";
import { UserProviderCredentialRepository } from "../repositories/user-provider-credential.repository";
import type { Env } from "@/shared/types";

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_AUTH_METHOD: AuthMethod = "oauth";
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_DEVICE_AUTH_USER_CODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const OPENAI_DEVICE_AUTH_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OPENAI_DEVICE_AUTH_VERIFICATION_URL = "https://auth.openai.com/codex/device";
const OPENAI_DEVICE_AUTH_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const OPENAI_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export type OpenAICodexErrorCode =
  | "OPENAI_CODEX_INVALID_STATE"
  | "OPENAI_CODEX_INVALID_CODE"
  | "OPENAI_CODEX_AUTH_REQUIRED"
  | "OPENAI_CODEX_REAUTH_REQUIRED"
  | "OPENAI_CODEX_TOKEN_EXCHANGE_FAILED"
  | "OPENAI_CODEX_TOKEN_REFRESH_FAILED";

const OPENAI_CODEX_AUTH_DOMAIN = "openai_codex_auth" as const;

export type OpenAICodexAuthError = DomainError<
  typeof OPENAI_CODEX_AUTH_DOMAIN,
  OpenAICodexErrorCode,
  { status: number }
>;

function openAICodexAuthError(code: OpenAICodexErrorCode, message: string, status: number): OpenAICodexAuthError {
  return { domain: OPENAI_CODEX_AUTH_DOMAIN, code, message, status };
}

export type OpenAICodexAuthorizationUrlResult = {
  url: string;
  state: string;
};

export type OpenAICodexDeviceAuthorizationResult = {
  attemptId: string;
  verificationUrl: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: string;
};

export type OpenAICodexDeviceAuthorizationStatus =
  | { status: "pending" }
  | { status: "completed" }
  | { status: "expired" };

export type OpenAICodexConnectionStatus = {
  connected: boolean;
  requiresReauth: boolean;
};

export type OpenAICodexCredentials = {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  expiresAt: string | null;
};

type OpenAICodexCredentialPayload = OpenAICodexCredentials;

type OpenAICodexTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type OpenAICodexDeviceAuthorizationResponse = {
  device_auth_id?: string;
  user_code?: string;
  usercode?: string;
  interval?: string | number;
  error?: string | { message?: string };
  message?: string;
};

type OpenAICodexDeviceAttemptContext = {
  deviceAuthId: string;
  intervalSeconds: number;
  verificationUrl: string;
  userCode: string;
};

type OpenAICodexDevicePollResponse = {
  authorization_code?: string;
  code_challenge?: string;
  code_verifier?: string;
  error?: string | { message?: string };
  message?: string;
};

function getDeviceAuthErrorMessage(payload: {
  error?: string | { message?: string };
  message?: string;
}): string | null {
  if (typeof payload.error === "string" && payload.error.length > 0) {
    return payload.error;
  }
  if (typeof payload.error === "object" && payload.error !== null && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  if (typeof payload.message === "string" && payload.message.length > 0) {
    return payload.message;
  }
  return null;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT");
  }
  const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(payload));
}

function deriveExpiryIsoString(
  accessToken: string,
  expiresInSeconds?: number,
): string | null {
  if (typeof expiresInSeconds === "number" && Number.isFinite(expiresInSeconds)) {
    return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  }

  try {
    const payload = decodeJwtPayload(accessToken);
    if (typeof payload.exp === "number") {
      return new Date(payload.exp * 1000).toISOString();
    }
  } catch {
    return null;
  }

  return null;
}

function needsRefresh(expiresAt: string | null): boolean {
  if (!expiresAt) {
    return false;
  }

  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }

  return (expiresAtMs - Date.now()) <= OPENAI_REFRESH_BUFFER_MS;
}

function parseStoredCredentials(decryptedJson: string): OpenAICodexCredentialPayload {
  return JSON.parse(decryptedJson) as OpenAICodexCredentialPayload;
}

export class OpenAICodexAuthService {
  private readonly providerAuthAttemptRepository: ProviderAuthAttemptRepository;
  private readonly userProviderCredentialRepository: UserProviderCredentialRepository;
  private readonly logger: Logger;

  constructor(
    private readonly env: Env,
    logger: Logger = createLogger("openai-codex-auth-service.ts"),
  ) {
    this.providerAuthAttemptRepository = new ProviderAuthAttemptRepository(env.DB);
    this.userProviderCredentialRepository = new UserProviderCredentialRepository(env.DB);
    this.logger = logger.scope("openai-codex-auth-service.ts");
  }

  /**
   * Starts a device authorization attempt for OpenAI Codex.
   * @param userId Authenticated user id.
   * @returns Device authorization instructions and polling metadata.
   */
  async startDeviceAuthorization(
    userId: string,
  ): Promise<Result<OpenAICodexDeviceAuthorizationResult, OpenAICodexAuthError>> {
    let response: Response;
    try {
      response = await fetch(OPENAI_DEVICE_AUTH_USER_CODE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          client_id: OPENAI_CLIENT_ID,
        }),
      });
    } catch (error) {
      this.logger.error("OpenAI Codex device auth start request failed", { error });
      return failure(openAICodexAuthError(
        "OPENAI_CODEX_TOKEN_EXCHANGE_FAILED",
        "Failed to contact OpenAI Codex device authorization endpoint.",
        502,
      ));
    }

    const rawText = await response.text();
    let payload: OpenAICodexDeviceAuthorizationResponse;
    try {
      payload = JSON.parse(rawText) as OpenAICodexDeviceAuthorizationResponse;
    } catch {
      payload = {};
    }
    const userCode = payload.user_code ?? payload.usercode;

    if (
      !response.ok ||
      typeof payload.device_auth_id !== "string" ||
      typeof userCode !== "string"
    ) {
      const errorMessage = getDeviceAuthErrorMessage(payload);
      return failure(openAICodexAuthError(
        "OPENAI_CODEX_TOKEN_EXCHANGE_FAILED",
        errorMessage
          ?? (response.status === 403 || response.status === 404
            ? "OpenAI Codex device authorization is not enabled for this server."
            : "Failed to start OpenAI Codex device authorization."),
        response.status >= 400 && response.status < 600 ? response.status : 502,
      ));
    }

    const attemptId = crypto.randomUUID();
    const parsedInterval = typeof payload.interval === "string"
      ? Number.parseInt(payload.interval, 10)
      : payload.interval;
    const intervalSeconds = typeof parsedInterval === "number" && Number.isFinite(parsedInterval) && parsedInterval > 0
      ? parsedInterval
      : 5;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const context: OpenAICodexDeviceAttemptContext = {
      deviceAuthId: payload.device_auth_id,
      intervalSeconds,
      verificationUrl: OPENAI_DEVICE_AUTH_VERIFICATION_URL,
      userCode,
    };

    await this.providerAuthAttemptRepository.upsert({
      id: attemptId,
      userId,
      providerId: OPENAI_CODEX_PROVIDER_ID,
      authMethod: OPENAI_CODEX_AUTH_METHOD,
      flowType: "device_code",
      encryptedContextJson: await encrypt(
        JSON.stringify(context),
        this.env.TOKEN_ENCRYPTION_KEY,
      ),
      expiresAt,
    });

    return success({
      attemptId,
      verificationUrl: context.verificationUrl,
      userCode: context.userCode,
      intervalSeconds,
      expiresAt,
    });
  }

  /**
   * Polls a device authorization attempt and completes it when the user approves.
   * @param userId Authenticated user id.
   * @param attemptId Stored attempt id.
   * @returns Current attempt status.
   */
  async pollDeviceAuthorization(
    userId: string,
    attemptId: string,
  ): Promise<OpenAICodexDeviceAuthorizationStatus> {
    const attempt = await this.providerAuthAttemptRepository.getByIdAndUserId(
      attemptId,
      userId,
    );
    if (!attempt) {
      return { status: "expired" };
    }

    if (Date.parse(attempt.expiresAt) <= Date.now()) {
      await this.providerAuthAttemptRepository.deleteById(attemptId);
      return { status: "expired" };
    }

    const context = JSON.parse(
      await decrypt(attempt.encryptedContextJson, this.env.TOKEN_ENCRYPTION_KEY),
    ) as OpenAICodexDeviceAttemptContext;

    const deviceAuthResult = await this.pollDeviceAuthCode(context);
    if (!deviceAuthResult.ok) {
      if (deviceAuthResult.error.status === 403 || deviceAuthResult.error.status === 404) {
        return { status: "pending" };
      }
      if (deviceAuthResult.error.status === 401) {
        await this.providerAuthAttemptRepository.deleteById(attemptId);
        return { status: "expired" };
      }
      // Transient upstream failures (network errors, 5xx) must not surface as
      // "expired" — the attempt is still valid and bounded by its own expiresAt.
      this.logger.error("Unexpected error polling device authorization", { error: deviceAuthResult.error });
      return { status: "pending" };
    }

    const tokenResult = await this.postTokenRequest(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: OPENAI_CLIENT_ID,
        code: deviceAuthResult.value.authorizationCode,
        code_verifier: deviceAuthResult.value.codeVerifier,
        redirect_uri: OPENAI_DEVICE_AUTH_REDIRECT_URI,
      }),
      "authorization_code",
    );
    if (!tokenResult.ok) {
      this.logger.error("OpenAI Codex token exchange failed after device authorization", {
        error: tokenResult.error,
      });
      await this.providerAuthAttemptRepository.deleteById(attemptId);
      return { status: "expired" };
    }

    const credentialsResult = this.parseTokenResponse(tokenResult.value, null);
    if (!credentialsResult.ok) {
      this.logger.error("Failed to parse device auth token response", { error: credentialsResult.error });
      await this.providerAuthAttemptRepository.deleteById(attemptId);
      return { status: "expired" };
    }
    await this.persistCredentials(userId, credentialsResult.value);
    await this.providerAuthAttemptRepository.deleteById(attemptId);
    return { status: "completed" };
  }

  /**
   * Exchanges an authorization code for OpenAI Codex credentials and stores them.
   * @deprecated Web product flow should use device authorization, not localhost callbacks.
   */
  async exchangeAuthorizationCode(): Promise<void> {
    throw new Error("Browser callback auth is not supported for the web product. Use device code auth.");
  }

  /**
   * Returns provider connection status, refreshing credentials when needed.
   * @param userId Authenticated user id.
   * @returns Connection status for OpenAI Codex.
   */
  async getConnectionStatus(userId: string): Promise<OpenAICodexConnectionStatus> {
    const record = await this.userProviderCredentialRepository.getByUserProviderAndMethod(
      userId,
      OPENAI_CODEX_PROVIDER_ID,
      OPENAI_CODEX_AUTH_METHOD,
    );
    if (!record) {
      return { connected: false, requiresReauth: false };
    }
    if (record.requiresReauth) {
      return { connected: false, requiresReauth: true };
    }

    const result = await this.refreshCredentialsIfNeeded(userId);
    if (result.ok) {
      return { connected: true, requiresReauth: false };
    }

    if (result.error.code === "OPENAI_CODEX_REAUTH_REQUIRED") {
      return { connected: false, requiresReauth: true };
    }
    if (result.error.code === "OPENAI_CODEX_AUTH_REQUIRED") {
      return { connected: false, requiresReauth: false };
    }

    this.logger.error("Failed to determine OpenAI Codex connection status", {
      error: result.error,
      fields: { userId },
    });
    return { connected: false, requiresReauth: false };
  }

  /**
   * Deletes stored OpenAI Codex credentials for a user.
   * @param userId Authenticated user id.
   */
  async disconnect(userId: string): Promise<void> {
    await this.userProviderCredentialRepository.deleteByUserAndProvider(
      userId,
      OPENAI_CODEX_PROVIDER_ID,
    );
  }

  /**
   * Returns valid OpenAI Codex credentials, refreshing them when needed.
   * @param userId Authenticated user id.
   * @returns Result with current valid credentials, or an OpenAICodexAuthError on auth failure.
   */
  async getValidCredentials(userId: string): Promise<Result<OpenAICodexCredentials, OpenAICodexAuthError>> {
    return this.refreshCredentialsIfNeeded(userId);
  }

  /**
   * Refreshes OpenAI Codex credentials if they are close to expiry.
   * @param userId Authenticated user id.
   * @returns Result with current valid credentials, or an OpenAICodexAuthError on auth failure.
   */
  async refreshCredentialsIfNeeded(userId: string): Promise<Result<OpenAICodexCredentials, OpenAICodexAuthError>> {
    const record = await this.userProviderCredentialRepository.getByUserProviderAndMethod(
      userId,
      OPENAI_CODEX_PROVIDER_ID,
      OPENAI_CODEX_AUTH_METHOD,
    );
    if (!record) {
      return failure(openAICodexAuthError("OPENAI_CODEX_AUTH_REQUIRED", "Codex authentication required.", 401));
    }
    if (record.requiresReauth) {
      return failure(openAICodexAuthError("OPENAI_CODEX_REAUTH_REQUIRED", "Codex authentication expired. Reconnect Codex.", 401));
    }

    const decryptedJson = await readStoredCredentialJson(
      record.encryptedCredentials,
      this.env.TOKEN_ENCRYPTION_KEY,
    );
    const credentials = parseStoredCredentials(decryptedJson);

    if (!credentials.refreshToken) {
      await this.userProviderCredentialRepository.markRequiresReauth(
        userId,
        OPENAI_CODEX_PROVIDER_ID,
        OPENAI_CODEX_AUTH_METHOD,
      );
      return failure(openAICodexAuthError("OPENAI_CODEX_REAUTH_REQUIRED", "OpenAI Codex refresh token is unavailable. Reconnect OpenAI Codex.", 401));
    }

    if (!credentials.idToken) {
      await this.userProviderCredentialRepository.markRequiresReauth(
        userId,
        OPENAI_CODEX_PROVIDER_ID,
        OPENAI_CODEX_AUTH_METHOD,
      );
      return failure(openAICodexAuthError("OPENAI_CODEX_REAUTH_REQUIRED", "OpenAI Codex ID token is unavailable. Reconnect OpenAI Codex.", 401));
    }

    if (!needsRefresh(credentials.expiresAt)) {
      return success(credentials);
    }

    const tokenResult = await this.postTokenRequest(
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: credentials.refreshToken,
        client_id: OPENAI_CLIENT_ID,
      }),
      "refresh_token",
    );
    if (!tokenResult.ok) {
      if (tokenResult.error.code === "OPENAI_CODEX_REAUTH_REQUIRED") {
        await this.userProviderCredentialRepository.markRequiresReauth(
          userId,
          OPENAI_CODEX_PROVIDER_ID,
          OPENAI_CODEX_AUTH_METHOD,
        );
      }
      return failure(tokenResult.error);
    }

    const credentialsResult = this.parseTokenResponse(tokenResult.value, credentials);
    if (!credentialsResult.ok) {
      return failure(credentialsResult.error);
    }

    await this.persistCredentials(userId, credentialsResult.value);
    return success(credentialsResult.value);
  }

  private parseTokenResponse(
    tokenData: OpenAICodexTokenResponse,
    fallback: OpenAICodexCredentials | null,
  ): Result<OpenAICodexCredentials, OpenAICodexAuthError> {
    if (typeof tokenData.access_token !== "string") {
      return failure(openAICodexAuthError(
        "OPENAI_CODEX_TOKEN_EXCHANGE_FAILED",
        "OpenAI Codex token response did not include an access token.",
        400,
      ));
    }

    const refreshToken = typeof tokenData.refresh_token === "string"
      ? tokenData.refresh_token
      : (fallback?.refreshToken ?? null);
    if (!refreshToken) {
      return failure(openAICodexAuthError(
        "OPENAI_CODEX_TOKEN_EXCHANGE_FAILED",
        "OpenAI Codex token response did not include a usable refresh token.",
        400,
      ));
    }

    const idToken = typeof tokenData.id_token === "string"
      ? tokenData.id_token
      : (fallback?.idToken ?? null);
    if (!idToken) {
      return failure(openAICodexAuthError(
        "OPENAI_CODEX_TOKEN_EXCHANGE_FAILED",
        "OpenAI Codex token response did not include a usable ID token.",
        400,
      ));
    }

    return success({
      accessToken: tokenData.access_token,
      refreshToken,
      idToken,
      expiresAt: deriveExpiryIsoString(tokenData.access_token, tokenData.expires_in)
        ?? fallback?.expiresAt
        ?? null,
    });
  }

  private async persistCredentials(
    userId: string,
    credentials: OpenAICodexCredentials,
  ): Promise<void> {
    const encryptedCredentials = await encrypt(
      JSON.stringify(credentials),
      this.env.TOKEN_ENCRYPTION_KEY,
    );

    await this.userProviderCredentialRepository.upsert({
      userId,
      providerId: OPENAI_CODEX_PROVIDER_ID,
      authMethod: OPENAI_CODEX_AUTH_METHOD,
      encryptedCredentials,
      requiresReauth: false,
    });
  }

  private async pollDeviceAuthCode(
    context: OpenAICodexDeviceAttemptContext,
  ): Promise<Result<{ authorizationCode: string; codeVerifier: string }, OpenAICodexAuthError>> {
    let response: Response;
    try {
      response = await fetch(OPENAI_DEVICE_AUTH_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          device_auth_id: context.deviceAuthId,
          user_code: context.userCode,
        }),
      });
    } catch (error) {
      this.logger.error("OpenAI Codex device auth poll request failed", { error });
      return failure(openAICodexAuthError(
        "OPENAI_CODEX_TOKEN_EXCHANGE_FAILED",
        "Failed to contact OpenAI Codex device authorization endpoint.",
        502,
      ));
    }

    const rawText = await response.text();
    let payload: OpenAICodexDevicePollResponse;
    try {
      payload = JSON.parse(rawText) as OpenAICodexDevicePollResponse;
    } catch {
      payload = {};
    }

    if (response.status === 403 || response.status === 404) {
      return failure(openAICodexAuthError(
        "OPENAI_CODEX_TOKEN_EXCHANGE_FAILED",
        getDeviceAuthErrorMessage(payload) ?? "OpenAI Codex device authorization is pending.",
        response.status,
      ));
    }

    if (!response.ok) {
      return failure(openAICodexAuthError(
        "OPENAI_CODEX_TOKEN_EXCHANGE_FAILED",
        getDeviceAuthErrorMessage(payload) ?? "OpenAI Codex device authorization failed.",
        response.status >= 400 && response.status < 600 ? response.status : 502,
      ));
    }

    if (
      typeof payload.authorization_code !== "string" ||
      typeof payload.code_verifier !== "string"
    ) {
      return failure(openAICodexAuthError(
        "OPENAI_CODEX_TOKEN_EXCHANGE_FAILED",
        "OpenAI Codex device authorization response was missing the authorization code.",
        502,
      ));
    }

    return success({
      authorizationCode: payload.authorization_code,
      codeVerifier: payload.code_verifier,
    });
  }


  private async postTokenRequest(
    body: URLSearchParams,
    grantType: "authorization_code" | "refresh_token",
  ): Promise<Result<OpenAICodexTokenResponse, OpenAICodexAuthError>> {
    let response: Response;
    try {
      response = await fetch(OPENAI_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
    } catch (error) {
      this.logger.error("OpenAI Codex token request failed", { error });
      return failure(openAICodexAuthError(
        grantType === "authorization_code"
          ? "OPENAI_CODEX_TOKEN_EXCHANGE_FAILED"
          : "OPENAI_CODEX_TOKEN_REFRESH_FAILED",
        "Failed to contact OpenAI Codex auth endpoint.",
        502,
      ));
    }
    const rawText = await response.text();
    let tokenData: OpenAICodexTokenResponse;
    try {
      tokenData = JSON.parse(rawText) as OpenAICodexTokenResponse;
    } catch {
      tokenData = {};
    }

    if (response.ok) {
      return success(tokenData);
    }

    const errorDescription = tokenData.error_description ?? "OpenAI Codex token request failed.";
    const authErrorCode = tokenData.error;
    this.logger.error("OpenAI Codex token request failed", { error: tokenData });
    if (authErrorCode === "authorization_pending" || authErrorCode === "slow_down") {
      return failure(openAICodexAuthError("OPENAI_CODEX_TOKEN_EXCHANGE_FAILED", authErrorCode, 400));
    }
    if (authErrorCode === "expired_token" || authErrorCode === "access_denied") {
      return failure(openAICodexAuthError("OPENAI_CODEX_REAUTH_REQUIRED", authErrorCode, 401));
    }
    if (authErrorCode === "invalid_grant" || response.status === 401) {
      return failure(openAICodexAuthError("OPENAI_CODEX_REAUTH_REQUIRED", errorDescription, 401));
    }

    return failure(openAICodexAuthError(
      grantType === "authorization_code"
        ? "OPENAI_CODEX_TOKEN_EXCHANGE_FAILED"
        : "OPENAI_CODEX_TOKEN_REFRESH_FAILED",
      errorDescription,
      response.status >= 400 && response.status < 600 ? response.status : 502,
    ));
  }
}
