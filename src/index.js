import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} from 'discord.js';

import { supabase } from './supabase.js';
import { log } from './logger.js';
import { loadAllGuildConfigs, getGuildConfig, getActiveContest, refreshGuildConfig } from './config.js';
import { handleScreenshotMessage, handleVoteReaction } from './participation.js';
import { handleInteraction } from './commands/handlers.js';
import { registerCommands } from './commands/index.js';
import { startScheduler } from './scheduler.js';

if (!process.env.DISCORD_BOT_TOKEN) {
  throw new Error('Missing DISCORD_BOT_TOKEN env variable');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Register slash commands
  await registerCommands(client);

  // Load all guild configurations from Supabase
  await loadAllGuildConfigs();

  // Mark bot as present in all current guilds
  for (const guild of client.guilds.cache.values()) {
    await supabase
      .from('discord_guild_configs')
      .update({ bot_present: true, last_sync: new Date().toISOString() })
      .eq('guild_id', guild.id);
  }

  startScheduler(client);

  await log(null, 'bot_started', { guilds: client.guilds.cache.size });
  console.log(`Bot ready on ${client.guilds.cache.size} guild(s).`);
});

client.on(Events.GuildCreate, async guild => {
  await refreshGuildConfig(guild.id);
  await supabase
    .from('discord_guild_configs')
    .upsert(
      { guild_id: guild.id, guild_name: guild.name, bot_present: true },
      { onConflict: 'guild_id', ignoreDuplicates: false }
    );
  await log(guild.id, 'guild_joined', { guildName: guild.name });
});

client.on(Events.GuildDelete, async guild => {
  await supabase
    .from('discord_guild_configs')
    .update({ bot_present: false })
    .eq('guild_id', guild.id);
  await log(guild.id, 'guild_left', { guildName: guild.name });
});

client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  if (!message.guildId) return;

  const config = await getGuildConfig(message.guildId);
  if (!config) return;

  const { guildConfig } = config;

  // Only process messages in the configured contest channel
  if (message.channelId !== guildConfig.contest_channel_id) return;

  const contest = await getActiveContest(guildConfig.environment_id);
  if (!contest) return;

  await handleScreenshotMessage(message, guildConfig, contest);
});

async function resolveReaction(reaction) {
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch {
      return null;
    }
  }
  if (reaction.message.partial) {
    try {
      await reaction.message.fetch();
    } catch {
      return null;
    }
  }
  return reaction;
}

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot) return;
  const r = await resolveReaction(reaction);
  if (!r) return;

  const guildId = r.message.guildId;
  if (!guildId) return;

  const config = await getGuildConfig(guildId);
  if (!config) return;

  const contest = await getActiveContest(config.guildConfig.environment_id);
  if (!contest) return;

  await handleVoteReaction(r, user, true, guildId, contest);
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
  if (user.bot) return;
  const r = await resolveReaction(reaction);
  if (!r) return;

  const guildId = r.message.guildId;
  if (!guildId) return;

  const config = await getGuildConfig(guildId);
  if (!config) return;

  const contest = await getActiveContest(config.guildConfig.environment_id);
  if (!contest) return;

  await handleVoteReaction(r, user, false, guildId, contest);
});

client.on(Events.InteractionCreate, async interaction => {
  await handleInteraction(interaction, client);
});

client.on(Events.Error, err => {
  console.error('Discord client error:', err.message);
});

client.login(process.env.DISCORD_BOT_TOKEN);
