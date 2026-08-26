import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@repo/vm-agent/dist/git-credential-helper.bundle.js": fileURLToPath(
        new URL("./tests/git-credential-helper.bundle.mock.ts", import.meta.url),
      ),
      "@repo/vm-agent/dist/vm-agent-webhook.bundle.js": fileURLToPath(
        new URL("./tests/vm-agent-webhook.bundle.mock.ts", import.meta.url),
      ),
      "cloudflare:workers": fileURLToPath(
        new URL("./tests/cloudflare-workers.mock.ts", import.meta.url),
      ),
      "cloudflare:email": fileURLToPath(
        new URL("./tests/cloudflare-email.mock.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    server: {
      deps: {
        // Inline so the cloudflare:* aliases above apply inside the real SDK
        // when tests opt out of the global "agents" mock.
        inline: ["agents", "partyserver"],
      },
    },
  },
});
