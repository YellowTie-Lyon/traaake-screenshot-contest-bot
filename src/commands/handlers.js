import { EmbedBuilder } from 'discord.js';
import { getGuildConfig, getActiveContest, invalidateCache } from '../config.js';
import { openContest, closeContest } from '../contest.js';
import { log } from '../logger.js';
import { supabase } from '../supabase.js';
import { checkContests } from '../scheduler.js';

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
    case 'reset':
      await handleReset(interaction, guildConfig, isAdmin);
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
    const result = await closeContest(guild, guildConfig, activeContest, client);
    if (result?.noEntries) {
      await interaction.editReply('✅ Concours fermé — aucune participation cette semaine.');
    } else if (result?.tied) {
      await interaction.editReply('⚖️ Égalité détectée — le concours est prolongé de 24h.');
    } else {
      await interaction.editReply('✅ Concours fermé et gagnants annoncés !');
    }

  } else if (sub === 'check') {
    await interaction.deferReply({ ephemeral: true });
    await checkContests(client);
    await interaction.editReply('✅ Vérification des votes effectuée.');

  } else if (sub === 'ban') {
    await handleBan(interaction, guildConfig, isAdmin);

  } else if (sub === 'unban') {
    await handleUnban(interaction, guildConfig, isAdmin);

  } else if (sub === 'bans') {
    await handleBans(interaction, guildConfig, isAdmin);

  } else if (sub === 'status') {
    if (!activeContest) {
      await interaction.reply({ content: 'Aucun concours actif en ce moment.', ephemeral: true });
      return;
    }

    const { data: entries } = await supabase
      .from('participations')
      .select('id, vote_count, participants(discord_username)')
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
        value: entries.map((e, i) => `${i + 1}. **${e.participants.discord_username}** — ${e.vote_count} vote(s)`).join('\n'),
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
    .select('points, participants(discord_username, discord_user_id)')
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
      username: entry.participants.discord_username,
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

async function handleReset(interaction, guildConfig, isAdmin) {
  if (!isAdmin) {
    await interaction.reply({ content: 'Commande réservée aux admins.', ephemeral: true });
    return;
  }

  const confirmation = interaction.options.getString('confirmation');
  if (confirmation !== 'CONFIRMER') {
    await interaction.reply({ content: '❌ Tapez exactement `CONFIRMER` pour valider le reset.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const environmentId = guildConfig.environment_id;
  const guild = interaction.guild;

  // Remove photographer role from current holder
  const { data: roleSettings } = await supabase
    .from('contest_settings')
    .select('photographer_role_id')
    .eq('environment_id', environmentId)
    .single();

  if (roleSettings?.photographer_role_id) {
    const role = guild.roles.cache.get(roleSettings.photographer_role_id);
    if (role) {
      const members = await guild.members.fetch();
      for (const member of members.values()) {
        if (member.roles.cache.has(roleSettings.photographer_role_id)) {
          await member.roles.remove(roleSettings.photographer_role_id).catch(() => null);
        }
      }
    }
  }

  // Delete points, participations and reset winner data for all contests
  const { data: contests } = await supabase
    .from('contests')
    .select('id')
    .eq('environment_id', environmentId);

  if (contests?.length) {
    const contestIds = contests.map(c => c.id);
    // Clear FK references first to avoid constraint violation
    await supabase.from('contests')
      .update({ winner_participation_id: null, winner_discord_user_id: null })
      .in('id', contestIds);
    await supabase.from('points_ledger').delete().in('contest_id', contestIds);
    await supabase.from('participations').delete().in('contest_id', contestIds);
  }

  // Delete participants
  await supabase.from('participants').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  // Close active contest if any
  await supabase.from('contests')
    .update({ status: 'closed', closed_at: new Date().toISOString() })
    .eq('environment_id', environmentId)
    .in('status', ['active', 'tiebreak']);

  await log(guildConfig.guild_id, 'leaderboard_reset', { triggeredBy: interaction.user.id });
  await interaction.editReply('✅ Classement remis à zéro — points, participations, membres, votes et gagnants supprimés.');
}

function parseDuration(str) {
  if (!str) return null;
  const match = str.match(/^(\d+)(j|d|h)$/i);
  if (!match) return null;
  const amount = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const ms = unit === 'h' ? amount * 3600000 : amount * 86400000;
  return new Date(Date.now() + ms);
}

async function handleBan(interaction, guildConfig, isAdmin) {
  if (!isAdmin) {
    await interaction.reply({ content: 'Commande réservée aux admins.', ephemeral: true });
    return;
  }

  const target = interaction.options.getUser('membre');
  const reason = interaction.options.getString('raison') ?? null;
  const dureeStr = interaction.options.getString('durée') ?? null;
  const expiresAt = parseDuration(dureeStr);

  await supabase.from('contest_bans').upsert(
    {
      environment_id: guildConfig.environment_id,
      discord_user_id: target.id,
      discord_username: target.username,
      reason,
      banned_by: interaction.user.id,
      banned_at: new Date().toISOString(),
      expires_at: expiresAt?.toISOString() ?? null,
    },
    { onConflict: 'environment_id,discord_user_id' }
  );

  const expiry = expiresAt
    ? `jusqu'au <t:${Math.floor(expiresAt.getTime() / 1000)}:F>`
    : 'définitivement';

  await interaction.reply({
    content: `🚫 **${target.username}** est exclu du concours ${expiry}${reason ? ` — *${reason}*` : ''}.`,
    ephemeral: true,
  });
  await log(guildConfig.guild_id, 'contest_ban', { targetId: target.id, reason, expiresAt, bannedBy: interaction.user.id });
}

async function handleUnban(interaction, guildConfig, isAdmin) {
  if (!isAdmin) {
    await interaction.reply({ content: 'Commande réservée aux admins.', ephemeral: true });
    return;
  }

  const target = interaction.options.getUser('membre');

  const { error } = await supabase
    .from('contest_bans')
    .delete()
    .eq('environment_id', guildConfig.environment_id)
    .eq('discord_user_id', target.id);

  if (error) {
    await interaction.reply({ content: `❌ Erreur : ${error.message}`, ephemeral: true });
    return;
  }

  await interaction.reply({ content: `✅ **${target.username}** peut à nouveau participer au concours.`, ephemeral: true });
  await log(guildConfig.guild_id, 'contest_unban', { targetId: target.id, unbannedBy: interaction.user.id });
}

async function handleBans(interaction, guildConfig, isAdmin) {
  if (!isAdmin) {
    await interaction.reply({ content: 'Commande réservée aux admins.', ephemeral: true });
    return;
  }

  const now = new Date().toISOString();
  const { data: bans } = await supabase
    .from('contest_bans')
    .select('discord_username, reason, banned_at, expires_at')
    .eq('environment_id', guildConfig.environment_id)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order('banned_at', { ascending: false });

  if (!bans?.length) {
    await interaction.reply({ content: 'Aucun membre exclu en ce moment.', ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('🚫 Membres exclus du concours')
    .setColor(0xff4444)
    .setDescription(
      bans.map(b => {
        const expiry = b.expires_at ? `<t:${Math.floor(new Date(b.expires_at).getTime() / 1000)}:F>` : 'Permanent';
        return `**${b.discord_username}** — ${expiry}${b.reason ? ` — *${b.reason}*` : ''}`;
      }).join('\n')
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
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
