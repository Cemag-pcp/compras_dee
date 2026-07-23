const fs = require("fs/promises");
const path = require("path");
const { chromium } = require("playwright");
const log = require("./logger");
const {
  updatePlanilhaRecursosUtilizadosFromRows,
  buildRecursosUtilizadosMatrix,
  RECURSOS_COLUMNS_DEE,
  RECURSOS_NUMERIC_COLUMNS_DEE,
  RECURSOS_COLUMNS_REQUISITADOS,
  RECURSOS_NUMERIC_COLUMNS_REQUISITADOS,
  updateAnalisePedidosPendentesFromRows,
  buildAnalisePedidosPendentesMatrix,
  PEDIDOS_FINAL_COLUMNS,
  updateSaldoRecursosFromRows,
  buildSaldoRecursosMatrix,
  SALDOS_COLUMNS,
  updateAnalisePedidosMateriaisCustoIndiretoFromRows
} = require("./reports");
const { writeCsv } = require("./csv-utils");

// Versao 2: reconstroi o fluxo usando a API interna do Innovaro
// (window.Environment.getInstance().currentProcess.getGrid(nome)) em vez de
// document.querySelector/frame.evaluate em busca de elementos de DOM.
//
// Motivo: mapeamento ao vivo (sessao MCP) confirmou que as grades de simulacao
// e especificacao nao expoem DOM nem accessibility tree consultaveis (provavel
// Shadow DOM fechado + renderizacao em canvas). A unica via validada de
// interacao programatica e o EventEmitter interno de cada grid:
//   grid.emit(nomeDoEvento, payload)
//
// Eventos confirmados ao vivo nesta sessao, todos no formato
// { gridName, ...payload, preventDefault: false }:
//   - "search"       -> busca/seleciona um registro (testado em grSimulacoes)
//   - "recordSelect" -> alterna (toggle) a selecao (checkbox) de um registro,
//                       payload precisa de { bookmark, rangeSelection: false }
//   - "allSelect"    -> marca todos os registros
//   - "allUnselect"  -> desmarca todos os registros (visto na lista de eventos,
//                       nao disparado manualmente nesta sessao)
//
// "firstRecord"/"nextRecord" em loop FORAM tentados para coletar bookmarks
// linha a linha, mas na pratica isso fez a grade "virar pagina" sem parar
// (provavel paginacao/recarregamento de dados a cada nextRecord disparado
// via emit, mais rapido do que o framework consegue assimilar). Por isso a
// selecao das primeiras N linhas usa allSelect + leitura de
// grid.selectedRecords em vez de navegacao manual.
//
// NAO confirmado nesta sessao (fomos interrompidos antes de validar):
//   - o nome exato do campo interno para "Prev. Emissao Doc." e "Hora"
//   - se grid.focusField(nome) de fato funciona para focar uma celula sem
//     precisar de coordenadas de pixel
// Por seguranca, fillMissingDateAndHour tenta uma lista de nomes candidatos e
// PULA a linha (com aviso) se nenhum candidato responder, em vez de clicar
// "no escuro" -- ao vivo, clicar numa celula de data ja preenchida entrou em
// modo de edicao e limpou o valor visualmente até cancelarmos, então um clique
// as ciegas em produção é arriscado.
//
// IMPORTANTE (descoberto ao vivo depois): grid.field(nome) na verdade espera
// (nome, tipo, ...) e LANÇA EXCEÇÃO ("Tipo informado para o campo é inválido")
// quando chamado só com o nome, como readFieldValue faz acima. Ou seja, essa
// funcao (e fillMissingDateAndHour, que depende dela) ainda NAO está validada
// e provavelmente sempre cai no fallback de "nenhum candidato respondeu".
//
// Tambem confirmado ao vivo: a tela "Pendência de Pedidos" (botão da
// toolbar) abre um formulario cuja grid interna se chama "grFiltroDePedidos"
// -- mesmo nome usado no XPath do main.py antigo (`id="grFiltroDePedidos"`),
// confirmando que os nomes internos dos componentes sao estaveis entre a UI
// antiga e a nova. Esse formulario tambem nao expõe DOM/accessibility tree
// (mesma limitação dos grids), então o preenchimento dos seus 19 campos é
// feito via navegação real por Tab (ordem confirmada ao vivo: linha por
// linha, esquerda -> direita), não via grid.field()/Environment API.

const DEFAULT_WAIT_MS = Number(process.env.INNOVARO_DEFAULT_WAIT_MS || 2500);
const SLOW_MO_MS = Number(process.env.INNOVARO_SLOW_MO_MS || 250);
const SIMULATION_NAME =
  process.env.INNOVARO_SIMULATION_NAME || "Pendencia Diaria Carretas Compras";
const RELATORIO_SIMULATION_NAME =
  process.env.INNOVARO_RELATORIO_SIMULATION_NAME || SIMULATION_NAME;
// 2a simulação (materiais indiretos) — mesmo fluxo da 1a, mas com outra
// simulação e sem passar pela grade Especificação (ver
// runSegundaSimulacaoMatIndireto).
const SIMULATION_MAT_IND_NAME =
  process.env.INNOVARO_SIMULATION_MAT_IND_NAME || "Simulação Mat ind (Mov 3M)";
const RELATORIO_CLASSE_EXPLOSAO =
  process.env.INNOVARO_RELATORIO_CLASSE_EXPLOSAO || "Último Nível";
const RELATORIO_CLASSE_DEPOSITO =
  process.env.INNOVARO_RELATORIO_CLASSE_DEPOSITO || "Almox de Compras";
const RELATORIO_CLASSE_RECURSO =
  process.env.INNOVARO_RELATORIO_CLASSE_RECURSO || "Materiais e Produtos";
const SPEC_ROWS_TO_CHECK = Number(process.env.INNOVARO_EXCLUDED_SPEC_COUNT || 7);
const HOUR_TOKEN = "h";

const DATE_FIELD_CANDIDATES = [
  "PREV_EMISSAO_DOC",
  "PREVEMISSAODOC",
  "DT_PREV_EMISSAO",
  "DTPREVEMISSAO",
  "PREVISAO_EMISSAO_DOC"
];
const HOUR_FIELD_CANDIDATES = ["HORA", "HR_PREV_EMISSAO", "HRPREVEMISSAO"];

// Offsets de pixel RELATIVOS ao canto superior-esquerdo do container real
// da grade Especificação (elemento [data-grid-name="grEspecificacao"], que
// existe no DOM mesmo com o conteúdo interno em canvas/Shadow DOM fechado).
// Calculados via getBoundingClientRect ao vivo (ver getSpecGridContainerBox)
// em vez de coordenadas absolutas de página, para sobreviver a mudanças de
// scroll/altura do painel "Simulações" acima (já confirmado que isso muda a
// posição absoluta entre execuções). Ainda assim sao calibrados numa
// sessao MCP especifica — confira visualmente no viewport real do script
// (1600x900) e ajuste via env se necessario.
const SPEC_GRID_OFFSET_OPTIONS_MENU = {
  x: Number(process.env.INNOVARO_SPEC_OPTIONS_MENU_OFFSET_X || 116),
  y: Number(process.env.INNOVARO_SPEC_OPTIONS_MENU_OFFSET_Y || 41)
};
// (O item "Exibir chaves" no menu é selecionado via teclado/Enter, não por
// coordenada — ver exibirChavesEspecificacao. O menu pode abrir pra cima ou
// pra baixo do ícone dependendo do espaço na tela, então um delta fixo não
// é confiável.)
// Célula "Prev. Emissão Doc." da 1a linha de dados (sem a coluna "Chave"
// visível — se "Exibir chaves" já tiver sido acionado antes, este offset X
// precisa aumentar pela largura da coluna Chave).
const SPEC_GRID_OFFSET_FIRST_ROW_PREV_EMISSAO = {
  x: Number(process.env.INNOVARO_SPEC_FIRST_ROW_OFFSET_X || 537),
  y: Number(process.env.INNOVARO_SPEC_FIRST_ROW_OFFSET_Y || 113)
};
// Cabeçalho da coluna "Chave" (só existe depois de exibirChavesEspecificacao
// ter rodado). Um clique único ordena a grade por essa coluna.
const SPEC_GRID_OFFSET_CHAVE_HEADER = {
  x: Number(process.env.INNOVARO_SPEC_CHAVE_HEADER_OFFSET_X || 85),
  y: Number(process.env.INNOVARO_SPEC_CHAVE_HEADER_OFFSET_Y || 91)
};
// Ícone "⌃" (seta para cima) da barra de ferramentas da grade Especificação
// — botão "ir para o primeiro registro". Confirmado ao vivo via MCP: clicar
// nele muda o indicador de posição (ex.: "7 de 123" -> "1 de 123") e foca a
// 1a linha. Usado no loop de preenchimento para sempre voltar ao topo antes
// de checar/editar, em vez de assumir se a grade reordena ou não após uma
// edição (comportamento que já vimos divergir entre contextos diferentes
// desta mesma grid).
const SPEC_GRID_OFFSET_FIRST_RECORD_BUTTON = {
  x: Number(process.env.INNOVARO_SPEC_FIRST_RECORD_BUTTON_OFFSET_X || 42),
  y: Number(process.env.INNOVARO_SPEC_FIRST_RECORD_BUTTON_OFFSET_Y || 41)
};
// Checkbox da 1a linha de dados (coluna "Chave" exibida) e altura de cada
// linha subsequente — usados para marcar/desmarcar via clique físico real,
// já que grid.emit('recordSelect', ...) NÃO funciona depois de ordenar a
// grade por uma coluna (confirmado ao vivo: o emit não tem efeito algum
// nesse estado, só o clique físico no checkbox realmente alterna a seleção).
const SPEC_GRID_OFFSET_FIRST_ROW_CHECKBOX = {
  x: Number(process.env.INNOVARO_SPEC_CHECKBOX_OFFSET_X || 17),
  y: Number(process.env.INNOVARO_SPEC_CHECKBOX_OFFSET_Y || 113)
};
const SPEC_GRID_ROW_HEIGHT = Number(process.env.INNOVARO_SPEC_ROW_HEIGHT || 23);
// Botão "−" no cabeçalho da grade Especificação, que exclui os registros
// MARCADOS (após confirmar "Sim" num diálogo). Offset relativo ao container.
const SPEC_GRID_OFFSET_DELETE_BUTTON = {
  x: Number(process.env.INNOVARO_SPEC_DELETE_BUTTON_OFFSET_X || 57),
  y: Number(process.env.INNOVARO_SPEC_DELETE_BUTTON_OFFSET_Y || 16)
};

// Limite de seguranca de iteracoes do loop de preenchimento de datas/horas.
// Default: null -> o loop usa o recordCount da propria grid (ver
// fillFirstEmptySpecificationRowsLoop), que combinado com a deteccao por
// bookmark (para quando a linha do topo nao muda de posicao) e o criterio
// real de parada. Defina INNOVARO_SPEC_FILL_MAX_ITERATIONS apenas para um
// teste limitado/conservador (ex.: validar poucas linhas antes de rodar
// tudo).
const SPEC_FILL_MAX_ITERATIONS = process.env.INNOVARO_SPEC_FILL_MAX_ITERATIONS
  ? Number(process.env.INNOVARO_SPEC_FILL_MAX_ITERATIONS)
  : null;

const PENDENCIA_CLASSE_RECURSO = process.env.INNOVARO_CLASSE_RECURSO || "Produtos";
const PENDENCIA_CLASSE_PEDIDO_HIERARQUIA =
  process.env.INNOVARO_CLASSE_PEDIDO_HIERARQUIA || "Vendas";
const PENDENCIA_EMISSAO_INICIAL = process.env.INNOVARO_PENDENCIA_EMISSAO_INICIAL || "01/01/2025";

// Ordem confirmada ao vivo (Tab segue a tela linha por linha, esquerda ->
// direita) dos 19 campos do formulario "Restrições de busca pendência"
// (grid interna grFiltroDePedidos). Campos sem `value` sao apagados e
// deixados vazios; campos com `value` sao SEMPRE apagados e redigitados
// (nunca apenas pulados/preservados — ja confirmamos ao vivo que esse
// campo pode vir vazio em vez de pre-preenchido, então assumir que "já está
// certo" é arriscado).
//
// BUG JA CONFIRMADO E CORRIGIDO: a tentativa anterior de confirmar esses
// campos com Tab+Enter causava o Enter avançar UM CAMPO EXTRA alem do Tab,
// desalinhando o restante do formulario. No teste manual ao vivo, digitar o
// valor e dar apenas Tab (sem Enter) já confirma a selecao corretamente —
// por isso nenhum desses campos usa Enter.
const PENDENCIA_FILTER_FIELDS = [
  { label: "Chave de criação do pedido" },
  { label: "Chave do pedido" },
  { label: "Pessoa" },
  { label: "Recurso" },
  { label: "Classe do Recurso", value: PENDENCIA_CLASSE_RECURSO },
  { label: "Classe do pedido com hierarquia", value: PENDENCIA_CLASSE_PEDIDO_HIERARQUIA },
  { label: "Classe do pedido sem hierarquia" },
  { label: "Previsão emissão doc. inicial" },
  { label: "Previsão emissão doc. final" },
  { label: "Aprovação inicial" },
  { label: "Aprovação final" },
  { label: "Emissão inicial", value: PENDENCIA_EMISSAO_INICIAL },
  { label: "Emissão final" },
  { label: "Programação inicial" },
  { label: "Programação final" },
  { label: "Local de entrega" },
  { label: "Local de escrituração" },
  { label: "Representante" },
  { label: "Aprovador" }
];

// Mapeamento confirmado em 2026-06-23 via Playwright MCP + inspeção da API
// interna do Innovaro:
// - o relatório abre a partir da grade do menu "Plano mestre e simulação (MPS)"
// - o formulário não expõe inputs DOM; ele usa a grid interna `vars`
// - a cadeia real de campos da grid `vars` é:
//   chaveDaSimulacao -> explosao -> deposito -> recursos
// Por isso o preenchimento precisa primeiro focar o field interno correto e
// só então digitar/confirmar com Tab.
const RELATORIO_LOGISTICA_FIELDS = [
  { label: "Simulação", fieldName: "chaveDaSimulacao", value: RELATORIO_SIMULATION_NAME },
  { label: "Classe de Explosão", fieldName: "explosao", value: RELATORIO_CLASSE_EXPLOSAO },
  { label: "Classes de Depósitos", fieldName: "deposito", value: RELATORIO_CLASSE_DEPOSITO },
  { label: "Classes de Recursos", fieldName: "recursos", value: RELATORIO_CLASSE_RECURSO }
];

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

// BUG CONFIRMADO ao vivo: os grupos do menu lateral funcionam como
// acordeão — clicar de novo num grupo JÁ expandido FECHA a árvore em vez
// de reabrir. Como navigateToProducaoPlanoMestre/navigateToRelatorioLogisticaCompras
// são chamadas mais de uma vez no fluxo (1a e 2a simulação), na 2a passada
// o menu já podia estar expandido da 1a vez, e um clique simples em
// "Produção" fechava a árvore em vez de mantê-la aberta.
//
// Tentativa anterior de corrigir com um pré-check ("já está expandido?")
// escopado a um container `aside.wf-nav-menu` quebrou a 1a passada também
// (esse container não tem o conteúdo do menu populado — deu timeout logo
// no início). Por isso a abordagem agora é reativa, não preditiva: clica,
// confirma se o próximo nível ficou visível e, se não (clique fechou em
// vez de abrir), clica de nova vez. Funciona em qualquer estado inicial
// (fechado, parcialmente ou totalmente expandido) sem precisar acertar um
// seletor de container não confirmado.
async function clickMenuGroupUntilRevealed(page, groupLocator, revealedLocator, options = {}) {
  const { maxAttempts = 2, waitMs = 1000 } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await groupLocator.click();
    await waitForUi(page, waitMs);

    if (await revealedLocator.isVisible().catch(() => false)) {
      return;
    }
  }

  throw new Error(
    `Item do menu não ficou visível depois de ${maxAttempts} clique(s) (possível efeito acordeão).`
  );
}

// CSS-class-based selectors (aside.wf-nav-menu, role="menu",
// span.wf-nav-menu-module__title-text) foram tentados e descartados: cada
// um deu timeout total numa execução real (ou seja, nenhum desses
// confirma de forma ESTÁVEL o item do menu — o que apareceu numa mensagem
// de erro pontual do Playwright não significa que é assim em toda
// execução). O simples page.getByText(texto, {exact:true}) é o que
// funcionou de forma confiável em todas as outras dezenas de passos deste
// script. O único problema real e confirmado foi UMA violação de strict
// mode (2 matches: o item de menu de verdade + um eco do mesmo texto num
// breadcrumb role="navigation"). Em vez de escopar por uma classe/role não
// confiável, a correção mínima é .last() — sem risco quando há só 1 match
// (caso comum), e sem depender de nada que já provamos ser instável.
function menuText(page, text) {
  return page.getByText(text, { exact: true }).last();
}

// Confirmado ao vivo (voltarParaPlanoMestre): ".last()" não é confiável em
// TODAS as telas — no fim do fluxo, getByText("Plano mestre e simulação")
// bate em pelo menos 2 elementos: o link real do flyout de "Produção" (o
// que queremos) e um <span class="wf-menu-card__headline"> ESCONDIDO,
// resquício da view em grade aberta antes por
// navigateToRelatorioLogisticaCompras (fica no DOM mesmo depois de
// fechada). ".last()" pegou esse span escondido e o waitFor deu timeout.
// Esta variante percorre TODOS os matches e retorna o primeiro
// efetivamente visível, em vez de assumir uma posição fixa (primeiro ou
// último) na lista de matches.
// BUG CONFIRMADO ao vivo: isVisible() sozinho não basta. Além do <span
// class="wf-menu-card__headline"> escondido (view em grade), há um
// segundo "eco" do texto: o <span class="mdc-tab__text-label"> da ABA já
// aberta (de uma navegação anterior nesta mesma sessão) — que passa em
// isVisible() (está no layout normal, sem display:none), mas fica
// coberto pelo "scrim" (fundo escurecido, class="wf-nav-menu__scrim") do
// menu flyout aberto por cima dela. O clique trava 30s tentando (Playwright
// vê "element is visible, enabled and stable" mas o scrim intercepta o
// ponto de clique). Por isso o critério aqui não é só "visível", e sim
// "é o elemento que está de fato no topo, no ponto onde o clique cairia"
// (equivalente ao hit-test que o próprio Playwright faz antes de clicar,
// mas verificado ANTES de escolher o candidato, não depois de já ter
// tentado clicar e travado).
async function menuTextVisible(page, text, options = {}) {
  const { timeoutMs = 10000, pollMs = 300 } = options;
  const candidates = page.getByText(text, { exact: true });
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const count = await candidates.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const candidate = candidates.nth(i);
      const clickable = await candidate
        .evaluate((el) => {
          if (el.offsetParent === null) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          const cx = rect.x + rect.width / 2;
          const cy = rect.y + rect.height / 2;
          const topEl = document.elementFromPoint(cx, cy);
          return !!topEl && (el === topEl || el.contains(topEl) || topEl.contains(el));
        })
        .catch(() => false);

      if (clickable) {
        return candidate;
      }
    }
    await page.waitForTimeout(pollMs);
  }

  throw new Error(`Nenhum elemento clicável encontrado para o texto "${text}" após ${timeoutMs}ms.`);
}

// Confirmado ao vivo: no estado frio (1a rodada do menu), "Produção"
// revela "Plano mestre e simulação (MPS)", que por sua vez revela "Plano
// mestre e simulação" — os 2 níveis são necessários (uma simplificação
// anterior que pulava o nível "(MPS)" falhava sempre na 1a rodada). O
// efeito acordeão (clique fecha em vez de abrir) só é um problema na 2a
// rodada em diante; clickMenuGroupUntilRevealed lida com os dois casos
// (1 clique quando fechado, 2 cliques quando já estava aberto) em cada
// nível, sem precisar diferenciar explicitamente "1a vs 2a rodada".
async function navigateToProducaoPlanoMestre(page) {
  log.step("Navegação: Produção > Plano mestre e simulação");
  await openMainMenu(page);
  await waitForUi(page, 1500);

  const producaoGroup = menuText(page, "Produção");
  const mpsGroup = menuText(page, "Plano mestre e simulação (MPS)");

  log.info('Expandindo "Produção"...');
  await clickMenuGroupUntilRevealed(page, producaoGroup, mpsGroup);

  // BUG CONFIRMADO ao vivo (sessão MCP): depois que a tela já foi visitada
  // uma vez nesta sessão (aba "Plano mestre e simulação" aberta + view em
  // grade de navigateToRelatorioLogisticaCompras usada), o texto "Plano
  // mestre e simulação" passa a bater em 3 elementos — o link real do
  // flyout (clicável), o <span class="mdc-tab__text-label"> da aba já
  // aberta (coberto pelo scrim do menu, "visível" mas não clicável) e um
  // <span class="wf-menu-card__headline"> escondido (resquício da view em
  // grade). Nem .first() nem .last() (menuText) escolhem o certo de forma
  // confiável — por isso aqui, diferente de outros clickMenuGroupUntilRevealed
  // deste arquivo, o "revelado" é verificado com menuTextVisible (hit-test:
  // só considera clicável o elemento que está de fato no topo, no ponto
  // onde o clique cairia), num loop de até 2 tentativas (mesmo limite de
  // clickMenuGroupUntilRevealed, para lidar com o efeito acordeão).
  log.info('Expandindo "Plano mestre e simulação (MPS)"...');
  let planoMestreLeaf = null;
  for (let attempt = 1; attempt <= 2 && !planoMestreLeaf; attempt += 1) {
    await mpsGroup.click();
    await waitForUi(page, 1000);
    planoMestreLeaf = await menuTextVisible(page, "Plano mestre e simulação", { timeoutMs: 3000 }).catch(
      () => null
    );
  }
  if (!planoMestreLeaf) {
    throw new Error(
      'Item do menu "Plano mestre e simulação" não ficou clicável depois de 2 clique(s) em "(MPS)" (possível efeito acordeão).'
    );
  }

  log.info('Clicando em "Plano mestre e simulação"...');
  await planoMestreLeaf.click();

  // Âncora no início (^) — sem isso, a regex também bate na aba "Menu:
  // Plano mestre e simulação (MPS) ..." (view em grade), que CONTÉM a
  // mesma substring, causando violação de strict mode (2 matches) quando
  // essa aba já estiver aberta de uma navegação anterior.
  await page.getByRole("tab", { name: /^Plano mestre e simulação/i }).waitFor({ timeout: 30000 });
  await waitForUi(page, 5000);
  log.done("Navegação: Produção > Plano mestre e simulação");
}

// Confirmado ao vivo: ao final do fluxo (depois de já ter passado por
// Estoque e Compra), o menu chega com "Produção" já expandido o
// suficiente para revelar "Plano mestre e simulação" direto — diferente
// da 1a navegação (navigateToProducaoPlanoMestre), que precisa dos 2
// níveis de acordeão (Produção -> "Plano mestre e simulação (MPS)" ->
// leaf). Aqui só 2 cliques: "Produção" -> "Plano mestre e simulação",
// sem tocar no grupo "(MPS)".
// BUG CONFIRMADO ao vivo (duas execuções reais divergentes): o estado do
// menu ao final do fluxo NÃO é sempre o mesmo. Numa execução (fluxo
// completo, já tendo passado por Estoque e Compra), abrir o menu revelou
// "Plano mestre e simulação" direto, clicável, sem precisar clicar em
// "Produção" — clicar em "Produção" ali só fechava o flyout à toa. Noutra
// execução (só Produção visitada), o menu abriu "frio" (nenhum candidato
// clicável para o texto da folha), exigindo os 2 níveis de acordeão de
// novo, iguais a navigateToProducaoPlanoMestre. Por isso esta função é
// ADAPTATIVA em vez de assumir um dos dois estados: tenta o atalho
// (folha já clicável) com um timeout curto e, se não achar, cai para
// navigateToProducaoPlanoMestre (já provada robusta nos dois cenários,
// já que é a mesma função usada com sucesso no início do fluxo).
async function voltarParaPlanoMestre(page) {
  log.step("Navegação final: Produção > Plano mestre e simulação");
  await openMainMenu(page);
  await waitForUi(page, 1500);

  // menuTextVisible (não menuText/.last()): getByText("Plano mestre e
  // simulação") pode bater em mais de um elemento nesta tela — o link
  // real do flyout, um <span class="wf-menu-card__headline"> escondido
  // (resquício da view em grade) e/ou o <span class="mdc-tab__text-label">
  // de uma aba já aberta (coberta pelo scrim do menu, "visível" mas não
  // clicável). menuTextVisible faz hit-test para escolher só o clicável.
  const planoMestreLeaf = await menuTextVisible(page, "Plano mestre e simulação", {
    timeoutMs: 4000
  }).catch(() => null);

  if (planoMestreLeaf) {
    log.info('"Plano mestre e simulação" já clicável — indo direto (sem "Produção"/"(MPS)").');
    await planoMestreLeaf.click();
    // Âncora no início (^) — sem isso, a regex também bate na aba "Menu:
  // Plano mestre e simulação (MPS) ..." (view em grade), que CONTÉM a
  // mesma substring, causando violação de strict mode (2 matches) quando
  // essa aba já estiver aberta de uma navegação anterior.
  await page.getByRole("tab", { name: /^Plano mestre e simulação/i }).waitFor({ timeout: 30000 });
    await waitForUi(page, 5000);
    log.done("Navegação final: Produção > Plano mestre e simulação");
    return;
  }

  log.info('"Plano mestre e simulação" não apareceu direto — menu abriu "frio", refazendo os 2 níveis de acordeão...');
  await navigateToProducaoPlanoMestre(page);
  log.done("Navegação final: Produção > Plano mestre e simulação");
}

async function navigateToRelatorioLogisticaCompras(page) {
  log.step('Navegação: Produção > "Relatório de Logística de Compras da Simulação"');

  // BUG CONFIRMADO ao vivo (2x): (1) clicar em "Abrir menu em grade"
  // SEMPRE abre uma aba NOVA "Menu: Plano mestre e simulação (MPS)" — não
  // reaproveita uma já aberta de uma chamada anterior desta função (usada
  // 2x no fluxo, 1a e 2a simulação), deixando uma aba antiga escondida no
  // DOM que atrapalha o seletor do card depois. (2) Tentar clicar
  // DIRETAMENTE na aba já aberta enquanto o menu principal ainda está
  // aberto (com o flyout de "Produção" visível) trava 30s — o
  // "wf-nav-menu__scrim" (fundo escurecido do menu) intercepta o clique
  // na aba, que fica na barra de abas por trás dele. Por isso, se a aba já
  // existir, o menu principal NEM CHEGA A SER ABERTO — só fechamos se por
  // acaso já estiver aberto, e clicamos direto na aba.
  const gridTab = page.getByRole("tab", { name: /^Menu: Plano mestre e simulação \(MPS\)/i });
  const gridTabAlreadyOpen = (await gridTab.count().catch(() => 0)) > 0;

  if (gridTabAlreadyOpen) {
    log.info('Aba "Menu: Plano mestre e simulação (MPS)" já aberta — focando nela...');
    const closeMenuButton = page.getByRole("button", { name: "Fechar menu", exact: true });
    if (await closeMenuButton.isVisible().catch(() => false)) {
      await closeMenuButton.click();
      await waitForUi(page, 500);
    }
    await gridTab.last().click();
  } else {
    await openMainMenu(page);
    await waitForUi(page, 1500);

    const producaoGroup = menuText(page, "Produção");
    const mpsGroup = page
      .locator('li[data-wf-type="group"]')
      .filter({ hasText: "Plano mestre e simulação (MPS)" })
      .first();

    log.info('Expandindo "Produção"...');
    await clickMenuGroupUntilRevealed(page, producaoGroup, mpsGroup, { waitMs: 1200 });

    log.info('Abrindo a grade do menu "Plano mestre e simulação (MPS)"...');
    await mpsGroup.getByRole("button", { name: "Abrir menu em grade" }).click();
  }
  await waitForUi(page, 1500);

  log.info('Selecionando o card "Relatório de Logística de Compras da Simulação"...');
  const reportCard = page
    .locator("section.wf-menu-card")
    .filter({
      has: page.locator("span.wf-menu-card__headline", {
        hasText: "Relatório de Logística de Compras da Simulação"
      })
    })
    .first();
  await reportCard.getByRole("button", { name: "Abrir" }).click();

  // .first(): se esta função já rodou antes na mesma sessão (2a
  // simulação), pode existir mais de uma aba "Relatório de Logística de
  // Compras da Simulação" com o MESMO nome exato — sem .first()/.last()
  // aqui, waitFor viola strict mode (visto ao vivo com "Plano mestre e
  // simulação" vs. "Menu: Plano mestre e simulação (MPS)", mesmo padrão).
  await page
    .getByRole("tab", { name: /Relatório de Logística de Compras da Simulação/i })
    .first()
    .waitFor({ timeout: 30000 });
  await waitForUi(page, 4000);
  log.done('Navegação: Produção > "Relatório de Logística de Compras da Simulação"');
}

// Espelha o fluxo antigo (main_copy.py, linhas 849-853: listar_menu_click
// "Compra" -> "Consultas" -> "Análise de Pedidos Pendentes ou Baixados -
// CEMAG"), chamado logo após a atualização da tabela "Recursos Utilizados"
// no Google Sheets. Usa o mesmo padrão de acordeão + folha já validado em
// navigateToProducaoPlanoMestre (clickMenuGroupUntilRevealed lida com o
// efeito acordeão em qualquer estado inicial do menu).
async function navigateToAnalisePedidosPendentes(page) {
  log.step('Navegação: Compra > Consultas > "Análise de Pedidos Pendentes ou Baixados - CEMAG"');
  await openMainMenu(page);
  await waitForUi(page, 1500);

  const compraGroup = menuText(page, "Compra");
  const consultasGroup = menuText(page, "Consultas");
  const analiseLeaf = menuText(page, "Análise de Pedidos Pendentes ou Baixados - CEMAG");

  log.info('Expandindo "Compra"...');
  await clickMenuGroupUntilRevealed(page, compraGroup, consultasGroup);

  log.info('Expandindo "Consultas"...');
  await clickMenuGroupUntilRevealed(page, consultasGroup, analiseLeaf);

  log.info('Clicando em "Análise de Pedidos Pendentes ou Baixados - CEMAG"...');
  await analiseLeaf.click();

  await page
    .getByRole("tab", { name: /Análise de Pedidos Pendentes ou Baixados/i })
    .waitFor({ timeout: 30000 });
  await waitForUi(page, 4000);
  log.done('Navegação: Compra > Consultas > "Análise de Pedidos Pendentes ou Baixados - CEMAG"');
}

// Espelha o fluxo antigo (PASSO_A_PASSO_AUTOMACAO.md, passo 10 /
// main_copy.py: listar_menu_click "Estoque" -> "Consultas" -> "Saldos de
// Recursos - CEMAG"). Mesmo padrão de acordeão + folha de
// navigateToAnalisePedidosPendentes (clickMenuGroupUntilRevealed lida com
// o efeito acordeão em qualquer estado inicial do menu). Chamada no fluxo
// principal logo após updateRecursosUtilizadosNoSheets (validada
// isoladamente antes, ver test-navigate-saldos-recursos.js).
async function navigateToSaldosDeRecursos(page) {
  log.step('Navegação: Estoque > Consultas > "Saldos de Recursos - CEMAG"');
  await openMainMenu(page);
  await waitForUi(page, 1500);

  const estoqueGroup = menuText(page, "Estoque");
  const consultasGroup = menuText(page, "Consultas");
  const saldosLeaf = menuText(page, "Saldos de Recursos - CEMAG");

  log.info('Expandindo "Estoque"...');
  await clickMenuGroupUntilRevealed(page, estoqueGroup, consultasGroup);

  log.info('Expandindo "Consultas"...');
  await clickMenuGroupUntilRevealed(page, consultasGroup, saldosLeaf);

  log.info('Clicando em "Saldos de Recursos - CEMAG"...');
  await saldosLeaf.click();

  await page.getByRole("tab", { name: /Saldos de Recursos/i }).waitFor({ timeout: 30000 });
  await waitForUi(page, 4000);
  log.done('Navegação: Estoque > Consultas > "Saldos de Recursos - CEMAG"');
}

// Confirmado ao vivo via screenshot (1783003103221-teste-analise-pedidos.png):
// depois de clicar em "Executar", aparece um diálogo modal com % de
// progresso ("13% Escrevendo relatório..."), mesmo padrão dos diálogos
// intermediários de explodirSimulacao ("80% Gravando...", etc.) — só que
// aqui NÃO há um diálogo final de "sucesso" com texto fixo conhecido para
// esperar. Por isso o critério de parada é o diálogo (role="dialog")
// deixar de existir/ficar visível, com polling em vez de waitForUi fixo
// (evita clicar em "Exportar" enquanto o relatório ainda está sendo
// escrito — foi exatamente isso que aconteceu no screenshot acima, capturado
// no meio do carregamento porque o script seguiu cedo demais).
async function waitForAnalisePedidosReportReady(page, options = {}) {
  const { timeoutMs = 180000, pollMs = 1000 } = options;
  const dialog = page.getByRole("dialog").first();

  log.info('Aguardando diálogo de progresso ("Escrevendo relatório...") finalizar...');
  let lastText = null;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const visible = await dialog.isVisible().catch(() => false);
    if (!visible) {
      log.info("Diálogo de progresso não está mais visível — relatório pronto.");
      return;
    }

    const text = await dialog.innerText().catch(() => null);
    if (text && text !== lastText) {
      log.info(`Relatório em geração: "${text.trim().replace(/\s+/g, " ")}"`);
      lastText = text;
    }

    await page.waitForTimeout(pollMs);
  }

  log.warn(
    `Diálogo de progresso ainda visível após ${timeoutMs}ms — seguindo mesmo assim.`
  );
}

// Confirmado ao vivo (sessão MCP salva em
// .playwright-mcp/page-2026-06-23T14-58-16-841Z.yml): a tela "Análise de
// Pedidos Pendentes ou Baixados - CEMAG" tem uma barra de ferramentas com
// dois botões sem nome acessível próprio (o texto "Executar"/"Exportar"
// fica num <generic> dentro do <button>, não no atributo aria-label) —
// mesmo padrão do botão "Explodir" (ver explodirSimulacao), por isso
// localizado via filter({ hasText }) em vez de getByRole com name. Clicar
// em "Executar" roda a consulta com os filtros/valores já carregados na
// tela (sem precisar navegar pelos campos antes). Depois do clique, espera
// o diálogo de progresso "Escrevendo relatório..." desaparecer
// (waitForAnalisePedidosReportReady) antes de considerar a etapa concluída.
async function executarAnalisePedidosPendentes(page) {
  log.step('Execução: Análise de Pedidos Pendentes ou Baixados - CEMAG ("Executar")');

  log.info('Clicando no botão "Executar"...');
  await page.getByRole("button").filter({ hasText: "Executar" }).click();
  await waitForUi(page, 800);

  await waitForAnalisePedidosReportReady(page);

  log.done('Execução: Análise de Pedidos Pendentes ou Baixados - CEMAG ("Executar")');
}

// Mesma tela "Saldos de Recursos - CEMAG" de navigateToSaldosDeRecursos —
// botão "Executar" sem nome acessível próprio, mesmo padrão de
// executarAnalisePedidosPendentes (ver comentário lá). Reaproveita
// waitForAnalisePedidosReportReady (função genérica, apesar do nome —
// só faz polling de um diálogo modal de progresso até ele desaparecer,
// sem depender de texto específico de "Análise de Pedidos"). Chamada no
// fluxo principal logo após navigateToSaldosDeRecursos.
async function executarSaldosDeRecursos(page) {
  log.step('Execução: Saldos de Recursos - CEMAG ("Executar")');

  log.info('Clicando no botão "Executar"...');
  await page.getByRole("button").filter({ hasText: "Executar" }).click();
  await waitForUi(page, 800);

  await waitForAnalisePedidosReportReady(page);

  log.done('Execução: Saldos de Recursos - CEMAG ("Executar")');
}

// Mesmo padrão de findRecursosUtilizadosTableLocator/
// findAnalisePedidosPendentesTableLocator (ver comentários lá): escopado
// por table.sl-rootTable cujo descendente td.sl-title tem o texto exato do
// título do relatório.
async function findSaldosDeRecursosTableLocator(page, options = {}) {
  const { timeoutMs = 15000, pollMs = 500 } = options;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    for (const frame of page.frames()) {
      const tableLocator = frame
        .locator("table.sl-rootTable")
        .filter({ has: frame.locator("td.sl-title", { hasText: "Saldos de Recursos - CEMAG" }) });

      const count = await tableLocator.count().catch(() => 0);
      if (count > 0) {
        return tableLocator.first();
      }
    }
    await page.waitForTimeout(pollMs);
  }

  return null;
}

async function waitForSaldosDeRecursosTable(page, options = {}) {
  const { timeoutMs = 30000, minRowCount = 1 } = options;
  log.step('Busca da tabela "Saldos de Recursos - CEMAG"');

  const startedAt = Date.now();
  const table = await findSaldosDeRecursosTableLocator(page, { timeoutMs });

  if (!table) {
    throw new Error(
      'Não foi possível localizar a tabela "Saldos de Recursos - CEMAG" em nenhum frame da página (título não encontrado).'
    );
  }

  log.info('Tabela "Saldos de Recursos - CEMAG" localizada — aguardando linhas de dados...');
  const rowsLocator = table.locator("tbody.sl-content tr.sl-r");

  let rowCount = 0;
  const remainingMs = Math.max(5000, timeoutMs - (Date.now() - startedAt));
  const rowsDeadline = Date.now() + remainingMs;

  while (Date.now() < rowsDeadline) {
    rowCount = await rowsLocator.count().catch(() => 0);
    if (rowCount >= minRowCount) {
      break;
    }
    await page.waitForTimeout(500);
  }

  if (rowCount < minRowCount) {
    throw new Error(
      `Tabela "Saldos de Recursos - CEMAG" encontrada, mas sem linhas de dados (tr.sl-r) após ${timeoutMs}ms.`
    );
  }

  log.done(`Busca da tabela "Saldos de Recursos - CEMAG" (linhas encontradas: ${rowCount})`);
  return { table, rowCount };
}

// Confirmado ao vivo via HTML colado pelo usuário: diferente de "Análise de
// Pedidos" (5 níveis de agrupamento), esta tabela tem UM SÓ nível de
// agrupamento (data-group-index sempre "0") — o próprio Recurso (código +
// nome + unidade, ex.: "027713PERF - Chapa Aço Carbono ... (Un)"), exibido
// como linha própria (tr.sl-g-ln) antes de 1+ linhas de detalhe por
// depósito (tr.sl-r). Linhas de total por recurso (tr.sl-g-ln-t, só
// aparecem quando o recurso tem mais de 1 depósito) são PULADAS, mesmo
// critério usado em extractAnalisePedidosPendentesTable.
//
// A tabela tem 12 colunas (thead colspan=12), mas cabeçalhos de 2 delas
// ficam sob super-cabeçalhos agrupados (sl-colGroupHeader: "Recurso" cobre
// Classe/Unid. Medida/Fora de Linha/Fornecedor Principal/Fabricante;
// "Custo" cobre Total/Médio). Os nomes abaixo replicam a convenção
// "Grupo#Coluna" do export CSV antigo (ver SALDOS_COLUMNS em reports.js) —
// por posição fixa, já confirmada contra o HTML real, não lida
// dinamicamente do sl-colGroupHeader (mesma abordagem pragmática usada em
// extractAnalisePedidosPendentesTable para os nomes de grupo).
async function extractSaldosDeRecursosTable(table) {
  return table.evaluate((tableEl) => {
    const normalize = (text) => text.replace(/\s+/g, " ").trim();

    const columnHeaders = [
      "",
      "Depósito",
      "Recurso#Classe",
      "Recurso#Unid. Medida",
      "Recurso#Fora de Linha",
      "Recurso#Fornecedor Principal",
      "Recurso#Fabricante",
      "Ref. Fabricante",
      "Qde p Vol Compra",
      "Saldo",
      "Custo#Total",
      "Custo#Médio"
    ];
    const headers = ["1o. Agrupamento", ...columnHeaders];

    let currentRecurso = "";
    const rows = [];

    const trs = Array.from(tableEl.querySelectorAll("tbody.sl-content > tr"));
    for (const tr of trs) {
      if (tr.classList.contains("sl-g-ln")) {
        if (tr.classList.contains("sl-g-ln-t")) {
          continue; // linha de total por Recurso — não é dado detalhado
        }
        const groupCell = tr.querySelector("td.sl-g");
        currentRecurso = groupCell ? normalize(groupCell.innerText) : "";
        continue;
      }

      if (!tr.classList.contains("sl-r")) {
        continue; // linha desconhecida — ignora
      }

      const cells = Array.from(tr.querySelectorAll("td.sl-c")).map((td) => normalize(td.innerText));
      rows.push([currentRecurso, ...cells]);
    }

    return { headers, rows };
  });
}

// TEMPORÁRIO (depuração): mesmo padrão de logAnalisePedidosPendentesTable
// — extrai a tabela, aplica o tratamento (numérico + seleção de colunas)
// que updateSaldoRecursosFromRows usaria para gravar em "Est.
// Produção"!N3:U, mas só salva em CSV e loga um resumo. NÃO grava no
// Sheets. Usado para conferir grupo/colunas/números antes de acoplar esta
// etapa ao fluxo principal (mesmo cuidado já tomado com "Análise de
// Pedidos", onde uma coluna faltante — "Qde Canc" — só foi percebida
// conferindo o CSV contra o cabeçalho real da planilha).
async function logSaldoRecursosTable(page) {
  const { table } = await waitForSaldosDeRecursosTable(page);
  const { headers, rows } = await extractSaldosDeRecursosTable(table);

  log.info(
    `Tabela "Saldos de Recursos - CEMAG" extraída: ${rows.length} linha(s), colunas: ${headers.join(", ")}`
  );

  const { objects, matrix } = buildSaldoRecursosMatrix(headers, rows);

  const outputDir = path.join(process.cwd(), "output", "playwright");
  await fs.mkdir(outputDir, { recursive: true });
  const csvPath = path.join(outputDir, `${Date.now()}-saldos-recursos-debug.csv`);
  await writeCsv(csvPath, SALDOS_COLUMNS, matrix);

  log.info(`=== Resultado do tratamento (NÃO gravado no Sheets) salvo em CSV: ${csvPath} ===`);
  log.info(`Resumo: ${matrix.length} linha(s) x ${SALDOS_COLUMNS.length} colunas.`);

  return { headers, rows, objects, matrix, csvPath };
}

// Localiza a tabela, extrai do DOM e atualiza a aba "Est. Produção" (N3:U)
// via updateSaldoRecursosFromRows (reports.js). NÃO chamada no fluxo
// principal ainda (ver logSaldoRecursosTable) — mesma etapa de cautela já
// aplicada em updateAnalisePedidosPendentesNoSheets.
async function updateSaldoRecursosNoSheets(page) {
  const { table } = await waitForSaldosDeRecursosTable(page);
  const { headers, rows } = await extractSaldosDeRecursosTable(table);

  log.info(
    `Tabela "Saldos de Recursos - CEMAG" extraída: ${rows.length} linha(s), colunas: ${headers.join(", ")}`
  );

  await updateSaldoRecursosFromRows(headers, rows);
}

// Mesmo padrão de findRecursosUtilizadosTableLocator (ver comentário lá):
// escopado por table.sl-rootTable cujo descendente td.sl-title tem o texto
// exato do título do relatório, para não pegar a tabela sl-rootTable
// errada quando há mais de uma na página.
async function findAnalisePedidosPendentesTableLocator(page, options = {}) {
  const { timeoutMs = 15000, pollMs = 500 } = options;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    for (const frame of page.frames()) {
      const tableLocator = frame
        .locator("table.sl-rootTable")
        .filter({
          has: frame.locator("td.sl-title", {
            hasText: "Análise de Pedidos Pendentes ou Baixados - CEMAG"
          })
        });

      const count = await tableLocator.count().catch(() => 0);
      if (count > 0) {
        return tableLocator.first();
      }
    }
    await page.waitForTimeout(pollMs);
  }

  return null;
}

async function waitForAnalisePedidosPendentesTable(page, options = {}) {
  const { timeoutMs = 30000, minRowCount = 1 } = options;
  log.step('Busca da tabela "Análise de Pedidos Pendentes ou Baixados - CEMAG"');

  const startedAt = Date.now();
  const table = await findAnalisePedidosPendentesTableLocator(page, { timeoutMs });

  if (!table) {
    throw new Error(
      'Não foi possível localizar a tabela "Análise de Pedidos Pendentes ou Baixados - CEMAG" em nenhum frame da página (título não encontrado).'
    );
  }

  log.info('Tabela "Análise de Pedidos Pendentes ou Baixados - CEMAG" localizada — aguardando linhas de dados...');
  const rowsLocator = table.locator("tbody.sl-content tr.sl-r");

  let rowCount = 0;
  const remainingMs = Math.max(5000, timeoutMs - (Date.now() - startedAt));
  const rowsDeadline = Date.now() + remainingMs;

  while (Date.now() < rowsDeadline) {
    rowCount = await rowsLocator.count().catch(() => 0);
    if (rowCount >= minRowCount) {
      break;
    }
    await page.waitForTimeout(500);
  }

  if (rowCount < minRowCount) {
    throw new Error(
      `Tabela "Análise de Pedidos Pendentes ou Baixados - CEMAG" encontrada, mas sem linhas de dados (tr.sl-r) após ${timeoutMs}ms.`
    );
  }

  log.done(`Busca da tabela "Análise de Pedidos Pendentes ou Baixados - CEMAG" (linhas encontradas: ${rowCount})`);
  return { table, rowCount };
}

// Confirmado ao vivo via HTML inspecionado (trecho colado pelo usuário):
// diferente de "Recursos Utilizados" (tabela plana), esta tabela é
// AGRUPADA em 5 níveis (Região, Estado/UF, Pessoa, Classe Recurso, Data
// Entrega — confirmado pelo texto "Grupo 1..5" no bloco "Informações de
// Filtro" do cabeçalho). Cada nível de agrupamento aparece como uma linha
// própria (tr.sl-g-ln, com data-group-index de 0 a 4 e o valor do grupo num
// único td.sl-g), NÃO como colunas — diferente do CSV antigo exportado
// (que achatava os agrupamentos em colunas "1o./2o./3o./4o./5o.
// Agrupamento", ver PEDIDOS_RENAME_MAP em reports.js). Por isso a extração
// percorre TODAS as <tr> da tbody em ordem, mantém um "grupo atual" (5
// posições) atualizado a cada linha de agrupamento encontrada, e cola esse
// grupo na frente das 26 colunas de cada linha de dado (tr.sl-r) — assim
// reconstitui o mesmo formato achatado que updateAnalisePedidosPendentes
// (CSV) já sabe gravar no Sheets, sem precisar mexer no reports.js.
//
// Linhas de total/subtotal (tr.sl-g-ln-t, ex.: "12  767,0000  ...") são
// PULADAS — não são dado detalhado, são somas que a planilha de destino não
// espera como linha própria.
//
// Usa `innerText` (não `textContent`) para ler os cabeçalhos e células: os
// cabeçalhos de 2 linhas (ex.: "Qde<br>Ped", "Dias<br>Entrega") só viram
// "Qde Ped"/"Dias Entrega" com espaço via innerText (que respeita <br> como
// quebra de linha); textContent junta sem espaço nenhum ("QdePed"), o que
// quebraria o casamento de nomes com PEDIDOS_FINAL_COLUMNS.
async function extractAnalisePedidosPendentesTable(table) {
  return table.evaluate((tableEl) => {
    const normalize = (text) => text.replace(/\s+/g, " ").trim();

    const headerCells = Array.from(tableEl.querySelectorAll("thead tr.sl-colTitles th.sl-colHeader"));
    const columnHeaders = headerCells.map((th) => normalize(th.innerText));

    const groupHeaders = ["Região", "Estado", "Pessoa", "Classe Recurso", "Data Entrega"];
    const currentGroup = ["", "", "", "", ""];
    const rows = [];

    const trs = Array.from(tableEl.querySelectorAll("tbody.sl-content > tr"));
    for (const tr of trs) {
      if (tr.classList.contains("sl-g-ln")) {
        if (tr.classList.contains("sl-g-ln-t")) {
          continue; // linha de total/subtotal — não é dado detalhado
        }
        const groupIndex = Number(tr.getAttribute("data-group-index"));
        const groupCell = tr.querySelector("td.sl-g");
        const groupText = groupCell ? normalize(groupCell.innerText) : "";
        if (Number.isInteger(groupIndex) && groupIndex >= 0 && groupIndex < currentGroup.length) {
          currentGroup[groupIndex] = groupText;
        }
        continue;
      }

      if (!tr.classList.contains("sl-r")) {
        continue; // linha desconhecida — ignora
      }

      const cells = Array.from(tr.querySelectorAll("td.sl-c")).map((td) => normalize(td.innerText));
      rows.push([...currentGroup, ...cells]);
    }

    return { headers: [...groupHeaders, ...columnHeaders], rows };
  });
}

// TEMPORÁRIO (depuração): mesmo padrão de logRecursosUtilizadosTable —
// extrai a tabela, aplica o MESMO tratamento (numérico + seleção de
// colunas) que updateAnalisePedidosPendentesFromRows usaria para gravar no
// Sheets, mas só salva em CSV e imprime um resumo no console. NÃO grava no
// Google Sheets. Usado para conferir headers/valores (grupos reconstituídos
// corretamente, números convertidos certo) antes de confiar na gravação
// real na aba "Dados Pedidos".
async function logAnalisePedidosPendentesTable(page) {
  const { table } = await waitForAnalisePedidosPendentesTable(page);
  const { headers, rows } = await extractAnalisePedidosPendentesTable(table);

  log.info(
    `Tabela "Análise de Pedidos Pendentes ou Baixados - CEMAG" extraída: ${rows.length} linha(s), colunas: ${headers.join(", ")}`
  );

  const { objects, matrix } = buildAnalisePedidosPendentesMatrix(headers, rows);

  const outputDir = path.join(process.cwd(), "output", "playwright");
  await fs.mkdir(outputDir, { recursive: true });
  const csvPath = path.join(outputDir, `${Date.now()}-analise-pedidos-pendentes-debug.csv`);
  await writeCsv(csvPath, PEDIDOS_FINAL_COLUMNS, matrix);

  log.info(
    `=== Resultado do tratamento (NÃO gravado no Sheets) salvo em CSV: ${csvPath} ===`
  );
  log.info(`Resumo: ${matrix.length} linha(s) x ${PEDIDOS_FINAL_COLUMNS.length} colunas.`);

  return { headers, rows, objects, matrix, csvPath };
}

// Localiza a tabela, extrai do DOM (extractAnalisePedidosPendentesTable) e
// atualiza a aba "Dados Pedidos" da planilha DEE via
// updateAnalisePedidosPendentesFromRows (reports.js). Equivalente a
// updateRecursosUtilizadosNoSheets, mas para esta tabela. NÃO chamada no
// fluxo principal ainda — usar logAnalisePedidosPendentesTable primeiro
// para validar o resultado antes de promover esta função ao fluxo real
// (mesmo cuidado já tomado com Recursos Utilizados, ver comentário lá).
async function updateAnalisePedidosPendentesNoSheets(page) {
  const { table } = await waitForAnalisePedidosPendentesTable(page);
  const { headers, rows } = await extractAnalisePedidosPendentesTable(table);

  log.info(
    `Tabela "Análise de Pedidos Pendentes ou Baixados - CEMAG" extraída: ${rows.length} linha(s), colunas: ${headers.join(", ")}`
  );

  await updateAnalisePedidosPendentesFromRows(headers, rows);
}

// Confirmado ao vivo: o botão "Pendência de Pedidos" da toolbar (visivel
// quando uma simulação está selecionada) abre a tela "Executa Busca de
// Pedidos", com o formulario "Restrições de busca pendência" (grid interna
// grFiltroDePedidos) e o titulo "Simulação: <nome>" no topo.
async function openPendenciaDePedidos(page) {
  log.step("Abertura: Pendência de Pedidos");
  log.info("Clicando no botão Pendência de Pedidos...");
  await page.getByRole("button").filter({ hasText: "Pendência de Pedidos" }).click();
  await page.getByRole("button").filter({ hasText: "Executa Busca de Pedidos" }).waitFor({
    timeout: 30000
  });
  await waitForUi(page, 3000);
  log.done("Abertura: Pendência de Pedidos");
}

// Confirmado ao vivo: ao abrir a tela, o primeiro campo ("Chave de criação
// do pedido") já vem focado automaticamente. Todo campo é apagado
// (Control+A, Backspace); campos com `value` são sempre redigitados na
// sequência (nunca apenas pulados/preservados — já vimos esse campo vir
// vazio em uma execução, então assumir "já está certo" é arriscado).
//
// BUG JÁ CONFIRMADO E CORRIGIDO: confirmar esses campos com Tab+Enter fazia
// o Enter avançar UM CAMPO EXTRA além do Tab, desalinhando o resto do
// formulário (o valor de um campo acabava digitado no campo seguinte). No
// teste manual ao vivo, digitar o valor e dar apenas Tab (sem Enter) já
// confirma a seleção corretamente — por isso nenhum campo usa Enter para
// confirmar, só para submeter o formulário no final.
//
// No último campo ("Aprovador"), após apagar, pressiona Enter para
// submeter o formulário (equivalente a "Executa Busca de Pedidos"). Navega
// entre campos exclusivamente via Tab (não há DOM/accessibility tree
// consultável neste formulário, mesma limitação dos grids de
// simulação/especificação).
async function fillPendenciaFilters(page) {
  log.step("Preenchimento de filtros: Restrições de busca pendência (via Tab)");

  for (let i = 0; i < PENDENCIA_FILTER_FIELDS.length; i += 1) {
    const field = PENDENCIA_FILTER_FIELDS[i];
    const isLast = i === PENDENCIA_FILTER_FIELDS.length - 1;

    log.info(
      `Campo ${i + 1}/${PENDENCIA_FILTER_FIELDS.length}: "${field.label}" -> ${
        field.value ? `"${field.value}"` : "vazio"
      }`
    );

    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await waitForUi(page, 300);

    if (field.value) {
      await page.keyboard.type(field.value);
      await waitForUi(page, 800);
    }

    if (!isLast) {
      await page.keyboard.press("Tab");
      await waitForUi(page, 400);
    }

    if (isLast) {
      log.info("Último campo — pressionando Enter para submeter o formulário...");
      await page.keyboard.press("Enter");
      await waitForUi(page, 3000);
    }
  }

  log.info("Aguardando a tela voltar para a grade Especificação após a busca...");
  await waitForGridAvailable(page, "grEspecificacao", { timeoutMs: 30000, minRecordCount: 1 });

  log.done("Preenchimento de filtros: Restrições de busca pendência (via Tab)");
}

// A barra de progresso indeterminada (".wf-process-view__working") ganha a
// classe "mdc-linear-progress--closed" quando está ociosa e perde essa
// classe enquanto o ERP está carregando algo dinamicamente (ex.: gerando o
// relatório após o Enter final do formulário). Espera primeiro ela aparecer
// (ficar sem a classe --closed) e só depois espera ela voltar a ficar
// "closed" — se ela nunca aparecer dentro do prazo, assume que a resposta
// já chegou rápido demais para capturar e segue.
async function waitForProcessViewLoading(page, options = {}) {
  // Confirmado ao vivo (2026-07-03): o relatório da 2a simulação (materiais
  // indiretos) levou mais de 2 minutos pra carregar — o timeout antigo
  // (120000ms) esgotou com o carregamento AINDA em andamento, e o código
  // seguiu cedo demais pra waitForRecursosUtilizadosTable, que não achou a
  // tabela (ela simplesmente ainda não existia). Aumentado para 5 minutos,
  // mesma ordem de grandeza do timeout de explodirSimulacao (10 min) para
  // outro processo igualmente variável em duração.
  const { appearTimeoutMs = 5000, finishTimeoutMs = 300000 } = options;
  const loadingBar = page.locator(".wf-process-view__working:not(.mdc-linear-progress--closed)").first();

  log.info("Aguardando início do carregamento dinâmico...");
  const appeared = await loadingBar
    .waitFor({ state: "attached", timeout: appearTimeoutMs })
    .then(() => true)
    .catch(() => false);

  if (!appeared) {
    log.info("Indicador de carregamento não apareceu a tempo — seguindo.");
    return;
  }

  log.info("Carregamento em andamento — aguardando finalizar...");
  await loadingBar.waitFor({ state: "detached", timeout: finishTimeoutMs }).catch(() => {
    log.info("Aviso: indicador de carregamento ainda ativo após o timeout — seguindo mesmo assim.");
  });

  log.info("Carregamento dinâmico concluído.");
}

// options.simulationName permite sobrescrever o valor do 1o campo
// ("Simulação") sem mexer no env padrão — usado pela 2a simulação
// (materiais indiretos), que reaproveita esta mesma tela do relatório com
// outro nome de simulação.
async function fillRelatorioLogisticaFilters(page, options = {}) {
  const { simulationName } = options;
  log.step("Preenchimento de filtros: Relatório de Logística de Compras da Simulação");

  await waitForGridAvailable(page, "vars", { timeoutMs: 30000, minRecordCount: 0 });

  const fields = simulationName
    ? [{ ...RELATORIO_LOGISTICA_FIELDS[0], value: simulationName }, ...RELATORIO_LOGISTICA_FIELDS.slice(1)]
    : RELATORIO_LOGISTICA_FIELDS;

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    const isLast = i === fields.length - 1;

    log.info(
      `Campo ${i + 1}/${fields.length}: "${field.label}" (${field.fieldName}) -> "${field.value}"`
    );

    await focusGridField(page, "vars", field.fieldName);
    await waitForUi(page, 300);

    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await waitForUi(page, 300);

    await page.keyboard.type(field.value);
    await waitForUi(page, 900);

    if (!isLast) {
      await page.keyboard.press("Tab");
      await waitForUi(page, 500);
    } else {
      log.info("Último campo — pressionando Enter (5x) para carregar o relatório...");
      for (let enterCount = 0; enterCount < 5; enterCount += 1) {
        await page.keyboard.press("Enter");
        await waitForUi(page, 800);
      }
      await waitForProcessViewLoading(page);
    }
  }

  log.done("Preenchimento de filtros: Relatório de Logística de Compras da Simulação");
}

// --- Helpers da API interna (window.Environment) ---

async function emitGridEvent(page, gridName, eventName, payload) {
  const frame = await waitForErpFrame(page);
  return frame.evaluate(
    ({ gridName, eventName, payload }) => {
      const process = window.Environment?.getInstance?.()?.currentProcess;
      const grid = process?.getGrid?.(gridName);
      if (!grid) {
        throw new Error(`Grid "${gridName}" nao encontrada via Environment API.`);
      }
      grid.emit(eventName, payload);
    },
    { gridName, eventName, payload }
  );
}

async function focusGridField(page, gridName, fieldName) {
  const frame = await waitForErpFrame(page);
  return frame.evaluate(
    ({ gridName, fieldName }) => {
      const process = window.Environment?.getInstance?.()?.currentProcess;
      const grid = process?.getGrid?.(gridName);
      if (!grid) {
        throw new Error(`Grid "${gridName}" nao encontrada via Environment API.`);
      }
      if (!grid.hasField?.(fieldName)) {
        throw new Error(`Campo "${fieldName}" nao existe na grid "${gridName}".`);
      }
      grid.focusField({ fieldName });
      return {
        gridName,
        fieldName,
        currentField: grid.currentField?.name || null
      };
    },
    { gridName, fieldName }
  );
}

// Mede a posição/tamanho REAL do container da grade `gridName` (elemento
// [data-grid-name] dentro do iframe) somado ao offset do próprio iframe na
// página — dá a posição absoluta atual do container, robusta a mudanças de
// scroll/layout (ex.: altura variável do painel "Simulações" acima, que já
// confirmamos deslocar a grade Especificação entre execuções). O elemento
// existe no DOM real mesmo quando o conteúdo interno é canvas/Shadow DOM
// fechado, então isso funciona mesmo sem conseguir ler o conteúdo da grade.
async function getSpecGridContainerBox(page, gridName) {
  const box = await page.evaluate((gridName) => {
    const iframe = document.querySelector("iframe");
    if (!iframe) return null;
    const iframeRect = iframe.getBoundingClientRect();
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    const section = doc.querySelector(`[data-grid-name="${gridName}"]`);
    if (!section) return null;
    const rect = section.getBoundingClientRect();
    return {
      x: iframeRect.x + rect.x,
      y: iframeRect.y + rect.y,
      width: rect.width,
      height: rect.height
    };
  }, gridName);

  if (!box) {
    throw new Error(`Não foi possível medir o container da grid "${gridName}" (elemento [data-grid-name] não encontrado).`);
  }

  return box;
}

async function readGridState(page, gridName) {
  const frame = await waitForErpFrame(page);
  return frame.evaluate((gridName) => {
    const process = window.Environment?.getInstance?.()?.currentProcess;
    const grid = process?.getGrid?.(gridName);
    if (!grid) {
      return null;
    }
    return {
      recordCount: grid.recordCount,
      currentRecordIndex: grid.currentRecordIndex,
      bookmark: grid.bookmark,
      clientRecNo: grid.clientRecNo,
      selectedRecords: grid.selectedRecords
    };
  }, gridName);
}

// Aguarda em polling (em vez de espera fixa) até que a grid `gridName`
// esteja disponível via Environment API e tenha pelo menos `minRecordCount`
// registros. Necessário apos navegações/submissões de formulário, já que a
// tela pode levar um tempo variável para trocar de interação (ex.: voltar
// de "buscarPendenciaDePedidos" para "principal") e a grid antiga deixa de
// existir antes da nova ficar disponível.
async function waitForGridAvailable(page, gridName, options = {}) {
  const { timeoutMs = 20000, pollMs = 700, minRecordCount = 0 } = options;
  const startedAt = Date.now();
  let lastState = null;

  while (Date.now() - startedAt < timeoutMs) {
    lastState = await readGridState(page, gridName).catch(() => null);
    if (lastState && lastState.recordCount >= minRecordCount) {
      return lastState;
    }
    await page.waitForTimeout(pollMs);
  }

  throw new Error(
    `Grid "${gridName}" não ficou disponível (ou não atingiu ${minRecordCount} registros) ` +
      `após ${timeoutMs}ms. Último estado: ${JSON.stringify(lastState)}`
  );
}

// Confirmado ao vivo (HTML inspecionado): "Recursos Utilizados" NÃO é uma
// grid da API interna (window.Environment/[data-grid-name]) como vars,
// grEspecificacao etc. — é uma tabela HTML simples de relatório
// (table.sl-rootTable), provavelmente renderizada num frame separado/
// aninhado dentro do iframe do processo.
//
// BUG CONFIRMADO ao vivo: existe mais de um table.sl-rootTable na página
// (outros relatórios/painéis usam o mesmo componente). Um primeiro
// approach que buscava só por texto "Recursos Utilizados" em qualquer
// lugar do frame, e depois fazia document.querySelector("table.sl-rootTable")
// (sem escopo), pegava a PRIMEIRA tabela sl-rootTable do documento — não
// necessariamente a certa — e contava linhas de TODAS as tabelas somadas
// (log mostrou "416 linhas" e colunas "Código, Descrição", de uma tabela
// completamente diferente). Por isso agora a busca usa um Locator do
// Playwright escopado: table.sl-rootTable cujo DESCENDENTE td.sl-title
// (o título do painel) tem o texto exato "Recursos Utilizados" — e todo o
// resto (contagem de linhas, extração) deriva desse mesmo Locator, nunca
// de um querySelector global solto.
async function findRecursosUtilizadosTableLocator(page, options = {}) {
  const { timeoutMs = 15000, pollMs = 500 } = options;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    for (const frame of page.frames()) {
      const tableLocator = frame
        .locator("table.sl-rootTable")
        .filter({ has: frame.locator("td.sl-title", { hasText: "Recursos Utilizados" }) });

      const count = await tableLocator.count().catch(() => 0);
      if (count > 0) {
        return tableLocator.first();
      }
    }
    await page.waitForTimeout(pollMs);
  }

  return null;
}

// Após o relatório carregar (fillRelatorioLogisticaFilters + Enter),
// localiza a tabela "Recursos Utilizados" (escopada, ver comentário acima)
// e espera as linhas de dados (tbody.sl-content > tr.sl-r) DESSA tabela
// especificamente aparecerem.
async function waitForRecursosUtilizadosTable(page, options = {}) {
  const { timeoutMs = 30000, minRowCount = 1 } = options;
  log.step('Busca da tabela "Recursos Utilizados"');

  const startedAt = Date.now();
  const table = await findRecursosUtilizadosTableLocator(page, { timeoutMs });

  if (!table) {
    throw new Error(
      'Não foi possível localizar a tabela "Recursos Utilizados" em nenhum frame da página (título não encontrado).'
    );
  }

  log.info('Tabela "Recursos Utilizados" localizada — aguardando linhas de dados...');
  const rowsLocator = table.locator("tbody.sl-content tr.sl-r");

  let rowCount = 0;
  const remainingMs = Math.max(5000, timeoutMs - (Date.now() - startedAt));
  const rowsDeadline = Date.now() + remainingMs;

  while (Date.now() < rowsDeadline) {
    rowCount = await rowsLocator.count().catch(() => 0);
    if (rowCount >= minRowCount) {
      break;
    }
    await page.waitForTimeout(500);
  }

  if (rowCount < minRowCount) {
    throw new Error(
      `Tabela "Recursos Utilizados" encontrada, mas sem linhas de dados (tr.sl-r) após ${timeoutMs}ms.`
    );
  }

  log.done(`Busca da tabela "Recursos Utilizados" (linhas encontradas: ${rowCount})`);
  return { table, rowCount };
}

// Lê a tabela "Recursos Utilizados" direto do DOM a partir do Locator já
// escopado (waitForRecursosUtilizadosTable), no mesmo formato
// {headers, rows} que readInnovaroCsv produziria a partir do CSV exportado
// — permite reusar rowsToObjects/applyNumericColumns/objectsToMatrix
// (csv-utils.js) sem precisar baixar/ler arquivo nenhum. table.evaluate
// passa o elemento <table> real para a função, então não há ambiguidade
// com outras tabelas sl-rootTable da página.
async function extractRecursosUtilizadosTable(table) {
  return table.evaluate((tableEl) => {
    const headers = Array.from(tableEl.querySelectorAll("thead tr.sl-colTitles th.sl-colHeader")).map((th) =>
      th.textContent.trim()
    );

    const rows = Array.from(tableEl.querySelectorAll("tbody.sl-content tr.sl-r")).map((tr) =>
      Array.from(tr.querySelectorAll("td.sl-c")).map((td) => td.textContent.trim())
    );

    return { headers, rows };
  });
}

// Localiza a tabela, extrai os dados do DOM e atualiza a aba "Dados
// Simulação" da planilha "Análise Previsão de Consumo (CMM / NTP) DEE" —
// equivalente ao updatePlanilhaRecursosUtilizados(csvPath) do fluxo antigo
// (main_copy.py + reports.js), mas sem depender de exportar/ler CSV.
async function updateRecursosUtilizadosNoSheets(page) {
  const { table } = await waitForRecursosUtilizadosTable(page);
  const { headers, rows } = await extractRecursosUtilizadosTable(table);

  log.info(
    `Tabela "Recursos Utilizados" extraída: ${rows.length} linha(s), colunas: ${headers.join(", ")}`
  );

  await updatePlanilhaRecursosUtilizadosFromRows(headers, rows);
}

// TEMPORÁRIO (depuração): extrai a tabela, aplica o MESMO tratamento
// numérico que seria usado para gravar no Sheets (buildRecursosUtilizadosMatrix
// com as colunas da planilha DEE) e só imprime o resultado no console — NÃO
// grava no Google Sheets. Usado para inspecionar por que alguns valores
// numéricos apareciam zerados (bug do separador de milhar em toBrNumber,
// já corrigido em csv-utils.js) antes de voltar a gravar de fato.
async function logRecursosUtilizadosTable(page) {
  const { table } = await waitForRecursosUtilizadosTable(page);
  const { headers, rows } = await extractRecursosUtilizadosTable(table);

  log.info(
    `Tabela "Recursos Utilizados" extraída: ${rows.length} linha(s), colunas: ${headers.join(", ")}`
  );

  const { objects, matrix } = buildRecursosUtilizadosMatrix(headers, rows, {
    columns: RECURSOS_COLUMNS_DEE,
    numericColumns: RECURSOS_NUMERIC_COLUMNS_DEE
  });

  const outputDir = path.join(process.cwd(), "output", "playwright");
  await fs.mkdir(outputDir, { recursive: true });
  const csvPath = path.join(outputDir, `${Date.now()}-recursos-utilizados-debug.csv`);
  await writeCsv(csvPath, RECURSOS_COLUMNS_DEE, matrix);

  log.info(
    `=== Resultado do tratamento (NÃO gravado no Sheets) salvo em CSV: ${csvPath} ===`
  );
  log.info(`Resumo: ${matrix.length} linha(s) x ${RECURSOS_COLUMNS_DEE.length} colunas.`);

  return { headers, rows, objects, matrix, csvPath };
}

// 2a simulação (materiais indiretos): mesma tabela "Recursos Utilizados",
// mas com o conjunto de colunas da planilha "Requisitados" (sem TRP/DEE —
// confirmado no fluxo antigo, main_copy.py linhas 378-412). Por enquanto só
// salva em CSV para conferência (igual logRecursosUtilizadosTable) — NÃO
// grava no Sheets ainda.
async function saveRecursosUtilizadosMatIndireto(page) {
  const { table } = await waitForRecursosUtilizadosTable(page);
  const { headers, rows } = await extractRecursosUtilizadosTable(table);

  log.info(
    `Tabela "Recursos Utilizados" (materiais indiretos) extraída: ${rows.length} linha(s), colunas: ${headers.join(", ")}`
  );

  const { objects, matrix } = buildRecursosUtilizadosMatrix(headers, rows, {
    columns: RECURSOS_COLUMNS_REQUISITADOS,
    numericColumns: RECURSOS_NUMERIC_COLUMNS_REQUISITADOS
  });

  const outputDir = path.join(process.cwd(), "output", "playwright");
  await fs.mkdir(outputDir, { recursive: true });
  const csvPath = path.join(outputDir, `${Date.now()}-recursos-utilizados-mat-indireto-debug.csv`);
  await writeCsv(csvPath, RECURSOS_COLUMNS_REQUISITADOS, matrix);

  log.info(`=== Tabela "Recursos Utilizados" (materiais indiretos) salva em CSV: ${csvPath} ===`);
  log.info(`Resumo: ${matrix.length} linha(s) x ${RECURSOS_COLUMNS_REQUISITADOS.length} colunas.`);

  return { headers, rows, objects, matrix, csvPath };
}

// Localiza a tabela "Recursos Utilizados" (2a simulação, materiais
// indiretos), extrai do DOM e atualiza a aba "Dados Simulação" (E2:M) da
// planilha "Requisitados" via updateAnalisePedidosMateriaisCustoIndiretoFromRows
// (reports.js). Equivalente a updateRecursosUtilizadosNoSheets, mas para
// esta tabela/planilha. Valores já conferidos manualmente num CSV gerado
// por saveRecursosUtilizadosMatIndireto antes de promover para gravação
// real (mesmo cuidado já tomado com as outras tabelas).
async function updateRecursosUtilizadosMatIndiretoNoSheets(page) {
  const { table } = await waitForRecursosUtilizadosTable(page);
  const { headers, rows } = await extractRecursosUtilizadosTable(table);

  log.info(
    `Tabela "Recursos Utilizados" (materiais indiretos) extraída: ${rows.length} linha(s), colunas: ${headers.join(", ")}`
  );

  await updateAnalisePedidosMateriaisCustoIndiretoFromRows(headers, rows);
}

// Confirmado ao vivo: emitir "search" em grSimulacoes navega/seleciona o
// registro cuja NOME contem searchValue (bookmark/clientRecNo mudam).
async function searchSimulationViaApi(page, simulationName) {
  log.step(`Busca de simulação via API interna: "${simulationName}"`);

  const before = await readGridState(page, "grSimulacoes");
  log.info(`Estado da grid antes da busca: ${JSON.stringify(before)}`);

  await emitGridEvent(page, "grSimulacoes", "search", {
    gridName: "grSimulacoes",
    fieldName: "NOME",
    searchValue: simulationName,
    allFields: false,
    preventDefault: false
  });

  await waitForUi(page, 3000);

  const after = await readGridState(page, "grSimulacoes");
  log.info(`Estado da grid depois da busca: ${JSON.stringify(after)}`);

  if (!after || (before && after.bookmark === before.bookmark)) {
    throw new Error(
      `A busca pela simulação "${simulationName}" não pareceu mover o registro atual — confira o nome/grid.`
    );
  }

  log.done(`Busca de simulação via API interna: "${simulationName}"`);
}

// Confirmado ao vivo: o ícone "três pontinhos" (⋮) no cabeçalho da grade
// Especificação abre um menu com "Exibir chaves" (primeiro item),
// "Duplicar registro", "Histórico de alterações", "Exportar para
// CSV/Excel/JSON/XML" e "Visualizar como relatório". Clicar em "Exibir
// chaves" adiciona uma coluna "Chave" com o ID único de cada registro
// (ex.: "249043112").
//
// IMPORTANTE (bug encontrado e corrigido ao vivo): o menu pode abrir PARA
// CIMA ou PARA BAIXO do ícone, dependendo do espaço disponível na tela —
// um delta fixo (x,y) do item "Exibir chaves" em relação ao ícone não é
// confiável (testamos e o item apareceu a -252px em vez de +10px numa
// segunda execução). Por isso, em vez de clicar por coordenada no item do
// menu, pressionamos Enter, que seleciona o primeiro item (sempre "Exibir
// chaves") independente de pra que lado o menu abriu. Só o clique no ícone
// "⋮" usa coordenada (offset relativo ao container da grade).
//
// NAO confirmado ainda: se o valor de Chave é legível via API interna —
// inspecionamos as propriedades own/prototype do grid (grEspecificacao) e
// não encontramos um array de registros/dataset exposto diretamente; a
// leitura, se vier a existir, provavelmente ainda dependeria de
// grid.field() com o argumento de tipo correto (não confirmado). Por ora
// este passo só deixa a coluna visível na tela.
async function exibirChavesEspecificacao(page) {
  log.step('Exibição da coluna "Chave" na grade Especificação');

  const box = await getSpecGridContainerBox(page, "grEspecificacao");
  const optionsX = box.x + SPEC_GRID_OFFSET_OPTIONS_MENU.x;
  const optionsY = box.y + SPEC_GRID_OFFSET_OPTIONS_MENU.y;

  log.info(`Clicando no ícone de opções (⋮) da grade Especificação (${optionsX}, ${optionsY})...`);
  await page.mouse.click(optionsX, optionsY);
  await waitForUi(page, 800);

  log.info('Pressionando Enter para selecionar o primeiro item do menu ("Exibir chaves")...');
  await page.keyboard.press("Enter");
  await waitForUi(page, 800);

  log.done('Exibição da coluna "Chave" na grade Especificação');
}

// Confirmado ao vivo: um único clique no cabeçalho da coluna "Chave" ordena
// a grade por essa coluna (aparece um ícone de seta ▾ antes do texto
// "Chave"). Só funciona depois de exibirChavesEspecificacao ter rodado
// (coluna precisa existir). Offset relativo ao container da grade, mesma
// técnica das demais coordenadas deste arquivo.
async function ordenarPorChaveEspecificacao(page) {
  log.step('Ordenação da grade Especificação pela coluna "Chave"');

  const box = await getSpecGridContainerBox(page, "grEspecificacao");
  const chaveHeaderX = box.x + SPEC_GRID_OFFSET_CHAVE_HEADER.x;
  const chaveHeaderY = box.y + SPEC_GRID_OFFSET_CHAVE_HEADER.y;

  log.info(`Clicando uma vez no cabeçalho "Chave" (${chaveHeaderX}, ${chaveHeaderY})...`);
  await page.mouse.click(chaveHeaderX, chaveHeaderY);
  await waitForUi(page, 800);

  log.done('Ordenação da grade Especificação pela coluna "Chave"');
}

// Le grid.selectedRecords de forma defensiva: ao vivo essa propriedade
// serializou como "{}" via JSON.stringify mesmo com 1 linha marcada, porque
// o valor real provavelmente e um Set/Map/objeto com campos privados (nao um
// objeto plano). Tenta varias formas de desempacotar antes de desistir.
async function readSelectedBookmarks(page, gridName) {
  const frame = await waitForErpFrame(page);
  return frame.evaluate((gridName) => {
    const process = window.Environment.getInstance().currentProcess;
    const grid = process.getGrid(gridName);
    const raw = grid.selectedRecords;

    if (raw == null) {
      return [];
    }
    if (Array.isArray(raw)) {
      return raw;
    }
    if (raw instanceof Map) {
      return Array.from(raw.keys());
    }
    if (raw instanceof Set) {
      return Array.from(raw);
    }
    if (typeof raw[Symbol.iterator] === "function") {
      try {
        return Array.from(raw);
      } catch (_) {
        // cai para as tentativas seguintes
      }
    }
    const keys = Object.keys(raw);
    if (keys.length > 0) {
      return keys;
    }
    return [];
  }, gridName);
}

// Diagnostico: descreve o formato real de grid.selectedRecords e de
// grid.allSelected, para investigar caso a leitura acima volte vazia.
async function debugSelectionShape(page, gridName) {
  const frame = await waitForErpFrame(page);
  return frame.evaluate((gridName) => {
    const process = window.Environment.getInstance().currentProcess;
    const grid = process.getGrid(gridName);
    const raw = grid.selectedRecords;
    return {
      allSelected: grid.allSelected,
      recordCount: grid.recordCount,
      selectedRecordsType: typeof raw,
      selectedRecordsConstructor: raw?.constructor?.name ?? null,
      selectedRecordsSize: raw?.size ?? null,
      selectedRecordsLength: raw?.length ?? null,
      selectedRecordsOwnKeys: raw && typeof raw === "object" ? Object.keys(raw) : null
    };
  }, gridName);
}

// Aguarda em polling (em vez de espera fixa) ate que `readSelectedBookmarks`
// retorne pelo menos `minCount` itens, ou esgotar o timeout.
async function waitForSelectedBookmarks(page, gridName, minCount, options = {}) {
  const { timeoutMs = 15000, pollMs = 600 } = options;
  const startedAt = Date.now();
  let bookmarks = [];

  while (Date.now() - startedAt < timeoutMs) {
    bookmarks = await readSelectedBookmarks(page, gridName);
    if (bookmarks.length >= minCount) {
      return bookmarks;
    }
    await page.waitForTimeout(pollMs);
  }

  return bookmarks;
}

// Marca TODAS as linhas da grade Especificação e desmarca apenas as
// primeiras `count` (na ordem visual atual) — resultado final: as `count`
// primeiras desmarcadas, todas as outras marcadas.
//
// BUG CONFIRMADO AO VIVO: depois de ordenar a grade por uma coluna (ex.:
// ordenarPorChaveEspecificacao), grid.emit('recordSelect', {bookmark, ...})
// NÃO TEM EFEITO ALGUM — nem mesmo navegando antes para o bookmark via
// recordChange. Testado repetidas vezes (allSelect continuava com 113/113
// marcadas mesmo após emitir recordSelect nos bookmarks corretos). Só o
// CLIQUE FÍSICO real no checkbox da linha funciona nesse estado. Por isso
// esta função usa page.mouse.click nas `count` primeiras linhas (offset
// relativo ao container da grade + altura de linha), em vez de
// emit('recordSelect'). Mantém allSelect no início só para deixar tudo
// marcado antes de desmarcar as `count` primeiras.
async function selectFirstSpecificationRows(page, count = SPEC_ROWS_TO_CHECK) {
  log.step(`Marcação de todas as linhas, exceto as primeiras ${count}, da grade Especificação`);

  log.info("Focando a grade Especificação antes de marcar tudo...");
  await emitGridEvent(page, "grEspecificacao", "focus", { gridName: "grEspecificacao" }).catch(() => {});
  await waitForUi(page, 500);

  log.info("Marcando todas as linhas (allSelect)...");
  await emitGridEvent(page, "grEspecificacao", "allSelect", {
    gridName: "grEspecificacao",
    preventDefault: false
  });

  const allBookmarks = await waitForSelectedBookmarks(page, "grEspecificacao", count, {
    timeoutMs: 15000
  });
  log.info(`Total de linhas marcadas após allSelect: ${allBookmarks.length}`);

  if (allBookmarks.length < count) {
    const shape = await debugSelectionShape(page, "grEspecificacao").catch((e) => String(e));
    log.warn(`Diagnóstico de grid.selectedRecords: ${JSON.stringify(shape)}`);
    throw new Error(
      `Esperava pelo menos ${count} linhas marcadas após allSelect, mas encontrei ${allBookmarks.length}.`
    );
  }

  log.info(`Desmarcando as primeiras ${count} linhas via clique físico no checkbox...`);
  const box = await getSpecGridContainerBox(page, "grEspecificacao");

  for (let i = 0; i < count; i += 1) {
    const clickX = box.x + SPEC_GRID_OFFSET_FIRST_ROW_CHECKBOX.x;
    const clickY = box.y + SPEC_GRID_OFFSET_FIRST_ROW_CHECKBOX.y + i * SPEC_GRID_ROW_HEIGHT;
    log.info(`Linha ${i + 1}/${count}: clicando no checkbox (${clickX}, ${clickY})...`);
    await page.mouse.click(clickX, clickY);
    await waitForUi(page, 500);
  }

  const finalBookmarks = await readSelectedBookmarks(page, "grEspecificacao");
  log.info(`Linhas marcadas no final: ${finalBookmarks.length}`);

  log.done(`Marcação de todas as linhas, exceto as primeiras ${count}, da grade Especificação`);
  return finalBookmarks;
}

// Clica no botão "−" do cabeçalho da grade Especificação para EXCLUIR os
// registros atualmente MARCADOS, e confirma "Sim" no diálogo que pergunta
// "Tem certeza que deseja excluir os N registros selecionados?". Ação
// REAL e IRREVERSÍVEL — só deve ser chamada quando a seleção atual (ver
// selectFirstSpecificationRows) já reflete exatamente o que deve ser
// excluído. Confirmado ao vivo: exclui as linhas marcadas, mantendo
// intactas as que estavam desmarcadas.
async function excluirLinhasMarcadasEspecificacao(page) {
  log.step("Exclusão das linhas marcadas da grade Especificação");

  const box = await getSpecGridContainerBox(page, "grEspecificacao");
  const deleteX = box.x + SPEC_GRID_OFFSET_DELETE_BUTTON.x;
  const deleteY = box.y + SPEC_GRID_OFFSET_DELETE_BUTTON.y;

  log.info(`Clicando no botão "−" (${deleteX}, ${deleteY})...`);
  await page.mouse.click(deleteX, deleteY);
  await waitForUi(page, 1000);

  log.info('Confirmando exclusão (botão "Sim")...');
  await page.locator('button[aria-label="Sim"]').click();
  await waitForUi(page, 1500);

  const state = await readGridState(page, "grEspecificacao");
  log.info(`Estado da grade Especificação após exclusão: ${JSON.stringify(state)}`);

  log.done("Exclusão das linhas marcadas da grade Especificação");
}

// Tenta ler o valor de um campo do registro ATUAL usando grid.field(nome).
// Retorna null se nenhum dos nomes candidatos existir/responder — nesse caso
// o chamador deve pular a linha em vez de arriscar um clique sem saber o
// estado real do campo.
async function readFieldValue(page, gridName, fieldCandidates) {
  const frame = await waitForErpFrame(page);
  return frame.evaluate(
    ({ gridName, fieldCandidates }) => {
      const process = window.Environment.getInstance().currentProcess;
      const grid = process.getGrid(gridName);

      for (const name of fieldCandidates) {
        try {
          const field = grid.field(name);
          if (field) {
            return {
              fieldName: name,
              value: field.value ?? field.pendingValue ?? null
            };
          }
        } catch (_) {
          // tenta o proximo candidato
        }
      }
      return null;
    },
    { gridName, fieldCandidates }
  );
}

// Move o cursor da grade para o registro identificado por `bookmark` antes de
// ler/editar seus campos (recordSelect move o cursor mas o objetivo aqui e
// reaproveitar o mesmo evento so para navegacao, sem alterar a selecao —
// ainda assim ele alterna o checkbox, entao isso so deve ser chamado para
// linhas que ja sabemos estar marcadas, mantendo o estado final consistente).
async function focusGridRecord(page, gridName, bookmark) {
  const frame = await waitForErpFrame(page);
  await frame.evaluate(
    ({ gridName, bookmark }) => {
      const process = window.Environment.getInstance().currentProcess;
      const grid = process.getGrid(gridName);
      if (typeof grid.focus === "function") {
        grid.focus();
      }
      grid.emit("recordChange", { gridName, bookmark, preventDefault: false });
    },
    { gridName, bookmark }
  );
  await waitForUi(page, 400);
}

// NAO VALIDADO AO VIVO: usa grid.focusField (visto na lista de metodos do
// prototype) para tentar focar o campo programaticamente, evitando cliques
// por coordenada de pixel (frageis e, no caso de celulas ja preenchidas,
// arriscados — ao vivo um clique direto na celula de data limpou o valor
// visualmente até cancelarmos a edição).
async function fillFieldWithToken(page, gridName, fieldName, token) {
  const frame = await waitForErpFrame(page);

  const focused = await frame
    .evaluate(
      ({ gridName, fieldName }) => {
        const process = window.Environment.getInstance().currentProcess;
        const grid = process.getGrid(gridName);
        if (typeof grid.focusField === "function") {
          grid.focusField(fieldName);
          return true;
        }
        return false;
      },
      { gridName, fieldName }
    )
    .catch(() => false);

  if (!focused) {
    throw new Error(
      `Não foi possível focar o campo "${fieldName}" via grid.focusField — função indisponível ou falhou.`
    );
  }

  await waitForUi(page, 500);
  await page.keyboard.type(token);
  await page.keyboard.press("Tab");
  await waitForUi(page, 800);
}

// Para cada uma das primeiras `count` linhas da grade Especificação: navega
// até ela, tenta ler "Prev. Emissão Doc." e "Hora" via API interna e, SE E
// SOMENTE SE confirmado vazio, preenche com "h" (token que o Innovaro expande
// para a data/hora atual) e pressiona Tab. Se a leitura via API falhar (nome
// de campo não confirmado), pula a linha com aviso em vez de clicar "no
// escuro".
async function fillMissingDateAndHour(page, bookmarks) {
  log.step(`Verificação/preenchimento de Prev. Emissão Doc. e Hora (${bookmarks.length} linhas)`);

  for (let i = 0; i < bookmarks.length; i += 1) {
    const bookmark = bookmarks[i];
    log.info(`Linha ${i + 1}/${bookmarks.length} (bookmark ${bookmark})`);

    await focusGridRecord(page, "grEspecificacao", bookmark);

    const dateField = await readFieldValue(page, "grEspecificacao", DATE_FIELD_CANDIDATES);
    const hourField = await readFieldValue(page, "grEspecificacao", HOUR_FIELD_CANDIDATES);

    if (!dateField && !hourField) {
      log.warn(
        `Linha ${i + 1}: nenhum nome de campo candidato respondeu via grid.field(). ` +
          "Pulando esta linha sem clicar — confirme o nome real do campo antes de habilitar o preenchimento automático."
      );
      continue;
    }

    if (dateField) {
      log.info(`Linha ${i + 1}: campo "${dateField.fieldName}" = "${dateField.value}"`);
      if (!dateField.value) {
        log.info(`Linha ${i + 1}: data vazia — preenchendo com "${HOUR_TOKEN}"...`);
        await fillFieldWithToken(page, "grEspecificacao", dateField.fieldName, HOUR_TOKEN);
      } else {
        log.info(`Linha ${i + 1}: data já preenchida — nada a fazer.`);
      }
    } else {
      log.warn(`Linha ${i + 1}: nenhum candidato de campo de data respondeu — pulando data desta linha.`);
    }

    if (hourField) {
      log.info(`Linha ${i + 1}: campo "${hourField.fieldName}" = "${hourField.value}"`);
      if (!hourField.value) {
        log.info(`Linha ${i + 1}: hora vazia — preenchendo com "${HOUR_TOKEN}"...`);
        await fillFieldWithToken(page, "grEspecificacao", hourField.fieldName, HOUR_TOKEN);
      } else {
        log.info(`Linha ${i + 1}: hora já preenchida — nada a fazer.`);
      }
    } else {
      log.warn(`Linha ${i + 1}: nenhum candidato de campo de hora respondeu — pulando hora desta linha.`);
    }
  }

  log.done(`Verificação/preenchimento de Prev. Emissão Doc. e Hora (${bookmarks.length} linhas)`);
}

// Lê o texto realmente exibido/selecionado na célula com foco atual via
// window.getSelection() do DOCUMENTO do iframe (não do shadow). Descoberta
// chave confirmada ao vivo: clicar ou dar Tab para uma célula da grade
// Especificação SELECIONA o texto existente (igual um input normal), e essa
// seleção É visível para getSelection() mesmo que a grade em si seja
// renderizada em Shadow DOM fechado/canvas — getSelection() opera no nível
// do documento, por fora do encapsulamento do shadow. Célula vazia retorna
// string vazia; célula preenchida retorna o valor exato (ex.: "01/01/2026",
// "07:00"). Isso resolve o problema de não conseguir ler grid.field()
// (que só expõe metadado da coluna, nunca o valor da célula atual).
async function readFocusedCellSelectionText(page) {
  const frame = await waitForErpFrame(page);
  return frame.evaluate(() => window.getSelection().toString());
}

// Lê nome/label do campo (coluna) atualmente focado, via
// grid.currentField — útil só para diagnóstico/log.
async function readCurrentFieldInfo(page, gridName) {
  const frame = await waitForErpFrame(page);
  return frame.evaluate((gridName) => {
    const process = window.Environment.getInstance().currentProcess;
    const grid = process.getGrid(gridName);
    const cf = grid.currentField;
    return cf ? { name: cf.name, label: cf.label } : null;
  }, gridName);
}

// Preenche "Prev. Emissão Doc."/"Hora" das linhas pendentes da grade
// Especificação (resultado da busca de Pendência de Pedidos).
//
// HISTÓRICO: já vimos esta mesma grid (grEspecificacao) se comportar de
// duas formas diferentes dependendo do contexto/dataset — em um, editar uma
// linha a reordena automaticamente para fora do topo; em outro (confirmado
// numa execução REAL do fluxo completo), a linha editada permanece parada
// na posição 1. Tentar adivinhar qual comportamento vai ocorrer (ex.:
// avançar a coordenada Y em SPEC_GRID_ROW_HEIGHT por iteração) é frágil.
//
// SOLUÇÃO ATUAL (confirmada ao vivo via MCP): em vez de adivinhar a
// posição, cada iteração clica primeiro no ícone "⌃" da toolbar da grade
// (SPEC_GRID_OFFSET_FIRST_RECORD_BUTTON) — botão real "ir para o primeiro
// registro" (clicar nele mudou o indicador de "7 de 123" para "1 de 123" e
// focou a 1a linha) — e só então lê/edita a linha 1. Isso funciona nos dois
// cenários: se a grade reordena após editar, a próxima linha pendente sobe
// para o topo e o botão simplesmente confirma que já estamos lá; se a grade
// NÃO reordena, o botão garante que voltamos à linha 1 (a mesma que acabamos
// de preencher) para then detectar que ela já está preenchida e parar.
//
// Em cada iteração, LÊ o valor real via window.getSelection() (ver
// readFocusedCellSelectionText — funciona mesmo a grade sendo Shadow DOM
// fechado/canvas) e só digita "h" na célula que estiver vazia; campo já
// preenchido NÃO é alterado. Para quando a linha do topo já tem AMBOS os
// campos preenchidos — sinal de que chegamos ao fim das linhas pendentes
// (vêm agrupadas no topo, conforme confirmado nesta simulação).
async function fillFirstEmptySpecificationRowsLoop(page, maxIterations = SPEC_FILL_MAX_ITERATIONS) {
  const initialState = await waitForGridAvailable(page, "grEspecificacao", {
    timeoutMs: 20000,
    minRecordCount: 1
  });
  const effectiveMax = maxIterations || initialState.recordCount;

  log.step(
    `Preenchimento em loop de Prev. Emissão Doc./Hora (até ${effectiveMax} linhas, ` +
      `recordCount=${initialState.recordCount})`
  );

  let filledCount = 0;
  let stoppedReason = "atingiu maxIterations";

  for (let i = 0; i < effectiveMax; i += 1) {
    const box = await getSpecGridContainerBox(page, "grEspecificacao");

    const firstRecordX = box.x + SPEC_GRID_OFFSET_FIRST_RECORD_BUTTON.x;
    const firstRecordY = box.y + SPEC_GRID_OFFSET_FIRST_RECORD_BUTTON.y;
    log.info(
      `Iteração ${i + 1}/${effectiveMax}: clicando em "ir para o primeiro registro" (${firstRecordX}, ${firstRecordY})...`
    );
    await page.mouse.click(firstRecordX, firstRecordY);
    await waitForUi(page, 600);

    const clickX = box.x + SPEC_GRID_OFFSET_FIRST_ROW_PREV_EMISSAO.x;
    const clickY = box.y + SPEC_GRID_OFFSET_FIRST_ROW_PREV_EMISSAO.y;

    log.info(
      `Iteração ${i + 1}/${effectiveMax}: clicando em "Prev. Emissão Doc." da linha 1 (${clickX}, ${clickY})...`
    );
    await page.mouse.click(clickX, clickY);
    await waitForUi(page, 600);

    // Lê AMBOS os campos antes de digitar qualquer coisa, para decidir se
    // deve parar sem alterar nada (evita preencher um campo e só depois
    // descobrir que deveria ter parado).
    const prevEmissaoInfo = await readCurrentFieldInfo(page, "grEspecificacao");
    const prevEmissaoText = await readFocusedCellSelectionText(page);
    const prevEmissaoEmpty = prevEmissaoText.trim() === "";

    log.info(
      `Iteração ${i + 1}: campo "${prevEmissaoInfo?.label ?? "?"}" = "${prevEmissaoText}" ` +
        `(${prevEmissaoEmpty ? "vazio" : "preenchido"})`
    );

    await page.keyboard.press("Tab");
    await waitForUi(page, 500);

    const horaInfo = await readCurrentFieldInfo(page, "grEspecificacao");
    const horaText = await readFocusedCellSelectionText(page);
    const horaEmpty = horaText.trim() === "";

    log.info(
      `Iteração ${i + 1}: campo "${horaInfo?.label ?? "?"}" = "${horaText}" ` +
        `(${horaEmpty ? "vazio" : "preenchido"})`
    );

    if (!prevEmissaoEmpty && !horaEmpty) {
      stoppedReason = `linha no topo já estava com Prev. Emissão Doc. e Hora preenchidas (iteração ${i + 1})`;
      log.info(`Parando sem alterar nada: ${stoppedReason}.`);
      break;
    }

    // Foco está em "Hora" agora — preenche-a primeiro se vazia.
    if (horaEmpty) {
      await page.keyboard.type(HOUR_TOKEN);
      await waitForUi(page, 400);
    }

    // Volta para "Prev. Emissão Doc." (Shift+Tab) só se ela estava vazia, e
    // confirma com Tab antes do próximo clique (evita deixar valor digitado
    // sem confirmar, que poderia ser descartado pelo clique da próxima
    // iteração).
    if (prevEmissaoEmpty) {
      await page.keyboard.press("Shift+Tab");
      await waitForUi(page, 400);
      await page.keyboard.type(HOUR_TOKEN);
      await waitForUi(page, 400);
      await page.keyboard.press("Tab");
      await waitForUi(page, 400);
    }

    // Confirma a edição da linha: em vez de Enter, dá 7 Tabs para sair de
    // fato dos campos editados e comitar o valor digitado antes da próxima
    // iteração clicar na seta para cima novamente.
    for (let tabIndex = 0; tabIndex < 7; tabIndex += 1) {
      await page.keyboard.press("Tab");
      await waitForUi(page, 400);
    }

    filledCount += 1;
  }

  log.done(
    `Preenchimento em loop de Prev. Emissão Doc./Hora: ${filledCount} linha(s) preenchida(s) ` +
      `(parou: ${stoppedReason}).`
  );
}

// Confirmado ao vivo: o botão "Explodir" (toolbar superior, fora do
// iframe/grid, acessível via accessibility tree normal) dispara um
// pipeline assíncrono com VÁRIOS estágios sequenciais de duração variável,
// cada um mostrando um diálogo modal diferente — alguns com % (ex.:
// "Explodindo...: <recurso>", "Gravando...: <código>"), outros só com texto
// (ex.: "Consumindo saldos e gerando agendamentos...",
// "Gerando chaves do Balanceamento..."). A lista e a ordem exatos podem
// variar, e a duração total observada numa execução real foi de vários
// minutos. Por isso NÃO se usa waitForUi/timeout fixo: faz-se polling até
// aparecer o diálogo final "Explosão executada com sucesso!" (com botão
// "Fechar"), logando o texto do diálogo intermediário sempre que ele mudar
// (só para visibilidade/diagnóstico — não é usado para decidir quando
// parar).
async function explodirSimulacao(page, options = {}) {
  const { timeoutMs = 600000, pollMs = 1500 } = options;
  log.step("Explosão da simulação");

  log.info('Clicando no botão "Explodir"...');
  await page.getByRole("button").filter({ hasText: "Explodir" }).click();
  await waitForUi(page, 800);

  const successDialog = page
    .getByRole("dialog")
    .filter({ hasText: "Explosão executada com sucesso" });

  let lastOverlayText = null;
  const startedAt = Date.now();
  let succeeded = false;

  while (Date.now() - startedAt < timeoutMs) {
    if (await successDialog.isVisible().catch(() => false)) {
      succeeded = true;
      break;
    }

    const overlayText = await page
      .getByRole("dialog")
      .first()
      .innerText()
      .catch(() => null);

    if (overlayText && overlayText !== lastOverlayText) {
      log.info(`Explosão em andamento: "${overlayText.trim().replace(/\s+/g, " ")}"`);
      lastOverlayText = overlayText;
    }

    await page.waitForTimeout(pollMs);
  }

  if (!succeeded) {
    throw new Error(
      `Explosão não concluiu (diálogo "Explosão executada com sucesso!" não apareceu) após ${timeoutMs}ms.`
    );
  }

  log.info('Explosão concluída — clicando em "Fechar"...');
  await successDialog.getByRole("button", { name: "Fechar" }).click();
  await waitForUi(page, 1000);

  log.done("Explosão da simulação");
}

async function captureArtifacts(page, stepName) {
  const safeStepName = stepName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const outputDir = path.join(process.cwd(), "output", "playwright");
  const filePath = path.join(outputDir, `${Date.now()}-${safeStepName}.png`);

  await fs.mkdir(outputDir, { recursive: true });
  await page.screenshot({ path: filePath, fullPage: true });
  log.info(`Screenshot salvo: ${path.basename(filePath)}`);
}

async function runInnovaroAutomationV2() {
  log.info("=== Iniciando automação Innovaro (v2 — API interna) ===");
  log.info(`Log salvo em: ${log.getLogFilePath()}`);

  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    slowMo: SLOW_MO_MS
  });

  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 }
  });

  const page = await context.newPage();

  try {
    await login(page);
    await captureArtifacts(page, "apos-login");

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

    // fillPendenciaFilters já espera (waitForGridAvailable) a tela carregar
    // e voltar para a grade Especificação após submeter o formulário.
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

    await navigateToSaldosDeRecursos(page);
    await captureArtifacts(page, "saldos-recursos-aberta");

    await executarSaldosDeRecursos(page);
    await captureArtifacts(page, "saldos-recursos-executada");

    await updateSaldoRecursosNoSheets(page);
    await captureArtifacts(page, "saldos-recursos-atualizado-no-sheets");

    await navigateToAnalisePedidosPendentes(page);
    await captureArtifacts(page, "analise-pedidos-pendentes-aberta");

    await executarAnalisePedidosPendentes(page);
    await captureArtifacts(page, "analise-pedidos-pendentes-executada");

    await updateAnalisePedidosPendentesNoSheets(page);
    await captureArtifacts(page, "analise-pedidos-pendentes-atualizado-no-sheets");

    // Navegação via menu (Produção > Plano mestre e simulação) de volta
    // para a tela inicial, preparando o terreno para a 2a simulação
    // (materiais indiretos, abaixo). Usa voltarParaPlanoMestre (adaptativa:
    // tenta ir direto na folha e só refaz os 2 níveis de acordeão via
    // navigateToProducaoPlanoMestre se o menu abrir "frio" — ver comentário
    // na função) em vez de chamar navigateToProducaoPlanoMestre direto,
    // porque a essa altura o menu às vezes já chega expandido o suficiente
    // para revelar "Plano mestre e simulação" direto a partir de "Produção".
    await voltarParaPlanoMestre(page);
    await captureArtifacts(page, "voltou-para-plano-mestre");

    // 2a simulação (materiais indiretos): mesma tela/grid grSimulacoes já
    // usada para a 1a simulação, por isso reaproveita searchSimulationViaApi
    // (grid.emit('search', ...), já provada) em vez de reinventar a
    // interação de busca. explodirSimulacao também é reaproveitada — já
    // sabe fazer polling do pipeline de explosão (vários estágios, diálogos
    // intermediários com %) até "Explosão executada com sucesso!".
    await searchSimulationViaApi(page, SIMULATION_MAT_IND_NAME);
    await captureArtifacts(page, "segunda-simulacao-selecionada");

    await explodirSimulacao(page);
    await captureArtifacts(page, "segunda-simulacao-explodida");

    // Mesma tela do relatório da 1a simulação, reaproveitada com outro
    // nome de simulação via options.simulationName (já previsto em
    // fillRelatorioLogisticaFilters especificamente para este caso — ver
    // comentário na função).
    await navigateToRelatorioLogisticaCompras(page);
    await captureArtifacts(page, "segundo-relatorio-logistica-aberto");

    await fillRelatorioLogisticaFilters(page, { simulationName: SIMULATION_MAT_IND_NAME });
    await captureArtifacts(page, "segundo-relatorio-logistica-filtros-preenchidos");

    // Mesma tabela "Recursos Utilizados" já usada na 1a simulação (ver
    // waitForRecursosUtilizadosTable/extractRecursosUtilizadosTable), mas
    // com o conjunto de colunas da planilha "Requisitados" — grava direto
    // na aba "Dados Simulação" (E2:M) dessa planilha.
    await updateRecursosUtilizadosMatIndiretoNoSheets(page);
    await captureArtifacts(page, "recursos-utilizados-mat-indireto-atualizado-no-sheets");

    log.info(
      "=== Automação (v2) concluída até salvar a tabela Recursos Utilizados (2a simulação, materiais indiretos) ==="
    );
  } catch (err) {
    log.error(`Erro durante a automação (v2): ${err.message}`);
    await captureArtifacts(page, "erro-fatal-v2").catch(() => {});
    throw err;
  } finally {
    log.info("Fechando o navegador...");
    await browser.close().catch((closeErr) => {
      log.warn(`Falha ao fechar o navegador: ${closeErr.message}`);
    });
  }
}

module.exports = {
  // Orquestrador principal: login -> menu -> busca da simulação -> exibir
  // chaves. As etapas seguintes (Pendência de Pedidos em diante) já estão
  // implementadas mas comentadas dentro desta função (ver código).
  runInnovaroAutomationV2,

  // Tira um screenshot em output/playwright/<timestamp>-<stepName>.png.
  // Exportada para reaproveitar em orquestradores alternativos (ex.:
  // run-stage.js) sem duplicar a lógica de nome de arquivo/pasta.
  captureArtifacts,

  // Login isolado (preenche usuário/senha e espera o botão "Menu"
  // aparecer). Exportado para permitir testar passos individuais do fluxo
  // sem rodar a automação inteira (ex.: num script Node avulso).
  login,

  // Navegação inicial (Produção > "Plano mestre e simulação (MPS)" >
  // Plano mestre e simulação, com os 2 níveis completos de acordeão).
  // Exportada para permitir reproduzir, num script de teste isolado, o
  // mesmo estado de menu "já visitado" que voltarParaPlanoMestre encontra
  // no fim do fluxo real.
  navigateToProducaoPlanoMestre,

  // Navegação final (Produção > Plano mestre e simulação, 1 clique só, na
  // folha) usada no fim do fluxo principal, quando o menu já chega
  // expandido o suficiente para revelar a folha direto, sem precisar
  // clicar em "Produção". Diferente de navigateToProducaoPlanoMestre
  // (usada no início, com os 2 níveis completos de acordeão).
  voltarParaPlanoMestre,

  // Busca/seleciona uma simulação na grade grSimulacoes via API interna
  // (grid.emit('search', ...)). Confirma sucesso comparando o bookmark
  // antes/depois da busca.
  searchSimulationViaApi,

  // Clica no ícone "⋮" (três pontinhos) do cabeçalho da grade Especificação
  // (offset relativo ao container, via getSpecGridContainerBox) e pressiona
  // Enter para selecionar "Exibir chaves" (primeiro item do menu), que
  // adiciona a coluna "Chave" (ID único de cada registro) na grade. Usa
  // Enter em vez de clique no item do menu porque o menu pode abrir pra
  // cima ou pra baixo do ícone dependendo do espaço na tela.
  exibirChavesEspecificacao,

  // Clica uma vez no cabeçalho da coluna "Chave" da grade Especificação
  // para ordenar por ela. Só funciona depois de exibirChavesEspecificacao.
  ordenarPorChaveEspecificacao,

  // Clica no botão "Pendência de Pedidos" da toolbar (visível com uma
  // simulação selecionada) e espera a tela "Executa Busca de Pedidos"
  // (formulário grFiltroDePedidos) carregar.
  openPendenciaDePedidos,

  // Abre o menu principal e navega Compra > Consultas > "Análise de
  // Pedidos Pendentes ou Baixados - CEMAG" (equivalente ao
  // listar_menu_click do fluxo antigo, main_copy.py linhas 849-853).
  // Chamada no fluxo principal logo após updateRecursosUtilizadosNoSheets.
  navigateToAnalisePedidosPendentes,

  // Abre o menu principal e navega Estoque > Consultas > "Saldos de
  // Recursos - CEMAG" (equivalente ao listar_menu_click do fluxo antigo,
  // ver PASSO_A_PASSO_AUTOMACAO.md passo 10). Chamada no fluxo principal
  // logo após updateRecursosUtilizadosNoSheets (validada isoladamente
  // antes, ver test-navigate-saldos-recursos.js).
  navigateToSaldosDeRecursos,

  // Clica no botão "Executar" da tela "Saldos de Recursos - CEMAG" e
  // aguarda o diálogo de progresso finalizar (waitForAnalisePedidosReportReady).
  // Chamada no fluxo principal logo após navigateToSaldosDeRecursos.
  executarSaldosDeRecursos,

  // Mesmo padrão de findRecursosUtilizadosTableLocator/
  // waitForRecursosUtilizadosTable, escopado para o título "Saldos de
  // Recursos - CEMAG".
  findSaldosDeRecursosTableLocator,
  waitForSaldosDeRecursosTable,

  // Extrai a tabela "Saldos de Recursos - CEMAG" do DOM. Um só nível de
  // agrupamento (o Recurso, exibido como linha tr.sl-g-ln, não coluna) —
  // a extração cola o Recurso na frente das 12 colunas de cada linha de
  // detalhe (tr.sl-r) e pula linhas de total por recurso (tr.sl-g-ln-t).
  extractSaldosDeRecursosTable,

  // Depuração: extrai + aplica o tratamento (numérico + seleção de
  // colunas) e só salva em CSV/loga um resumo — NÃO grava no Sheets. Os
  // valores já foram conferidos manualmente (cabeçalho real de "Est.
  // Produção"!N3:U bate com SALDOS_COLUMNS), por isso o fluxo principal
  // usa updateSaldoRecursosNoSheets diretamente; esta função continua
  // disponível para depuração pontual.
  logSaldoRecursosTable,

  // Localiza a tabela, extrai do DOM e atualiza a aba "Est. Produção"
  // (N3:U) via updateSaldoRecursosFromRows (reports.js). Chamada no fluxo
  // principal logo após executarSaldosDeRecursos.
  updateSaldoRecursosNoSheets,

  // Clica no botão "Executar" da tela "Análise de Pedidos Pendentes ou
  // Baixados - CEMAG" (localizado por texto, sem nome acessível próprio —
  // mesmo padrão do botão "Explodir") e aguarda a barra de progresso
  // dinâmica (waitForProcessViewLoading) finalizar. Chamada no fluxo
  // principal logo após navigateToAnalisePedidosPendentes. Aguarda
  // waitForAnalisePedidosReportReady antes de retornar.
  executarAnalisePedidosPendentes,

  // Faz polling do diálogo modal de progresso ("Escrevendo relatório...",
  // com %) que aparece após clicar em "Executar" na tela "Análise de
  // Pedidos Pendentes ou Baixados - CEMAG", até ele deixar de estar
  // visível — sem diálogo final de "sucesso" conhecido, diferente de
  // explodirSimulacao. Usada por executarAnalisePedidosPendentes.
  waitForAnalisePedidosReportReady,

  // Mesmo padrão de findRecursosUtilizadosTableLocator/
  // waitForRecursosUtilizadosTable, escopado para o título "Análise de
  // Pedidos Pendentes ou Baixados - CEMAG".
  findAnalisePedidosPendentesTableLocator,
  waitForAnalisePedidosPendentesTable,

  // Extrai a tabela "Análise de Pedidos Pendentes ou Baixados - CEMAG" do
  // DOM. Diferente de extractRecursosUtilizadosTable (tabela plana), esta
  // tabela é agrupada em 5 níveis (Região/Estado/Pessoa/Classe
  // Recurso/Data Entrega, exibidos como linhas tr.sl-g-ln, não colunas) —
  // a extração reconstitui o formato achatado (grupo + 26 colunas por
  // linha) que reports.js já sabe gravar, colando o "grupo atual" na
  // frente de cada linha de dado (tr.sl-r) e pulando linhas de
  // total/subtotal (tr.sl-g-ln-t).
  extractAnalisePedidosPendentesTable,

  // Depuração: extrai + aplica o tratamento (numérico + seleção de
  // colunas) e só salva em CSV/loga um resumo — NÃO grava no Sheets. Os
  // valores já foram conferidos manualmente num CSV gerado por esta função
  // (grupos reconstituídos e números convertidos corretos), por isso o
  // fluxo principal agora usa updateAnalisePedidosPendentesNoSheets
  // diretamente; esta função continua disponível para depuração pontual.
  logAnalisePedidosPendentesTable,

  // Localiza a tabela, extrai do DOM e atualiza a aba "Dados Pedidos" da
  // planilha DEE via updateAnalisePedidosPendentesFromRows (reports.js).
  // Chamada no fluxo principal logo após executarAnalisePedidosPendentes.
  updateAnalisePedidosPendentesNoSheets,

  // Abre o menu principal, entra em "Produção" e clica em
  // "Relatório de Logística de Compras da Simulação", aguardando a tela do
  // formulário carregar.
  navigateToRelatorioLogisticaCompras,

  // Preenche os 19 campos do formulário "Restrições de busca pendência"
  // navegando via Tab (ordem: linha por linha, esquerda -> direita).
  // Campos sem valor configurado são apagados e deixados vazios; campos
  // com valor (Classe do Recurso, Classe do pedido com hierarquia, Emissão
  // inicial) são apagados e redigitados. No último campo, pressiona Enter
  // para submeter o formulário (equivalente a "Executa Busca de Pedidos").
  fillPendenciaFilters,

  // Preenche os 4 campos calculáveis do formulário "Relatório de
  // Logística de Compras da Simulação" digitando e confirmando cada valor
  // apenas com Tab: Simulação, Classe de Explosão, Classes de Depósitos e
  // Classes de Recursos. No último campo (Classes de Recursos), pressiona
  // Enter 5x em vez de Tab para carregar o relatório, e em seguida aguarda
  // a barra de progresso dinâmica (waitForProcessViewLoading) finalizar.
  fillRelatorioLogisticaFilters,

  // Espera a barra de progresso indeterminada do ERP
  // (".wf-process-view__working") aparecer (perder a classe
  // "mdc-linear-progress--closed") e depois desaparecer (recuperar essa
  // classe), sinalizando o fim de um carregamento dinâmico (ex.: geração de
  // relatório). Se ela não aparecer dentro do prazo, assume resposta rápida
  // e segue sem erro.
  waitForProcessViewLoading,

  // Confirmado ao vivo: "Recursos Utilizados" é uma tabela HTML simples
  // (table.sl-rootTable), não uma grid da API interna. BUG CONFIRMADO E
  // CORRIGIDO: existe mais de um table.sl-rootTable na página — a busca
  // antiga (texto livre + querySelector global) pegava a tabela errada
  // ("416 linhas", colunas "Código, Descrição"). Agora usa um Locator
  // escopado (findRecursosUtilizadosTableLocator): table.sl-rootTable cujo
  // descendente td.sl-title tem o texto exato "Recursos Utilizados", e
  // espera tbody.sl-content > tr.sl-r DESSA tabela aparecerem. Chamada no
  // fluxo principal logo depois do relatório carregar
  // (fillRelatorioLogisticaFilters + waitForProcessViewLoading).
  waitForRecursosUtilizadosTable,

  // Lê headers/linhas da tabela "Recursos Utilizados" a partir do Locator
  // já escopado retornado por waitForRecursosUtilizadosTable (mesmo formato
  // que readInnovaroCsv produz a partir do CSV exportado).
  extractRecursosUtilizadosTable,

  // Localiza a tabela, extrai do DOM e atualiza a aba "Dados Simulação" da
  // planilha "Análise Previsão de Consumo (CMM / NTP) DEE" via
  // updatePlanilhaRecursosUtilizadosFromRows (reports.js) — substitui o
  // passo de exportar/ler CSV do fluxo antigo. NÃO chamada no fluxo
  // principal agora (ver logRecursosUtilizadosTable) enquanto o bug de
  // valores zerados está em depuração.
  updateRecursosUtilizadosNoSheets,

  // TEMPORÁRIO (depuração): extrai + aplica o tratamento numérico e só
  // imprime no console (console.table/console.log) — NÃO grava no Sheets.
  // É o que o fluxo principal chama agora, no lugar de
  // updateRecursosUtilizadosNoSheets, até confirmarmos que os valores
  // numéricos (antes zerados por bug no toBrNumber) saem corretos.
  logRecursosUtilizadosTable,

  // Mesma extração da tabela "Recursos Utilizados", mas com as colunas da
  // planilha "Requisitados" (sem TRP/DEE) — usada pela 2a simulação
  // (materiais indiretos). Depuração: só salva em CSV, não grava no
  // Sheets. Os valores já foram conferidos manualmente, por isso o fluxo
  // principal usa updateRecursosUtilizadosMatIndiretoNoSheets diretamente;
  // esta função continua disponível para depuração pontual.
  saveRecursosUtilizadosMatIndireto,

  // Localiza a tabela, extrai do DOM e atualiza a aba "Dados Simulação"
  // (E2:M) da planilha "Requisitados" via
  // updateAnalisePedidosMateriaisCustoIndiretoFromRows (reports.js).
  // Chamada no fluxo principal logo após fillRelatorioLogisticaFilters
  // (2a simulação).
  updateRecursosUtilizadosMatIndiretoNoSheets,

  // Marca TODAS as linhas da grade Especificação e desmarca apenas as
  // primeiras N (na ordem visual atual) — resultado final: N primeiras
  // desmarcadas, todas as outras marcadas. Usa allSelect, depois CLIQUE
  // FÍSICO real no checkbox de cada uma das N primeiras linhas (offset
  // relativo ao container) — grid.emit('recordSelect', ...) não tem efeito
  // depois que a grade foi ordenada por uma coluna (confirmado ao vivo).
  // Chamada no fluxo principal após ordenarPorChaveEspecificacao.
  selectFirstSpecificationRows,

  // Clica no botão "−" do cabeçalho da grade Especificação para EXCLUIR os
  // registros marcados, e confirma "Sim" no diálogo de confirmação. Ação
  // REAL e IRREVERSÍVEL — chamada no fluxo principal após
  // selectFirstSpecificationRows (exclui tudo que não são as N primeiras).
  excluirLinhasMarcadasEspecificacao,

  // Para cada bookmark recebido, tenta ler "Prev. Emissão Doc." e "Hora"
  // via grid.field() (lista de nomes candidatos) e preenche com "h" só se
  // confirmado vazio. NÃO VALIDADO: grid.field() exige um argumento de tipo
  // que ainda não foi descoberto, então esta função provavelmente sempre
  // cai no fallback "nenhum candidato respondeu". Não é chamada no fluxo
  // principal atualmente.
  fillMissingDateAndHour,

  // Loop que preenche "Prev. Emissão Doc."/"Hora" da grade Especificação
  // (cenário pós-busca de Pendência de Pedidos, onde a grade reordena a
  // cada edição): repete firstRecord -> clicar na linha 1 -> digitar "h" no
  // Prev. Emissão Doc. -> Tab -> "h" na Hora, até o bookmark da linha 1 se
  // repetir (sinal indireto de que não há mais linhas vazias) ou atingir o
  // limite de iterações (default: recordCount da grid).
  fillFirstEmptySpecificationRowsLoop,

  // Clica no botão "Explodir" (toolbar superior) e aguarda em polling
  // (sem timeout fixo, já que a duração de cada estágio é dinâmica) até o
  // diálogo final "Explosão executada com sucesso!" aparecer, logando o
  // texto dos diálogos intermediários ("Explodindo...", "Gravando...",
  // "Consumindo saldos...", "Gerando chaves do Balanceamento...", etc.)
  // sempre que mudar. Clica em "Fechar" no diálogo final ao concluir.
  explodirSimulacao,

  // Helper genérico: dispara grid.emit(eventName, payload) numa grid pelo
  // nome, via window.Environment.getInstance().currentProcess.getGrid(nome).
  // Base de toda a interação programática com as grids (search,
  // recordSelect, allSelect, firstRecord, etc.).
  emitGridEvent,

  // Helper genérico: lê o estado atual de uma grid (recordCount,
  // currentRecordIndex, bookmark, clientRecNo, selectedRecords) via
  // Environment API. Usado para diagnóstico e para confirmar se uma ação
  // (search, allSelect, etc.) teve efeito.
  readGridState,

  // Helper genérico: mede a posição/tamanho absoluto (página) do container
  // real de uma grid via getBoundingClientRect (soma o offset do iframe).
  // Base dos cliques por coordenada relativa (exibirChavesEspecificacao,
  // fillFirstEmptySpecificationRowsLoop) — robusto a mudanças de
  // scroll/layout, já que mede a posição em tempo real em vez de usar
  // coordenadas absolutas fixas.
  getSpecGridContainerBox
};
