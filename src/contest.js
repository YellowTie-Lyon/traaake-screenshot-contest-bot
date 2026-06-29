import { supabase } from './supabase.js';
import { log } from './logger.js';
import { EmbedBuilder } from 'discord.js';

const POINTS_MAP = {
  1: 100,
  2: 75,
  3: 50,
};

export async function openContest(guild, guildConfig, contestSettings, client) {
  const environmentId = guildConfig.environment_id;

  // Get or create active season
  let season = await getActiveSeason();
  if (!season) {
    season = await createSeason();
  }

  // Create contest record
  const startDate = new Date();
  const endDate = new Date(startDate.getTime() + (contestSettings?.duration_days ?? 7) * 86400000);

  const { data: contest, error } = await supabase
    .from('contests')
    .insert({
      environment_id: environmentId,
      season_id: season.id,
      status: 'active',
      title: contestSettings?.contest_title ?? 'Concours Screenshot',
      started_at: startDate.toISOString(),
      ends_at: endDate.toISOString(),
    })
    .select()
    .single();

  if (error) {
    await log(guild.id, 'contest_open_failed', { error: error.message }, 'error');
    return null;
  }

  // Announce in contest channel
  const channel = guild.channels.cache.get(guildConfig.contest_channel_id);
  if (channel) {
    const announcementText = contestSettings?.announcement_message
      ?? `🎉 **Nouveau concours screenshot ouvert !**\nPostez vos plus belles captures dans ce salon. Le concours se termine <t:${Math.floor(endDate.getTime() / 1000)}:R>.`;

    const embed = new EmbedBuilder()
      .setTitle('📸 Concours Screenshot')
      .setDescription(announcementText)
      .setColor(0x5865f2)
      .setFooter({ text: `Concours #${contest.id}` })
      .setTimestamp();

    await channel.send({ embeds: [embed] });
  }

  await log(guild.id, 'contest_opened', { contestId: contest.id, seasonId: season.id });
  return contest;
}

export async function closeContest(guild, guildConfig, contest, client) {
  // Fetch participations sorted by votes
  const { data: participations } = await supabase
    .from('participations')
    .select('*, participants(*)')
    .eq('contest_id', contest.id)
    .order('vote_count', { ascending: false });

  if (!participations || participations.length === 0) {
    await supabase.from('contests').update({ status: 'closed' }).eq('id', contest.id);
    await log(guild.id, 'contest_closed_no_entries', { contestId: contest.id });
    return;
  }

  // Award points
  for (let i = 0; i < Math.min(3, participations.length); i++) {
    const participation = participations[i];
    const points = POINTS_MAP[i + 1] ?? 0;
    if (points === 0) continue;

    await supabase.from('points_ledger').insert({
      participant_id: participation.participant_id,
      season_id: contest.season_id,
      points,
      reason: `Concours #${contest.id} — place ${i + 1}`,
      contest_id: contest.id,
    });
  }

  // Mark contest closed with winner
  await supabase.from('contests').update({
    status: 'closed',
    winner_participation_id: participations[0].id,
    closed_at: new Date().toISOString(),
  }).eq('id', contest.id);

  // Announce winners
  const channel = guild.channels.cache.get(guildConfig.contest_channel_id);
  if (channel) {
    const embed = new EmbedBuilder()
      .setTitle('🏆 Résultats du concours !')
      .setColor(0xffd700)
      .setTimestamp();

    const lines = participations.slice(0, 3).map((p, i) => {
      const medals = ['🥇', '🥈', '🥉'];
      return `${medals[i]} <@${p.participants.discord_user_id}> — **${p.vote_count} vote(s)**`;
    });

    embed.setDescription(lines.join('\n'));

    const winner = participations[0];
    if (winner.image_url) embed.setImage(winner.image_url);

    await channel.send({ embeds: [embed] });
  }

  await log(guild.id, 'contest_closed', {
    contestId: contest.id,
    winnerId: participations[0]?.participant_id,
    totalEntries: participations.length,
  });
}

async function getActiveSeason() {
  const { data } = await supabase
    .from('seasons')
    .select('*')
    .eq('is_active', true)
    .single();
  return data ?? null;
}

async function createSeason() {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth() + 3, 1);

  const { data, error } = await supabase
    .from('seasons')
    .insert({
      name: `Saison ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
      starts_at: now.toISOString(),
      ends_at: end.toISOString(),
      is_active: true,
    })
    .select()
    .single();

  if (error) console.error('[CONTEST] createSeason failed:', error.message);
  return data;
}
