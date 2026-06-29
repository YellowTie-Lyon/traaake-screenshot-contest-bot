import { EmbedBuilder } from 'discord.js';
import { getGuildConfig, getActiveContest, invalidateCache } from '../config.js';
import { openContest, closeContest } from '../contest.js';
import { log } from '../logger.js';
import { supabase } from '../supabase.js';

export async function handleInteraction(interaction, client) {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guildId;
  const config = await getGuildConfig(guildId);

  if (!config) {
    await interaction.reply({ content: 'Ce serveur n\'est pas configuré dans Supabase.', ephemeral: true });
    return;
  }

  const { guildConfig, contestSettings } = config;

  // Check admin role for management commands
  const isAdmin = interaction.member.roles.cache.has(guildConfig.admin_role_id)
    || interaction.member.permissions.has('Administrator');

  switch (interaction.commandName) {
    case 'contest':
      await handleContestCommand(interaction, guildConfig, contestSettings, isAdmin, client);
      break;
    case 'leaderboard':
      await handleLeaderboard(interaction, guildConfig);
      break;
    case 'syncconfig':
      await handleSyncConfig(interaction, guildId, isAdmin);
      break;
  }
}

async function handleContestCommand(interaction, guildConfig, contestSettings, isAdmin, client) {
  const sub = interaction.options.getSubcommand();

  if (sub !== 'status' && !isAdmin) {
    await interaction.reply({ content: 'Tu dois avoir le rôle admin pour cette commande.', ephemeral: true });
    return;
  }

  const guild = interaction.guild;
  const activeContest = await getActiveContest(guildConfig.environment_id);

  if (sub === 'open') {
    if (activeContest) {
      await interaction.reply({ content: 'Un concours est déjà en cours.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const contest = await openContest(guild, guildConfig, contestSettings, client);
    await interaction.editReply(contest ? '✅ Concours ouvert !' : '❌ Erreur lors de l\'ouverture.');

  } else if (sub === 'close') {
    if (!activeContest) {
      await interaction.reply({ content: 'Aucun concours actif à fermer.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    await closeContest(guild, guildConfig, activeContest, client);
    await interaction.editReply('✅ Concours fermé et gagnants annoncés !');

  } else if (sub === 'status') {
    if (!activeContest) {
      await interaction.reply({ content: 'Aucun concours actif en ce moment.', ephemeral: true });
      return;
    }

    const { data: entries } = await supabase
      .from('participations')
      .select('id, vote_count, participants(username)')
      .eq('contest_id', activeContest.id)
      .order('vote_count', { ascending: false })
      .limit(5);

    const embed = new EmbedBuilder()
      .setTitle(`📸 ${activeContest.title}`)
      .setColor(0x5865f2)
      .addFields(
        { name: 'Statut', value: 'En cours', inline: true },
        { name: 'Fin', value: `<t:${Math.floor(new Date(activeContest.ends_at).getTime() / 1000)}:R>`, inline: true },
        { name: 'Participations', value: String(entries?.length ?? 0), inline: true }
      );

    if (entries?.length > 0) {
      embed.addFields({
        name: 'Top 5',
        value: entries.map((e, i) => `${i + 1}. **${e.participants.username}** — ${e.vote_count} vote(s)`).join('\n'),
      });
    }

    await interaction.reply({ embeds: [embed], ephemeral: false });
  }
}

async function handleLeaderboard(interaction, guildConfig) {
  await interaction.deferReply();

  const { data: season } = await supabase
    .from('seasons')
    .select('*')
    .eq('is_active', true)
    .single();

  if (!season) {
    await interaction.editReply('Aucune saison active.');
    return;
  }

  const { data: ledger } = await supabase
    .from('points_ledger')
    .select('points, participants(username, discord_user_id)')
    .eq('season_id', season.id);

  if (!ledger || ledger.length === 0) {
    await interaction.editReply('Aucun point attribué cette saison.');
    return;
  }

  // Aggregate points per participant
  const totals = new Map();
  for (const entry of ledger) {
    const key = entry.participants.discord_user_id;
    totals.set(key, {
      username: entry.participants.username,
      points: (totals.get(key)?.points ?? 0) + entry.points,
    });
  }

  const sorted = [...totals.values()].sort((a, b) => b.points - a.points).slice(0, 10);
  const medals = ['🥇', '🥈', '🥉'];

  const embed = new EmbedBuilder()
    .setTitle(`🏆 Classement — ${season.name}`)
    .setColor(0xffd700)
    .setDescription(
      sorted.map((e, i) => `${medals[i] ?? `${i + 1}.`} **${e.username}** — ${e.points} pts`).join('\n')
    )
    .setFooter({ text: 'Classement mis à jour en temps réel' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleSyncConfig(interaction, guildId, isAdmin) {
  if (!isAdmin) {
    await interaction.reply({ content: 'Commande réservée aux admins.', ephemeral: true });
    return;
  }
  invalidateCache(guildId);
  await interaction.reply({ content: '✅ Configuration rechargée depuis Supabase.', ephemeral: true });
  await log(guildId, 'config_synced_manually', { triggeredBy: interaction.user.id });
}
