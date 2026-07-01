import { supabase } from './supabase.js';
import { log } from './logger.js';
import { EmbedBuilder } from 'discord.js';
import { TEST_MODE, TEST_CONTEST_DURATION_MINUTES, TEST_TIEBREAK_DURATION_MINUTES } from './test-mode.js';

const POINTS_MAP = { 1: 100, 2: 60, 3: 30 };
const PARTICIPATION_POINTS = 20;
const VOTE_EMOJI = '❤️';

function nextWednesdayAt18() {
  const now = new Date();
  const result = new Date(now);
  const daysUntilWed = (3 - now.getDay() + 7) % 7 || 7; // at least 1 day ahead
  result.setDate(now.getDate() + daysUntilWed);
  result.setHours(18, 0, 0, 0);
  return result;
}

export async function openContest(guild, guildConfig, contestSettings, client, theme = null) {
  const environmentId = guildConfig.environment_id;

  let season = await getActiveSeason();
  if (!season) {
    season = await createSeason();
  }

  const startDate = new Date();
  const endDate = TEST_MODE
    ? new Date(Date.now() + TEST_CONTEST_DURATION_MINUTES * 60000)
    : nextWednesdayAt18();

  const { data: contest, error } = await supabase
    .from('contests')
    .insert({
      environment_id: environmentId,
      season_id: season.id,
      status: 'active',
      title: contestSettings?.contest_title ?? 'Concours Screenshot',
      theme: theme,
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
        ...(theme ? [{ name: '🎨 Thème', value: theme, inline: false }] : []),
        { name: '📅 Ouverture', value: startLabel, inline: true },
        { name: '🏁 Fermeture', value: endLabel, inline: true },
        { name: '⏳ Temps restant', value: `<t:${closeTimestamp}:R>`, inline: true },
        { name: '🏆 Classement', value: '[Voir le classement sur traaake.fr](https://traaake.fr/)', inline: false },
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
        .setFooter({ text: 'Communauté TraaaKe • traaake.fr' })
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
        const others = tiedParticipations.slice(1).map(p => `<@${p.participants.discord_user_id}>`).join(', ');
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
              `<@${winner.participants.discord_user_id}> et ${others} sont toujours à égalité avec **${winner.vote_count} ❤️**.\n\n` +
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
      // First tie detected → extend (24h normal, configurable in test mode)
      const tiebreakMs = TEST_MODE ? TEST_TIEBREAK_DURATION_MINUTES * 60000 : 24 * 3600000;
      const newEnd = new Date(Date.now() + tiebreakMs);
      await supabase.from('contests').update({ ends_at: newEnd.toISOString(), status: 'tiebreak' }).eq('id', contest.id);

      if (channel) {
        // List ALL tied participants (same vote_count as top)
        const topVotes = participations[0].vote_count;
        const tiedAll = participations.filter(p => p.vote_count === topVotes);
        const tiedMentions = tiedAll.map(p => `<@${p.participants.discord_user_id}>`).join(', ');

        const embed = new EmbedBuilder()
          .setTitle('⚖️ Égalité ! Le concours est prolongé.')
          .setDescription(
            `${tiedMentions} sont à égalité avec **${topVotes} ❤️**.\n\n` +
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

  // Award points — participation (everyone) + podium bonus (top 3)
  for (let i = 0; i < participations.length; i++) {
    const participation = participations[i];
    const podiumBonus = POINTS_MAP[i + 1] ?? 0;
    const total = PARTICIPATION_POINTS + podiumBonus;

    await supabase.from('points_ledger').insert({
      participant_id: participation.participant_id,
      season_id: contest.season_id,
      points: total,
      reason: podiumBonus > 0
        ? `Concours #${contest.id} — place ${i + 1} (+${podiumBonus} bonus)`
        : `Concours #${contest.id} — participation`,
      contest_id: contest.id,
    });

    // Increment participation_count for all, win_count only for winner
    const { data: currentStats } = await supabase
      .from('participants')
      .select('participation_count, win_count')
      .eq('id', participation.participant_id)
      .single();

    if (currentStats) {
      await supabase.from('participants').update({
        participation_count: currentStats.participation_count + 1,
        ...(i === 0 ? { win_count: currentStats.win_count + 1 } : {}),
      }).eq('id', participation.participant_id);
    }
  }

  // Assign/remove "Photographe de la semaine" role
  await updatePhotographerRole(guild, guildConfig, contest, participations[0]);

  // Edit opening messages in place so winner announcement stays above the winner photo
  if (channel) {
    const winner = participations[0];
    const startLabel = new Date(contest.started_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    const endLabel   = new Date(contest.ends_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

    const pts = (i) => PARTICIPATION_POINTS + (POINTS_MAP[i + 1] ?? 0);
    let podium = `🥇 <@${winner.participants.discord_user_id}> — **${winner.vote_count} ❤️** +${pts(0)} pts`;
    if (participations[1]) podium += `\n🥈 <@${participations[1].participants.discord_user_id}> — ${participations[1].vote_count} ❤️ +${pts(1)} pts`;
    if (participations[2]) podium += `\n🥉 <@${participations[2].participants.discord_user_id}> — ${participations[2].vote_count} ❤️ +${pts(2)} pts`;

    const embedWinner = new EmbedBuilder()
      .setTitle(`📸 Photographe de la semaine — ${winner.participants.discord_display_name}`)
      .setDescription(podium)
      .setColor(0xffd700)
      .addFields(
        { name: '📅 Semaine du', value: `${startLabel} au ${endLabel}`, inline: true },
        { name: '🏆 Classement', value: '[Voir sur traaake.fr](https://traaake.fr/)', inline: true },
      )
      .setFooter({ text: `📸 Photo de ${winner.participants.discord_display_name}` })
      .setTimestamp();

    // Supprimer le message texte d'ouverture et le message d'égalité s'il existe
    // Supprimer les messages du bot postés depuis l'ouverture du concours, sauf l'embed gagnant
    const keepId = contest.rules_message_id;
    const contestStart = new Date(contest.started_at);
    let lastId;
    while (true) {
      const batch = await channel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
      if (batch.size === 0) break;
      for (const msg of batch.values()) {
        if (new Date(msg.createdAt) < contestStart) continue;
        if (msg.author.id === channel.client.user.id && msg.id !== keepId) {
          await msg.delete().catch(() => null);
        }
      }
      const oldest = batch.last();
      if (!oldest || new Date(oldest.createdAt) < contestStart) break;
      lastId = oldest.id;
      if (batch.size < 100) break;
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

    // DM the winner
    try {
      const winnerUser = await channel.client.users.fetch(winner.participants.discord_user_id);
      const dm = await winnerUser.createDM();
      await dm.send(
        `🏆 **Félicitations ${winner.participants.discord_display_name} !**\n\n` +
        `Tu remportes le concours screenshot de la semaine avec **${winner.vote_count} ❤️** !\n` +
        `Tu reçois le rôle **Photographe de la semaine** et **${PARTICIPATION_POINTS + (POINTS_MAP[1] ?? 0)} points** au classement.\n\n` +
        `📊 Retrouve le classement complet sur **https://traaake.fr/**`
      );
    } catch { /* DMs may be closed */ }

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
  const currentYear = new Date().getFullYear();

  const { data } = await supabase
    .from('seasons')
    .select('*')
    .eq('is_active', true)
    .single();

  if (!data) return null;

  // If the active season is from a previous year, close it and start fresh
  if (new Date(data.starts_at).getFullYear() < currentYear) {
    await supabase.from('seasons').update({ is_active: false }).eq('id', data.id);
    return null;
  }

  return data;
}

async function createSeason() {
  const now = new Date();
  const year = now.getFullYear();
  const start = new Date(year, 0, 1);       // 1er janvier
  const end   = new Date(year, 11, 31, 23, 59, 59); // 31 décembre

  const { data, error } = await supabase
    .from('seasons')
    .insert({
      name: String(year),
      starts_at: start.toISOString(),
      ends_at: end.toISOString(),
      is_active: true,
    })
    .select()
    .single();

  if (error) console.error('[CONTEST] createSeason failed:', error.message);
  return data;
}
