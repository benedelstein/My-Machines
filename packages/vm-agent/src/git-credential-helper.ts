#!/usr/bin/env bun

export {};

const [remoteUrlValue, mintUrl, operation] = process.argv.slice(2);

if (operation !== "get") {
  process.exit(0);
}
if (!remoteUrlValue || !mintUrl) {
  process.stderr.write("Git credential helper is missing its configured URLs\n");
  process.exit(1);
}

const remote = new URL(remoteUrlValue);
const input = await Bun.stdin.text();
const values = Object.fromEntries(
  input
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      return separator < 0
        ? [line, ""]
        : [line.slice(0, separator), line.slice(separator + 1)];
    }),
);

if (
  values.protocol !== remote.protocol.slice(0, -1)
  || values.host !== remote.host
  || values.path !== remote.pathname.slice(1)
) {
  process.exit(0);
}

let response: Response | undefined;
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    response = await fetch(mintUrl, {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    if (response.ok || response.status < 500) {
      break;
    }
  } catch {
    // Retry transient network failures below.
  }
  if (attempt < 2) {
    await Bun.sleep(100 * (attempt + 1));
  }
}

if (!response?.ok) {
  process.stderr.write("Git credential mint failed\n");
  process.exit(1);
}

const body: unknown = await response.json();
if (
  typeof body !== "object"
  || body === null
  || !("token" in body)
  || typeof body.token !== "string"
  || !body.token
  || !("expiresAt" in body)
  || !Number.isInteger(body.expiresAt)
) {
  process.stderr.write("Git credential mint returned an invalid response\n");
  process.exit(1);
}

process.stdout.write(
  `username=x-ephemeral-git-token\npassword=${body.token}\n\n`,
);
