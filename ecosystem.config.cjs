// PM2 process definition for tradeaway.
//
// The bot runs directly from TypeScript via tsx (no build step) — PM2 launches
// Node with `--import tsx` so src/index.ts runs as-is. Start/manage with:
//
//   pm2 start ecosystem.config.cjs          # first launch
//   pm2 reload ecosystem.config.cjs --env production   # zero-downtime redeploy
//   pm2 save                                # persist across reboots (run once, after pm2 startup)
//   pm2 logs tradeaway                      # tail logs
//
// scripts/deploy.sh runs the reload for you on each git push.
module.exports = {
  apps: [
    {
      name: "tradeaway",
      script: "src/index.ts",
      interpreter: "node",
      // Modern tsx loader; works on Node 20+. Runs TypeScript without a build.
      interpreter_args: "--import tsx",
      cwd: __dirname,

      // Single long-running scanner — never cluster it.
      instances: 1,
      exec_mode: "fork",

      // Restart policy: recover from crashes, but back off if it's crash-looping
      // (e.g. bad config) instead of hammering restarts.
      autorestart: true,
      max_restarts: 10,
      min_uptime: "30s",
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,

      // Guard against a slow memory leak; PM2 restarts above this RSS.
      max_memory_restart: "500M",

      // Give in-flight work time to drain on reload before SIGKILL.
      kill_timeout: 8000,

      // Logs (rotate with `pm2 install pm2-logrotate`).
      time: true,
      merge_logs: true,
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",

      env: {
        NODE_ENV: "production",
        // Real secrets/config live in .env (loaded by the app), not here, so this
        // file stays safe to commit. Override the health port here if 3000 clashes.
        HEALTH_PORT: "3000",
        HEALTH_HOST: "127.0.0.1",
      },
    },
  ],
};
