import { supabase } from './supabase.js';

let discordClient = null;

export function setLogClient(client) {
  discordClient = client;
}

const LOG_COLORS = {
  info:  0x5865f2,
  warn:  0xffa500,
  error: 0xff4444,
};

const DISCORD_LOG_ACTIONS = new Set([
  'contest_opened',
  'contest_closed',
  'contest_no_entries',
  'tiebreak_started',
  'tiebreak_resolved',
  'contest_ban',
  'contest_unban',
  'participation_submitted',
  'duplicate_submission_blocked',
  'banned_user_blocked',
  'participation_insert_failed',
  'participant_upsert_failed',
  'points_adjusted',
]);

export async function log(guildId, action, details = {}, level = 'info') {
  console.log(`[${level.toUpperCase()}] [${guildId ?? 'global'}] ${action}`, details);

  try {
    await supabase.from('bot_logs').insert({
      guild_id: guildId,
      action,
      details,
      level,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Failed to write bot_log:', err.message);
  }

  if (!discordClient || !guildId || !DISCORD_LOG_ACTIONS.has(action)) return;

  try {
    const { data: cfg } = await supabase
      .from('discord_guild_configs')
      .select('log_channel_id')
      .eq('guild_id', guildId)
      .single();

    if (!cfg?.log_channel_id) return;

    const guild = discordClient.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(cfg.log_channel_id);
    if (!channel) return;

    const lines = Object.entries(details)
      .map(([k, v]) => `**${k}:** ${v}`)
      .join('\n');

    const { EmbedBuilder } = await import('discord.js');
    const embed = new EmbedBuilder()
      .setColor(LOG_COLORS[level] ?? LOG_COLORS.info)
      .setTitle(`\`${action}\``)
      .setDescription(lines || '—')
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  } catch {
    // Never crash the bot for a log
  }
}
