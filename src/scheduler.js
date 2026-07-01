import cron from 'node-cron';
import { supabase } from './supabase.js';
import { log } from './logger.js';
import { getGuildConfig } from './config.js';
import { closeContest, openContest } from './contest.js';
import { TEST_MODE, TEST_TIEBREAK_CHECK_SECONDS, TEST_REOPEN_DELAY_MINUTES, TEST_REMINDER_INTERVAL_MINUTES } from './test-mode.js';

const tasks = [];
const reminderSentForContest = new Set();

export function startScheduler(client) {
  // Sync guild last_seen every 5 min
  tasks.push(cron.schedule('*/5 * * * *', () => syncGuilds(client)));

  if (TEST_MODE) {
    // Check every N seconds if a contest needs closing or tiebreak resolving
    const intervalMs = TEST_TIEBREAK_CHECK_SECONDS * 1000;
    tasks.push(setInterval(() => testModeTickClose(client), intervalMs));
    // Reminder at configured interval — also run immediately on startup to catch missed windows
    sendContestReminder(client);
    tasks.push(setInterval(() => sendContestReminder(client), TEST_REMINDER_INTERVAL_MINUTES * 60000));
    console.log(`[SCHEDULER] TEST MODE — checking every ${TEST_TIEBREAK_CHECK_SECONDS}s, reminder every ${TEST_REMINDER_INTERVAL_MINUTES}min.`);
  } else {
    // Check every minute if it's time to send the reminder (day+hour read from DB)
    tasks.push(cron.schedule('* * * * *', () => checkReminderSchedule(client)));
  }

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

// Called manually via /contest check to force close/tiebreak resolution
export async function checkContests(client) {
  const now = new Date();
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getGuildConfig(guild.id);
      if (!config) continue;

      const { guildConfig } = config;

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

      if (contest.status === 'tiebreak') {
        // Check if tie is resolved (someone took the lead)
        const { data: top2 } = await supabase
          .from('participations')
          .select('id, vote_count')
          .eq('contest_id', contest.id)
          .order('vote_count', { ascending: false })
          .limit(2);

        const stillTied = top2?.length >= 2 && top2[0].vote_count === top2[1].vote_count;

        // Close if tie resolved OR tiebreak period expired
        if (!stillTied || now >= endsAt) {
          await closeContest(guild, guildConfig, contest, client);
        }
      } else if (now >= endsAt) {
        // Active contest past its end time → close
        await closeContest(guild, guildConfig, contest, client);
      }

    } catch (err) {
      await log(guild.id, 'scheduler_error', { error: err.message }, 'error');
    }
  }
}

async function testModeTickClose(client) {
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
      const msLeft = endsAt - now;

      // Send warning N minutes before end (configurable, default 5)
      const warningMs = (contestSettings?.warning_minutes ?? 5) * 60000;
      if (!contest.warning_sent && msLeft > 0 && msLeft <= warningMs) {
        const channel = guild.channels.cache.get(guildConfig.contest_channel_id);
        if (channel) {
          await channel.send(`⚠️ **Le concours screenshot ferme** <t:${Math.floor(endsAt.getTime() / 1000)}:R> ! Dernière chance pour voter et participer 📸`);
        }
        await supabase.from('contests').update({ warning_sent: true }).eq('id', contest.id);
        await log(guild.id, 'contest_warning_sent', { contestId: contest.id });
        console.log(`[TICK] Warning 5min envoyé`);
        continue;
      }

      if (contest.status === 'tiebreak') {
        const { data: allTied } = await supabase
          .from('participations')
          .select('id, vote_count, participants(discord_user_id)')
          .eq('contest_id', contest.id)
          .order('vote_count', { ascending: false });

        const topVotes = allTied?.[0]?.vote_count ?? 0;
        const tiedNow = allTied?.filter(p => p.vote_count === topVotes) ?? [];
        const stillTied = tiedNow.length >= 2;

        if (stillTied && now < endsAt) {
          // Check if tiebreak participants changed — update message if so
          const tiedIds = tiedNow.map(p => p.participants.discord_user_id).sort().join(',');
          const lastTiedIds = contest.tiebreak_participants ?? '';
          if (tiedIds !== lastTiedIds) {
            console.log(`[TICK] Participants à égalité ont changé — mise à jour du message`);
            const channel = guild.channels.cache.get(guildConfig.contest_channel_id);
            if (channel) {
              // Delete old tiebreak message
              if (contest.tiebreak_message_id) {
                await channel.messages.delete(contest.tiebreak_message_id).catch(() => null);
              }
              const { EmbedBuilder } = await import('discord.js');
              const tiebreakLabel = TEST_MODE ? '30 minutes' : '24h';
              const tiedMentions = tiedNow.map(p => `<@${p.participants.discord_user_id}>`).join(', ');
              const embed = new EmbedBuilder()
                .setTitle('⚖️ Égalité détectée !')
                .setDescription(
                  `${tiedMentions} sont à égalité avec **${topVotes} ❤️**. Le concours est **prolongé de ${tiebreakLabel}** pour départager les concurrents !\n\n` +
                  `🗳️ Continuez à voter pour votre screenshot préféré — chaque vote compte !\n` +
                  `⏳ Nouveau délai de fermeture : <t:${Math.floor(new Date(contest.ends_at).getTime() / 1000)}:R>\n` +
                  `🔄 Le vainqueur est vérifié **toutes les 30 secondes** — dès qu'un participant prend l'avantage, le concours se ferme immédiatement !\n\n` +
                  `*En cas d'égalité persistante à la fin du délai, le gagnant sera désigné par ancienneté de publication.*`
                )
                .setColor(0xff9900)
                .setTimestamp();
              const newMsg = await channel.send({ embeds: [embed] });
              await supabase.from('contests').update({
                tiebreak_message_id: newMsg.id,
                tiebreak_participants: tiedIds,
              }).eq('id', contest.id);
            }
          }
          console.log(`[TICK] Tiebreak toujours en cours — égalité à ${topVotes} votes (${tiedNow.length} participants)`);
          continue;
        }
        if (!stillTied) console.log(`[TICK] Tiebreak résolu — fermeture en cours`);
        if (stillTied && now >= endsAt) console.log(`[TICK] Tiebreak expiré — fermeture par ancienneté`);
      } else if (now < endsAt) {
        continue;
      }

      console.log(`[TICK] Fermeture du concours en cours...`);
      const result = await closeContest(guild, guildConfig, contest, client);

      if (result?.tied) {
        console.log(`[TICK] Tiebreak déclenché — réouverture annulée`);
        continue;
      }

      const reopenMs = TEST_REOPEN_DELAY_MINUTES * 60000;
      console.log(`[TICK] Réouverture programmée dans ${TEST_REOPEN_DELAY_MINUTES} minutes`);

      // Announce the reopen delay in the contest channel
      const contestChannel = guild.channels.cache.get(guildConfig.contest_channel_id);
      if (contestChannel) {
        const reopenTimestamp = Math.floor((Date.now() + reopenMs) / 1000);
        await contestChannel.send(`🔒 Le salon est temporairement fermé. Le prochain concours screenshot ouvrira <t:${reopenTimestamp}:R> — préparez vos plus beaux clichés ! 📸`).catch(() => null);
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
            console.log(`[TICK] Réouverture annulée — un concours est déjà en cours`);
            return;
          }

          await openContest(guild, guildConfig, contestSettings, client);
          console.log(`[TICK] Concours réouvert sur ${guild.name}`);
          await log(guild.id, 'contest_auto_reopened', { guildName: guild.name });
        } catch (err) {
          await log(guild.id, 'test_reopen_failed', { error: err.message }, 'error');
        }
      }, reopenMs);

    } catch (err) {
      console.error(`[TICK] Erreur: ${err.message}`);
      await log(guild.id, 'test_tick_error', { error: err.message }, 'error');
    }
  }
}

// In production: check every minute if it's the configured reminder day+hour
async function checkReminderSchedule(client) {
  const now = new Date();
  // Only trigger at minute 0 (i.e. exactly on the hour)
  if (now.getMinutes() !== 0) return;

  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getGuildConfig(guild.id);
      if (!config) continue;
      const { contestSettings } = config;
      const reminderDay  = contestSettings?.reminder_day  ?? 1; // Monday
      const reminderHour = contestSettings?.reminder_hour ?? 18;
      if (now.getDay() === reminderDay && now.getHours() === reminderHour) {
        await sendContestReminder(client);
      }
    } catch (err) {
      await log(guild.id, 'reminder_schedule_error', { error: err.message }, 'error');
    }
  }
}

async function sendContestReminder(client) {
  const now = new Date();
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getGuildConfig(guild.id);
      if (!config) continue;
      const { guildConfig, contestSettings } = config;

      const { data: contest } = await supabase
        .from('contests')
        .select('id, ends_at, warning_sent')
        .eq('environment_id', guildConfig.environment_id)
        .in('status', ['active', 'tiebreak'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!contest) continue;

      const channel = guild.channels.cache.get(guildConfig.contest_channel_id);
      if (!channel) continue;

      const endsAt = new Date(contest.ends_at);
      const msLeft = endsAt - now;

      // Warning N minutes before end
      const warningMs = (contestSettings?.warning_minutes ?? 5) * 60000;
      if (!contest.warning_sent && msLeft > 0 && msLeft <= warningMs) {
        await channel.send(`⚠️ **Le concours screenshot ferme** <t:${Math.floor(endsAt.getTime() / 1000)}:R> ! Dernière chance pour voter et participer 📸`);
        await supabase.from('contests').update({ warning_sent: true }).eq('id', contest.id);
        await log(guild.id, 'contest_warning_sent', { contestId: contest.id });
        continue;
      }

      // Regular reminder — once per contest
      if (reminderSentForContest.has(contest.id)) continue;
      const closeTimestamp = Math.floor(endsAt.getTime() / 1000);
      const reminderMsg = contestSettings?.reminder_message
        ?? `⏰ **Rappel** — Le concours screenshot se termine <t:${closeTimestamp}:R> ! Plus que quelques heures pour voter et participer 📸`;
      await channel.send(reminderMsg.replace('{timestamp}', `<t:${closeTimestamp}:R>`));
      reminderSentForContest.add(contest.id);
      await log(guild.id, 'contest_reminder_sent', { contestId: contest.id });
    } catch (err) {
      await log(guild.id, 'reminder_error', { error: err.message }, 'error');
    }
  }
}

async function syncGuilds(client) {
  for (const guild of client.guilds.cache.values()) {
    await supabase
      .from('discord_guild_configs')
      .update({ last_sync: new Date().toISOString() })
      .eq('guild_id', guild.id);

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
