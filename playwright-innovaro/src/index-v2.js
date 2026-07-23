require("dotenv").config();
const { runInnovaroAutomationV2 } = require("./innovaro-automation-v2");
const log = require("./logger");

runInnovaroAutomationV2().catch((error) => {
  log.error("Falha na automacao Playwright do Innovaro (v2).");
  log.error(String(error));
  process.exitCode = 1;
});
