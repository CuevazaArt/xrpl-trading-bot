module.exports = {
  apps: [
    {
      name: "helena",
      script: "./dist/index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "200M",

      // Reinicio preventivo diario a las 4:00 AM (mantenimiento)
      cron_restart: "0 4 * * *",

      // Evitar restart loops: max 10 reinicios, mínimo 30s de uptime
      max_restarts: 10,
      min_uptime: "30s",

      // Dar tiempo al graceful shutdown para cancelar órdenes
      kill_timeout: 10000,

      // Logging
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "./logs/err.log",
      out_file: "./logs/out.log",
      merge_logs: true,

      env: {
        NODE_ENV: "production",
      }
    }
  ]
};
