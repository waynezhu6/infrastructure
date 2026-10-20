import { setTimeout as sleep } from "node:timers/promises";
import { createVerifier } from "./auth.js";
import { loadConfig } from "./config.js";
import { createRunner } from "./deploy.js";
import { exec } from "./exec.js";
import { Deployer, Store } from "./jobs.js";
import { createApp } from "./server.js";

const config = loadConfig();
const store = new Store(config.dataDir);
const deployer = new Deployer(createRunner({ config, store, exec, fetch, sleep }), store);
const verify = createVerifier(config);

const server = createApp({ verify, deployer, infraDir: config.infraDir });
server.listen(config.port, () => console.log(`deployer listening on :${config.port}`));

// Infrastructure deploys restart this container. Stop taking new deploys, but
// let running ones finish (compose's stop_grace_period bounds the wait).
process.on("SIGTERM", async () => {
  console.log("SIGTERM: finishing running deploys");
  server.close();
  await deployer.idle();
  process.exit(0);
});
