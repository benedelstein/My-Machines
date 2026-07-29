interface DiscordCommandOption {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  max_length?: number;
}

interface DiscordCommandBody {
  name: string;
  description: string;
  type: number;
  options: DiscordCommandOption[];
}

const APPLICATION_COMMAND_TYPE_CHAT_INPUT = 1;
const OPTION_TYPE_STRING = 3;

const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!applicationId || !botToken) {
  throw new Error("Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN before registering the command.");
}

const command: DiscordCommandBody = {
  name: "session",
  description: "Create a My Machines session from a natural-language prompt.",
  type: APPLICATION_COMMAND_TYPE_CHAT_INPUT,
  options: [
    {
      type: OPTION_TYPE_STRING,
      name: "prompt",
      description: "What should My Machines change, including the repo hint.",
      required: true,
      max_length: 4000,
    },
  ],
};

const route = guildId
  ? `/applications/${applicationId}/guilds/${guildId}/commands`
  : `/applications/${applicationId}/commands`;

const response = await fetch(`https://discord.com/api/v10${route}`, {
  method: "POST",
  headers: {
    "Authorization": `Bot ${botToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(command),
});

if (!response.ok) {
  throw new Error(`Failed to register Discord command: ${response.status} ${await response.text()}`);
}

process.stdout.write(`Registered /session command: ${await response.text()}\n`);

export {};
