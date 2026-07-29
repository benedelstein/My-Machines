import { IntegrationSessionResponse } from "@repo/shared";
import { z } from "zod";

interface Env {
  API_BASE_URL: string;
  DISCORD_PUBLIC_KEY: string;
  INTEGRATION_SESSION_REQUEST_TOKEN: string;
}

const DiscordUserSchema = z.object({
  id: z.string(),
  username: z.string().optional(),
  global_name: z.string().nullable().optional(),
});

const DiscordInteractionSchema = z.object({
  type: z.number(),
  token: z.string().optional(),
  application_id: z.string().optional(),
  guild_id: z.string().optional(),
  channel_id: z.string().optional(),
  user: DiscordUserSchema.optional(),
  member: z.object({ user: DiscordUserSchema.optional() }).optional(),
  data: z.object({
    name: z.string().optional(),
    options: z.array(z.object({
      name: z.string(),
      type: z.number(),
      value: z.string().optional(),
    })).optional(),
  }).optional(),
});

type DiscordUser = z.infer<typeof DiscordUserSchema>;
type DiscordInteraction = z.infer<typeof DiscordInteractionSchema>;

const INTERACTION_TYPE_PING = 1;
const INTERACTION_TYPE_APPLICATION_COMMAND = 2;
const RESPONSE_TYPE_PONG = 1;
const RESPONSE_TYPE_CHANNEL_MESSAGE = 4;
const RESPONSE_TYPE_DEFERRED_CHANNEL_MESSAGE = 5;
const EPHEMERAL_FLAG = 64;
const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    const body = await request.text();
    const isVerified = await verifyDiscordRequest(request, body, env.DISCORD_PUBLIC_KEY);
    if (!isVerified) {
      return new Response("invalid request signature", { status: 401 });
    }

    const interaction = parseInteraction(body);
    if (!interaction) {
      return jsonResponse(channelMessage("Invalid Discord interaction payload."));
    }

    if (interaction.type === INTERACTION_TYPE_PING) {
      return jsonResponse({ type: RESPONSE_TYPE_PONG });
    }

    if (interaction.type !== INTERACTION_TYPE_APPLICATION_COMMAND) {
      return jsonResponse(channelMessage("Unsupported Discord interaction type."));
    }

    const prompt = getPrompt(interaction);
    const user = interaction.member?.user ?? interaction.user;
    const applicationId = interaction.application_id;
    const interactionToken = interaction.token;
    if (!prompt || !user || !applicationId || !interactionToken) {
      return jsonResponse(channelMessage("Use `/session prompt:<what to change>` to create a session."));
    }

    ctx.waitUntil(createSessionAndEditResponse({ env, prompt, user, applicationId, interactionToken }));
    return jsonResponse({
      type: RESPONSE_TYPE_DEFERRED_CHANNEL_MESSAGE,
      data: { flags: EPHEMERAL_FLAG },
    });
  },
};

async function createSessionAndEditResponse(params: {
  env: Env;
  prompt: string;
  user: DiscordUser;
  applicationId: string;
  interactionToken: string;
}): Promise<void> {
  let message = "I could not create a My Machines session. Something went wrong, please try again.";
  try {
    const response = await fetch(`${params.env.API_BASE_URL.replace(/\/$/, "")}/integrations/session-requests`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${params.env.INTEGRATION_SESSION_REQUEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        externalUser: {
          provider: "discord",
          id: params.user.id,
          displayName: params.user.global_name ?? params.user.username,
          username: params.user.username,
        },
        prompt: params.prompt,
      }),
    });
    message = await buildDiscordMessage(response);
  } catch {
    // Fall through and report the generic failure so the deferred response never hangs.
  }

  await editOriginalInteractionResponse({
    applicationId: params.applicationId,
    interactionToken: params.interactionToken,
    content: message,
  });
}

async function buildDiscordMessage(response: Response): Promise<string> {
  if (!response.ok) {
    return "I could not create a My Machines session. The API rejected the request.";
  }

  const parsed = IntegrationSessionResponse.safeParse(await response.json());
  if (!parsed.success) {
    return "I could not create a My Machines session. The API returned an unexpected response.";
  }

  if (!parsed.data.ok) {
    if (parsed.data.linkUrl) {
      const expires = parsed.data.linkExpiresAt
        ? ` This link expires at ${new Date(parsed.data.linkExpiresAt).toLocaleString()}.`
        : "";
      return truncateDiscordMessage(
        `${parsed.data.message} ${parsed.data.linkUrl}${expires}`,
      );
    }

    const candidates = parsed.data.candidates?.map((candidate) => `- ${candidate.repoFullName}`).join("\n");
    return truncateDiscordMessage([
      `I could not create a session: ${parsed.data.message}`,
      candidates ? `\nPossible repos:\n${candidates}` : "",
    ].join(""));
  }

  const title = parsed.data.title ? ` (${parsed.data.title})` : "";
  const link = parsed.data.sessionUrl ? `\n${parsed.data.sessionUrl}` : "";
  const reason = parsed.data.routingReason ? `\nRouting: ${parsed.data.routingReason}` : "";
  return truncateDiscordMessage(
    `Started a My Machines session in ${parsed.data.repoFullName}${title}.${link}${reason}`,
  );
}

async function editOriginalInteractionResponse(params: {
  applicationId: string;
  interactionToken: string;
  content: string;
}): Promise<void> {
  await fetch(
    `${DISCORD_API_BASE_URL}/webhooks/${params.applicationId}/${params.interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: params.content,
        allowed_mentions: { parse: [] },
      }),
    },
  );
}

function channelMessage(content: string) {
  return {
    type: RESPONSE_TYPE_CHANNEL_MESSAGE,
    data: {
      content,
      flags: EPHEMERAL_FLAG,
      allowed_mentions: { parse: [] },
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

function parseInteraction(body: string): DiscordInteraction | null {
  try {
    const parsed = DiscordInteractionSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function getPrompt(interaction: DiscordInteraction): string | null {
  if (interaction.data?.name !== "session") {
    return null;
  }
  const option = interaction.data.options?.find((item) => item.name === "prompt");
  return typeof option?.value === "string" && option.value.trim()
    ? option.value.trim()
    : null;
}

async function verifyDiscordRequest(
  request: Request,
  body: string,
  publicKeyHex: string,
): Promise<boolean> {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp) {
    return false;
  }

  try {
    const publicKey = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      "Ed25519",
      false,
      ["verify"],
    );
    return crypto.subtle.verify(
      "Ed25519",
      publicKey,
      hexToBytes(signature),
      new TextEncoder().encode(`${timestamp}${body}`),
    );
  } catch {
    return false;
  }
}

function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[\da-f]+$/i.test(value)) {
    throw new Error("Invalid hex string");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function truncateDiscordMessage(value: string): string {
  return value.length <= 1900 ? value : `${value.slice(0, 1897)}...`;
}
