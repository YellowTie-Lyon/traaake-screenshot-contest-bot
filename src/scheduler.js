import cron from 'node-cron';
import { supabase } from './supabase.js';
import { log } from './logger.js';
import { getGuildConfig } from './config.js';
import { closeContest, openContest } from './contest.js';
const tasks = [];

export function startScheduler(client) {
  const tz = { timezone: 'Europe/Paris' };
  // Sync guild channels/roles every 5 min
  tasks.push(cron.schedule('*/5 * * * *', () => syncGuilds(client)));
  // Check every minute: close expired active contests, auto-reopen
  tasks.push(cron.schedule('* * * * *', () => checkContests(client), tz));
  // Tiebreak: check every 30s for vote leader
  tasks.push(setInterval(() => checkTiebreak(client), 30000));
  // Monday 18h00 Paris: vote reminder @everyone
  tasks.push(cron.schedule('0 18 * * 1', () => sendVoteReminder(client), tz));
  // Wednesday 17h45 Paris: 10min warning before close
  tasks.push(cron.schedule('45 17 * * 3', () => sendContestWarning(client), tz));
  // Daily 18h Paris except Monday (vote reminder) and Wednesday (close day): promo classement
  tasks.push(cron.schedule('0 18 * * 0,2,4,5,6', () => sendDailyPromo(client), tz));

  console.log('[SCHEDULER] Started.');
}

export function stopScheduler() {
  for (const task of tasks) {
    if (typeof task.stop === 'function') task.stop();
    else clearInterval(task);
  }
  tasks.length = 0;
  console.log('[SCHEDULER] Stopped.');
}

// Runs every minute in production. Also callable via /contest check.
export async function checkContests(client) {
  const now = new Date();
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getGuildConfig(guild.id);
      if (!config) continue;
      const { guildConfig, contestSettings } = config;

      const { data: contest } = await supabase
        .from('contests')
        .select('*')
        .eq('environment_id', guildConfig.environment_id)
        .in('status', ['active', 'tiebreak'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!contest) continue;

      const endsAt = new Date(contest.ends_at);

      // Tiebreak handled by 30s interval — only fallback close here
      if (contest.status === 'tiebreak') {
        if (now >= endsAt) {
          await _closeAndScheduleReopen(guild, guildConfig, contest, contestSettings, client);
        }
        continue;
      }

      // Active contest expired → close
      if (now >= endsAt) {
        await _closeAndScheduleReopen(guild, guildConfig, contest, contestSettings, client);
      }

    } catch (err) {
      await log(guild.id, 'scheduler_error', { error: err.message }, 'error');
    }
  }
}

// Runs every 30s — only handles tiebreak resolution
async function checkTiebreak(client) {
  const now = new Date();
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getGuildConfig(guild.id);
      if (!config) continue;
      const { guildConfig, contestSettings } = config;

      const { data: contest } = await supabase
        .from('contests')
        .select('*')
        .eq('environment_id', guildConfig.environment_id)
        .eq('status', 'tiebreak')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!contest) continue;

      const endsAt = new Date(contest.ends_at);
      const { data: top2 } = await supabase
        .from('participations')
        .select('id, vote_count')
        .eq('contest_id', contest.id)
        .order('vote_count', { ascending: false })
        .limit(2);

      const stillTied = top2?.length >= 2 && top2[0].vote_count === top2[1].vote_count;
      if (!stillTied || now >= endsAt) {
        console.log(`[TIEBREAK] ${!stillTied ? 'Gagnant trouvé' : 'Délai expiré'} — fermeture`);
        await _closeAndScheduleReopen(guild, guildConfig, contest, contestSettings, client);
      }
    } catch (err) {
      await log(guild.id, 'tiebreak_check_error', { error: err.message }, 'error');
    }
  }
}

// Lundi 18h00 — rappel vote avec @everyone
async function sendVoteReminder(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getGuildConfig(guild.id);
      if (!config) continue;
      const { guildConfig } = config;

      const { data: contest } = await supabase
        .from('contests')
        .select('id, ends_at')
        .eq('environment_id', guildConfig.environment_id)
        .in('status', ['active', 'tiebreak'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!contest) continue;

      const channel = guild.channels.cache.get(guildConfig.contest_channel_id);
      if (!channel) continue;

      const closeTimestamp = Math.floor(new Date(contest.ends_at).getTime() / 1000);
      await channel.send({
        content: `@everyone 🗳️ **Rappel** — Le concours screenshot se termine <t:${closeTimestamp}:R> ! Votez pour vos screenshots préférés avec ❤️ 📸`,
        allowedMentions: { parse: ['everyone'] },
      });
      await log(guild.id, 'vote_reminder_sent', { contestId: contest.id });
      console.log(`[SCHEDULER] Rappel vote envoyé`);
    } catch (err) {
      await log(guild.id, 'vote_reminder_error', { error: err.message }, 'error');
    }
  }
}

// Mercredi 17h45 — warning 10 min avant fermeture
async function sendContestWarning(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getGuildConfig(guild.id);
      if (!config) continue;
      const { guildConfig } = config;

      const { data: contest } = await supabase
        .from('contests')
        .select('id, ends_at, warning_sent')
        .eq('environment_id', guildConfig.environment_id)
        .in('status', ['active', 'tiebreak'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!contest || contest.warning_sent) continue;

      const channel = guild.channels.cache.get(guildConfig.contest_channel_id);
      if (!channel) continue;

      const closeTimestamp = Math.floor(new Date(contest.ends_at).getTime() / 1000);
      await channel.send(`⚠️ **Le concours screenshot ferme** <t:${closeTimestamp}:R> ! Dernière chance pour voter et participer 📸`);
      await supabase.from('contests').update({ warning_sent: true }).eq('id', contest.id);
      await log(guild.id, 'contest_warning_sent', { contestId: contest.id });
      console.log(`[SCHEDULER] Warning fermeture envoyé`);
    } catch (err) {
      await log(guild.id, 'contest_warning_error', { error: err.message }, 'error');
    }
  }
}

// Called once on startup to recover a missed reopen (bot restarted during 2min window)
export async function checkPendingReopen(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getGuildConfig(guild.id);
      if (!config) continue;
      const { guildConfig, contestSettings } = config;

      const reopenDelayMinutes = contestSettings?.reopen_delay_minutes;
      if (!reopenDelayMinutes) continue;

      // Skip if a contest is already active
      const { data: active } = await supabase
        .from('contests')
        .select('id')
        .eq('environment_id', guildConfig.environment_id)
        .in('status', ['active', 'tiebreak'])
        .limit(1)
        .single();
      if (active) continue;

      // Check if last closed contest is within the reopen window
      const { data: lastClosed } = await supabase
        .from('contests')
        .select('id, closed_at')
        .eq('environment_id', guildConfig.environment_id)
        .eq('status', 'closed')
        .order('closed_at', { ascending: false })
        .limit(1)
        .single();

      if (!lastClosed?.closed_at) continue;

      const msElapsed = Date.now() - new Date(lastClosed.closed_at).getTime();
      const reopenMs = reopenDelayMinutes * 60000;

      if (msElapsed < reopenMs) {
        const remainingMs = reopenMs - msElapsed;
        console.log(`[STARTUP] Réouverture en attente détectée — dans ${Math.round(remainingMs / 1000)}s`);
        setTimeout(async () => {
          try {
            await openContest(guild, guildConfig, contestSettings, client);
            await log(guild.id, 'contest_auto_reopened', { guildName: guild.name, reason: 'startup_recovery' });
          } catch (err) {
            await log(guild.id, 'reopen_startup_failed', { error: err.message }, 'error');
          }
        }, remainingMs);
      }
    } catch (err) {
      console.error(`[STARTUP] checkPendingReopen error: ${err.message}`);
    }
  }
}

async function _closeAndScheduleReopen(guild, guildConfig, contest, contestSettings, client) {
  const result = await closeContest(guild, guildConfig, contest, client);
  if (result?.tied) return;

  const reopenDelayMinutes = contestSettings?.reopen_delay_minutes;
  if (!reopenDelayMinutes) return;

  const reopenMs = reopenDelayMinutes * 60000;
  const contestChannel = guild.channels.cache.get(guildConfig.contest_channel_id);
  if (contestChannel) {
    const reopenTimestamp = Math.floor((Date.now() + reopenMs) / 1000);
    const reopenMsg = await contestChannel.send(
      `🔒 Le salon est temporairement fermé. Le prochain concours screenshot ouvrira <t:${reopenTimestamp}:R> — préparez vos plus beaux clichés ! 📸`
    ).catch(() => null);
    if (reopenMsg) {
      await supabase.from('contests').update({ reopen_message_id: reopenMsg.id }).eq('id', contest.id);
    }
  }

  setTimeout(async () => {
    try {
      const { data: existing } = await supabase
        .from('contests')
        .select('id')
        .eq('environment_id', guildConfig.environment_id)
        .in('status', ['active', 'tiebreak'])
        .limit(1)
        .single();
      if (existing) {
        console.log(`[SCHEDULER] Réouverture annulée — concours déjà en cours`);
        return;
      }
      await openContest(guild, guildConfig, contestSettings, client);
      console.log(`[SCHEDULER] Concours réouvert sur ${guild.name}`);
      await log(guild.id, 'contest_auto_reopened', { guildName: guild.name });
    } catch (err) {
      await log(guild.id, 'reopen_failed', { error: err.message }, 'error');
    }
  }, reopenMs);
}

async function sendDailyPromo(client) {
  const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getGuildConfig(guild.id);
      if (!config) continue;
      const { guildConfig } = config;

      const { data: contest } = await supabase
        .from('contests')
        .select('id, promo_last_sent_date')
        .eq('environment_id', guildConfig.environment_id)
        .in('status', ['active', 'tiebreak'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!contest) continue;
      if (contest.promo_last_sent_date === today) continue;

      const channel = guild.channels.cache.get(guildConfig.contest_channel_id);
      if (!channel) continue;

      await channel.send(`🏆 Le classement de la saison est disponible sur **[traaake.fr](https://traaake.fr/)** — viens voir où tu en es ! 📊`);
      await supabase.from('contests').update({ promo_last_sent_date: today }).eq('id', contest.id);
      await log(guild.id, 'contest_daily_promo_sent', { contestId: contest.id, date: today });
      console.log(`[PROMO] Message classement envoyé (${today})`);
    } catch (err) {
      await log(guild.id, 'daily_promo_error', { error: err.message }, 'error');
    }
  }
}

async function syncGuilds(client) {
  for (const guild of client.guilds.cache.values()) {
    await supabase
      .from('discord_guild_configs')
      .upsert(
        { guild_id: guild.id, guild_name: guild.name, bot_present: true, last_sync: new Date().toISOString() },
        { onConflict: 'guild_id', ignoreDuplicates: false }
      );

    // Sync available text channels
    const channels = guild.channels.cache
      .filter(c => ['GuildText', 'GuildAnnouncement'].includes(c.type?.toString() ?? c.constructor.name))
      .map(c => ({
        guild_id: guild.id,
        channel_id: c.id,
        channel_name: c.name,
        channel_type: c.type?.toString() === 'GuildAnnouncement' ? 'announcement' : 'text',
        updated_at: new Date().toISOString(),
      }));

    if (channels.length) {
      await supabase.from('guild_channels').upsert(channels, { onConflict: 'guild_id,channel_id' });
      // Remove stale channels no longer in guild
      const currentIds = channels.map(c => c.channel_id);
      await supabase.from('guild_channels')
        .delete()
        .eq('guild_id', guild.id)
        .not('channel_id', 'in', `(${currentIds.join(',')})`);
    }

    // Sync available roles (exclude @everyone)
    const roles = guild.roles.cache
      .filter(r => r.id !== guild.id)
      .map(r => ({
        guild_id: guild.id,
        role_id: r.id,
        role_name: r.name,
        role_color: r.color,
        position: r.position,
        updated_at: new Date().toISOString(),
      }));

    if (roles.length) {
      await supabase.from('guild_roles').upsert(roles, { onConflict: 'guild_id,role_id' });
      // Remove stale roles no longer in guild
      const currentRoleIds = roles.map(r => r.role_id);
      await supabase.from('guild_roles')
        .delete()
        .eq('guild_id', guild.id)
        .not('role_id', 'in', `(${currentRoleIds.join(',')})`);
    }
  }
}
