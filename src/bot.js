import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
} from 'discord.js';
import { supabase } from './supabase.js';
import { log, setLogClient } from './logger.js';
import { loadAllGuildConfigs, getGuildConfig, getActiveContest, refreshGuildConfig } from './config.js';
import { handleScreenshotMessage, handleVoteReaction } from './participation.js';
import { handleInteraction } from './commands/handlers.js';
import { commands, registerCommands } from './commands/index.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { resyncVotes } from './votes-resync.js';

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

    // Register slash commands on each guild (instant, no 1h propagation delay)
    await registerCommands(client, env.discord_bot_token);

    await loadAllGuildConfigs();

    for (const guild of client.guilds.cache.values()) {
      await supabase
        .from('discord_guild_configs')
        .update({ bot_present: true, last_sync: new Date().toISOString() })
        .eq('guild_id', guild.id);
    }

    setLogClient(client);
    await resyncVotes(client);
    startScheduler(client);
    watchContestChanges(client, env);

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
    const isMod = message.member?.permissions.has('ManageMessages') ?? false;
    const contest = await getActiveContest(config.guildConfig.environment_id);
    if (!contest) {
      // No active contest → admins/mods can write freely, others are blocked
      if (!isMod) {
        await message.delete().catch(() => null);
        await message.author.send(
          `❌ Le salon **#${message.channel?.name ?? 'concours'}** est réservé au concours screenshot.\nAucun concours n'est ouvert pour le moment.`
        ).catch(() => null);
      }
      return;
    }
    await handleScreenshotMessage(message, config.guildConfig, contest, config.contestSettings);
  });

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (user.bot) return;
    const r = await resolveReaction(reaction);
    if (!r) return;
    const guildId = r.message.guildId;
    if (!guildId) return;
    const config = await getGuildConfig(guildId);
    if (!config) return;
    if (r.message.channelId !== config.guildConfig.contest_channel_id) return;

    // Interdit : réaction sur un message du bot
    if (r.message.author?.bot) {
      await r.users.remove(user.id).catch(() => null);
      return;
    }

    // Interdit : toute réaction autre que ❤️
    if (r.emoji.name !== '❤️') {
      await r.users.remove(user.id).catch(() => null);
      return;
    }

    // Interdit : réaction sur une photo d'un concours fermé
    const { data: closedParticipation } = await supabase
      .from('participations')
      .select('id, contests!inner(status)')
      .eq('message_id', r.message.id)
      .eq('contests.status', 'closed')
      .limit(1)
      .single();
    if (closedParticipation) {
      await r.users.remove(user.id).catch(() => null);
      return;
    }

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

    // Block reaction removal on past winner photos for everyone (closed contests)
    if (r.message.channelId === config.guildConfig.contest_channel_id) {
      const { data: closedParticipation } = await supabase
        .from('participations')
        .select('id, contests!inner(status)')
        .eq('message_id', r.message.id)
        .eq('contests.status', 'closed')
        .limit(1)
        .single();
      if (closedParticipation) {
        // Discord ne permet pas de bloquer le retrait — le bot re-ajoute ❤️ pour figer le compteur
        await r.message.react('❤️').catch(() => null);
        return;
      }
    }

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

function watchContestChanges(client, env) {
  supabase
    .channel(`contests-${env.id}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'contests',
        filter: `environment_id=eq.${env.id}`,
      },
      async payload => {
        const contest = payload.new;
        const old = payload.old;
        if (contest.status === old.status) return;

        console.log(`[BOT] Contest ${contest.id} status: ${old.status} → ${contest.status}`);

        // Find the guild for this contest
        const { data: guildConfig } = await supabase
          .from('discord_guild_configs')
          .select('*')
          .eq('environment_id', env.id)
          .single();

        if (!guildConfig) return;

        const guild = client.guilds.cache.get(guildConfig.guild_id);
        if (!guild) return;

        const channel = guild.channels.cache.get(guildConfig.contest_channel_id);

        if (contest.status === 'active' && old.status === 'suspended') {
          if (channel) await channel.send('✅ **Le concours est réouvert !** Continuez à voter avec ❤️ !');
          await log(guildConfig.guild_id, 'contest_reopened_dashboard', { contestId: contest.id });

        } else if (contest.status === 'active' && !old.status) {
          // Opened from dashboard — opening message handled by openContest()

        } else if (contest.status === 'suspended') {
          if (channel) await channel.send('⏸️ **Le concours est temporairement suspendu** par un administrateur.');
          await log(guildConfig.guild_id, 'contest_suspended_dashboard', { contestId: contest.id });

        } else if (contest.status === 'closed') {
          // Closed from dashboard — trigger full close logic
          const { openContest, closeContest } = await import('./contest.js');
          const { data: contestSettings } = await supabase
            .from('contest_settings')
            .select('*')
            .eq('environment_id', env.id)
            .single();

          await closeContest(guild, guildConfig, contest, client);
        }
      }
    )
    .subscribe();
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
