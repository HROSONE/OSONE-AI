/**
 * Conferidor determinístico do provedor LOCAL (Ollama + Qwen Coder) no OSONE CODE.
 *
 * Não precisa de GPU, de Ollama instalado, nem de servidor rodando: ele liga o motor de regras
 * compartilhado (src/lib/ollama.ts) e confere, em texto, que as pontas todas estão ligadas —
 * tipos, roteamento no server.ts, rotas do Agente Local e a tela do CODE. Um trecho solto
 * (ex.: fetch sem token Bearer) é exatamente o tipo de defeito que este script pega antes do
 * usuário descobrir no meio de um download de gigabytes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Node 20 não sabe importar .ts direto; tsx (devDependency do projeto) faz essa ponte.
let ollamaLib;
try {
  ollamaLib = await import('../src/lib/ollama.ts');
} catch (err) {
  if (err?.code === 'ERR_UNKNOWN_FILE_EXTENSION') {
    console.error("Este conferidor precisa do tsx para ler o motor em TypeScript: rode 'npm i -D tsx' e tente de novo.");
    process.exit(2);
  }
  throw err;
}
const {
  MODELOS_OLLAMA_PADRAO,
  OPGOES_DE_MODELO_OLLAMA,
  normalizarEnderecoDoOllama,
  ehEnderecoLocalDoOllama,
  montarPedidoOllama,
  lerPecacoDoFluxoOllama,
  emendarContinuacaoLocal,
  motivoIndicaCorte,
  nomeDeModeloValido,
  comandoDeInstalacaoDoOllama,
} = ollamaLib;

const carregar = (caminho) => readFileSync(new URL(caminho, import.meta.url), 'utf8');
const server = carregar('../server.ts');
const workspace = carregar('../src/components/CodeWorkspace.tsx');
const agente = carregar('../src/localAgentService.ts');
const types = carregar('../src/types.ts');

const checks = [];
const conferir = (nome, passou) => checks.push([nome, Boolean(passou)]);

// ===== 1. O MODELO PADRÃO É O MAIS MODESTO (PC sem GPU, 8 GB de RAM) =====
conferir('padrão é qwen2.5-coder:1.5b', MODELOS_OLLAMA_PADRAO === 'qwen2.5-coder:1.5b');
conferir('opções vão do leve ao pesado', OPGOES_DE_MODELO_OLLAMA[0]?.id === 'qwen2.5-coder:1.5b'
  && OPGOES_DE_MODELO_OLLAMA.some((m) => m.id === 'qwen2.5-coder:7b'));
conferir('a tela avisa que 3B+ aperta em 8 GB', /apertado em 8 GB/.test(OPGOES_DE_MODELO_OLLAMA.find((m) => m.id === 'qwen2.5-coder:3b')?.desc || ''));

// ===== 2. SEGURANÇA: SÓ LOOPBACK =====
conferir('vazio cai no padrão loopback', normalizarEnderecoDoOllama('') === 'http://127.0.0.1:11434');
conferir('localhost vira 127.0.0.1 com porta', normalizarEnderecoDoOllama('localhost') === 'http://127.0.0.1:11434');
conferir('aceita 127.x e ::1', ehEnderecoLocalDoOllama('http://127.0.0.1:11434') && ehEnderecoLocalDoOllama('::1'));
conferir('recusa rede e domínio (anti-SSRF)', !ehEnderecoLocalDoOllama('http://192.168.0.9:11434')
  && !ehEnderecoLocalDoOllama('http://evil.example.com')
  && !ehEnderecoLocalDoOllama('http://10.0.0.5:11434'));
conferir('nome de modelo malicioso é recusado', nomeDeModeloValido('qwen2.5-coder:1.5b')
  && !nomeDeModeloValido('x; rm -rf /') && !nomeDeModeloValido(''));

// ===== 3. PEDIDO E FLUXO DO /api/generate =====
const pedido = montarPedidoOllama({ modelo: 'qwen2.5-coder:1.5b', prompt: 'oi', systemInstruction: 'sistema', stream: true });
conferir('pedido traz modelo, system e num_ctx', pedido.model === 'qwen2.5-coder:1.5b'
  && pedido.system === 'sistema' && pedido.options.num_ctx === 8192);
conferir('teto de tokens respeita o máximo', Number(pedido.options.num_predict) <= Number(process.env.OSONE_OLLAMA_MAX_TOKENS || 8192));
const pedaco = lerPecacoDoFluxoOllama('{"response":"fun","done":false}');
conferir(' lê fragmento JSON do fluxo', pedaco.texto === 'fun' && !pedaco.done);
conferir('linha de progresso é ignorada em silêncio', lerPecacoDoFluxoOllama('{"status":"loading model"}').texto === '');
conferir('corte detectado por length/stop_token', motivoIndicaCorte('length') && motivoIndicaCorte('stop_token') && !motivoIndicaCorte('stop'));
conferir('continuação desconta a repetição', emendarContinuacaoLocal('abcDEF', 'DEFghi') === 'abcDEFghi');

// ===== 4. SERVIDOR ROTEIA O PROVEDOR LOCAL =====
conferir('provedor "ollama" reconhecido no server', /'gemini' \| 'openai' \| 'anthropic' \| 'ollama'/.test(server));
conferir('motor local chamado no /api/generate', server.includes("if (provedorCode === 'ollama')") && server.includes('gerarComOllamaAteOFim(req.body)'));
conferir('streaming SSE também roteia ollama', server.includes('gerarComOllamaAteOFim(req.body, (pedaco) => enviar({ text: pedaco }))'));
conferir('guarda anti-SSRF no servidor', server.includes('ehEnderecoLocalDoOllama(enderecoBruto)'));

// ===== 5. AGENTE LOCAL: INSTALAR, BAIXAR, ACOMPANHAR =====
conferir('rotas do agente registradas', agente.includes("agentRouter.post('/ollama/instalar'")
  && agente.includes("agentRouter.post('/ollama/baixar-modelo'")
  && agente.includes("agentRouter.get('/ollama/progresso'"));
conferir('download recusa modelo inválido', agente.includes('nomeDeModeloValido(modelo)'));
conferir('plano de instalação existe p/ win, mac e linux', comandoDeInstalacaoDoOllama('win32')
  && comandoDeInstalacaoDoOllama('darwin') && comandoDeInstalacaoDoOllama('linux'));

// ===== 6. TELA: TOKEN BEARER EM TODAS AS CHAMADAS DO AGENTE =====
conferir('prop localAgentToken chegou ao CODE', /localAgentToken\?: string;/.test(workspace)
  && workspace.includes('onUpdateApiKeys, localAgentToken, isGenerating'));
conferir('App entrega o token ao CodeWorkspace', /<CodeWorkspace[\s\S]{0,600}localAgentToken=\{apiKeys\.localAgentToken \|\| ''\}/.test(carregar('../src/App.tsx')));
const chamadasComBearer = (workspace.match(/Bearer \$\{localAgentToken\}/g) || []).length;
conferir('todas as 3 chamadas ao agente enviam Bearer', chamadasComBearer >= 3);
conferir('botões de instalar Ollama e baixar modelo na tela', workspace.includes('instalarOllamaPelaInterface')
  && workspace.includes('baixarModeloDoOllamaPelaInterface'));
conferir('polling de progresso a cada 2s', workspace.includes('}, 2000)') && workspace.includes('/api/agent/ollama/progresso'));

// ===== 7. TIPOS =====
conferir('ApiKeys conhece o provedor e o modelo local', types.includes("'ollama'")
  && types.includes('osoneCodeOllamaModel') && types.includes('osoneCodeOllamaUrl'));

const falhas = checks.filter(([, passou]) => !passou);
for (const [nome, passou] of checks) console.log(`${passou ? '✔' : '✘'} ${nome}`);
assert.equal(falhas.length, 0, `Falharam ${falhas.length}: ${falhas.map(([n]) => n).join('; ')}`);
console.log(`${checks.length}/${checks.length} conferências do Ollama local no OSONE CODE passaram.`);
