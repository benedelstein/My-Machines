export async function launch(): Promise<never> {
  throw new Error("Cloudflare Browser Run is unavailable in Node unit tests");
}
