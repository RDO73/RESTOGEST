import { app } from './app.js';
import { config } from './config/env.js';

app.listen(config.port, () => {
  console.log(`[RESTOGEST V1 SERVER] En écoute sur le port ${config.port} (env: ${config.nodeEnv})`);
});
