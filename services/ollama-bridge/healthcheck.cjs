const http = require('node:http');
const request = http.get({ socketPath: '/run/ollama-bridge/ollama.sock', path: '/health', timeout: 2000 }, response => {
  response.resume();
  process.exitCode = response.statusCode === 200 ? 0 : 1;
});
request.on('timeout', () => request.destroy());
request.on('error', () => { process.exitCode = 1; });
