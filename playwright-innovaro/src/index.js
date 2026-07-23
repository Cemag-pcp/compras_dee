require("dotenv").config();
const { runInnovaroAutomation } = require("./innovaro-automation");
const log = require("./logger");

runInnovaroAutomation().catch((error) => {
  log.error("Falha na automacao Playwright do Innovaro.");
  log.error(String(error));
  process.exitCode = 1;
});
