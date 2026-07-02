require('dotenv/config');

module.exports = {
  apps: [
    {
      name: 'trakebot-prod',
      script: 'src/index.js',
      node_args: '--experimental-vm-modules',
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        SUPABASE_URL: process.env.SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
        ENVIRONMENT_ID: process.env.ENVIRONMENT_ID_PROD,
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
