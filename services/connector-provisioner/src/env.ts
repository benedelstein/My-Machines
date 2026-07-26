import type { BrowserWorker } from "@cloudflare/playwright";

export interface Env {
  BROWSER: BrowserWorker;
  CONNECTOR_PROVISIONER_BEARER_TOKEN: string;
  SPRITES_API_KEY: string;
  SPRITES_API_URL: string;
  SPRITES_DASHBOARD_STORAGE_STATE: string;
  SPRITES_DASHBOARD_URL: string;
  SPRITES_ORG_SLUG: string;
}

export function hasBaseConfiguration(env: Env): boolean {
  return [
    env.CONNECTOR_PROVISIONER_BEARER_TOKEN,
    env.SPRITES_API_KEY,
    env.SPRITES_API_URL,
  ].every((value) => typeof value === "string" && value.length > 0);
}

export function hasMintConfiguration(env: Env): boolean {
  return [
    env.SPRITES_DASHBOARD_STORAGE_STATE,
    env.SPRITES_DASHBOARD_URL,
    env.SPRITES_ORG_SLUG,
  ].every((value) => typeof value === "string" && value.length > 0)
    && typeof env.BROWSER?.fetch === "function";
}
