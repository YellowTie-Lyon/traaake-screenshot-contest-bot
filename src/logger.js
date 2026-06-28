import { supabase } from './supabase.js';

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
}
