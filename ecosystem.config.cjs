// PM2 configuration — deploy two bot processes on the VPS, one per Discord application.
// Each process only knows its ENVIRONMENT_ID; the Discord token is fetched from Supabase.
module.exports = {
  apps: [
    {
      name: 'traaake-bot-prod',
      script: 'src/index.js',
      node_args: '--experimental-vm-modules',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        // Shared Supabase credentials (same project, both envs)
        SUPABASE_URL: process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        // UUID of the "production" row in the environments table
        ENVIRONMENT_ID: process.env.ENVIRONMENT_ID_PROD,
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      name: 'traaake-bot-test',
      script: 'src/index.js',
      node_args: '--experimental-vm-modules',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        SUPABASE_URL: process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        // UUID of the "test" row in the environments table
        ENVIRONMENT_ID: process.env.ENVIRONMENT_ID_TEST,
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
