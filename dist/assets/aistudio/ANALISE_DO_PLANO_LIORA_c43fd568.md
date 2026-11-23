# Análise integral do arquivo de planejamento da LIORA

## 1. Escopo analisado

Foi analisado o arquivo `plano principal em chat(1).txt`, com aproximadamente 1.835 linhas e 4.348 palavras. O conteúdo mistura visão de produto, arquitetura, segurança, interface, tecnologias, roadmap, exemplos de ferramentas, critérios de implementação e um prompt inicial de fundação.

O texto tem dois grandes blocos: primeiro, a visão ampla do assistente pessoal (originalmente chamado ULTRON); depois, uma proposta mais atualizada para o projeto LIORA, com requisitos de interface e fundação técnica. O segundo bloco é importante porque corrige parte das decisões do primeiro.

## 2. Visão do produto extraída do arquivo

A ideia não é criar apenas um chatbot, mas um **assistente pessoal orientado por objetivos, com interface desktop, voz, memória, ferramentas locais e conexões com serviços/dispositivos**.

O sistema completo precisa combinar:

- cérebro de IA e roteamento de modelos;
- voz bidirecional, interrupção e transcrição;
- memória de curto e longo prazo;
- planejamento, execução, verificação e recuperação de tarefas;
- catálogo modular de ferramentas;
- controle local de PC e navegador;
- criação e manipulação de arquivos;
- apoio a programação e trabalhos criativos;
- internet, e-mail e outros serviços;
- casa inteligente, celular e dispositivos;
- proatividade e agendamento;
- visão computacional e gestos;
- segurança proporcional e trilha de auditoria.

O arquivo também defende uma regra de engenharia essencial: o modelo não deve executar diretamente qualquer comando. Ele precisa solicitar uma ferramenta estruturada, e o programa valida a ação, as permissões, os argumentos e o resultado.

## 3. Decisões técnicas que devem prevalecer

### Arquitetura local

O arquivo contém recomendações antigas de Electron + React e Python/FastAPI. Mais adiante, o prompt específico de fundação da LIORA define **React + TypeScript + Vite + Tauri**, com Rust em `src-tauri`, sem Electron. Para o projeto atual, a orientação coerente é preservar Tauri e a arquitetura já existente.

### IA e voz

- Gemini é a rota prioritária para os cenários adequados, especialmente voz multimodal em tempo real quando a API/modelo configurado suportar.
- OpenRouter é uma rota alternativa para modelos que suportem as capacidades necessárias.
- Modelos locais podem ser adicionados futuramente, quando realmente instalados/configurados.
- A interface de voz deve possuir um único proprietário global de sessão; navegar entre telas não pode abrir um segundo microfone ou duplicar sessões.

### Ferramentas e integrações

- APIs oficiais antes de automação visual.
- Ferramentas locais estreitas antes de comandos de shell genéricos.
- UI Automation/acessibilidade antes de clicar por coordenadas fixas quando aplicável.
- Playwright para automação de navegador compatível.
- MCP para conectar ferramentas sem acoplar tudo ao núcleo.
- SQLite e Markdown como partes complementares da memória.
- Home Assistant como possível camada intermediária de casa inteligente.
- PULO como conceito de continuidade/transferência entre dispositivos, não como acesso irrestrito a qualquer aparelho.

## 4. Direção visual extraída

A identidade desejada é futurista e sofisticada, com preto, branco e vermelho. O arquivo fornece os seguintes tokens de referência:

- fundo `#050505`;
- superfícies `#111111` e `#171717`;
- texto principal `#F5F5F5` e branco `#FFFFFF`;
- texto secundário `#A8A8A8` e discreto `#666666`;
- vermelho principal `#FF2B2B`, vermelho energético `#FF4A4A` e vermelho profundo `#8B0000`;
- gradiente `#FF4545 → #D90E0E → #720000`.

As fontes indicadas são Space Grotesk para display, Inter para interface e JetBrains Mono para dados/logs.

A orb LIORA CORE é central ao conceito, com aparência fluida semelhante à água, partículas e pequenas esferas orbitais, linhas de energia, profundidade, movimento real em 3D, zoom, rotação e pulsação sincronizada com a fala. O design deve suportar estados distintos e ter fallback de desempenho; não deve prejudicar voz ou responsividade.

## 5. Navegação e páginas pedidas

O documento mestre preserva e amplia a seguinte navegação:

- **Home:** orb, saudação, campo de comando, estado da assistente, tarefas e métricas reais ou explicitamente simuladas.
- **Conversation:** subabas Texto, Voz ao vivo, Transcrição e Histórico.
- **Activity:** tarefas, timeline, ferramentas utilizadas, resultado, duração, logs e verificação.
- **Memory:** preferências, projetos, tarefas, dispositivos, resumos, pesquisa semântica, edição/exportação/exclusão.
- **Devices:** PC, celular, TV, impressora, casa inteligente, câmera/sensores, veículo e outros.
- **Automations:** eventos, gatilhos, condições, ações, horários silenciosos, execução e histórico.
- **Developer:** projetos, análise de código, diffs, testes, execução controlada e conectores.
- **Integrations:** provedores de IA, MCP, browser, e-mail, calendário, casa, celular e ferramentas criativas.
- **Settings:** geral, tema, orb, voz, provedores, credenciais, privacidade, permissões, integrações, dispositivos, notificações, diagnóstico e exportação.

## 6. Autonomia e política de permissões

O pedido do usuário é autonomia real sem confirmações incômodas para cada gesto. Isso é compatível com uma matriz de risco:

- **R0 — leitura/consulta:** geralmente sem confirmação.
- **R1 — ação local reversível:** normalmente sem confirmação dentro do escopo previamente autorizado.
- **R2 — ação sensível/externalizada:** confirmação explícita antes de enviar, publicar, compartilhar ou mudar recursos externos sensíveis.
- **R3 — destrutiva/crítica:** confirmação contextual reforçada e possibilidade de bloqueio quando não for delimitável ou verificável.

Pastas e recursos como `C:\Windows`, `System32`, boot, registro, serviços, drivers, discos, permissões elevadas e exclusões recursivas precisam ser protegidos por padrão. Deve haver validação real de caminhos, traversal e links simbólicos; não basta esconder botões.

Também é essencial uma etapa de verificação após ações importantes. A LIORA só deve dizer que concluiu se obtiver evidência adequada; se a verificação não estiver disponível, precisa assumir essa limitação.

## 7. Gestão de modelos e chaves

O pedido inclui suporte a muitas credenciais. A especificação mantém um catálogo extensível de credenciais autorizadas, rotas preferidas, estado de saúde, rótulos, modelos e erros seguros. O ponto crítico é que várias chaves não devem ser usadas para contornar quotas, limites, cobrança ou termos do provedor. A arquitetura deve oferecer failover legítimo para outro endpoint/conta autorizada, armazenamento seguro, ocultação dos segredos e redaction nos logs.

Na fase AI Studio, usar secrets do lado do servidor. Na versão desktop, usar cofre do sistema operacional ou armazenamento criptografado adequado. O frontend nunca recebe a chave completa.

## 8. Requisito especial: Google AI Studio versus controle local

O AI Studio é útil como ambiente de prototipagem web e pode exportar código ZIP. O preview do navegador, sozinho, não obtém permissões nativas do Windows. Para operações reais de PC será necessária integração com o Tauri existente (comandos Rust) ou um agente local explicitamente instalado, autenticado e limitado.

Por isso, o prompt pede duas experiências distintas:

- **Modo de demonstração:** UI, fluxos, providers acessíveis, mocks marcados e estado real de integração.
- **Modo desktop local:** capacidades reais atrás do `LocalExecutionBridge`, ligadas aos comandos nativos e às políticas de autorização.

Essa separação é necessária para que o protótipo possa ser exportado sem enganar o usuário sobre o que já funciona.

## 9. Engenharia reversa

A ferramenta provavelmente mencionada é **REA — Reverse Engineer Anything** (`https://github.com/morluto/rea`). Pode ser integrada opcionalmente ao módulo Developer via CLI/MCP para investigar comportamentos de software e coletar evidências. Não deve ser confundida com um sistema de controle geral do PC nem depender dela para funções essenciais. A análise deve ocorrer somente em software que o usuário tenha direito de examinar, com escopo e limites visíveis.

## 10. Roadmap consolidado

O Prompt Mestre converte a visão ampla em fases:

0. Reconhecimento e governança.
1. Fundação de interface e navegação.
2. LIORA CORE 3D.
3. Chat textual funcional.
4. Roteador de modelos e credenciais.
5. Voz em tempo real e transcrição.
6. Planner, registry, permissões e verificador.
7. Ponte Tauri e ferramentas locais.
8. Browser e internet.
9. Memória.
10. Agente de programação e ferramentas criativas.
11. Event bus, proatividade e scheduler.
12. Integrações externas.
13. PULO e celular.
14. Casa e dispositivos.
15. Visão e gestos.
16. Carro e integrações avançadas.
17. Auditoria, empacotamento e validação final.

## 11. Principais riscos e como o Prompt Mestre os trata

| Risco | Tratamento incluído |
|---|---|
| A IA gerar uma UI bonita, mas sem funcionamento real | Estados IMPLEMENTADO/SIMULADO/PENDENTE e critérios de aceite |
| O preview web prometer controle nativo | `LocalExecutionBridge` mockado no AI Studio e integração Tauri documentada |
| Uma chamada de modelo executar comandos arbitrários | Tool Registry, schemas, Permission Engine e executor separado |
| Excluir arquivos críticos ou afetar Windows | Diretórios protegidos, validação de caminho e confirmação específica |
| Chaves vazarem em frontend/logs | Segredos server-side/cofre local, redaction e nenhuma chave no bundle |
| Voz duplicar sessão ou deixar microfone aberto após erro | Dono global da sessão, máquina de estados e cleanup testado |
| Agente declarar sucesso falso | Verifier obrigatório e evidência pós-ação |
| Projeto tornar-se monólito difícil de evoluir | Módulos, fases pequenas, testes e documentação de estado |
| Integrações simuladas serem confundidas com reais | Modo/capability status visível em cada tela |
| Autonomia virar ações ilimitadas | Orçamento, rate limits, cancelamento, permissões e política de risco |

## 12. O que não deve ser prometido como concluído por uma única geração

O plano completo é de um produto de várias fases. Uma primeira geração no AI Studio pode criar uma base visual e web, chat com o provedor configurado, contracts, mocks, documentação e testes compatíveis. Não pode por si só provar controle nativo do Windows, conexão a celular, operação de câmera, integração com carro, execução local Tauri ou suporte real a todos os aplicativos possíveis.

Esses recursos devem continuar no `/goal`, mas com sua própria fase de integração e validação. O objetivo não é diminuir a ambição; é organizar sua execução para que cada etapa se torne parte do produto final, sem ser descartada e sem simular resultados.

## 13. Resultado desta análise

O Prompt Mestre resultante preserva a visão do arquivo, resolve a divergência Electron/Tauri em favor do alvo Tauri, organiza o design solicitado, inclui o conceito PULO e o recurso de engenharia reversa REA, detalha controles de voz/transcrição, gestão de chaves, ferramentas, memória, proatividade e dispositivos, e acrescenta critérios explícitos de segurança, teste, auditoria e status.

O arquivo principal para colar no Google AI Studio é `LIORA_PROMPT_MESTRE_GOOGLE_AI_STUDIO.txt`. A versão Markdown é útil para leitura, revisão e versionamento.
