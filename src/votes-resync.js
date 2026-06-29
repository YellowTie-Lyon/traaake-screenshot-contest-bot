import { supabase } from './supabase.js';
import { log } from './logger.js';

const VOTE_EMOJI = '❤️';

/**
 * On bot startup, recount all ❤️ reactions on active contest participations
 * to recover accurate vote counts after a crash or restart.
 */
export async function resyncVotes(client) {
  console.log('[RESYNC] Starting vote resync...');

  for (const guild of client.guilds.cache.values()) {
    try {
      // Find active contest for this guild
      const { data: guildConfig } = await supabase
        .from('discord_guild_configs')
        .select('environment_id, contest_channel_id')
        .eq('guild_id', guild.id)
        .eq('environment_id', process.env.ENVIRONMENT_ID)
        .single();

      if (!guildConfig) continue;

      const { data: contest } = await supabase
        .from('contests')
        .select('id')
        .eq('environment_id', guildConfig.environment_id)
        .in('status', ['active', 'tiebreak'])
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (!contest) continue;

      const { data: participations } = await supabase
        .from('participations')
        .select('id, message_id, vote_count')
        .eq('contest_id', contest.id)
        .not('message_id', 'is', null);

      if (!participations || participations.length === 0) continue;

      const channel = guild.channels.cache.get(guildConfig.contest_channel_id);
      if (!channel) continue;

      let resynced = 0;

      for (const participation of participations) {
        try {
          const message = await channel.messages.fetch(participation.message_id);
          if (!message) continue;

          const reaction = message.reactions.cache.get(VOTE_EMOJI)
            ?? await message.reactions.resolve(VOTE_EMOJI);

          // Fetch all users who reacted, subtract bots
          let count = 0;
          if (reaction) {
            const users = await reaction.users.fetch();
            count = users.filter(u => !u.bot).size;
          }

          if (count !== participation.vote_count) {
            await supabase
              .from('participations')
              .update({ vote_count: count })
              .eq('id', participation.id);
            resynced++;
          }
        } catch {
          // Message may have been deleted
        }
      }

      if (resynced > 0) {
        await log(guild.id, 'votes_resynced', { contestId: contest.id, resynced });
        console.log(`[RESYNC] Guild ${guild.name}: resynced ${resynced} participation(s).`);
      } else {
        console.log(`[RESYNC] Guild ${guild.name}: votes already in sync.`);
      }

    } catch (err) {
      console.error(`[RESYNC] Error for guild ${guild.name}:`, err.message);
    }
  }

  console.log('[RESYNC] Done.');
}
