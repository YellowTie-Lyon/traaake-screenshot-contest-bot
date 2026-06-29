import cron from 'node-cron';
import { supabase } from './supabase.js';
import { log } from './logger.js';
import { getGuildConfig, getActiveContest } from './config.js';
import { openContest, closeContest } from './contest.js';

const tasks = [];

export function startScheduler(client) {
  tasks.push(
    cron.schedule('0 * * * *', () => checkContests(client)),
    cron.schedule('*/5 * * * *', () => syncGuilds(client))
  );
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

      const active = await getActiveContest(environmentId);
      if (active) {
        if (new Date(active.end_date) <= new Date()) {
          await closeContest(guild, guildConfig, active, client);
        }
        continue;
      }

      if (!contestSettings?.is_active || !contestSettings.schedule_cron) continue;

      const since = new Date(Date.now() - (contestSettings.duration_days ?? 7) * 86400000);
      const { data: recent } = await supabase
        .from('contests')
        .select('id')
        .eq('environment_id', environmentId)
        .gte('created_at', since.toISOString())
        .limit(1);

      if (!recent || recent.length === 0) {
        await openContest(guild, guildConfig, contestSettings, client);
      }
    } catch (err) {
      await log(guild.id, 'scheduler_error', { error: err.message }, 'error');
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
