import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  REST,
  Routes,
} from 'discord.js';
import { supabase } from './supabase.js';
import { log } from './logger.js';
import { loadAllGuildConfigs, getGuildConfig, getActiveContest, refreshGuildConfig } from './config.js';
import { handleScreenshotMessage, handleVoteReaction } from './participation.js';
import { handleInteraction } from './commands/handlers.js';
import { commands } from './commands/index.js';
import { startScheduler, stopScheduler } from './scheduler.js';

function createClient() {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });
}

async function resolveReaction(reaction) {
  if (reaction.partial) await reaction.fetch().catch(() => null);
  if (reaction.message.partial) await reaction.message.fetch().catch(() => null);
  if (reaction.partial || reaction.message.partial) return null;
  return reaction;
}

export async function connectBot(env) {
  console.log(`[BOT] Connecting to Discord as environment "${env.name}"...`);

  const client = createClient();

  client.once(Events.ClientReady, async () => {
    console.log(`[BOT] Logged in as ${client.user.tag} (env: ${env.name})`);

    // Register slash commands on this specific Discord application
    const rest = new REST({ version: '10' }).setToken(env.discord_bot_token);
    await rest.put(Routes.applicationCommands(env.discord_app_id), { body: commands })
      .catch(err => console.error('[BOT] Failed to register slash commands:', err.message));

    await loadAllGuildConfigs();

    for (const guild of client.guilds.cache.values()) {
      await supabase
        .from('discord_guild_configs')
        .update({ bot_present: true, last_sync: new Date().toISOString() })
        .eq('guild_id', guild.id);
    }

    startScheduler(client);

    await log(null, 'bot_connected', { environment: env.name, guilds: client.guilds.cache.size });
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
    if (message.author.bot || !message.guildId) return;
    const config = await getGuildConfig(message.guildId);
    if (!config) return;
    if (message.channelId !== config.guildConfig.contest_channel_id) return;
    const contest = await getActiveContest(config.guildConfig.environment_id);
    if (!contest) return;
    await handleScreenshotMessage(message, config.guildConfig, contest);
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    console.log(`[REACTION] Add: ${reaction.emoji.name} by ${user.tag} on ${reaction.message.id}`);
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

  client.on(Events.MessageDelete, async message => {
    if (!message.guildId) return;
    const config = await getGuildConfig(message.guildId);
    if (!config) return;
    if (message.channelId !== config.guildConfig.contest_channel_id) return;

    const { data: participation } = await supabase
      .from('participations')
      .select('id, participant_id, participants(discord_user_id, discord_username)')
      .eq('message_id', message.id)
      .single();

    if (!participation) return;

    await supabase.from('participations').delete().eq('id', participation.id);
    await log(message.guildId, 'participation_deleted', {
      messageId: message.id,
      participantId: participation.participant_id,
    });
    console.log(`[BOT] Participation deleted for message ${message.id}`);
  });

  client.on(Events.InteractionCreate, interaction => handleInteraction(interaction, client));
  client.on(Events.Error, err => console.error('[BOT] Discord error:', err.message));

  await client.login(env.discord_bot_token);
  return client;
}

export async function disconnectBot(client, envName) {
  if (!client) return;
  stopScheduler();

  // Mark all guilds as bot not present
  for (const guild of client.guilds.cache.values()) {
    await supabase
      .from('discord_guild_configs')
      .update({ bot_present: false })
      .eq('guild_id', guild.id);
  }

  await log(null, 'bot_disconnected', { environment: envName });
  await client.destroy();
  console.log(`[BOT] Disconnected from Discord (env: ${envName})`);
}
