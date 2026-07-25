import type { NetworkAccessConfig, ProviderId } from "@repo/shared";
import type { NetworkPolicyRule } from "./WorkersSpriteClient";

/** Allow rule helper */
function allow(domain: string): NetworkPolicyRule {
  return { domain, action: "allow" };
}

function denyAll(): NetworkPolicyRule {
  return { domain: "*", action: "deny" };
}

function appendDenyAll(rules: NetworkPolicyRule[]): NetworkPolicyRule[] {
  return [...rules, denyAll()];
}

/**
 * Default network allow rules for Sprite VMs.
 * Based on Claude Code's trusted domain list:
 * https://code.claude.com/docs/en/claude-code-on-the-web#default-allowed-domains
 */
const DEFAULT_NETWORK_ALLOW_RULES: NetworkPolicyRule[] = [
  // --- Anthropic Services ---
  // TODO: maybe filter allowlist by provider?
  allow("api.anthropic.com"),
  allow("statsig.anthropic.com"),
  allow("platform.claude.com"),
  allow("code.claude.com"),
  allow("claude.ai"),
  allow("openai.com"),
  allow("auth.openai.com"),
  allow("chatgpt.com"),
  allow("chat.com"),
  allow("ai-sdk.dev"),

  // --- Version Control ---
  allow("github.com"),
  allow("www.github.com"),
  allow("api.github.com"),
  allow("npm.pkg.github.com"),
  allow("raw.githubusercontent.com"),
  allow("pkg-npm.githubusercontent.com"),
  allow("objects.githubusercontent.com"),
  allow("release-assets.githubusercontent.com"),
  allow("codeload.github.com"),
  allow("avatars.githubusercontent.com"),
  allow("camo.githubusercontent.com"),
  allow("gist.github.com"),
  allow("gitlab.com"),
  allow("www.gitlab.com"),
  allow("registry.gitlab.com"),
  allow("bitbucket.org"),
  allow("www.bitbucket.org"),
  allow("api.bitbucket.org"),

  // --- Container Registries ---
  allow("registry-1.docker.io"),
  allow("auth.docker.io"),
  allow("index.docker.io"),
  allow("hub.docker.com"),
  allow("www.docker.com"),
  allow("production.cloudflare.docker.com"),
  allow("download.docker.com"),
  allow("gcr.io"),
  allow("*.gcr.io"),
  allow("ghcr.io"),
  allow("mcr.microsoft.com"),
  allow("*.data.mcr.microsoft.com"),
  allow("public.ecr.aws"),

  // --- Cloud Platforms ---
  allow("cloud.google.com"),
  allow("accounts.google.com"),
  allow("gcloud.google.com"),
  allow("*.googleapis.com"),
  allow("storage.googleapis.com"),
  allow("compute.googleapis.com"),
  allow("container.googleapis.com"),
  allow("azure.com"),
  allow("portal.azure.com"),
  allow("microsoft.com"),
  allow("www.microsoft.com"),
  allow("*.microsoftonline.com"),
  allow("packages.microsoft.com"),
  allow("dotnet.microsoft.com"),
  allow("dot.net"),
  allow("visualstudio.com"),
  allow("dev.azure.com"),
  allow("*.amazonaws.com"),
  allow("*.api.aws"),
  allow("oracle.com"),
  allow("www.oracle.com"),
  allow("java.com"),
  allow("www.java.com"),
  allow("java.net"),
  allow("www.java.net"),
  allow("download.oracle.com"),
  allow("yum.oracle.com"),

  // --- Package Managers: JavaScript/Node ---
  allow("registry.npmjs.org"),
  allow("www.npmjs.com"),
  allow("www.npmjs.org"),
  allow("npmjs.com"),
  allow("npmjs.org"),
  allow("yarnpkg.com"),
  allow("registry.yarnpkg.com"),

  // --- Package Managers: Python ---
  allow("astral.sh"),
  allow("www.astral.sh"),
  allow("pypi.org"),
  allow("www.pypi.org"),
  allow("files.pythonhosted.org"),
  allow("pythonhosted.org"),
  allow("test.pypi.org"),
  allow("pypi.python.org"),
  allow("pypa.io"),
  allow("www.pypa.io"),

  // --- Package Managers: Ruby ---
  allow("rubygems.org"),
  allow("www.rubygems.org"),
  allow("api.rubygems.org"),
  allow("index.rubygems.org"),
  allow("ruby-lang.org"),
  allow("www.ruby-lang.org"),
  allow("rubyforge.org"),
  allow("www.rubyforge.org"),
  allow("rubyonrails.org"),
  allow("www.rubyonrails.org"),
  allow("rvm.io"),
  allow("get.rvm.io"),

  // --- Package Managers: Rust ---
  allow("crates.io"),
  allow("www.crates.io"),
  allow("index.crates.io"),
  allow("static.crates.io"),
  allow("rustup.rs"),
  allow("static.rust-lang.org"),
  allow("www.rust-lang.org"),

  // --- Package Managers: Go ---
  allow("proxy.golang.org"),
  allow("sum.golang.org"),
  allow("index.golang.org"),
  allow("golang.org"),
  allow("www.golang.org"),
  allow("goproxy.io"),
  allow("pkg.go.dev"),

  // --- Package Managers: JVM ---
  allow("maven.org"),
  allow("repo.maven.org"),
  allow("central.maven.org"),
  allow("repo1.maven.org"),
  allow("jcenter.bintray.com"),
  allow("gradle.org"),
  allow("www.gradle.org"),
  allow("services.gradle.org"),
  allow("plugins.gradle.org"),
  allow("kotlin.org"),
  allow("www.kotlin.org"),
  allow("spring.io"),
  allow("repo.spring.io"),

  // --- Package Managers: Other Languages ---
  allow("packagist.org"),
  allow("www.packagist.org"),
  allow("repo.packagist.org"),
  allow("nuget.org"),
  allow("www.nuget.org"),
  allow("api.nuget.org"),
  allow("pub.dev"),
  allow("api.pub.dev"),
  allow("hex.pm"),
  allow("www.hex.pm"),
  allow("cpan.org"),
  allow("www.cpan.org"),
  allow("metacpan.org"),
  allow("www.metacpan.org"),
  allow("api.metacpan.org"),
  allow("cocoapods.org"),
  allow("www.cocoapods.org"),
  allow("cdn.cocoapods.org"),
  allow("haskell.org"),
  allow("www.haskell.org"),
  allow("hackage.haskell.org"),
  allow("swift.org"),
  allow("www.swift.org"),

  // --- Linux Distributions ---
  allow("archive.ubuntu.com"),
  allow("security.ubuntu.com"),
  allow("ubuntu.com"),
  allow("www.ubuntu.com"),
  allow("*.ubuntu.com"),
  allow("ppa.launchpad.net"),
  allow("launchpad.net"),
  allow("www.launchpad.net"),

  // --- Development Tools & Platforms ---
  allow("dl.k8s.io"),
  allow("pkgs.k8s.io"),
  allow("k8s.io"),
  allow("www.k8s.io"),
  allow("releases.hashicorp.com"),
  allow("apt.releases.hashicorp.com"),
  allow("rpm.releases.hashicorp.com"),
  allow("archive.releases.hashicorp.com"),
  allow("hashicorp.com"),
  allow("www.hashicorp.com"),
  allow("repo.anaconda.com"),
  allow("conda.anaconda.org"),
  allow("anaconda.org"),
  allow("www.anaconda.com"),
  allow("anaconda.com"),
  allow("continuum.io"),
  allow("apache.org"),
  allow("www.apache.org"),
  allow("archive.apache.org"),
  allow("downloads.apache.org"),
  allow("eclipse.org"),
  allow("www.eclipse.org"),
  allow("download.eclipse.org"),
  allow("nodejs.org"),
  allow("www.nodejs.org"),

  // --- Cloud Services & Monitoring ---
  allow("statsig.com"),
  allow("www.statsig.com"),
  allow("api.statsig.com"),
  allow("sentry.io"),
  allow("*.sentry.io"),
  allow("http-intake.logs.datadoghq.com"),
  allow("*.datadoghq.com"),
  allow("*.datadoghq.eu"),

  // --- Content Delivery & Mirrors ---
  allow("sourceforge.net"),
  allow("*.sourceforge.net"),
  allow("packagecloud.io"),
  allow("*.packagecloud.io"),

  // --- Schema & Configuration ---
  allow("json-schema.org"),
  allow("www.json-schema.org"),
  allow("json.schemastore.org"),
  allow("www.schemastore.org"),

  // --- Model Context Protocol ---
  allow("*.modelcontextprotocol.io"),
];

export const DEFAULT_NETWORK_POLICY: NetworkPolicyRule[] = appendDenyAll(
  DEFAULT_NETWORK_ALLOW_RULES,
);

/** Build a full policy from the default allowlist plus extra rules before the terminal deny-all. */
export function buildNetworkPolicy(
  extraRules: NetworkPolicyRule[],
): NetworkPolicyRule[] {
  return appendDenyAll([...DEFAULT_NETWORK_ALLOW_RULES, ...extraRules]);
}

export function getDefaultNetworkAllowlistDomains(): string[] {
  return DEFAULT_NETWORK_ALLOW_RULES.map((rule) => rule.domain);
}

export function buildBootstrapNetworkPolicy(args: {
  workerHostname: string;
}): NetworkPolicyRule[] {
  return buildNetworkPolicy([allow(args.workerHostname)]);
}

export function buildFinalNetworkPolicy(args: {
  workerHostname: string;
  providerId: ProviderId;
  network: NetworkAccessConfig;
}): NetworkPolicyRule[] {
  switch (args.network.mode) {
    case "open":
      return [{ domain: "*", action: "allow" }];
    case "default":
      return buildNetworkPolicy([allow(args.workerHostname)]);
    case "custom": {
      const customRules = [
        allow(args.workerHostname),
        ...args.network.extraAllowlist.map(allow),
      ];
      return args.network.includeDefaultAllowlist
        ? buildNetworkPolicy(customRules)
        : appendDenyAll([
            ...customRules,
            ...getProviderNetworkPolicyRules(args.providerId),
          ]);
    }
    case "locked":
      return appendDenyAll([
        allow(args.workerHostname),
        ...getProviderNetworkPolicyRules(args.providerId),
      ]);
    default: {
      const exhaustiveCheck: never = args.network;
      throw new Error(`Unhandled network mode: ${exhaustiveCheck}`);
    }
  }
}

export function getProviderNetworkPolicyRules(
  providerId: ProviderId,
): NetworkPolicyRule[] {
  switch (providerId) {
    case "claude-code":
      return [
        allow("api.anthropic.com"),
        allow("statsig.anthropic.com"),
        allow("platform.claude.com"),
        allow("code.claude.com"),
        allow("claude.ai"),
      ];
    case "openai-codex":
      return [
        allow("api.openai.com"),
        allow("openai.com"),
        allow("auth.openai.com"),
        allow("chatgpt.com"),
        allow("chat.com"),
      ];
    default: {
      const exhaustiveCheck: never = providerId;
      throw new Error(`Unhandled provider: ${exhaustiveCheck}`);
    }
  }
}
