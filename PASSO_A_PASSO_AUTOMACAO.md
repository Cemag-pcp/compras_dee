# Passo a passo da automação

Este documento descreve o fluxo principal da automação implementada em `main.py`.

## Objetivo

A automação entra no Innovaro, executa simulações e consultas, baixa arquivos CSV gerados pelo sistema e atualiza abas específicas no Google Sheets.

## Pré-requisitos

1. Ter Google Chrome instalado.
2. Ter acesso ao Innovaro no endereço interno `http://192.168.3.141/sistema`.
3. Ter acesso à conta usada no Google Sheets via arquivo `service_account_cemag.json`.
4. Ter permissão para baixar arquivos CSV na pasta padrão `Downloads`.
5. Ter as bibliotecas do projeto instaladas:
   - `selenium`
   - `pandas`
   - `numpy`
   - `gspread`
   - `oauth2client`

## Resumo rápido do fluxo

1. Abre o Chrome.
2. Faz login no Innovaro.
3. Abre o menu principal.
4. Entra no módulo de Produção.
5. Abre a simulação `Pendencia Diaria Carretas Compras`.
6. Ajusta filtros e executa a simulação.
7. Preenche datas e horas pendentes na grade da simulação.
8. Executa a explosão da simulação.
9. Abre o relatório logístico da simulação.
10. Exporta o CSV de recursos utilizados.
11. Atualiza a aba `Dados Simulação` da planilha principal.
12. Entra no módulo de Estoque.
13. Gera e exporta o relatório `Saldos de Recursos - CEMAG`.
14. Atualiza a aba `Est. Produção`.
15. Entra no módulo de Compra.
16. Gera e exporta o relatório `Análise de Pedidos Pendentes ou Baixados - CEMAG`.
17. Atualiza a aba `Dados Pedidos`.
18. Volta para Produção.
19. Executa a simulação `Simulação Mat ind (Mov 3M)`.
20. Exporta o relatório logístico dessa segunda simulação.
21. Atualiza a planilha de materiais custo indireto (`Requisitados`).
22. Se houver erro, salva um print da tela e encerra o navegador.

## Passo a passo detalhado

### 1. Inicialização

1. A automação tenta abrir o Chrome com `webdriver.Chrome()`.
2. Se o driver não estiver compatível, ela procura a versão do Chrome instalada.
3. Depois baixa o `chromedriver` correspondente, extrai o arquivo e tenta abrir o navegador novamente.
4. Em seguida maximiza a janela.

### 2. Login no Innovaro

1. Acessa o endereço interno do Innovaro.
2. Preenche usuário.
3. Preenche senha.
4. Clica no botão de login.

## 3. Navegação inicial no menu

1. Sai de qualquer `iframe`, se existir.
2. Abre o menu lateral principal do Innovaro.
3. Navega na seguinte sequência:
   - `Produção`
   - `Plano mestre e simulação (MPS)`
   - `Plano mestre e simulação`

### 4. Abertura da simulação principal

1. Entra no `iframe` da tela.
2. Usa o campo de localização da grade.
3. Pesquisa pela simulação `Pendencia Diaria Carretas Compras`.
4. Aguarda o carregamento da tela.
5. Ajusta a visualização e os itens marcados na grade.
6. Executa a abertura da pendência usando o atalho de execução.

### 5. Ajuste dos filtros da pendência

1. Dentro da tela de filtros, localiza o campo de classe do recurso.
2. Apaga o valor atual.
3. Preenche com `Produtos`.
4. Define a emissão inicial como `01/01/2021`.
5. Define a emissão final com o valor `h`, que o sistema usa para completar a data atual.
6. Executa a busca da pendência.

### 6. Tratamento dos itens da simulação

1. A automação abre a grade de itens retornada.
2. Lê a tabela HTML da tela e transforma o conteúdo em `DataFrame`.
3. Mantém apenas as colunas relevantes:
   - `Recurso`
   - `Quantidade`
   - `Prev. Emissão Doc.`
   - `Hora`
4. Remove linhas vazias e linhas já preenchidas.
5. Para cada item pendente:
   - Preenche `Prev. Emissão Doc.` com `31/12/2025`
   - Preenche `Hora` com `h`
6. Esse preenchimento garante que os itens estejam aptos para a explosão.

### 7. Explosão da simulação principal

1. Sai do `iframe`.
2. Executa o comando de explosão com atalho do sistema.
3. Aguarda a tela de confirmação.
4. Clica para confirmar a explosão.

### 8. Exportação do relatório logístico da simulação principal

1. Abre novamente o menu do Innovaro.
2. Entra em `Relatório de Logística de Compras da Simulação`.
3. Entra no `iframe` do relatório.
4. Preenche os parâmetros do relatório:
   - Simulação: `Pendencia Diaria Carretas Compras`
   - Nível: `Último Nível`
   - Almoxarifado: `Almox de Compras`
   - Classe: `Materiais e Produtos`
5. Executa o relatório.
6. Aguarda a geração dos dados.
7. Sai do `iframe`.
8. Abre a rotina de exportação.
9. Escolhe o formato de exportação.
10. Executa a exportação final.
11. Entra de novo no `iframe` de resultado.
12. Clica no botão de download.
13. O CSV é salvo na pasta `Downloads`.

### 9. Atualização da aba `Dados Simulação`

1. A automação localiza o CSV mais recente da pasta `Downloads`.
2. Lê o arquivo usando separador `;`.
3. Renomeia colunas que vêm com caracteres extras do exportador do Innovaro.
4. Remove `=` e aspas dos valores.
5. Converte campos numéricos, como:
   - `Média`
   - `CMA`
   - `Simulado`
   - `Qtd.Est.`
   - `Ped.Pend.`
   - `Saldo`
   - `Cust.Unit.`
6. Limpa o intervalo `E2:M` da aba `Dados Simulação`.
7. Escreve os novos valores nessa aba da planilha `Análise Previsão de Consumo (CMM / NTP ) DEE`.

### 10. Consulta de estoque

1. Sai do `iframe`.
2. Abre o menu principal.
3. Navega por:
   - `Estoque`
   - `Consultas`
   - `Saldos de Recursos - CEMAG`
4. Entra no `iframe` da consulta.
5. Preenche a data-base com `h`.
6. Executa a consulta.
7. Aguarda a geração.
8. Abre a exportação.
9. Seleciona o formato.
10. Executa a exportação.
11. Clica para baixar o CSV.

### 11. Atualização da aba `Est. Produção`

1. A automação lê o CSV mais recente baixado.
2. Renomeia as colunas exportadas pelo Innovaro.
3. Limpa e converte a coluna `Saldo`.
4. Limpa o intervalo `N3:U` da aba `Est. Produção`.
5. Envia os novos dados para essa aba.

### 12. Consulta de compras

1. Sai do `iframe`.
2. Abre o menu principal.
3. Navega por:
   - `Compra`
   - `Consultas`
   - `Análise de Pedidos Pendentes ou Baixados - CEMAG`
4. Entra no `iframe` da consulta.
5. Ajusta a data de emissão final para `h`.
6. Executa a consulta.
7. Aguarda a geração dos dados.
8. Aciona a exportação.
9. Seleciona o formato.
10. Executa a exportação final.
11. Baixa o CSV.

### 13. Atualização da aba `Dados Pedidos`

1. A automação lê o CSV baixado.
2. Renomeia colunas do relatório.
3. Remove colunas que não serão usadas.
4. Limpa caracteres de exportação.
5. Converte os campos numéricos principais:
   - `Qde Ped`
   - `Qde Pend`
   - `Unitário`
   - `Total`
6. Limpa o intervalo `B2:Y` da aba `Dados Pedidos`.
7. Atualiza a aba com os dados novos.

### 14. Segunda simulação: materiais indiretos

1. A automação volta ao módulo `Plano mestre e simulação`.
2. Pesquisa pela simulação `Simulação Mat ind (Mov 3M)`.
3. Aguarda a tela carregar.
4. Executa a explosão dessa simulação.
5. Confirma a ação.
6. Abre novamente o relatório `Relatório de Logística de Compras da Simulação`.
7. Informa a simulação `Simulação Mat ind (Mov 3M)`.
8. Executa o relatório.
9. Faz o download do CSV gerado.

### 15. Atualização da planilha `Requisitados`

1. A automação lê o CSV da segunda simulação.
2. Faz o mesmo tratamento de colunas e números usado em `Dados Simulação`.
3. Limpa o intervalo `E2:M` da aba `Dados Simulação` da planilha:
   - `Análise Previsão de Consumo (Materiais Custo Indireto "Requisitados")`
4. Atualiza essa aba com os novos valores.

### 16. Tratamento de erro e encerramento

1. Se ocorrer qualquer exceção durante a execução:
   - a automação salva um print chamado `erro_screenshot.png`
   - registra a mensagem do erro no terminal
2. No final, com erro ou sem erro, o navegador é encerrado com `nav.quit()`.

## Planilhas atualizadas pela automação

### Planilha 1

Nome: `Análise Previsão de Consumo (CMM / NTP ) DEE`

Abas atualizadas:
- `Dados Simulação`
- `Est. Produção`
- `Dados Pedidos`

### Planilha 2

Nome: `Análise Previsão de Consumo (Materiais Custo Indireto "Requisitados")`

Abas atualizadas:
- `Dados Simulação`

## Observações importantes

1. A automação depende fortemente da estrutura atual das telas do Innovaro.
2. Se algum botão, coluna, `iframe` ou ordem do menu mudar, o script pode quebrar.
3. O script sempre usa o CSV mais recente da pasta `Downloads`.
4. Se houver outro download paralelo durante a execução, a automação pode ler o arquivo errado.
5. Existe um segundo script no projeto, `main_segunda_planilha.py`, que reaproveita a mesma base, mas este documento foi escrito com foco no fluxo principal de `main.py`.
