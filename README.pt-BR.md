# FluidLab — Português brasileiro

Simulador de pneumática, eletropneumática, hidráulica, lógica digital e eletrônica
que funciona no navegador. Esta versão local tem a interface em português brasileiro.

## Executar

No Windows, dê dois cliques em **Iniciar FluidLab.cmd**, na pasta do projeto.
Ele inicia o servidor e abre o navegador padrão. Mantenha a janela do servidor
aberta durante o uso; para encerrar, pressione `Ctrl+C`.

O inicializador usa Node.js 18 ou superior. Também é possível abrir um terminal
na pasta do projeto e executar:

```sh
npm start
```

Abra http://127.0.0.1:8777 no navegador. Não é necessário instalar dependências
nem compilar o projeto.

Como alternativa, com Python instalado:

```sh
python serve.py 8777
```

No Windows, se o Python estiver disponível pelo inicializador `py`, use:

```sh
py serve.py 8777
```

Abra http://localhost:8777 no navegador. O servidor precisa permanecer em
execução durante o uso.

## Usar o simulador

- Escolha um circuito em **Carregar exemplo** ou comece com **Novo**.
- Clique em um componente da biblioteca ou arraste-o para a área de desenho.
- Use **Seleção** (`V`) para selecionar componentes e editar suas propriedades.
- Use **Conexão** (`W`) ou arraste um ponto de conexão para ligar componentes.
- Clique em **Iniciar** ou pressione **Espaço** para iniciar ou pausar a simulação.
- Durante a simulação, clique nos botões e nas alavancas para acioná-los.
- Use **Sonda** (`P`) para medir grandezas em uma conexão pelo osciloscópio.
- **Exportar** permite salvar o esquema em JSON, SVG, PNG ou PDF, além da lista de materiais em CSV.
- **Importar** carrega esquemas JSON, inclusive os gerados pela versão original.

Atalhos adicionais: `R` gira o componente; `Delete` exclui a seleção;
`Ctrl+Z` desfaz; `Ctrl+Shift+Z` refaz; `Esc` para e reinicia a simulação.

## Tradução e compatibilidade

Foram traduzidos menus, dicas, propriedades, nomes e grupos de componentes,
falhas simuladas, exemplos, mensagens de erro, GRAFCET e textos das exportações.
Datas e ordenação de nomes usam a localidade `pt-BR`.

Os identificadores internos, os valores de opções salvos em JSON e a sintaxe de
programação do CLP permanecem compatíveis com a versão original. Por exemplo,
as formas de onda aparecem como **Senoidal**, **Quadrada** e **Triangular**, mas
seus valores internos continuam sendo `sinus`, `rechteck` e `dreieck`.
As palavras-chave de Structured Text, como `IF`, `THEN`, `TON` e `END_IF`, seguem
a sintaxe original. Os cálculos de simulação e os símbolos técnicos foram preservados.

Esta versão usa português diretamente, sem seletor de idiomas. Os documentos
técnicos da pasta `docs`, comentários do código e descrições dos testes continuam
nos idiomas originais.

## Verificar o funcionamento

Com Node.js 18 ou superior instalado:

```sh
node tests/run.js
```

Consulte o [README original](README.md) para detalhes de arquitetura, física e
licenciamento. A tradução mantém a licença original do projeto.
