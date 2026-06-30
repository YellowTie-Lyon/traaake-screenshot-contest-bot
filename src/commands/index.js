import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { log } from '../logger.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('contest')
    .setDescription('Gérer le concours screenshot')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand(sub =>
      sub.setName('open').setDescription('Ouvrir un nouveau concours')
        .addStringOption(opt => opt.setName('thème').setDescription('Thème facultatif du concours (ex: coucher de soleil)').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('close').setDescription('Fermer le concours actuel et annoncer les gagnants')
    )
    .addSubcommand(sub =>
      sub.setName('status').setDescription('Voir le statut du concours actuel')
    )
    .addSubcommand(sub =>
      sub.setName('check').setDescription('Forcer la vérification des votes maintenant (admin)')
    )
    .addSubcommand(sub =>
      sub.setName('ban')
        .setDescription('Exclure un membre du concours (admin)')
        .addUserOption(opt => opt.setName('membre').setDescription('Membre à exclure').setRequired(true))
        .addStringOption(opt => opt.setName('raison').setDescription('Raison du ban').setRequired(false))
        .addStringOption(opt => opt.setName('durée').setDescription('Durée du ban (vide = permanent)').setRequired(false)
          .addChoices(
            { name: '1 minute (test)', value: '1m' },
            { name: '1 jour', value: '1j' },
            { name: '3 jours', value: '3j' },
            { name: '7 jours', value: '7j' },
            { name: '14 jours', value: '14j' },
            { name: '30 jours', value: '30j' },
            { name: 'Permanent', value: 'permanent' },
          )
        )
    )
    .addSubcommand(sub =>
      sub.setName('unban')
        .setDescription('Lever l\'exclusion d\'un membre (admin)')
        .addUserOption(opt => opt.setName('membre').setDescription('Membre à débannir').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('bans').setDescription('Lister les membres exclus du concours (admin)')
    ),

  new SlashCommandBuilder()
    .setName('classement')
    .setDescription('Afficher le classement de l\'année en cours')
    .setDefaultMemberPermissions(null),

  new SlashCommandBuilder()
    .setName('syncconfig')
    .setDescription('Recharger la configuration depuis Supabase')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Remettre le classement à zéro (admin uniquement)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(opt =>
      opt.setName('confirmation')
        .setDescription('Tapez "CONFIRMER" pour valider le reset')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('purge')
    .setDescription('[TEMP] Supprimer tous les messages du salon concours (admin uniquement)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

  new SlashCommandBuilder()
    .setName('monstats')
    .setDescription('Voir tes statistiques de participation au concours screenshot')
    .setDefaultMemberPermissions(null),

  new SlashCommandBuilder()
    .setName('points')
    .setDescription('Gérer les points d\'un membre (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand(sub =>
      sub.setName('ajouter')
        .setDescription('Ajouter des points à un membre')
        .addUserOption(opt => opt.setName('membre').setDescription('Membre ciblé').setRequired(true))
        .addIntegerOption(opt => opt.setName('points').setDescription('Nombre de points à ajouter').setMinValue(1).setRequired(true))
        .addStringOption(opt => opt.setName('raison').setDescription('Raison').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('retirer')
        .setDescription('Retirer des points à un membre')
        .addUserOption(opt => opt.setName('membre').setDescription('Membre ciblé').setRequired(true))
        .addIntegerOption(opt => opt.setName('points').setDescription('Nombre de points à retirer').setMinValue(1).setRequired(true))
        .addStringOption(opt => opt.setName('raison').setDescription('Raison').setRequired(false))
    ),

].map(cmd => cmd.toJSON());

export async function registerCommands(client, token) {
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    // Register on each guild directly (instant, no propagation delay)
    for (const guild of client.guilds.cache.values()) {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, guild.id),
        { body: commands }
      );
      console.log(`Slash commands registered on guild ${guild.name}.`);
    }
  } catch (err) {
    console.error('Failed to register slash commands:', err.message);
  }
}
