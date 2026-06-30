import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { fetchEnvironment } from '../src/environment.js';

const env = await fetchEnvironment();
const rest = new REST({ version: '10' }).setToken(env.discord_bot_token);

// Clear all global commands
await rest.put(Routes.applicationCommands(env.discord_app_id), { body: [] });
console.log('Global commands cleared.');
