import { z } from "zod";
import { isInternalHostname } from "./internal-hostname";

const httpsUrl = z.string().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    context.addIssue({
      code: "custom",
      message: "HTTPS is required",
    });
  }
  if (url.username.length > 0 || url.password.length > 0) {
    context.addIssue({
      code: "custom",
      message: "URL userinfo is not allowed",
    });
  }
  if (isInternalHostname(url.hostname)) {
    context.addIssue({
      code: "custom",
      message: "Internal hostnames are not allowed",
    });
  }
});

const safeHeaderValue = z.string().max(128).refine((value) => !/[\r\n]/u.test(value), {
  message: "Header values cannot contain newlines",
});

const spriteLabel = z.string().max(63).regex(
  /^(session|env):[A-Za-z0-9][A-Za-z0-9_-]{7,}$/u,
  "Labels must be session:<id> or env:<id> with an id of at least 8 characters",
);

const MintConnectorRequestBaseSchema = z.object({
  name: z.string().min(1).max(100).refine((value) => !/[\r\n]/u.test(value)),
  baseApiUrl: httpsUrl,
  token: z.string().min(1).max(16_384),
  testUrl: httpsUrl,
  headerName: z.literal("Authorization").default("Authorization"),
  headerPrefix: safeHeaderValue.default("Bearer"),
  spriteLabels: z.array(spriteLabel).min(1).max(16),
  allowedEndpoints: z.array(z.string().min(1).max(256)).min(1).max(32).optional(),
});

function requireMatchingTestOrigin(
  value: z.infer<typeof MintConnectorRequestBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (new URL(value.baseApiUrl).origin !== new URL(value.testUrl).origin) {
    context.addIssue({
      code: "custom",
      path: ["testUrl"],
      message: "Test URL must use the base API origin",
    });
  }
}

function requireSessionEndpointPins(
  value: z.infer<typeof MintConnectorRequestBaseSchema>,
  context: z.RefinementCtx,
): void {
  const isSessionConnector = value.spriteLabels.every((label) => label.startsWith("session:"));
  if (isSessionConnector && value.allowedEndpoints === undefined) {
    context.addIssue({
      code: "custom",
      path: ["allowedEndpoints"],
      message: "Session connectors must pin allowedEndpoints",
    });
  }
}

export const MintConnectorRequestSchema = MintConnectorRequestBaseSchema
  .superRefine(requireMatchingTestOrigin)
  .superRefine(requireSessionEndpointPins);

export type MintConnectorRequest = z.infer<typeof MintConnectorRequestSchema>;
