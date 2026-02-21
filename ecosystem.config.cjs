module.exports = {
  apps: [
    {
      name: "appointment-vault",
      script: "src/app.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "300M",
      env: {
        APP_HOST: "127.0.0.1",
        APP_PORT: "3000"
      }
    }
  ]
};
