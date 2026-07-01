import cron from 'node-cron';
import { supabase } from './supabase.js';
import { log } from './logger.js';
import { getGuildConfig } from './config.js';
import { closeContest, openContest } from './contest.js';
import { TEST_MODE, TEST_TIEBREAK_CHECK_SECONDS, TEST_REOPEN_DELAY_MINUTES } from './test-mode.js';

const tasks = [];

export function startScheduler(client) {
  // Sync guild last_seen every 5 min
  tasks.push(cron.schedule('*/5 * * * *', () => syncGuilds(client)));

  if (TEST_MODE) {
    // Check every N seconds if a contest needs closing or tiebreak resolving
    const intervalMs = TEST_TIEBREAK_CHECK_SECONDS * 1000;
    tasks.push(setInterval(() => testModeTickClose(client), intervalMs));
    console.log(`[SCHEDULER] TEST MODE — checking every ${TEST_TIEBREAK_CHECK_SECONDS}s.`);
  } else {
    // Reminder every 15 minutes if a contest is active
    tasks.push(cron.schedule('*/15 * * * *', () => sendContestReminder(client)));
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

      if (!contest) continue;

      const endsAt = new Date(contest.ends_at);
      if (now < endsAt) continue;

      if (contest.status === 'tiebreak') {
        // Check if tie is resolved
        const { data: top2 } = await supabase
          .from('participations')
          .select('id, vote_count')
          .eq('contest_id', contest.id)
          .order('vote_count', { ascending: false })
          .limit(2);

        const stillTied = top2?.length >= 2 && top2[0].vote_count === top2[1].vote_count;
        if (stillTied) continue;
      }

      // Close the contest
      await closeContest(guild, guildConfig, contest, client);

      // Auto-reopen after delay
      const reopenMs = TEST_REOPEN_DELAY_MINUTES * 60000;
      setTimeout(async () => {
        try {
          await openContest(guild, guildConfig, contestSettings, client);
          console.log(`[TEST MODE] Contest auto-reopened on guild ${guild.name}`);
        } catch (err) {
          await log(guild.id, 'test_reopen_failed', { error: err.message }, 'error');
        }
      }, reopenMs);

    } catch (err) {
      await log(guild.id, 'test_tick_error', { error: err.message }, 'error');
    }
  }
}

async function sendContestReminder(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getGuildConfig(guild.id);
      if (!config) continue;
      const { guildConfig } = config;

      const { data: contest } = await supabase
        .from('contests')
        .select('ends_at')
        .eq('environment_id', guildConfig.environment_id)
        .in('status', ['active', 'tiebreak'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!contest) continue;

      const channel = guild.channels.cache.get(guildConfig.contest_channel_id);
      if (!channel) continue;

      const closeTimestamp = Math.floor(new Date(contest.ends_at).getTime() / 1000);
      await channel.send(
        `⏰ **Rappel** — Le concours screenshot se termine <t:${closeTimestamp}:R> ! Plus que quelques heures pour voter et participer 📸`
      );
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
