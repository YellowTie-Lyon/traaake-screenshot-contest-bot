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
    // Reminder at configured interval
    tasks.push(setInterval(() => sendContestReminder(client), TEST_REMINDER_INTERVAL_MINUTES * 60000));
    console.log(`[SCHEDULER] TEST MODE — checking every ${TEST_TIEBREAK_CHECK_SECONDS}s, reminder every ${TEST_REMINDER_INTERVAL_MINUTES}min.`);
  } else {
    // Reminder every Monday at 18:00 with @everyone
    tasks.push(cron.schedule('0 18 * * 1', () => sendContestReminder(client)));
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

// Called manually via /contest check to force tiebreak resolution check
export async function checkContests(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getGuildConfig(guild.id);
      if (!config) continue;

      const { guildConfig } = config;
      const environmentId = guildConfig.environment_id;

      const { data: contest } = await supabase
        .from('contests')
        .select('*')
        .eq('environment_id', environmentId)
        .eq('status', 'tiebreak')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!contest) continue;

      // Check if tiebreak is resolved
      const { data: top2 } = await supabase
        .from('participations')
        .select('id, vote_count')
        .eq('contest_id', contest.id)
        .order('vote_count', { ascending: false })
        .limit(2);

      const stillTied = top2?.length >= 2 && top2[0].vote_count === top2[1].vote_count;
      if (stillTied) continue;

      // Tie resolved → close now
      await closeContest(guild, guildConfig, contest, client);

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

      if (!contest) {
        console.log(`[TICK] ${guild.name} — aucun concours actif`);
        continue;
      }

      const endsAt = new Date(contest.ends_at);
      const msLeft = endsAt - now;
      console.log(`[TICK] ${guild.name} — concours ${contest.status} | temps restant: ${Math.round(msLeft / 1000)}s`);

      // Send 5-min warning if not already sent
      if (!contest.warning_sent && msLeft > 0 && msLeft <= 5 * 60000) {
        const channel = guild.channels.cache.get(guildConfig.contest_channel_id);
        if (channel) {
          await channel.send(`⚠️ **Le concours screenshot ferme** <t:${Math.floor(endsAt.getTime() / 1000)}:R> ! Dernière chance pour voter et participer 📸`);
        }
        await supabase.from('contests').update({ warning_sent: true }).eq('id', contest.id);
        await log(guild.id, 'contest_warning_sent', { contestId: contest.id });
        console.log(`[TICK] Warning 5min envoyé`);
        continue;
      }

      if (now < endsAt) continue;

      if (contest.status === 'tiebreak') {
        const { data: top2 } = await supabase
          .from('participations')
          .select('id, vote_count')
          .eq('contest_id', contest.id)
          .order('vote_count', { ascending: false })
          .limit(2);

        const stillTied = top2?.length >= 2 && top2[0].vote_count === top2[1].vote_count;
        if (stillTied) {
          console.log(`[TICK] Tiebreak toujours en cours — égalité à ${top2[0].vote_count} votes`);
          continue;
        }
        console.log(`[TICK] Tiebreak résolu — fermeture en cours`);
      }

      console.log(`[TICK] Fermeture du concours en cours...`);
      const result = await closeContest(guild, guildConfig, contest, client);

      if (result?.tied) {
        console.log(`[TICK] Tiebreak déclenché — réouverture annulée`);
        continue;
      }

      const reopenMs = TEST_REOPEN_DELAY_MINUTES * 60000;
      console.log(`[TICK] Réouverture programmée dans ${TEST_REOPEN_DELAY_MINUTES} minutes`);
      setTimeout(async () => {
        try {
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

async function sendContestReminder(client) {
  const now = new Date();
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

      if (!contest) continue;

      const channel = guild.channels.cache.get(guildConfig.contest_channel_id);
      if (!channel) continue;

      const endsAt = new Date(contest.ends_at);
      const msLeft = endsAt - now;

      // 5-min warning
      if (!contest.warning_sent && msLeft > 0 && msLeft <= 5 * 60000) {
        await channel.send(`⚠️ **Le concours screenshot ferme** <t:${Math.floor(endsAt.getTime() / 1000)}:R> ! Dernière chance pour voter et participer 📸`);
        await supabase.from('contests').update({ warning_sent: true }).eq('id', contest.id);
        await log(guild.id, 'contest_warning_sent', { contestId: contest.id });
        continue;
      }

      // Regular reminder — once per contest
      if (reminderSentForContest.has(contest.id)) continue;
      const closeTimestamp = Math.floor(endsAt.getTime() / 1000);
      await channel.send(`⏰ **Rappel** — Le concours screenshot se termine <t:${closeTimestamp}:R> ! Plus que quelques heures pour voter et participer 📸`);
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
  }
}
