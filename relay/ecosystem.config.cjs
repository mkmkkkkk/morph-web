module.exports = {
  apps: [
    {
      name: 'tr-relay',
      script: 'index.js',
      cwd: '/Users/michaelyang/Documents/Workspace/morph/relay',
      restart_delay: 3000,
      max_restarts: 20,
      watch: false,
    },
    {
      name: 'tr-tunnel',
      script: 'cloudflared',
      args: 'tunnel --config /Users/michaelyang/.cloudflared/tr-relay.yml run',
      interpreter: 'none',
      restart_delay: 5000,
      max_restarts: 50,
    }
  ]
}
