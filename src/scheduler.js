import cron from 'node-cron';
import { supabase } from './supabase.js';
import { log } from './logger.js';
import { getGuildConfig, getActiveContest, loadAllGuildConfigs } from './config.js';
import { openContest, closeContest } from './contest.js';

export function startScheduler(client) {
  // Every hour: check for contests that need to open or close
  cron.schedule('0 * * * *', () => checkContests(client));

  // Every 5 min: sync guild membership
  cron.schedule('*/5 * * * *', () => syncGuilds(client));
}

async function checkContests(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getGuildConfig(guild.id);
      if (!config) continue;

      const { guildConfig, contestSettings } = config;
      const environmentId = guildConfig.environment_id;

      // Check if there's an active contest that should be closed
      const active = await getActiveContest(environmentId);
      if (active) {
        const endDate = new Date(active.end_date);
        if (endDate <= new Date()) {
          await closeContest(guild, guildConfig, active, client);
        }
        continue;
      }

      // Check if a contest should be opened (based on schedule in contest_settings)
      if (!contestSettings?.is_active) continue;

      const schedule = contestSettings.schedule_cron;
      if (!schedule) continue;

      // If we're in the cron window, open the contest
      // We check this by seeing if there's no contest in the last duration_days
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
