import { supabase } from './supabase.js';
import { log } from './logger.js';

// In-memory cache: guildId -> { guildConfig, contestSettings }
const cache = new Map();

export async function getGuildConfig(guildId) {
  const cached = cache.get(guildId);
  if (cached) return cached;
  return refreshGuildConfig(guildId);
}

export async function refreshGuildConfig(guildId) {
  const { data: guildConfig, error } = await supabase
    .from('discord_guild_configs')
    .select('*, environments(*)')
    .eq('guild_id', guildId)
    .eq('environment_id', process.env.ENVIRONMENT_ID)
    .single();

  if (error || !guildConfig) {
    await log(guildId, 'config_load_failed', { error: error?.message }, 'warn');
    return null;
  }

  const { data: contestSettings } = await supabase
    .from('contest_settings')
    .select('*')
    .eq('environment_id', guildConfig.environment_id)
    .single();

  const config = { guildConfig, contestSettings: contestSettings ?? null };
  cache.set(guildId, config);
  return config;
}

export async function loadAllGuildConfigs() {
  const { data, error } = await supabase
    .from('discord_guild_configs')
    .select('*')
    .eq('bot_present', true);

  if (error) {
    console.error('Failed to load guild configs:', error.message);
    return [];
  }

  for (const cfg of data) {
    cache.delete(cfg.guild_id);
    await refreshGuildConfig(cfg.guild_id);
  }

  return data;
}

export function invalidateCache(guildId) {
  cache.delete(guildId);
}

export async function getActiveContest(environmentId) {
  const { data } = await supabase
    .from('contests')
    .select('*, seasons(*)')
    .eq('environment_id', environmentId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  return data ?? null;
}
