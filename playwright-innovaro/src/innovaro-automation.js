const { chromium } = require("playwright");
const log = require("./logger");
const { saveDownload } = require("./downloads");
const {
  updatePlanilhaRecursosUtilizados,
  updateSaldoRecursos,
  updateAnalisePedidosPendentes,
  updateAnalisePedidosMateriaisCustoIndireto
} = require("./reports");

const DEFAULT_WAIT_MS = Number(process.env.INNOVARO_DEFAULT_WAIT_MS || 2500);
const SLOW_MO_MS = Number(process.env.INNOVARO_SLOW_MO_MS || 250);
const ERP_PHASE_TIMEOUT_MS = Number(process.env.INNOVARO_PHASE_TIMEOUT_MS || 180000);

const SIMULATION_NAME =
  process.env.INNOVARO_SIMULATION_NAME || "Pendencia Diaria Carretas Compras";
const SIMULATION_MAT_IND_NAME =
  process.env.INNOVARO_SIMULATION_MAT_IND_NAME || "Simulação Mat ind (Mov 3M)";

const EMISSION_INITIAL = process.env.INNOVARO_EMISSION_INITIAL || "01/01/2021";
const EMISSION_DOC_DEFAULT = process.env.INNOVARO_EMISSION_DOC_DEFAULT || "31/12/2025";
const EXCLUDED_SPEC_COUNT = Number(process.env.INNOVARO_EXCLUDED_SPEC_COUNT || 8);

const RELATORIO_NIVEL = process.env.INNOVARO_RELATORIO_NIVEL || "Último Nível";
const RELATORIO_ALMOXARIFADO = process.env.INNOVARO_RELATORIO_ALMOXARIFADO || "Almox de Compras";
const RELATORIO_CLASSE = process.env.INNOVARO_RELATORIO_CLASSE || "Materiais e Produtos";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  }
  return value;
}

async function waitForUi(page, waitMs = DEFAULT_WAIT_MS) {
  await page.waitForTimeout(waitMs);
}

async function waitForErpFrame(page) {
  const iframeLocator = page.locator("iframe").last();
  await iframeLocator.waitFor({ timeout: 30000 });

  const frameHandle = await iframeLocator.elementHandle();
  const frame = await frameHandle?.contentFrame();

  if (!frame) {
    throw new Error("Nao foi possivel acessar o iframe ativo do Innovaro.");
  }

  return frame;
}

async function waitForErpPhaseToFinish(page, options = {}) {
  const {
    phaseName = "fase do ERP",
    waitMs = DEFAULT_WAIT_MS,
    timeoutMs = ERP_PHASE_TIMEOUT_MS
  } = options;

  log.info(`Aguardando fim da ${phaseName}...`);
  const frame = await waitForErpFrame(page);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const phaseState = await frame.evaluate(() => {
      const bodyText = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
      const phasePattern = /Explodindo|Gravando|Criando n[ií]vel|Carregando|Processando/i;

      const busyByText = phasePattern.test(bodyText);
      const busyByOverlay = [...document.querySelectorAll("div, section, span")].some((el) => {
        const text = (el.textContent || "").trim();
        const style = window.getComputedStyle(el);

        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          phasePattern.test(text)
        );
      });

      const busyByFramework =
        Boolean(document.querySelector("#progressMessageBox")) ||
        Boolean(document.querySelector("#statusMessageBox")) ||
        Boolean(document.querySelector("[role='progressbar']"));

      return {
        busy: busyByText || busyByOverlay || busyByFramework
      };
    });

    if (!phaseState.busy) {
      log.info(`${phaseName} concluida (${Date.now() - startedAt}ms)`);
      await page.waitForTimeout(waitMs);
      return;
    }

    await page.waitForTimeout(1500);
  }

  throw new Error(`Tempo esgotado aguardando o termino da ${phaseName}.`);
}

async function waitForErpReady(page, options = {}) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await waitForErpPhaseToFinish(page, options);
}

async function waitForScreenChange(page, waitMs = DEFAULT_WAIT_MS) {
  await waitForErpReady(page, { phaseName: "mudanca de tela", waitMs });
}

async function evaluateInFrame(page, callback, arg) {
  const frame = await waitForErpFrame(page);
  return frame.evaluate(callback, arg);
}

async function waitForFrameCondition(page, callback, arg, options = {}) {
  const { timeoutMs = 30000, pollMs = 500 } = options;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const ok = await evaluateInFrame(page, callback, arg);
    if (ok) {
      return;
    }

    await page.waitForTimeout(pollMs);
  }

  throw new Error("Condicao do iframe nao foi satisfeita dentro do tempo esperado.");
}

async function login(page) {
  log.step("Login");
  const url = requiredEnv("INNOVARO_URL");
  log.info(`Abrindo URL: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  log.info("Preenchendo credenciais...");
  await page.getByRole("textbox", { name: "Usuário" }).fill(requiredEnv("INNOVARO_USERNAME"));
  await waitForUi(page, 500);
  await page.getByRole("textbox", { name: "Senha" }).fill(requiredEnv("INNOVARO_PASSWORD"));
  await waitForUi(page, 500);
  log.info("Clicando em Entrar...");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByRole("button", { name: "Menu", exact: true }).waitFor({ timeout: 30000 });
  await waitForUi(page, 4000);
  log.done("Login");
}

async function openMainMenu(page) {
  const closeMenuButton = page.getByRole("button", { name: "Fechar menu", exact: true });
  if (await closeMenuButton.isVisible().catch(() => false)) {
    return;
  }

  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await closeMenuButton.waitFor({ timeout: 15000 });
  await waitForUi(page);
}

async function navigateMenuPath(page, items, options = {}) {
  const { waitForTabRegex, waitMs = 5000 } = options;
  log.step(`Navegação: ${items.join(" > ")}`);
  await openMainMenu(page);

  for (const item of items) {
    log.info(`Clicando em "${item}"...`);
    await page.getByText(item, { exact: true }).click();
    await waitForUi(page);
  }

  if (waitForTabRegex) {
    await page.getByRole("tab", { name: waitForTabRegex }).waitFor({ timeout: 30000 });
  }

  await waitForScreenChange(page, waitMs);
  log.done(`Navegação: ${items.join(" > ")}`);
}

async function navigateToProducaoPlanoMestre(page) {
  await navigateMenuPath(
    page,
    ["Produção", "Plano mestre e simulação (MPS)", "Plano mestre e simulação"],
    { waitForTabRegex: /Plano mestre e simulação/i, waitMs: 5000 }
  );
}

async function navigateToRelatorioLogistica(page) {
  await navigateMenuPath(page, ["Relatório de Logística de Compras da Simulação"]);
}

async function searchAndSelectSimulation(page, simulationName) {
  const frame = await waitForErpFrame(page);

  // Loga inputs e botões disponíveis para diagnóstico
  const uiSnapshot = await frame.evaluate(() => {
    const inputs = [...document.querySelectorAll("input:not([type='hidden'])")].map((el) => ({
      id: el.id, name: el.name, placeholder: el.placeholder, type: el.type
    }));
    const buttons = [...document.querySelectorAll("button, input[type='button'], input[type='submit']")].map((el) => ({
      id: el.id, text: (el.textContent || el.value || "").replace(/\s+/g, " ").trim().slice(0, 40)
    }));
    return { inputs, buttons };
  }).catch(() => ({ inputs: [], buttons: [] }));
  log.info(`Inputs no iframe: ${JSON.stringify(uiSnapshot.inputs)}`);
  log.info(`Botões no iframe: ${JSON.stringify(uiSnapshot.buttons)}`);

  // Localiza o campo de busca pelo nome da simulação
  const searchInputSelector = await frame.evaluate(() => {
    const token = `codex-sim-${Date.now()}`;
    const candidates = [
      document.querySelector("#edtPesquisa"),
      document.querySelector("#edtNome"),
      document.querySelector("#edtBusca"),
      document.querySelector("#edtFiltro"),
      document.querySelector("input[name='NOME']"),
      document.querySelector("input[placeholder*='esquisar' i]"),
      document.querySelector("input[placeholder*='ome' i]"),
      document.querySelector("input[placeholder*='iltro' i]"),
      (() => {
        const btn = [...document.querySelectorAll("button, a, input[type='button']")].find(
          (el) => /pesquis|buscar|search|procurar/i.test(el.textContent || el.value || el.title || "")
        );
        const area = btn?.closest("tr, div, form, fieldset");
        return area?.querySelector("input:not([type='hidden'])") || null;
      })()
    ].filter(Boolean);

    if (!candidates[0]) return null;
    candidates[0].setAttribute("data-codex-sim", token);
    return `[data-codex-sim="${token}"]`;
  });

  if (searchInputSelector) {
    log.info(`Campo de busca encontrado — digitando "${simulationName}"...`);
    const input = frame.locator(searchInputSelector);
    await input.click();
    await input.press("Control+A");
    await input.type(simulationName);
    await waitForUi(page, 300);

    // Clica no botão de busca ou pressiona Enter
    const btnClicked = await frame.evaluate(() => {
      const btn = [...document.querySelectorAll("button, input[type='button'], input[type='submit'], a")].find(
        (el) => /pesquis|buscar|search|procurar/i.test(
          (el.textContent || el.value || el.title || el.getAttribute("aria-label") || "")
        )
      );
      if (btn) { btn.click(); return (btn.textContent || btn.value || "").trim(); }
      return null;
    });

    if (btnClicked) {
      log.info(`Botão de busca clicado: "${btnClicked}"`);
    } else {
      log.info("Botão de busca não encontrado — usando Enter...");
      await input.press("Enter");
    }

    await waitForErpReady(page, { phaseName: "busca da simulacao", waitMs: 3000 });

  } else {
    log.warn("Campo de busca visual não encontrado — tentando API interna do ERP...");
    const apiResult = await frame.evaluate((name) => {
      try {
        const grid = window.Environment?.getInstance?.()?.currentProcess?.getGrid?.("grSimulacoes");
        if (grid) {
          grid.emit("search", {
            gridName: "grSimulacoes",
            fieldName: "NOME",
            searchValue: name,
            allFields: false,
            preventDefault: false
          });
          return "search-emitted";
        }
      } catch (_) {}
      return "api-unavailable";
    }, simulationName);
    log.info(`API interna: ${apiResult}`);
    await page.waitForTimeout(4000);
  }

  // Aguarda linhas aparecerem e clica na correta
  await waitForFrameCondition(
    page,
    () => document.querySelectorAll("#grSimulacoes tbody tr td").length > 0,
    null,
    { timeoutMs: 30000 }
  );

  const rows = await evaluateInFrame(page, () =>
    [...document.querySelectorAll("#grSimulacoes tbody tr")].map((r) =>
      r.textContent?.replace(/\s+/g, " ").trim().slice(0, 80)
    )
  ).catch(() => []);
  log.info(`Linhas no grid após busca: ${rows.length}`);
  rows.forEach((r, i) => log.info(`  [${i}] ${r}`));

  const clicked = await evaluateInFrame(page, (name) => {
    const normalize = (v) =>
      String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();

    const allRows = [...document.querySelectorAll("#grSimulacoes tbody tr")];
    const row = allRows.find((r) => normalize(r.textContent).includes(normalize(name))) || allRows[0];
    if (!row) return false;

    row.querySelector("td")?.click();
    return row.textContent?.replace(/\s+/g, " ").trim().slice(0, 80);
  }, simulationName);

  if (!clicked) {
    await captureArtifacts(page, "erro-simulacao-nao-encontrada");
    throw new Error(`Nenhuma linha encontrada no grid após busca por "${simulationName}".`);
  }

  log.info(`Linha selecionada: "${clicked}"`);
}

async function selectSimulation(page, simulationName = SIMULATION_NAME) {
  log.step(`Seleção de simulação: "${simulationName}"`);
  await captureArtifacts(page, "debug-antes-selecao-simulacao");

  log.info("Aguardando grid de simulações (#grSimulacoes)...");
  await waitForFrameCondition(
    page,
    () => Boolean(document.querySelector("#grSimulacoes")),
    null,
    { timeoutMs: 30000 }
  );

  await searchAndSelectSimulation(page, simulationName);

  await waitForScreenChange(page, 3000);
  log.done(`Seleção de simulação: "${simulationName}"`);
}

async function excludeConfiguredEspecificacoes(page, rowsToExclude = EXCLUDED_SPEC_COUNT) {
  log.step(`Exclusão de especificações (${rowsToExclude} linhas)`);
  log.info(`Selecionando e excluindo ${rowsToExclude} especificações...`);
  const beforeCount = await evaluateInFrame(page, (count) => {
    const normalize = (value) =>
      String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toUpperCase();

    const clickElement = (element) => {
      if (!element) {
        return false;
      }

      element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return true;
    };

    const titleElement = [...document.querySelectorAll("div, span, td, th")].find(
      (el) => normalize(el.textContent) === "ESPECIFICACAO"
    );

    if (!titleElement) {
      throw new Error("Cabecalho da grade Especificacao nao encontrado.");
    }

    const minusButton = [...document.querySelectorAll("button, a, span, div")].find(
      (el) =>
        normalize(el.textContent) === "-" &&
        el.getBoundingClientRect().top <= titleElement.getBoundingClientRect().bottom + 50
    );

    const chaveHeader = [...document.querySelectorAll("div, span, td, th")].find(
      (el) => normalize(el.textContent) === "CHAVE"
    );

    clickElement(chaveHeader);

    const grid = document.querySelector("#grEspecificacao");
    if (!grid) {
      throw new Error("Grid grEspecificacao nao encontrado.");
    }

    const rows = [...grid.querySelectorAll("tbody tr")].filter((row) =>
      row.querySelector("input[type='checkbox']")
    );

    const firstDataRow = rows[0]?.querySelector("td:nth-child(2), td:nth-child(1)");
    clickElement(firstDataRow);

    const checkboxes = rows
      .map((row) => row.querySelector("input[type='checkbox']"))
      .filter(Boolean)
      .slice(0, count);

    checkboxes.forEach((checkbox) => {
      if (!checkbox.checked) {
        checkbox.click();
      }
    });

    const selectedCount = checkboxes.filter((checkbox) => checkbox.checked).length;
    if (selectedCount !== count) {
      throw new Error(`Quantidade marcada invalida: ${selectedCount}. Esperado: ${count}.`);
    }

    if (!clickElement(minusButton)) {
      throw new Error("Botao de exclusao da grade Especificacao nao encontrado.");
    }

    const badgeText = titleElement.parentElement?.innerText || titleElement.innerText || "";
    const match = badgeText.match(/(\d+)\s+de\s+(\d+)/i);
    return match ? Number(match[2]) : null;
  }, rowsToExclude);

  log.info(`Total antes da exclusão: ${beforeCount ?? "desconhecido"}. Confirmando exclusão...`);
  await page.getByRole("button", { name: "Sim", exact: true }).click();
  await waitForErpReady(page, { phaseName: "exclusao de itens da Especificacao", waitMs: 4000 });

  log.info("Aguardando atualização da grade após exclusão...");
  await waitForFrameCondition(
    page,
    (expectedDecrease) => {
      const titleText = document.body?.innerText || "";
      const match = titleText.match(/Especifica[a-zçãõ]*\s+(\d+)\s+de\s+(\d+)/i);
      if (!match) {
        return false;
      }

      const total = Number(match[2]);
      return Number.isFinite(total) && total <= expectedDecrease - 1;
    },
    beforeCount || 999999,
    { timeoutMs: 60000, pollMs: 1000 }
  );
  log.done(`Exclusão de especificações (${rowsToExclude} linhas)`);
}

async function openPendenciaDePedidos(page) {
  log.step("Abertura: Pendência de Pedidos");
  log.info("Clicando no botão Pendência de Pedidos...");
  await page.getByRole("button").filter({ hasText: "Pendência de Pedidos" }).click();
  await page.getByRole("button").filter({ hasText: "Executa Busca de Pedidos" }).waitFor({
    timeout: 30000
  });
  await waitForErpReady(page, {
    phaseName: "abertura de Pendencia de Pedidos",
    waitMs: 4000
  });
  log.done("Abertura: Pendência de Pedidos");
}

async function locateInputNearLabel(page, labelText) {
  const selector = await evaluateInFrame(
    page,
    ({ label, token }) => {
      const normalize = (value) =>
        String(value || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .replace(/\s+/g, " ")
          .trim()
          .toUpperCase();

      const expected = normalize(label);
      const nodes = [...document.querySelectorAll("td, label, span, div")];

      for (const node of nodes) {
        if (normalize(node.textContent) !== expected) {
          continue;
        }

        const row = node.closest("tr");
        if (!row) {
          continue;
        }

        const cells = [...row.children];
        const currentCell = cells.find((cell) => cell === node || cell.contains(node));
        const currentIndex = cells.indexOf(currentCell);

        for (let index = currentIndex + 1; index < cells.length; index += 1) {
          const input = cells[index].querySelector("input:not([type='hidden'])");
          if (!input) {
            continue;
          }

          input.setAttribute("data-codex-target", token);
          return `[data-codex-target="${token}"]`;
        }
      }

      throw new Error(`Campo associado ao rotulo ${label} nao encontrado.`);
    },
    {
      label: labelText,
      token: `codex-${Date.now()}-${Math.random().toString(16).slice(2)}`
    }
  );

  const frame = await waitForErpFrame(page);
  const input = frame.locator(selector);
  await input.waitFor({ timeout: 30000 });
  return input;
}

async function setInputNearLabel(page, labelText, value, options = {}) {
  log.info(`Preenchendo campo "${labelText}" com "${value}"...`);
  const { pressTab = false, clear = true, finalKey } = options;
  const input = await locateInputNearLabel(page, labelText);
  await input.click();

  if (clear) {
    await input.press("Control+A").catch(() => {});
  }

  await input.type(value);

  if (finalKey) {
    await input.press(finalKey);
  } else if (pressTab) {
    await input.press("Tab");
  } else {
    await input.press("Enter");
  }

  await waitForErpReady(page, {
    phaseName: `atualizacao do campo ${labelText}`,
    waitMs: 2000
  });
}

async function fillPendenciaFilters(page) {
  log.step("Preenchimento de filtros de Pendência");
  await setInputNearLabel(page, "Classe do Recurso", "Produtos");
  await setInputNearLabel(page, "Emissão inicial", EMISSION_INITIAL);
  await setInputNearLabel(page, "Emissão final", "h", { clear: true, pressTab: true });
  log.done("Preenchimento de filtros de Pendência");
}

async function executePendingOrdersSearch(page) {
  log.step("Execução: Busca de Pedidos");
  log.info("Clicando em Executa Busca de Pedidos...");
  await page.getByRole("button").filter({ hasText: "Executa Busca de Pedidos" }).click();
  await waitForErpReady(page, {
    phaseName: "execucao da busca de pedidos",
    waitMs: 4000
  });
  log.done("Execução: Busca de Pedidos");
}

async function fillMissingEmissionDocAndHour(page) {
  log.step("Preenchimento de datas/horas ausentes na Especificação");
  log.info("Aguardando grid #grEspecificacao...");
  await waitForFrameCondition(
    page,
    () => Boolean(document.querySelector("#grEspecificacao")),
    null,
    { timeoutMs: 60000 }
  );

  const pendingRows = await evaluateInFrame(page, (defaultDate) => {
    const grid = document.querySelector("#grEspecificacao");
    if (!grid) {
      throw new Error("Grid grEspecificacao nao encontrado apos a busca.");
    }

    const rows = [...grid.querySelectorAll("tbody tr")].filter((row) => row.querySelector("td"));
    const result = [];

    rows.forEach((row, index) => {
      const cells = [...row.querySelectorAll("td")];
      const emissionCell = cells[4];
      const hourCell = cells[5];

      const emissionText = (emissionCell?.innerText || "").trim();
      const hourText = (hourCell?.innerText || "").trim();

      if (!emissionText) {
        result.push({
          rowIndex: index,
          defaultDate,
          currentHour: hourText
        });
      }
    });

    return result;
  }, EMISSION_DOC_DEFAULT);

  log.info(`Linhas sem data de emissão encontradas: ${pendingRows.length}`);
  const frame = await waitForErpFrame(page);

  for (const row of pendingRows) {
    log.info(`Preenchendo linha ${row.rowIndex + 1}: data=${row.defaultDate}, hora=h`);
    const emissionCell = frame.locator("#grEspecificacao tbody tr").nth(row.rowIndex).locator("td").nth(4);
    const hourCell = frame.locator("#grEspecificacao tbody tr").nth(row.rowIndex).locator("td").nth(5);

    await emissionCell.click();
    await page.keyboard.type(row.defaultDate);
    await page.keyboard.press("Enter");
    await waitForErpReady(page, {
      phaseName: "preenchimento da previsao de emissao",
      waitMs: 1500
    });

    await hourCell.click();
    await page.keyboard.type("h");
    await page.keyboard.press("Enter");
    await waitForErpReady(page, {
      phaseName: "preenchimento da hora",
      waitMs: 1500
    });

    const confirmButton = page.getByRole("button", { name: "Confirmar", exact: true });
    if (await confirmButton.isVisible().catch(() => false)) {
      log.info("Clicando em Confirmar...");
      await confirmButton.click();
      await waitForErpReady(page, {
        phaseName: "confirmacao de edicao da grade",
        waitMs: 1500
      });
    }
  }
  log.done("Preenchimento de datas/horas ausentes na Especificação");
}

async function waitForExplosionLifecycle(page) {
  await waitForErpPhaseToFinish(page, {
    phaseName: "explosao",
    waitMs: 3000
  });

  await waitForErpPhaseToFinish(page, {
    phaseName: "gravacao da explosao",
    waitMs: 3000
  });

  await waitForScreenChange(page, 4000);
}

async function explodeSimulation(page) {
  log.step("Explosão da simulação");
  log.info("Clicando em Explodir...");
  await page.getByRole("button").filter({ hasText: "Explodir" }).click();
  await waitForExplosionLifecycle(page);

  const confirmButton = page.getByRole("button", { name: /^(ok|confirmar|sim)$/i });
  if (await confirmButton.isVisible({ timeout: 5000 }).catch(() => false)) {
    log.info("Confirmando explosão...");
    await confirmButton.click();
    await waitForErpReady(page, { phaseName: "confirmação da explosão", waitMs: 3000 });
  }

  log.done("Explosão da simulação");
}

async function fillRelatorioLogisticaFilters(page, filters) {
  log.step("Preenchimento de filtros: Relatório de Logística de Compras da Simulação");
  const entries = Object.entries(filters).filter(([, value]) => value !== undefined && value !== null);

  for (let index = 0; index < entries.length; index += 1) {
    const [label, value] = entries[index];
    const isLast = index === entries.length - 1;
    await setInputNearLabel(page, label, value, {
      clear: true,
      finalKey: isLast ? "Control+Shift+E" : undefined
    });
  }
  log.done("Preenchimento de filtros: Relatório de Logística de Compras da Simulação");
}

// Assistente de exportação do Innovaro: ainda não validado contra a tela nova do ERP.
// Os textos em wizardSteps e o link de download são procurados de forma tolerante;
// confira os logs caso esta etapa falhe na primeira execução real.
async function exportActiveReportToCsv(page, { fileName, wizardSteps = [] } = {}) {
  log.step(`Exportação de relatório: ${fileName}`);

  log.info("Abrindo assistente de exportação (Ctrl+Shift+X)...");
  await page.keyboard.press("Control+Shift+X");
  await waitForUi(page, 1500);

  for (const stepLabel of wizardSteps) {
    const option = page.getByText(stepLabel, { exact: false }).first();
    if (await option.isVisible({ timeout: 5000 }).catch(() => false)) {
      log.info(`Selecionando opção do assistente: "${stepLabel}"...`);
      await option.click();
      await waitForUi(page, 1500);
    } else {
      log.warn(`Opção "${stepLabel}" não encontrada no assistente de exportação.`);
    }
  }

  log.info("Executando exportação final (Ctrl+Shift+E) e aguardando download...");
  const downloadPromise = page.waitForEvent("download", { timeout: 60000 });
  await page.keyboard.press("Control+Shift+E");

  const downloadLink = page.getByText(/download/i).first();
  if (await downloadLink.isVisible({ timeout: 10000 }).catch(() => false)) {
    await downloadLink.click();
  }

  const download = await downloadPromise;
  const targetPath = await saveDownload(download, fileName);

  log.done(`Exportação de relatório: ${fileName}`);
  return targetPath;
}

async function captureArtifacts(page, stepName) {
  const fs = require("fs/promises");
  const path = require("path");
  const safeStepName = stepName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const outputDir = path.join(process.cwd(), "output", "playwright");
  const filePath = path.join(outputDir, `${Date.now()}-${safeStepName}.png`);

  await fs.mkdir(outputDir, { recursive: true });
  await page.screenshot({ path: filePath, fullPage: true });
  log.info(`Screenshot salvo: ${path.basename(filePath)}`);
}

async function runInnovaroAutomation() {
  log.info("=== Iniciando automação Innovaro ===");
  log.info(`Log salvo em: ${log.getLogFilePath()}`);

  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    slowMo: SLOW_MO_MS
  });

  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    acceptDownloads: true
  });

  const page = await context.newPage();

  try {
    await login(page);
    await captureArtifacts(page, "apos-login");

    await navigateToProducaoPlanoMestre(page);
    await selectSimulation(page, SIMULATION_NAME);
    await captureArtifacts(page, "simulacao-selecionada");

    await excludeConfiguredEspecificacoes(page, EXCLUDED_SPEC_COUNT);
    await captureArtifacts(page, "especificacao-filtrada");

    await openPendenciaDePedidos(page);
    await fillPendenciaFilters(page);
    await executePendingOrdersSearch(page);
    await captureArtifacts(page, "pendencia-executada");

    await fillMissingEmissionDocAndHour(page);
    await captureArtifacts(page, "datas-preenchidas");

    await explodeSimulation(page);
    await captureArtifacts(page, "explosao-concluida");

    await navigateToRelatorioLogistica(page);
    await fillRelatorioLogisticaFilters(page, {
      "Simulação": SIMULATION_NAME,
      "Nível": RELATORIO_NIVEL,
      Almoxarifado: RELATORIO_ALMOXARIFADO,
      Classe: RELATORIO_CLASSE
    });
    await waitForErpReady(page, { phaseName: "geração do relatório de logística", waitMs: 4000 });
    await captureArtifacts(page, "relatorio-logistica-gerado");

    const recursosCsvPath = await exportActiveReportToCsv(page, {
      fileName: `recursos-utilizados-${Date.now()}.csv`,
      wizardSteps: ["CSV", "Sim"]
    });
    await updatePlanilhaRecursosUtilizados(recursosCsvPath);

    await navigateMenuPath(page, ["Estoque", "Consultas", "Saldos de Recursos - CEMAG"]);
    await setInputNearLabel(page, "Data base", "h", { clear: true, finalKey: "Control+Shift+X" });
    await waitForErpReady(page, { phaseName: "consulta de saldos de recursos", waitMs: 4000 });
    await captureArtifacts(page, "saldos-recursos-gerado");

    const saldosCsvPath = await exportActiveReportToCsv(page, {
      fileName: `saldos-recursos-${Date.now()}.csv`,
      wizardSteps: ["Sim"]
    });
    await updateSaldoRecursos(saldosCsvPath);

    await navigateMenuPath(page, ["Compra", "Consultas", "Análise de Pedidos Pendentes ou Baixados - CEMAG"]);
    await setInputNearLabel(page, "Emissão final", "h", { clear: true, finalKey: "Control+Shift+X" });
    await waitForErpReady(page, { phaseName: "consulta de análise de pedidos", waitMs: 4000 });
    await captureArtifacts(page, "analise-pedidos-gerado");

    const pedidosCsvPath = await exportActiveReportToCsv(page, {
      fileName: `analise-pedidos-${Date.now()}.csv`,
      wizardSteps: ["Sim"]
    });
    await updateAnalisePedidosPendentes(pedidosCsvPath);

    await navigateToProducaoPlanoMestre(page);
    await selectSimulation(page, SIMULATION_MAT_IND_NAME);
    await captureArtifacts(page, "segunda-simulacao-selecionada");

    await explodeSimulation(page);
    await captureArtifacts(page, "segunda-simulacao-explodida");

    await navigateToRelatorioLogistica(page);
    await fillRelatorioLogisticaFilters(page, { "Simulação": SIMULATION_MAT_IND_NAME });
    await waitForErpReady(page, {
      phaseName: "geração do relatório (materiais indiretos)",
      waitMs: 4000
    });
    await captureArtifacts(page, "relatorio-materiais-indiretos-gerado");

    const materiaisIndiretosCsvPath = await exportActiveReportToCsv(page, {
      fileName: `materiais-indiretos-${Date.now()}.csv`,
      wizardSteps: ["CSV", "Sim"]
    });
    await updateAnalisePedidosMateriaisCustoIndireto(materiaisIndiretosCsvPath);

    log.info("=== Automação concluída com sucesso ===");
  } catch (err) {
    log.error(`Erro durante a automação: ${err.message}`);
    await captureArtifacts(page, "erro-fatal").catch(() => {});
    throw err;
  } finally {
    await context.close();
    await browser.close();
    log.info("Navegador fechado.");
  }
}

module.exports = {
  runInnovaroAutomation,
  waitForErpReady,
  waitForErpPhaseToFinish,
  waitForExplosionLifecycle
};
