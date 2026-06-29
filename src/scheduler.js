import cron from 'node-cron';
import { supabase } from './supabase.js';
import { log } from './logger.js';
import { getGuildConfig, getActiveContest } from './config.js';
import { openContest, closeContest } from './contest.js';

const tasks = [];

export function startScheduler(client) {
  // Every 15 min: check for contests to close or tiebreaks to resolve
  tasks.push(cron.schedule('*/15 * * * *', () => checkContests(client)));

  // Every Wednesday at 18:00: auto-open a new contest
  tasks.push(cron.schedule('0 18 * * 3', () => autoOpenContests(client)));

  // Every 5 min: sync last_sync
  tasks.push(cron.schedule('*/5 * * * *', () => syncGuilds(client)));

  console.log('[SCHEDULER] Started.');
}

export function stopScheduler() {
  for (const task of tasks) task.stop();
  tasks.length = 0;
  console.log('[SCHEDULER] Stopped.');
}

async function checkContests(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getGuildConfig(guild.id);
      if (!config) continue;

      const { guildConfig, contestSettings } = config;
      const environmentId = guildConfig.environment_id;

      // Check active or tiebreak contest
      const { data: contest } = await supabase
        .from('contests')
        .select('*, seasons(*)')
        .eq('environment_id', environmentId)
        .in('status', ['active', 'tiebreak'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!contest) continue;

      const endDate = new Date(contest.ends_at);
      if (endDate > new Date()) continue;

      if (contest.status === 'tiebreak') {
        // Check if tie is broken
        const { data: top2 } = await supabase
          .from('participations')
          .select('id, vote_count')
          .eq('contest_id', contest.id)
          .order('vote_count', { ascending: false })
          .limit(2);

        if (top2?.length >= 2 && top2[0].vote_count === top2[1].vote_count) {
          // Still tied — extend another 24h
          const newEnd = new Date(Date.now() + 24 * 3600000);
          await supabase.from('contests').update({ ends_at: newEnd.toISOString() }).eq('id', contest.id);
          await log(guild.id, 'contest_tiebreak_extended', { contestId: contest.id });
          continue;
        }
      }

      // Close the contest
      const result = await closeContest(guild, guildConfig, contest, client);

      // If no tie after closing, auto-schedule next Wednesday 18:00
      if (!result?.tied) {
        await log(guild.id, 'contest_next_scheduled', { next: 'Wednesday 18:00' });
      }
    } catch (err) {
      await log(guild.id, 'scheduler_error', { error: err.message }, 'error');
    }
  }
}

async function autoOpenContests(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getGuildConfig(guild.id);
      if (!config) continue;

      const { guildConfig, contestSettings } = config;
      if (!contestSettings?.is_active) continue;

      const active = await getActiveContest(guildConfig.environment_id);
      if (active) continue;

      await openContest(guild, guildConfig, contestSettings, client);
    } catch (err) {
      await log(guild.id, 'auto_open_error', { error: err.message }, 'error');
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
