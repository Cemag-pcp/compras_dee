require("dotenv").config();
const { chromium } = require("playwright");
const log = require("./logger");
const {
  login,
  navigateToProducaoPlanoMestre,
  searchSimulationViaApi,
  exibirChavesEspecificacao,
  ordenarPorChaveEspecificacao,
  selectFirstSpecificationRows,
  excluirLinhasMarcadasEspecificacao,
  openPendenciaDePedidos,
  fillPendenciaFilters,
  fillFirstEmptySpecificationRowsLoop,
  explodirSimulacao,
  navigateToRelatorioLogisticaCompras,
  fillRelatorioLogisticaFilters,
  updateRecursosUtilizadosNoSheets,
  navigateToSaldosDeRecursos,
  executarSaldosDeRecursos,
  updateSaldoRecursosNoSheets,
  navigateToAnalisePedidosPendentes,
  executarAnalisePedidosPendentes,
  updateAnalisePedidosPendentesNoSheets,
  updateRecursosUtilizadosMatIndiretoNoSheets,
  captureArtifacts
} = require("./innovaro-automation-v2");

const SLOW_MO_MS = Number(process.env.INNOVARO_SLOW_MO_MS || 250);
const SIMULATION_NAME =
  process.env.INNOVARO_SIMULATION_NAME || "Pendencia Diaria Carretas Compras";
const SIMULATION_MAT_IND_NAME =
  process.env.INNOVARO_SIMULATION_MAT_IND_NAME || "Simulação Mat ind (Mov 3M)";
const SPEC_ROWS_TO_CHECK = Number(process.env.INNOVARO_EXCLUDED_SPEC_COUNT || 9);

// Cada estágio abaixo é um ponto de entrada INDEPENDENTE: roda a partir de
// um login fresco, sem depender de nenhum outro estágio já ter rodado
// nesta mesma sessão do navegador. Isso só é seguro para os 4 blocos
// abaixo porque, a partir da grade "Especificação" (1a simulação) em
// diante, cada navegação (Saldos de Recursos, Análise de Pedidos, 2a
// simulação) é uma navegação de MENU independente — não depende de estado
// client-side deixado por um estágio anterior, só do que já está
// persistido no próprio ERP (ex.: uma simulação já explodida continua
// explodida entre sessões). Criado para depurar/re-rodar só o estágio com
// problema sem esperar o fluxo inteiro (runInnovaroAutomationV2, vários
// minutos) rodar de novo até chegar lá — útil sobretudo quando o ERP está
// instável e o erro só aparece na última etapa.
//
// NÃO dá pra subdividir mais que isso com segurança: dentro de
// "primeira-simulacao", por exemplo, os passos da grade Especificação
// (marcar/excluir linhas, preencher datas) são sequenciais de verdade —
// pular um deles no meio deixaria a grade num estado que os passos
// seguintes não esperam.
const STAGES = {
  "primeira-simulacao": {
    description:
      'Simulação principal completa: busca -> especificação -> pendência -> explosão -> relatório -> "Recursos Utilizados" (planilha DEE).',
    run: async (page) => {
      await navigateToProducaoPlanoMestre(page);
      await captureArtifacts(page, "tela-plano-mestre");

      await searchSimulationViaApi(page, SIMULATION_NAME);
      await captureArtifacts(page, "simulacao-selecionada");

      await exibirChavesEspecificacao(page);
      await captureArtifacts(page, "chaves-exibidas");

      await ordenarPorChaveEspecificacao(page);
      await captureArtifacts(page, "especificacao-ordenada-por-chave");

      await selectFirstSpecificationRows(page, SPEC_ROWS_TO_CHECK);
      await captureArtifacts(page, "todas-marcadas-exceto-primeiras");

      await excluirLinhasMarcadasEspecificacao(page);
      await captureArtifacts(page, "linhas-excluidas");

      await openPendenciaDePedidos(page);
      await captureArtifacts(page, "pendencia-de-pedidos-aberta");

      await fillPendenciaFilters(page);
      await captureArtifacts(page, "filtros-pendencia-preenchidos");

      await fillFirstEmptySpecificationRowsLoop(page);
      await captureArtifacts(page, "datas-horas-preenchidas");

      await explodirSimulacao(page);
      await captureArtifacts(page, "simulacao-explodida");

      await navigateToRelatorioLogisticaCompras(page);
      await captureArtifacts(page, "relatorio-logistica-aberto");

      await fillRelatorioLogisticaFilters(page);
      await captureArtifacts(page, "relatorio-logistica-filtros-preenchidos");

      await updateRecursosUtilizadosNoSheets(page);
      await captureArtifacts(page, "recursos-utilizados-atualizado-no-sheets");
    }
  },

  "saldos-recursos": {
    description: 'Saldos de Recursos - CEMAG: navega -> executa -> grava em "Est. Produção"!N3:U.',
    run: async (page) => {
      await navigateToSaldosDeRecursos(page);
      await captureArtifacts(page, "saldos-recursos-aberta");

      await executarSaldosDeRecursos(page);
      await captureArtifacts(page, "saldos-recursos-executada");

      await updateSaldoRecursosNoSheets(page);
      await captureArtifacts(page, "saldos-recursos-atualizado-no-sheets");
    }
  },

  "analise-pedidos": {
    description:
      'Análise de Pedidos Pendentes ou Baixados - CEMAG: navega -> executa -> grava em "Dados Pedidos"!B2:Y.',
    run: async (page) => {
      await navigateToAnalisePedidosPendentes(page);
      await captureArtifacts(page, "analise-pedidos-pendentes-aberta");

      await executarAnalisePedidosPendentes(page);
      await captureArtifacts(page, "analise-pedidos-pendentes-executada");

      await updateAnalisePedidosPendentesNoSheets(page);
      await captureArtifacts(page, "analise-pedidos-pendentes-atualizado-no-sheets");
    }
  },

  "segunda-simulacao": {
    description:
      'Simulação de materiais indiretos completa: busca -> explosão -> relatório -> "Recursos Utilizados" (planilha Requisitados).',
    run: async (page) => {
      await navigateToProducaoPlanoMestre(page);
      await captureArtifacts(page, "tela-plano-mestre-segunda-simulacao");

      await searchSimulationViaApi(page, SIMULATION_MAT_IND_NAME);
      await captureArtifacts(page, "segunda-simulacao-selecionada");

      await explodirSimulacao(page);
      await captureArtifacts(page, "segunda-simulacao-explodida");

      await navigateToRelatorioLogisticaCompras(page);
      await captureArtifacts(page, "segundo-relatorio-logistica-aberto");

      await fillRelatorioLogisticaFilters(page, { simulationName: SIMULATION_MAT_IND_NAME });
      await captureArtifacts(page, "segundo-relatorio-logistica-filtros-preenchidos");

      await updateRecursosUtilizadosMatIndiretoNoSheets(page);
      await captureArtifacts(page, "recursos-utilizados-mat-indireto-atualizado-no-sheets");
    }
  }
};

function printUsage() {
  console.log("Uso: node src/run-stage.js <estagio>\n");
  console.log("Estágios disponíveis:");
  for (const [name, stage] of Object.entries(STAGES)) {
    console.log(`  ${name}\n    ${stage.description}\n`);
  }
}

async function main() {
  const stageName = process.argv[2];

  if (!stageName || stageName === "--list" || !STAGES[stageName]) {
    if (stageName && stageName !== "--list") {
      console.error(`Estágio desconhecido: "${stageName}"\n`);
    }
    printUsage();
    process.exitCode = stageName && stageName !== "--list" ? 1 : 0;
    return;
  }

  const stage = STAGES[stageName];
  log.info(`=== Rodando estágio isolado: ${stageName} ===`);
  log.info(`Log salvo em: ${log.getLogFilePath()}`);

  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    slowMo: SLOW_MO_MS
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();

  try {
    await login(page);
    await captureArtifacts(page, "apos-login");

    await stage.run(page);

    log.info(`=== Estágio "${stageName}" concluído com sucesso ===`);
  } catch (err) {
    log.error(`Erro no estágio "${stageName}": ${err.message}`);
    await captureArtifacts(page, `erro-fatal-${stageName}`).catch(() => {});
    throw err;
  } finally {
    log.info("Fechando o navegador...");
    await browser.close().catch((closeErr) => {
      log.warn(`Falha ao fechar o navegador: ${closeErr.message}`);
    });
  }
}

main().catch((error) => {
  log.error(String(error));
  process.exitCode = 1;
});
