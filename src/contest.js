import { supabase } from './supabase.js';
import { log } from './logger.js';
import { EmbedBuilder } from 'discord.js';

const POINTS_MAP = { 1: 100, 2: 75, 3: 50 };
const VOTE_EMOJI = '❤️';

function nextWednesdayAt18() {
  const now = new Date();
  const result = new Date(now);
  const daysUntilWed = (3 - now.getDay() + 7) % 7 || 7; // at least 1 day ahead
  result.setDate(now.getDate() + daysUntilWed);
  result.setHours(18, 0, 0, 0);
  return result;
}

export async function openContest(guild, guildConfig, contestSettings, client) {
  const environmentId = guildConfig.environment_id;

  let season = await getActiveSeason();
  if (!season) {
    season = await createSeason();
  }

  const startDate = new Date();
  const endDate = nextWednesdayAt18();

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
    const startLabel = startDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const endLabel   = endDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const closeTimestamp = Math.floor(endDate.getTime() / 1000);

    const openMsg = await channel.send({ content: `@everyone ✈️ Le concours screenshot de la semaine est **ouvert** ! À vos plus beaux clichés !`, allowedMentions: { parse: ['everyone'] } });

    const embedAnnonce = new EmbedBuilder()
      .setTitle('📸 Concours Screenshot — Communauté TraaaKe')
      .setDescription(
        `Postez votre plus beau screenshot sur **Microsoft Flight Simulator 2020 ou 2024** et récoltez le plus de ❤️ !\n` +
        `Le gagnant obtient le rôle **Photographe de la semaine** 🏆`
      )
      .setColor(0x5865f2)
      .addFields(
        { name: '📅 Ouverture', value: startLabel, inline: true },
        { name: '🏁 Fermeture', value: endLabel, inline: true },
        { name: '⏳ Temps restant', value: `<t:${closeTimestamp}:R>`, inline: true },
        { name: '🏆 Classement', value: '[Voir le classement sur trakr.fr](https://trakr.fr)', inline: false },
      )
      .setFooter({ text: 'Relancé chaque mercredi à 18h00 • Communauté TraaaKe' });

    const embedRegles = new EmbedBuilder()
      .setTitle('📋 Règles du concours')
      .setDescription(
        `✅ Screenshots **Microsoft Flight Simulator 2020 & 2024 uniquement**\n` +
        `✅ **Une seule photo** par concours — supprime l'ancienne pour en changer\n` +
        `✅ Le screenshot doit **t'appartenir**\n` +
        `❌ Les **streamers / youtubers** ne peuvent pas participer\n` +
        `❌ Screenshots **troll, offensants ou inappropriés** supprimés par la modération\n` +
        `❌ **Pas de texte** avec l'image — poste uniquement la photo`
      )
      .setColor(0x2b2d31)
      .setFooter({ text: 'Toute infraction peut entraîner une exclusion du concours' });

    const rulesMsg = await channel.send({ embeds: [embedAnnonce, embedRegles] });

    // Store opening message IDs for cleanup at close
    await supabase.from('contests').update({
      opening_message_id: openMsg.id,
      rules_message_id: rulesMsg.id,
    }).eq('id', contest.id);
  }

  await log(guild.id, 'contest_opened', { contestId: contest.id, seasonId: season.id });
  return contest;
}

export async function closeContest(guild, guildConfig, contest, client) {
  // Guard against double-close (scheduler + manual)
  const { data: freshContest } = await supabase
    .from('contests').select('status').eq('id', contest.id).single();
  if (!freshContest || freshContest.status === 'closed') return { tied: false };

  const { data: participations } = await supabase
    .from('participations')
    .select('*, participants(*)')
    .eq('contest_id', contest.id)
    .order('vote_count', { ascending: false });

  const channel = guild.channels.cache.get(guildConfig.contest_channel_id);

  if (!participations || participations.length === 0) {
    await supabase.from('contests').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', contest.id);
    if (channel) {
      const embed = new EmbedBuilder()
        .setTitle('📸 Concours terminé — Aucune participation')
        .setDescription('Personne n\'a participé à ce concours. Rendez-vous mercredi prochain pour le prochain concours !')
        .setColor(0x2b2d31)
        .setFooter({ text: 'Communauté TraaaKe • trakr.fr' })
        .setTimestamp();

      // Edit opening messages in place
      if (contest.opening_message_id) {
        const openMsg = await channel.messages.fetch(contest.opening_message_id).catch(() => null);
        if (openMsg) await openMsg.edit('📸 Le concours screenshot est **terminé** — aucune participation cette semaine.').catch(() => null);
      }
      if (contest.rules_message_id) {
        const rulesMsg = await channel.messages.fetch(contest.rules_message_id).catch(() => null);
        if (rulesMsg) await rulesMsg.edit({ embeds: [embed] }).catch(() => null);
      }
    }
    await log(guild.id, 'contest_closed_no_entries', { contestId: contest.id });
    return { tied: false, noEntries: true };
  }

  // Check for tie between top 2
  const isTied = participations.length >= 2 &&
    participations[0].vote_count === participations[1].vote_count;

  if (isTied) {
    // Already in tiebreak and still tied → pick first submitted as final winner
    if (contest.status === 'tiebreak') {
      const { data: tiedParticipations } = await supabase
        .from('participations')
        .select('*, participants(*)')
        .eq('contest_id', contest.id)
        .eq('vote_count', participations[0].vote_count)
        .order('submitted_at', { ascending: true });

      // Replace top of sorted list with the tiebreak winner (first submitted)
      if (tiedParticipations?.length >= 2) {
        const winner = tiedParticipations[0];
        const loser = tiedParticipations[1];
        // Reorder so winner is first
        const idx = participations.findIndex(p => p.id === winner.id);
        if (idx > 0) {
          participations.splice(idx, 1);
          participations.unshift(winner);
        }

        if (channel) {
          const embed = new EmbedBuilder()
            .setTitle('⚖️ Égalité persistante — départage par ancienneté')
            .setDescription(
              `<@${winner.participants.discord_user_id}> et <@${loser.participants.discord_user_id}> sont toujours à égalité avec **${winner.vote_count} ❤️**.\n\n` +
              `🏆 **<@${winner.participants.discord_user_id}> remporte le concours** car sa photo a été postée en premier !`
            )
            .setColor(0xff9900)
            .setTimestamp();
          await channel.send({ embeds: [embed] });
        }

        await log(guild.id, 'contest_tiebreak_resolved', { contestId: contest.id, winnerId: winner.participant_id });
      }
      // Fall through to normal close logic with reordered participations
    } else {
      // First tie detected → extend 24h
      const newEnd = new Date(Date.now() + 24 * 3600000);
      await supabase.from('contests').update({ ends_at: newEnd.toISOString(), status: 'tiebreak' }).eq('id', contest.id);

      if (channel) {
        const embed = new EmbedBuilder()
          .setTitle('⚖️ Égalité ! Le concours est prolongé.')
          .setDescription(
            `<@${participations[0].participants.discord_user_id}> et <@${participations[1].participants.discord_user_id}> sont à égalité avec **${participations[0].vote_count} ❤️**.\n\n` +
            `Le concours est prolongé de **24h**. Votez pour départager ! Le concours se termine <t:${Math.floor(newEnd.getTime() / 1000)}:R>.`
          )
          .setColor(0xff9900)
          .setTimestamp();
        const tieMsg = await channel.send({ embeds: [embed] });
        await supabase.from('contests').update({ tiebreak_message_id: tieMsg.id }).eq('id', contest.id);
      }

      await log(guild.id, 'contest_tiebreak', { contestId: contest.id, tiedVotes: participations[0].vote_count });
      return { tied: true };
    }
  }

  // Close contest in DB immediately to prevent re-entry
  await supabase.from('contests').update({
    status: 'closed',
    winner_participation_id: participations[0].id,
    winner_discord_user_id: participations[0].participants.discord_user_id,
    closed_at: new Date().toISOString(),
  }).eq('id', contest.id);

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

  // Assign/remove "Photographe de la semaine" role
  await updatePhotographerRole(guild, guildConfig, contest, participations[0]);

  // Edit opening messages in place so winner announcement stays above the winner photo
  if (channel) {
    const winner = participations[0];
    const startLabel = new Date(contest.started_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const endLabel   = new Date(contest.ends_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

    let podium = `🥇 <@${winner.participants.discord_user_id}> — **${winner.vote_count} ❤️**`;
    if (participations[1]) podium += `\n🥈 <@${participations[1].participants.discord_user_id}> — ${participations[1].vote_count} ❤️`;
    if (participations[2]) podium += `\n🥉 <@${participations[2].participants.discord_user_id}> — ${participations[2].vote_count} ❤️`;

    const embedWinner = new EmbedBuilder()
      .setTitle(`🏆 Photographe de la semaine — ${winner.participants.discord_display_name}`)
      .setDescription(podium)
      .setColor(0xffd700)
      .addFields(
        { name: '📅 Semaine du', value: `${startLabel} au ${endLabel}`, inline: true },
        { name: '🏆 Classement', value: '[Voir sur trakr.fr](https://trakr.fr)', inline: true },
      )
      .setFooter({ text: `📸 Photo de ${winner.participants.discord_display_name}` })
      .setTimestamp();

    // Supprimer le message texte d'ouverture et le message d'égalité s'il existe
    if (contest.opening_message_id) {
      await channel.messages.delete(contest.opening_message_id).catch(() => null);
    }
    if (contest.tiebreak_message_id) {
      await channel.messages.delete(contest.tiebreak_message_id).catch(() => null);
    }

    // Transformer l'embed d'annonce/règles en annonce du gagnant (avec mention @everyone)
    if (contest.rules_message_id) {
      const rulesMsg = await channel.messages.fetch(contest.rules_message_id).catch(() => null);
      if (rulesMsg) {
        await rulesMsg.edit({
          content: `🏆 Le concours screenshot de la semaine du **${startLabel}** au **${endLabel}** est **terminé** ! Félicitations à <@${winner.participants.discord_user_id}> !`,
          embeds: [embedWinner],
        }).catch(() => null);
      }
    }

    // Delete non-winner participation photos (winner's photo stays below)
    for (const p of participations.slice(1)) {
      if (p.message_id) await channel.messages.delete(p.message_id).catch(() => null);
    }
  }

  await log(guild.id, 'contest_closed', {
    contestId: contest.id,
    winnerId: participations[0].participant_id,
    totalEntries: participations.length,
  });

  return { tied: false };
}

async function updatePhotographerRole(guild, guildConfig, contest, winnerParticipation) {
  const { data: settings } = await supabase
    .from('contest_settings')
    .select('photographer_role_id')
    .eq('environment_id', guildConfig.environment_id)
    .single();

  const roleId = settings?.photographer_role_id;
  if (!roleId) return;

  const role = guild.roles.cache.get(roleId);
  if (!role) {
    await log(guild.id, 'photographer_role_missing', { roleId }, 'error');
    return;
  }

  const newWinnerUserId = winnerParticipation.participants.discord_user_id;

  // Find previous contest winner
  let prevWinnerUserId = null;
  const { data: prevContest } = await supabase
    .from('contests')
    .select('winner_participation_id')
    .eq('environment_id', guildConfig.environment_id)
    .eq('status', 'closed')
    .neq('id', contest.id)
    .not('winner_participation_id', 'is', null)
    .order('closed_at', { ascending: false })
    .limit(1)
    .single();

  if (prevContest?.winner_participation_id) {
    const { data: prevParticipation } = await supabase
      .from('participations')
      .select('participants(discord_user_id)')
      .eq('id', prevContest.winner_participation_id)
      .single();
    prevWinnerUserId = prevParticipation?.participants?.discord_user_id ?? null;
  }

  // Remove role from previous winner if different
  if (prevWinnerUserId && prevWinnerUserId !== newWinnerUserId) {
    try {
      const prevMember = await guild.members.fetch(prevWinnerUserId);
      await prevMember.roles.remove(roleId);
    } catch {
      await log(guild.id, 'photographer_role_remove_failed', { userId: prevWinnerUserId }, 'warn');
    }
  }

  // Add role to new winner
  try {
    const newMember = await guild.members.fetch(newWinnerUserId);
    await newMember.roles.add(roleId);
  } catch (err) {
    await log(guild.id, 'photographer_role_add_failed', { userId: newWinnerUserId, error: err.message }, 'warn');
  }
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
