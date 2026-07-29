import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@repo/vm-agent/dist/git-credential-helper.bundle.js": fileURLToPath(
        new URL("./tests/git-credential-helper.bundle.mock.ts", import.meta.url),
      ),
      "cloudflare:workers": fileURLToPath(
        new URL("./tests/cloudflare-workers.mock.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
  },
});
