import cron from 'node-cron';
import { supabase } from './supabase.js';
import { log } from './logger.js';
import { getGuildConfig, getActiveContest } from './config.js';
import { openContest, closeContest } from './contest.js';

const tasks = [];

export const TEST_MODE       = process.env.CONTEST_TEST_MODE === 'true';
const CONTEST_DURATION_MS    = TEST_MODE ? 60_000 : 7 * 86400_000;
const WARNING_BEFORE_MS      = TEST_MODE ? 30_000 : 24 * 3600_000;
const REOPEN_DELAY_MS        = TEST_MODE ? 30_000 : 0; // 0 = next Wednesday via cron

export function startScheduler(client) {
  if (TEST_MODE) {
    console.log('[SCHEDULER] ⚠️  TEST MODE: 60s contest, 30s warning, 30s reopen delay');
    tasks.push(setInterval(() => checkContests(client), 5_000));
  } else {
    // Check every 15 min for contest expiry
    tasks.push(cron.schedule('*/15 * * * *', () => checkContests(client)));
    // Auto-open every Wednesday at 18:00
    tasks.push(cron.schedule('0 18 * * 3', () => autoOpenContests(client)));
    // Warning reminder every Tuesday at 19:00
    tasks.push(cron.schedule('0 19 * * 2', () => sendWarning(client)));
  }

  // Sync every 5 min regardless of mode
  tasks.push(cron.schedule('*/5 * * * *', () => syncGuilds(client)));

  console.log('[SCHEDULER] Started.');
}

export function stopScheduler() {
  for (const task of tasks) {
    if (typeof task.stop === 'function') task.stop(); // cron task
    else clearInterval(task);                          // setInterval
  }
  tasks.length = 0;
  console.log('[SCHEDULER] Stopped.');
}

async function checkContests(client) {
  console.log(`[SCHEDULER] checkContests — guilds: ${client.guilds.cache.size}`);
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getGuildConfig(guild.id);
      if (!config) { console.log(`[SCHEDULER] no config for guild ${guild.id}`); continue; }

      const { guildConfig, contestSettings } = config;
      const environmentId = guildConfig.environment_id;
      const channel = guild.channels.cache.get(guildConfig.contest_channel_id);

      const { data: contest, error: cErr } = await supabase
        .from('contests')
        .select('*')
        .eq('environment_id', environmentId)
        .in('status', ['active', 'tiebreak'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      console.log(`[SCHEDULER] contest: ${contest?.id ?? 'none'} | error: ${cErr?.message ?? 'none'}`);

      if (!contest) continue;

      const now = Date.now();
      const endDate = new Date(contest.ends_at).getTime();
      const timeLeft = endDate - now;

      // TEST MODE warning at 30s remaining
      if (TEST_MODE && timeLeft > 0 && timeLeft <= WARNING_BEFORE_MS && !contest.warning_sent) {
        if (channel) {
          await channel.send(
            `@everyone ⏰ **Plus que 30 secondes pour voter !** Réagissez avec ❤️ sur votre screenshot favori !`
          );
        }
        await supabase.from('contests').update({ warning_sent: true }).eq('id', contest.id);
        await log(guild.id, 'contest_warning_sent', { contestId: contest.id });
      }

      if (timeLeft > 0) continue;

      // Time to close
      if (contest.status === 'tiebreak') {
        const { data: top2 } = await supabase
          .from('participations')
          .select('id, vote_count')
          .eq('contest_id', contest.id)
          .order('vote_count', { ascending: false })
          .limit(2);

        if (top2?.length >= 2 && top2[0].vote_count === top2[1].vote_count) {
          const newEnd = new Date(Date.now() + (TEST_MODE ? 30_000 : 24 * 3600_000));
          await supabase.from('contests').update({ ends_at: newEnd.toISOString() }).eq('id', contest.id);
          await log(guild.id, 'contest_tiebreak_extended', { contestId: contest.id });
          continue;
        }
      }

      const result = await closeContest(guild, guildConfig, contest, client);

      if (!result?.tied) {
        // Schedule reopen
        if (REOPEN_DELAY_MS > 0) {
          setTimeout(async () => {
            const cfg = await getGuildConfig(guild.id);
            if (!cfg) return;
            await openContest(guild, cfg.guildConfig, cfg.contestSettings, client);
          }, REOPEN_DELAY_MS);

          if (TEST_MODE && channel) {
            await channel.send(`⏳ Prochain concours dans 30 secondes...`);
          }
        }
      }

    } catch (err) {
      await log(guild.id, 'scheduler_error', { error: err.message }, 'error');
    }
  }
}

async function sendWarning(client) {
  for (const guild of client.guilds.cache.values()) {
    try {
      const config = await getGuildConfig(guild.id);
      if (!config) continue;

      const { guildConfig } = config;
      const active = await getActiveContest(guildConfig.environment_id);
      if (!active) continue;

      const channel = guild.channels.cache.get(guildConfig.contest_channel_id);
      if (!channel) continue;

      const endLabel = new Date(active.ends_at).toLocaleDateString('fr-FR', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
      });

      await channel.send(
        `@everyone ⏰ **Dernier jour pour voter !** Le concours se termine demain **${endLabel}**.\nRéagissez avec ❤️ sur votre screenshot favori avant la fermeture !`
      );

      await supabase.from('contests').update({ warning_sent: true }).eq('id', active.id);
      await log(guild.id, 'contest_warning_sent', { contestId: active.id });
    } catch (err) {
      await log(guild.id, 'warning_error', { error: err.message }, 'error');
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
