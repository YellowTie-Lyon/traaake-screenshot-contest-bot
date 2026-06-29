import { supabase } from './supabase.js';
import { log } from './logger.js';
import { EmbedBuilder } from 'discord.js';

const POINTS_MAP = { 1: 100, 2: 75, 3: 50 };
const VOTE_EMOJI = '❤️';

export async function openContest(guild, guildConfig, contestSettings, client) {
  const environmentId = guildConfig.environment_id;

  let season = await getActiveSeason();
  if (!season) {
    season = await createSeason();
  }

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

  const channel = guild.channels.cache.get(guildConfig.contest_channel_id);
  if (channel) {
    const startLabel = startDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const endLabel   = endDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    await channel.send(
      `@everyone ! Le concours du photographe de la semaine est **OUVERT** ✅ A vous de jouer !\n` +
      `📅 **Date de début :** ${startLabel} / **Date de fin :** ${endLabel}`
    );

    const embed = new EmbedBuilder()
      .setTitle('CONCOURS SCREENSHOTS')
      .setDescription(
        `**Comment participer ?**\n` +
        `Chaque semaine, tentez de remporter le titre de **PHOTOGRAPHE DE LA SEMAINE** en postant votre meilleur screenshot sur Microsoft Flight Simulator 2020 & 2024 ✈️\n` +
        `Le screenshot avec le plus de ❤️ remporte le concours et son propriétaire obtient le rôle **PHOTOGRAPHE DE LA SEMAINE** 🎉\n\n` +
        `**Règles du concours :**\n` +
        `🔷 Les screenshots doivent provenir **uniquement** de Microsoft Flight Simulator 2020 & 2024 !\n` +
        `🔷 Un **seul** screenshot, **supprimez l'ancien** pour en poster un nouveau\n` +
        `🔷 Les screenshots doivent **vous appartenir**, sous peine de sanctions\n` +
        `🔷 Les **streamers/youtubers** ne peuvent pas participer au concours\n` +
        `🔷 Les screenshots jugés troll, offensant ou inapproprié par les modérateurs seront supprimés.\n` +
        `🔷 Le concours screenshots est relancé chaque mercredi soir`
      )
      .setColor(0x2b2d31);

    await channel.send({ embeds: [embed] });
  }

  await log(guild.id, 'contest_opened', { contestId: contest.id, seasonId: season.id });
  return contest;
}

export async function closeContest(guild, guildConfig, contest, client) {
  const { data: participations } = await supabase
    .from('participations')
    .select('*, participants(*)')
    .eq('contest_id', contest.id)
    .order('vote_count', { ascending: false });

  const channel = guild.channels.cache.get(guildConfig.contest_channel_id);

  if (!participations || participations.length === 0) {
    await supabase.from('contests').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', contest.id);
    await log(guild.id, 'contest_closed_no_entries', { contestId: contest.id });
    return { tied: false };
  }

  // Check for tie between top 2
  if (
    participations.length >= 2 &&
    participations[0].vote_count === participations[1].vote_count &&
    participations[0].vote_count > 0
  ) {
    // Extend contest by 24h for tie-breaking
    const newEnd = new Date(Date.now() + 24 * 3600000);
    await supabase.from('contests').update({ ends_at: newEnd.toISOString(), status: 'tiebreak' }).eq('id', contest.id);

    if (channel) {
      const embed = new EmbedBuilder()
        .setTitle('⚖️ Égalité ! Le concours est prolongé.')
        .setDescription(
          `**${participations[0].participants.discord_display_name}** et **${participations[1].participants.discord_display_name}** sont à égalité avec **${participations[0].vote_count} ❤️**.\n\n` +
          `Le concours est prolongé de 24h. Votez pour départager ! Le concours se termine <t:${Math.floor(newEnd.getTime() / 1000)}:R>.`
        )
        .setColor(0xff9900)
        .setTimestamp();
      await channel.send({ embeds: [embed] });
    }

    await log(guild.id, 'contest_tiebreak', { contestId: contest.id, tiedVotes: participations[0].vote_count });
    return { tied: true };
  }

  // Award points to top 3
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

  // Mark winner (only 1st place)
  await supabase.from('contests').update({
    status: 'closed',
    winner_participation_id: participations[0].id,
    winner_discord_user_id: participations[0].participants.discord_user_id,
    closed_at: new Date().toISOString(),
  }).eq('id', contest.id);

  // Announce winner
  if (channel) {
    const winner = participations[0];
    const startLabel = new Date(contest.started_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const endLabel   = new Date(contest.ends_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

    await channel.send(
      `🏆 Le gagnant du concours screens est ➡️ <@${winner.participants.discord_user_id}> 🏆\n` +
      `📅 **Date de début :** ${startLabel} / **Date de fin :** ${endLabel}`
    );
  }

  await log(guild.id, 'contest_closed', {
    contestId: contest.id,
    winnerId: participations[0].participant_id,
    totalEntries: participations.length,
  });

  return { tied: false };
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
