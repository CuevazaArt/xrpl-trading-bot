module.exports = {
  apps: [
    {
      name: "xrpl-trading-bot",
      script: "./dist/index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "200M",
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
