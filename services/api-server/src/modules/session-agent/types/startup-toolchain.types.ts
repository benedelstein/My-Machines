import { z } from "zod";

export const StartupToolchainCheckStatus = z.literal("ready");
export type StartupToolchainCheckStatus = z.infer<typeof StartupToolchainCheckStatus>;

export const StartupToolchainCheckResult = z.object({
  id: z.string(),
  status: StartupToolchainCheckStatus,
  requiredVersion: z.string().optional(),
});
export type StartupToolchainCheckResult = z.infer<typeof StartupToolchainCheckResult>;

export const StartupToolchainCheckpoint = z.object({
  contractHash: z.string(),
  checkedAt: z.number(),
  results: z.array(StartupToolchainCheckResult),
});
export type StartupToolchainCheckpoint = z.infer<typeof StartupToolchainCheckpoint>;
