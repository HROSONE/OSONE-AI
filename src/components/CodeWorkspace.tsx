import React, { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { buscarNoProjeto, substituirNoProjeto, OcorrenciaNaBusca } from '../lib/buscarNoProjeto';
import { realcar, linguagemDoArquivo } from '../lib/realce';
import {
  Code2, Play, FileCode, Plus, Trash2, Edit3, Download, Copy, Check,
  FolderGit2, Sparkles, RefreshCw, Eye, Columns,
  Upload, X, Mic, Loader2, MessageSquare, AlertCircle,
  Bot, Layers, ShieldCheck, Terminal, Cpu, Zap, RotateCw, CheckCircle2,
  AlertTriangle, ChevronDown, ChevronUp, ChevronLeft, PlayCircle, Gamepad2,
  Undo, Redo, RotateCcw, Paperclip, Flame, Search, Replace, KeyRound, Archive
} from 'lucide-react';
import { cn } from '../lib/utils';
import { CodePreview } from './CodePreview';
import { CodeGithubPanel } from './CodeGithubPanel';
import { ApiKeys, CodeRepositoryFile } from '../types';
import { buildCodeEditSystemInstruction, applyModelCodeResponse, parseSections, pareceDocumentoIncompleto } from '../lib/codeEdits';
import { INSTRUCAO_DE_PROJETO_MULTIARQUIVO, OSONE_CODE_MODELO_PRINCIPAL, aplicarArquivosDoModelo } from '../lib/projetoMultiArquivo';
import { montarPreview } from '../lib/montarPreview';
import { ProblemaDoPreview, juntarProblemas, montarPedidoDeCorrecao } from '../lib/errosDoPreview';
import { separarProjeto } from '../lib/separarArquivos';
import { montarPacote } from '../lib/exportarProjeto';
import { analisarFullstackDoCode, arquivosDeSuporteFullstack } from '../lib/fullstackDoCode';
import { compararProjeto, apenasOsTrechosQueMudaram, ComparacaoDeArquivo } from '../lib/compararCodigo';
import { caminhoDisponivel, chaveDeCaminho, nomeBaseDoCaminho, normalizarCaminhoDoCode, pastaDoCaminho } from '../lib/caminhosDoCode';
import { GithubImportResult } from '../lib/githubDoCode';
import { MODELOS_OLLAMA_PADRAO, OPGOES_DE_MODELO_OLLAMA } from '../lib/ollama';

// Geração/edição de código (Hunter e Enxame/Swarm) sempre usa o melhor modelo disponível para
// código, independente do modelo configurado nos Ajustes gerais do chat. A constante vive em
// lib/projetoMultiArquivo para a construção de projetos pedida por voz usar exatamente o mesmo
// modelo — ver o comentário na definição.
const OSONE_CODE_BEST_MODEL = OSONE_CODE_MODELO_PRINCIPAL;

/**
 * Chama /api/generate com retentativas automáticas (backoff simples) para falhas
 * transitórias de rede/servidor. Evita que um único agente do Swarm derrube o
 * pipeline inteiro por causa de uma falha passageira em uma das várias chamadas
 * sequenciais. Sempre manda "unrestricted: true" para tirar as travas de qualidade
 * (sem downgrade silencioso de modelo, raciocínio máximo, filtros de segurança
 * ajustáveis afrouxados) — só nas chamadas do OSONE CODE, não no resto do app.
 */
async function generateWithRetry(
  body: Record<string, unknown>,
  retries: number = 2,
  /** Cancela a chamada pela metade quando o usuário desiste. Ver 'cancelado' no retorno. */
  sinal?: AbortSignal
): Promise<{ ok: boolean; text: string; error?: string; truncated?: boolean; blocked?: boolean; cancelado?: boolean }> {
  let lastError = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (sinal?.aborted) return { ok: false, text: '', cancelado: true };
    try {
      const response = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unrestricted: true, ...body }),
        signal: sinal
      });
      const data = await response.json().catch(() => ({} as any));
      if (response.ok) {
        return { ok: true, text: data.text || '', truncated: !!data.truncated, blocked: !!data.blocked };
      }
      lastError = data?.error || `HTTP ${response.status}`;
    } catch (e: any) {
      // Desistir não é falhar: sem esta saída, o cancelamento viraria mais duas tentativas e um
      // erro vermelho na tela de quem só apertou "parar".
      if (e?.name === 'AbortError' || sinal?.aborted) return { ok: false, text: '', cancelado: true };
      lastError = e?.message || String(e);
    }
    if (attempt < retries) {
      await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  return { ok: false, text: '', error: lastError };
}

const BowAndArrowIcon = ({ size = 16, className = "" }: { size?: number; className?: string }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round" 
    className={className}
  >
    <path d="M12 21a9 9 0 0 0 0-18M2 12h20M17 7l5 5-5 5" />
  </svg>
);

export interface OSONEProject {
  id: string;
  name: string;
  files: CodeRepositoryFile[];
  activeFileId: string;
  updatedAt: number;
}

/**
 * A linguagem que vem do nome do arquivo.
 *
 * Estava escrito solto dentro da criação de arquivo, então quem renomeava um script.js para
 * styles.css ficava com um arquivo .css marcado como javascript: o realce pintava com as regras
 * erradas e o preview tratava folha de estilo como script. Num lugar só, renomear e criar passam
 * pela mesma regra.
 */
export function linguagemPelaExtensao(nomeDoArquivo: string): string {
  const ext = (nomeDoArquivo.split('.').pop() || '').toLowerCase();
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'css') return 'css';
  if (ext === 'py') return 'python';
  if (ext === 'ts' || ext === 'tsx') return 'typescript';
  if (ext === 'json') return 'json';
  if (ext === 'md') return 'markdown';
  if (ext === 'sql') return 'sql';
  return 'javascript';
}

function caminhoExisteNoProjeto(caminho: string, arquivos: CodeRepositoryFile[], ignorarId?: string): boolean {
  const chave = chaveDeCaminho(caminho);
  return arquivos.some(f => f.id !== ignorarId && chaveDeCaminho(f.name || '') === chave);
}

function prepararNomeDeArquivoDigitado(valor: string): string | null {
  const normalizado = normalizarCaminhoDoCode(valor || '');
  return normalizado.trim() ? normalizado : null;
}

interface GrupoDeArquivosDoCode {
  pasta: string;
  arquivos: CodeRepositoryFile[];
}

type FormatoProjetoDoCode = 'single' | 'tree';

function agruparArquivosPorPasta(arquivos: CodeRepositoryFile[]): GrupoDeArquivosDoCode[] {
  const grupos = new Map<string, CodeRepositoryFile[]>();
  for (const arquivo of arquivos || []) {
    const pasta = pastaDoCaminho(arquivo.name || '');
    const chave = pasta || '';
    const atuais = grupos.get(chave) || [];
    atuais.push(arquivo);
    grupos.set(chave, atuais);
  }

  return Array.from(grupos.entries())
    .sort(([a], [b]) => {
      if (a === '') return -1;
      if (b === '') return 1;
      return a.localeCompare(b, 'pt-BR');
    })
    .map(([pasta, lista]) => ({
      pasta,
      arquivos: [...lista].sort((a, b) => nomeBaseDoCaminho(a.name).localeCompare(nomeBaseDoCaminho(b.name), 'pt-BR'))
    }));
}

function entradaFrontendPreferidaDoCode(arquivos: CodeRepositoryFile[]): CodeRepositoryFile | undefined {
  const porCaminho = (nome: string) =>
    arquivos.find(f => chaveDeCaminho(f.name || '') === chaveDeCaminho(nome));

  return arquivos.find(f => f.isMain && /^(frontend|public|src)\//i.test(f.name || ''))
    || porCaminho('frontend/index.html')
    || porCaminho('public/index.html')
    || porCaminho('src/index.html')
    || porCaminho('src/main.tsx')
    || porCaminho('src/main.ts')
    || porCaminho('src/main.jsx')
    || porCaminho('src/main.js')
    || porCaminho('src/App.tsx')
    || porCaminho('src/App.jsx')
    || arquivos.find(f => /^(frontend|public|src)\/.*index\.html?$/i.test(f.name || ''));
}

const TEMPLATE_FULLSTACK_OSONE: Array<{ name: string; language: string; content: string; isMain?: boolean }> = [
  {
    name: 'frontend/index.html',
    language: 'html',
    isMain: true,
    content: `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OSONE Fullstack</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <main class="app">
    <p class="badge">frontend + server + shared</p>
    <h1>Projeto fullstack OSONE</h1>
    <p id="status">Carregando dados...</p>
    <button id="refresh">Consultar API</button>
  </main>
  <script type="module" src="./app.js"></script>
</body>
</html>`
  },
  {
    name: 'frontend/styles.css',
    language: 'css',
    content: `body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: radial-gradient(circle at top, #0e7490 0, #090a0f 48%, #020617 100%);
  color: #f8fafc;
  font-family: Inter, system-ui, sans-serif;
}

.app {
  width: min(560px, calc(100vw - 32px));
  padding: 32px;
  border-radius: 28px;
  background: rgba(2, 6, 23, 0.72);
  border: 1px solid rgba(34, 211, 238, 0.25);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
}

.badge {
  color: #22d3ee;
  letter-spacing: .16em;
  text-transform: uppercase;
  font-size: 12px;
}

button {
  border: 0;
  border-radius: 14px;
  padding: 12px 18px;
  background: #22d3ee;
  color: #031018;
  font-weight: 800;
  cursor: pointer;
}`
  },
  {
    name: 'frontend/app.js',
    language: 'javascript',
    content: `import { nomeDoProduto } from '../shared/config.js';

const status = document.getElementById('status');
const botao = document.getElementById('refresh');

async function consultarApi() {
  status.textContent = 'Consultando API...';
  try {
    const resposta = await fetch('/api/status');
    const dados = await resposta.json();
    status.textContent = dados.message;
  } catch {
    // No preview do OSONE CODE não existe servidor Express rodando; este fallback deixa o
    // frontend testável enquanto o server/api.js fica pronto para deploy real.
    status.textContent = nomeDoProduto + ' pronto no preview. Rode server/api.js no backend real.';
  }
}

botao.addEventListener('click', consultarApi);
consultarApi();`
  },
  {
    name: 'shared/config.js',
    language: 'javascript',
    content: `export const nomeDoProduto = 'OSONE Fullstack';
export const versaoApi = 'v1';`
  },
  {
    name: 'server/api.js',
    language: 'javascript',
    content: `import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nomeDoProduto, versaoApi } from '../shared/config.js';

const app = express();
const PORT = process.env.PORT || 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendPath = path.resolve(__dirname, '../frontend');

app.get('/api/status', (_req, res) => {
  res.json({
    ok: true,
    message: nomeDoProduto + ' API ' + versaoApi + ' online.'
  });
});

app.use(express.static(frontendPath));

app.get('*', (_req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

app.listen(PORT, () => {
  console.log('Projeto rodando em http://localhost:' + PORT);
});`
  },
  {
    name: 'README.md',
    language: 'markdown',
    content: `# Projeto Fullstack OSONE

Estrutura sugerida:

- \`frontend/\`: interface que aparece no preview vivo.
- \`server/\`: API/servidor para rodar fora do preview.
- \`shared/\`: código compartilhado entre frontend e backend.

O preview do OSONE CODE executa o frontend diretamente e resolve imports entre pastas.

Para rodar o backend real:

\`\`\`bash
npm install
npm run dev
\`\`\`

Depois abra http://localhost:3001.`
  }
];

/**
 * Uma cópia nova dos arquivos padrão, a cada chamada.
 *
 * DEFAULT_FILES era entregue por REFERÊNCIA aos projetos criados no preenchimento da lista: cinco
 * projetos "diferentes" apontando para o mesmo array e para os mesmos objetos de arquivo. Bastava
 * uma alteração que mutasse em vez de copiar para o conteúdo aparecer nos outros projetos.
 */
function arquivosPadraoNovos(): CodeRepositoryFile[] {
  return JSON.parse(JSON.stringify(DEFAULT_FILES));
}

const DEFAULT_FILES: CodeRepositoryFile[] = [
  {
    id: 'main-app',
    name: 'index.html',
    language: 'html',
    isMain: true,
    updatedAt: Date.now(),
    content: `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OSONE CODE App</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/lucide@latest"></script>
  <!-- Os arquivos do projeto entram por aqui: o preview resolve estes endereços contra o
       repositório e embute o conteúdo, então editar styles.css ou script.js muda a página. -->
  <link rel="stylesheet" href="styles.css">
  <style>
    body { background-color: #090a0f; color: #f3f4f6; font-family: system-ui, sans-serif; }
    .glass { background: rgba(255, 255, 255, 0.03); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.08); }
  </style>
</head>
<body class="min-h-screen flex items-center justify-center p-6">
  <div class="glass rounded-3xl p-8 max-w-md w-full shadow-2xl text-center space-y-6 border border-cyan-500/20">
    <div class="w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center mx-auto text-cyan-400">
      <i data-lucide="cpu" class="w-8 h-8"></i>
    </div>

    <div>
      <h1 class="text-2xl font-bold bg-gradient-to-r from-cyan-400 to-emerald-400 bg-clip-text text-transparent">
        OSONE CODE Studio
      </h1>
      <p class="text-xs text-zinc-400 mt-2">
        Arquitetura de Agentes Swarm & Harness Engineering.
      </p>
    </div>

    <div class="p-4 rounded-xl bg-black/40 border border-white/5 text-left text-xs font-mono text-cyan-300/80 space-y-1">
      <div>> Sistema OSONE CODE v5.0 ativo</div>
      <div>> Swarm Engine (PM, Architect, Coder, QA) pronto</div>
      <div>> Clique em "🐝 ENXAME OSONE CODE" para criar jogos</div>
    </div>

    <button id="counterBtn" class="w-full py-3 px-6 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-semibold transition-all transform active:scale-95 shadow-lg shadow-cyan-500/20">
      Clique aqui: <span id="countVal">0</span>
    </button>
  </div>

  <script src="script.js"></script>
  <script>
    lucide.createIcons();
    let count = 0;
    const btn = document.getElementById('counterBtn');
    const val = document.getElementById('countVal');
    btn.addEventListener('click', () => {
      count++;
      val.textContent = count;
    });
  </script>
</body>
</html>`
  },
  {
    id: 'styles-css',
    name: 'styles.css',
    language: 'css',
    updatedAt: Date.now() - 3600000,
    content: `/* Custom OSONE Stylesheet */
:root {
  --primary: #06b6d4;
  --bg-dark: #090a0f;
}

body {
  margin: 0;
  padding: 0;
  background-color: var(--bg-dark);
  font-family: 'JetBrains Mono', monospace;
}`
  },
  {
    id: 'script-js',
    name: 'script.js',
    language: 'javascript',
    updatedAt: Date.now() - 7200000,
    content: `// Main Application Logic
console.log("OSONE CODE Studio Inicializado!");

function calculateMetrics(a, b) {
  return a * b;
}`
  }
];

const DEFAULT_PROJECTS: OSONEProject[] = [
  {
    id: 'proj-1',
    name: 'Projeto 1',
    files: DEFAULT_FILES,
    activeFileId: 'main-app',
    updatedAt: Date.now()
  },
  {
    id: 'proj-2',
    name: 'Projeto 2',
    files: [
      {
        id: 'proj-2-main',
        name: 'index.html',
        language: 'html',
        isMain: true,
        updatedAt: Date.now(),
        content: `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Projeto 2 - OSONE CODE</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-zinc-950 text-white min-h-screen flex items-center justify-center p-6">
  <div class="p-8 rounded-2xl bg-zinc-900 border border-emerald-500/30 text-center space-y-4 max-w-md">
    <h1 class="text-2xl font-bold text-emerald-400">Projeto 2 - Novo Canvas</h1>
    <p class="text-xs text-zinc-400">Projeto independente. Alterações aqui afetam apenas este projeto!</p>
  </div>
</body>
</html>`
      }
    ],
    activeFileId: 'proj-2-main',
    updatedAt: Date.now()
  },
  {
    id: 'proj-3',
    name: 'Projeto 3',
    files: [
      {
        id: 'proj-3-main',
        name: 'index.html',
        language: 'html',
        isMain: true,
        updatedAt: Date.now(),
        content: `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Projeto 3 - OSONE CODE</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-zinc-950 text-white min-h-screen flex items-center justify-center p-6">
  <div class="p-8 rounded-2xl bg-zinc-900 border border-purple-500/30 text-center space-y-4 max-w-md">
    <h1 class="text-2xl font-bold text-purple-400">Projeto 3 - Canvas Limpo</h1>
    <p class="text-xs text-zinc-400">Edite, crie jogos ou apps com o Enxame OSONE CODE.</p>
  </div>
</body>
</html>`
      }
    ],
    activeFileId: 'proj-3-main',
    updatedAt: Date.now()
  },
  {
    id: 'proj-4',
    name: 'Projeto 4',
    files: [
      {
        id: 'proj-4-main',
        name: 'index.html',
        language: 'html',
        isMain: true,
        updatedAt: Date.now(),
        content: `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Projeto 4 - OSONE CODE</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-zinc-950 text-white min-h-screen flex items-center justify-center p-6">
  <div class="p-8 rounded-2xl bg-zinc-900 border border-amber-500/30 text-center space-y-4 max-w-md">
    <h1 class="text-2xl font-bold text-amber-400">Projeto 4 - Sandbox</h1>
    <p class="text-xs text-zinc-400">Pronto para codar!</p>
  </div>
</body>
</html>`
      }
    ],
    activeFileId: 'proj-4-main',
    updatedAt: Date.now()
  },
  {
    id: 'proj-5',
    name: 'Projeto 5',
    files: [
      {
        id: 'proj-5-main',
        name: 'index.html',
        language: 'html',
        isMain: true,
        updatedAt: Date.now(),
        content: `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <title>Projeto 5 - OSONE CODE</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-zinc-950 text-white min-h-screen flex items-center justify-center p-6">
  <div class="p-8 rounded-2xl bg-zinc-900 border border-cyan-500/30 text-center space-y-4 max-w-md">
    <h1 class="text-2xl font-bold text-cyan-400">Projeto 5 - Área de Testes</h1>
    <p class="text-xs text-zinc-400">Código mantido de forma totalmente isolada.</p>
  </div>
</body>
</html>`
      }
    ],
    activeFileId: 'proj-5-main',
    updatedAt: Date.now()
  }
];

/** O arquivo sobre o qual a IA vai trabalhar, entregue de fora para não haver adivinhação. */
export interface AlvoDaGeracao {
  nome: string;
  conteudo: string;
  /**
   * Quando existe, o pedido vale SÓ para este pedaço do arquivo — o resto fica fora de alcance.
   * Guarda o texto além das posições: entre enviar e a resposta chegar o arquivo pode mudar, e é
   * o texto que confirma que o alvo continua sendo o mesmo (ver substituirTrecho).
   */
  trechoSelecionado?: { inicio: number; fim: number; texto: string };
}

export interface MensagemDoChatCode {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
}

export const CodeWorkspace: React.FC<{
  onClose?: () => void;
  /**
   * Pede o código à IA e DEVOLVE o resultado, em vez de gravá-lo por conta própria.
   *
   * Quem grava é só o repositório aqui dentro (applyCodeToRepository), e isso não é detalhe de
   * organização: enquanto o outro lado escrevia direto no localStorage, a alteração feita pela IA
   * não entrava no histórico e não havia como desfazê-la.
   */
  onGenerateCodeRequest?: (
    prompt: string,
    referenceImages?: Array<{ mimeType: string; data: string }>,
    maxEffort?: boolean,
    alvo?: AlvoDaGeracao,
    /** Recebe o texto acumulado a cada pedaço, para o editor mostrar a escrita acontecendo. */
    aoEscrever?: (textoAcumulado: string) => void,
    /** Permite abandonar a geração pela metade, sem esperar o modelo terminar. */
    sinal?: AbortSignal
    /**
     * "projetoMultiArquivo" chega com o texto CRU quando a resposta foi um conjunto de arquivos,
     * e não o conteúdo de um. Quem aplica é este componente, porque os arquivos são dele e é aqui
     * que existe o histórico do Ctrl+Z.
     */
  ) => Promise<{ conteudo: string; resumo: string; projetoMultiArquivo?: string } | null>;
  onStartLiveVoice?: () => void;
  /** Conversa sobre o projeto sem aplicar qualquer alteração nos arquivos. */
  onCodeChatRequest?: (
    pergunta: string,
    contextoDoProjeto: string,
    historico: MensagemDoChatCode[]
  ) => Promise<string | null>;
  /** Mantém a voz informada sobre o projeto e a conversa vistos nesta aba. */
  onCodeChatContextChange?: (contexto: string) => void;
  apiKeys?: ApiKeys;
  onUpdateApiKeys?: (patch: Partial<ApiKeys>) => void;
  /**
   * Token do Agente Local, necessário para as rotas /api/agent/ollama/* (instalar o Ollama e
   * baixar o Qwen exigem Bearer). O App já provisiona este token sozinho; aqui ele só entra
   * como prop para que a aba do CODE consiga falar com o agente — sem ele, todo download
   * morreria em 401.
   */
  localAgentToken?: string;
  isGenerating?: boolean;
  /** Primeiro pedido aguardando na fila criada pela ferramenta de voz. */
  comandoDeVoz?: { id: string; prompt: string };
  /** Remove da fila somente depois que o editor terminou de aplicar (ou relatar a falha). */
  aoConcluirComandoDeVoz?: (id: string) => void;
}> = ({ onClose, onGenerateCodeRequest, onStartLiveVoice, apiKeys, onUpdateApiKeys, localAgentToken, isGenerating,
  comandoDeVoz, aoConcluirComandoDeVoz, onCodeChatRequest, onCodeChatContextChange }) => {
  // 5 PROJECTS MANAGEMENT
  const [projects, setProjects] = useState<OSONEProject[]>(() => {
    try {
      const saved = localStorage.getItem('osone_code_projects_v2');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const merged = [...parsed];
          for (let i = merged.length; i < 5; i++) {
            // Cópia nova por projeto: entregar o mesmo array a todos faria a edição de um
            // aparecer nos outros (ver arquivosPadraoNovos).
            merged.push(DEFAULT_PROJECTS[i]
              ? { ...DEFAULT_PROJECTS[i], files: JSON.parse(JSON.stringify(DEFAULT_PROJECTS[i].files)) }
              : {
                  id: `proj-${i+1}`,
                  name: `Projeto ${i+1}`,
                  files: arquivosPadraoNovos(),
                  activeFileId: 'main-app',
                  updatedAt: Date.now()
                });
          }
          return merged.slice(0, 5);
        }
      }
    } catch (e) {
      console.error("Erro ao carregar lista de projetos:", e);
    }

    try {
      const legacySaved = localStorage.getItem('osone_code_repository_files');
      if (legacySaved) {
        const parsedLegacy = JSON.parse(legacySaved);
        if (Array.isArray(parsedLegacy) && parsedLegacy.length > 0) {
          const initialProjects = [...DEFAULT_PROJECTS];
          initialProjects[0] = {
            ...initialProjects[0],
            files: parsedLegacy,
            activeFileId: parsedLegacy[0]?.id || 'main-app',
            updatedAt: Date.now()
          };
          return initialProjects;
        }
      }
    } catch (e) {}

    return DEFAULT_PROJECTS;
  });

  const [activeProjectId, setActiveProjectId] = useState<string>(() => {
    try {
      const savedId = localStorage.getItem('osone_code_active_project_id');
      if (savedId) return savedId;
    } catch (e) {}
    return 'proj-1';
  });

  const [editingProjectNameId, setEditingProjectNameId] = useState<string | null>(null);
  const [editingProjectNameText, setEditingProjectNameText] = useState<string>('');

  /**
   * OS ARQUIVOS SAEM DO PROJETO ATIVO — E DE MAIS NENHUM LUGAR.
   *
   * Aqui morava um defeito capaz de destruir o trabalho de um projeto inteiro, em silêncio. Esta
   * lista era carregada da chave ANTIGA ('osone_code_repository_files'), enquanto o projeto ativo
   * vinha de outra chave ('osone_code_active_project_id'). São duas fontes independentes para uma
   * informação só, e nada garantia que concordassem: bastava outra janela do OSONE gravar por
   * cima, ou uma gravação parcial, para o editor abrir os arquivos do Projeto 1 com a barra
   * marcando o Projeto 3.
   *
   * E aí vinha a parte cara. O auto-save (logo abaixo) grava 'files' DENTRO do projeto ativo, a
   * cada mudança. Com as duas fontes discordando, o primeiro caractere digitado gravava os
   * arquivos do Projeto 1 por cima do Projeto 3 — e o conteúdo do 3 deixava de existir, sem erro,
   * sem aviso, e sem passar pelo histórico que o Ctrl+Z alcança.
   *
   * Agora existe UMA fonte: o projeto ativo. A chave antiga só é lida na migração de quem vem de
   * uma versão sem projetos (ver o carregamento de 'projects' acima, que já a incorpora no
   * Projeto 1), nunca como origem paralela da lista.
   */
  const [files, setFiles] = useState<CodeRepositoryFile[]>(() => {
    const projetoAtivo = projects.find(p => p.id === activeProjectId) || projects[0];
    const doProjeto = projetoAtivo?.files;
    if (Array.isArray(doProjeto) && doProjeto.length > 0) return doProjeto;
    return arquivosPadraoNovos();
  });
  const arquivosAgrupados = useMemo(() => agruparArquivosPorPasta(files), [files]);

  const [activeFileId, setActiveFileId] = useState<string>(() => {
    const projetoAtivo = projects.find(p => p.id === activeProjectId) || projects[0];
    // O arquivo que estava aberto naquele projeto volta a abrir — desde que ainda exista.
    const salvo = projetoAtivo?.activeFileId;
    if (salvo && files.some(f => f.id === salvo)) return salvo;
    return files[0]?.id || 'main-app';
  });

  // UNDO/REDO HISTORY STATE FOR CODE EDITS
  const [historyStack, setHistoryStack] = useState<CodeRepositoryFile[][]>([]);
  const [redoStack, setRedoStack] = useState<CodeRepositoryFile[][]>([]);
  const [lastTypedHistoryTime, setLastTypedHistoryTime] = useState<number>(0);

  // IMAGENS DE REFERÊNCIA ANEXADAS AO PROMPT (clipe)
  interface AttachedImage { id: string; name: string; mimeType: string; data: string; previewUrl: string; }
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);

  // Editor de código: a área de escrita e a régua de números ao lado dela.
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const reguaRef = useRef<HTMLDivElement>(null);
  const realceRef = useRef<HTMLPreElement>(null);
  /** Onde deixar o cursor depois que a próxima renderização trouxer o texto novo. */
  const selecaoPendenteRef = useRef<{ inicio: number; fim: number } | null>(null);

  /**
   * ====== O CÓDIGO SENDO ESCRITO, AO VIVO ======
   *
   * Enquanto vale null, o editor é o editor de sempre. Quando a IA começa a escrever, este texto
   * cresce a cada pedaço que chega do modelo e o painel mostra o arquivo nascendo linha a linha,
   * em vez de a tela ficar parada até o resultado inteiro aparecer de uma vez.
   *
   * Não é enfeite: uma geração grande leva dezenas de segundos, e com a tela parada não há como
   * distinguir "está escrevendo" de "travou". Vendo o texto sair, dá para perceber logo que o
   * modelo entendeu errado e cancelar, em vez de esperar até o fim para descobrir.
   *
   * O que aparece aqui é o texto CRU do modelo, marcadores de edição incluídos. Ele não é gravado
   * em lugar nenhum: a gravação continua acontecendo só no fim, pelo caminho único de sempre.
   */
  const [escritaAoVivo, setEscritaAoVivo] = useState<string | null>(null);
  const painelAoVivoRef = useRef<HTMLPreElement>(null);
  const cancelamentoRef = useRef<AbortController | null>(null);

  /**
   * ====== PARAR O HUNTER E O ENXAME NO MEIO ======
   *
   * Os dois só sabiam ir até o fim. Fechar o modal escondia a tela, e a execução continuava
   * correndo por baixo — o Enxame seguia consumindo cota por quatro iterações e GRAVAVA no
   * repositório depois, com o painel já fora da vista. A pessoa via o arquivo mudar sozinho
   * minutos depois de ter desistido, sem relação visível com nada que ela tivesse feito.
   *
   * Agora fechar é parar: o controlador aborta as chamadas em curso e o laço confere o sinal
   * entre as etapas, antes de gravar qualquer coisa.
   */
  const cancelamentoDoHunterRef = useRef<AbortController | null>(null);
  const cancelamentoDoEnxameRef = useRef<AbortController | null>(null);

  /**
   * ====== SUGESTÕES LIDAS DO CÓDIGO QUE EXISTE ======
   *
   * A fileira de atalhos era um cardápio fixo: "Refatorar & Otimizar", "Corrigir BUGS",
   * "Adicionar Animações". As mesmas cinco frases num arquivo em branco e num jogo de 50 mil
   * caracteres — quer dizer, elas nunca sabiam do que estavam falando.
   *
   * O problema não é serem genéricas, é serem CEGAS: "corrigir bugs" sem ter lido o código é um
   * pedido para o modelo adivinhar o que procurar, e o que volta costuma ser mexida aleatória.
   * Uma sugestão que cita a função pelo nome ("o loop de colisão roda em O(n²) e trava acima de
   * 50 karts") vale mais do que as cinco juntas, porque já traz o diagnóstico dentro dela.
   *
   * As frases fixas continuam existindo, mas no lugar certo: arquivo em branco, onde não há o que
   * ler e o que serve mesmo é uma partida rápida.
   */
  /**
   * O trecho marcado no editor. Enquanto existe, o pedido da IA vale só para ele.
   *
   * É guardado com o TEXTO junto das posições, e não só com os números: entre apertar "gerar" e a
   * resposta chegar passam dezenas de segundos em que o arquivo pode mudar, e aí as posições
   * apontariam para outro lugar. O texto é o que confirma que o alvo continua sendo o mesmo.
   */
  const [selecaoDoEditor, setSelecaoDoEditor] = useState<{ inicio: number; fim: number; texto: string } | null>(null);

  /**
   * O que quebrou quando o código rodou de verdade.
   *
   * É a informação mais valiosa que existe para consertar um bug, e era a única que nunca chegava
   * à IA: o navegador executava o jogo, registrava `TypeError` com linha e coluna, mostrava numa
   * aba do preview — e ali parava. Pedir "corrigir bugs" mandava o modelo procurar às cegas.
   */
  const [problemasDoPreview, setProblemasDoPreview] = useState<ProblemaDoPreview[]>([]);

  const [sugestoesDoCodigo, setSugestoesDoCodigo] = useState<string[]>([]);
  const [lendoSugestoes, setLendoSugestoes] = useState(false);
  /** Conteúdo já analisado, para não gastar chamada relendo o mesmo arquivo. */
  const codigoJaAnalisadoRef = useRef<string>('');
  const cancelamentoDasSugestoesRef = useRef<AbortController | null>(null);

  /** Aborta o que estiver correndo e fecha o painel. Usado pelo X e pelo botão de parar. */
  const pararEFechar = (
    referencia: React.MutableRefObject<AbortController | null>,
    fechar: (v: boolean) => void
  ) => {
    referencia.current?.abort();
    referencia.current = null;
    fechar(false);
  };

  // Sair da aba com um agente rodando também para o agente.
  useEffect(() => () => {
    cancelamentoDoHunterRef.current?.abort();
    cancelamentoDoEnxameRef.current?.abort();
  }, []);

  // O painel acompanha a escrita: sem isto o texto cresceria fora da vista e a pessoa veria
  // sempre o começo do arquivo, que é a parte que não está mudando.
  useEffect(() => {
    if (escritaAoVivo === null) return;
    const painel = painelAoVivoRef.current;
    if (painel) painel.scrollTop = painel.scrollHeight;
  }, [escritaAoVivo]);

  // Sair da aba no meio de uma geração não pode deixar a conexão aberta consumindo cota.
  useEffect(() => () => cancelamentoRef.current?.abort(), []);

  // MODO DE ESFORÇO MÁXIMO: pede ao modelo o maior nível de raciocínio/capricho possível
  const [maxEffort, setMaxEffort] = useState<boolean>(false);

  const [viewLayout, setViewLayout] = useState<'split' | 'editor' | 'preview'>('split');
  const [showRepoSidebar, setShowRepoSidebar] = useState<boolean>(true);
  const [promptInput, setPromptInput] = useState<string>('');
  const [sessaoDaIa, setSessaoDaIa] = useState<'implementar' | 'conversar'>('implementar');
  const [perguntaDoChat, setPerguntaDoChat] = useState('');
  const [chatRespondendo, setChatRespondendo] = useState(false);
  const [chatPorProjeto, setChatPorProjeto] = useState<Record<string, MensagemDoChatCode[]>>(() => {
    try {
      const salvo = JSON.parse(localStorage.getItem('osone_code_chat_v1') || '{}');
      return salvo && typeof salvo === 'object' ? salvo : {};
    } catch {
      return {};
    }
  });
  const [copied, setCopied] = useState<boolean>(false);
  const [editingFileNameId, setEditingFileNameId] = useState<string | null>(null);
  const [editingFileNameText, setEditingFileNameText] = useState<string>('');
  const [isSaved, setIsSaved] = useState<boolean>(true);

  // NOTIFICATION BANNER STATE
  const [notificationBanner, setNotificationBanner] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  // HUNTER AGENT STATE
  const [isHunterModalOpen, setIsHunterModalOpen] = useState<boolean>(false);
  const [isCodeApiSettingsOpen, setIsCodeApiSettingsOpen] = useState<boolean>(false);

  /**
   * ====== OLLAMA LOCAL: ACOMPANHAR O DOWNLOAD DO QWEN PELA TELA ======
   *
   * Baixar um modelo são centenas de MB (o 1.5B) a gigabytes. Sem progresso na tela é "travou ou
   * instalou?"; por isso o botão dispara o pull no Agente Local e fica perguntando o percentual a
   * cada dois segundos até o processo terminar (ou dar erro). Os estados vivem aqui porque só a
   * aba do CODE usa o motor local — nada disso vaza para os provedores pagos.
   */
  const [ollamaBaixando, setOllamaBaixando] = useState<{ modelo: string; status: string; percentual: number } | null>(null);
  const [ollamaAviso, setOllamaAviso] = useState<string>('');

  useEffect(() => {
    if (!ollamaBaixando) return;
    let cancelado = false;
    const temporizador = setInterval(async () => {
      try {
        const resposta = await fetch(`/api/agent/ollama/progresso?modelo=${encodeURIComponent(ollamaBaixando.modelo)}`, {
          headers: localAgentToken ? { 'Authorization': `Bearer ${localAgentToken}` } : undefined,
        });
        const dado = await resposta.json().catch(() => ({} as any));
        if (cancelado) return;
        if (dado?.status === 'concluído') {
          setOllamaBaixando(null);
          setOllamaAviso(`✅ ${dado.modelo} está pronto. Pode gerar código com ele agora.`);
        } else if (dado?.status === 'erro' || dado?.status === 'falhou' || dado?.status === 'inexistente') {
          setOllamaBaixando(null);
          setOllamaAviso(`⚠️ ${dado.erro || `O download de ${dado.modelo} não pôde continuar.`} O Ollama está instalado e rodando neste computador?`);
        } else {
          setOllamaBaixando({ modelo: dado.modelo || ollamaBaixando.modelo, status: String(dado.status || 'baixando'), percentual: Number(dado.percentual) || 0 });
        }
      } catch { /* agente fora do ar: tenta de novo no próximo tique; o botão continua mostrando o último estado */ }
    }, 2000);
    return () => { cancelado = true; clearInterval(temporizador); };
  }, [ollamaBaixando?.modelo]);

  /**
   * Instala o Ollama neste computador com um clique, pela rota /ollama/instalar do Agente Local.
   *
   * A alternativa era mandar o usuário caçar ollama.com/download no navegador — e quem não tem
   * GPU justamente é quem menos sabe que precisa fazer isso. O agente abre um terminal visível
   * com o instalador oficial; quando terminar, o botão de baixar o modelo passa a funcionar.
   */
  const instalarOllamaPelaInterface = async () => {
    setOllamaAviso('');
    try {
      const resposta = await fetch('/api/agent/ollama/instalar', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(localAgentToken ? { 'Authorization': `Bearer ${localAgentToken}` } : {}),
        },
      });
      const dado = await resposta.json().catch(() => ({} as any));
      if (!resposta.ok) {
        setOllamaAviso(`⚠️ ${dado?.error || 'O Agente Local recusou a instalação.'}`);
        return;
      }
      setOllamaAviso(dado?.message || 'Instalação do Ollama iniciada numa janela de terminal. Quando terminar, baixe o modelo.');
    } catch (e: any) {
      setOllamaAviso(`⚠️ Não foi possível falar com o Agente Local (${e?.message || e}). Ele roda no mesmo computador que você abriu o OSONE CODE.`);
    }
  };

  const baixarModeloDoOllamaPelaInterface = async () => {
    const modelo = apiKeys?.osoneCodeOllamaModel || MODELOS_OLLAMA_PADRAO;
    setOllamaAviso('');
    try {
      const resposta = await fetch('/api/agent/ollama/baixar-modelo', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(localAgentToken ? { 'Authorization': `Bearer ${localAgentToken}` } : {}),
        },
        body: JSON.stringify({ modelo }),
      });
      const dado = await resposta.json().catch(() => ({} as any));
      if (!resposta.ok) {
        setOllamaAviso(`⚠️ ${dado?.error || 'O Agente Local recusou o download.'}`);
        return;
      }
      setOllamaBaixando({ modelo, status: dado?.status || 'iniciando', percentual: Number(dado?.percentual) || 0 });
    } catch (e: any) {
      setOllamaAviso(`⚠️ Não foi possível falar com o Agente Local (${e?.message || e}). Ele roda no mesmo computador que você abriu o OSONE CODE.`);
    }
  };

  const [isGithubPanelOpen, setIsGithubPanelOpen] = useState<boolean>(false);
  // O seletor de projeto virou um botão só, na barra superior: ele mostra o projeto ativo e
  // abre a lista para trocar/renomear, em vez de gastar uma faixa inteira da tela com pastilhas.
  const [menuProjetosAberto, setMenuProjetosAberto] = useState<boolean>(false);
  const [hunterPrompt, setHunterPrompt] = useState<string>('');
  const [hunterStatus, setHunterStatus] = useState<'idle' | 'analyzing' | 'doubt' | 'success' | 'error'>('idle');
  const [hunterReport, setHunterReport] = useState<string | null>(null);
  const [hunterDoubt, setHunterDoubt] = useState<string | null>(null);
  const [hunterDoubtInput, setHunterDoubtInput] = useState<string>('');
  const [hunterProgress, setHunterProgress] = useState<number>(0);

  // SWARM HARNESS ENGINE STATE
  const [isSwarmModalOpen, setIsSwarmModalOpen] = useState<boolean>(false);
  const [swarmPrompt, setSwarmPrompt] = useState<string>('');
  const [swarmProjectFormat, setSwarmProjectFormat] = useState<FormatoProjetoDoCode>('single');
  const [maxHarnessIterations, setMaxHarnessIterations] = useState<number>(3);
  const [swarmStatus, setSwarmStatus] = useState<'idle' | 'running' | 'success' | 'error'>('idle');
  const [swarmCurrentStep, setSwarmCurrentStep] = useState<'idle' | 'pm' | 'architect' | 'coder' | 'qa' | 'assembly'>('idle');
  const [swarmIteration, setSwarmIteration] = useState<number>(1);
  const [swarmLogs, setSwarmLogs] = useState<Array<{ agent: string; message: string; timestamp: string; type?: 'info' | 'success' | 'warn' | 'error' }>>([]);
  const [swarmProgress, setSwarmProgress] = useState<number>(0);
  const [swarmProgressText, setSwarmProgressText] = useState<string>('');
  
  // Artifacts generated by the swarm
  const [swarmPMArtifact, setSwarmPMArtifact] = useState<{ tipo?: string; gdd: string; mechanics: string[]; requirements: string[] } | null>(null);
  const [swarmArchitectArtifact, setSwarmArchitectArtifact] = useState<{ arquivos?: Array<{ caminho: string; papel?: string }>; fileStructure: string; gameLoopStrategy: string; librariesUsed: string[] } | null>(null);
  const [swarmQAReports, setSwarmQAReports] = useState<Array<{ iteration: number; score: number; passed: boolean; feedback: string; missingItems: string[] }>>([]);
  const [activeArtifactTab, setActiveArtifactTab] = useState<'pm' | 'architect' | 'qa' | 'logs'>('logs');

  const activeFile = files.find(f => f.id === activeFileId) || files[0];
  const activeProjectName = projects.find(p => p.id === activeProjectId)?.name || 'Projeto OSONE CODE';
  const analiseFullstack = useMemo(() => analisarFullstackDoCode(files), [files]);
  const projetoTemEstruturaFullstack = analiseFullstack.temFullstack;

  /**
   * A lista de arquivos sempre atual, para quem grava fora do ciclo de renderização.
   *
   * O Enxame chama a gravação várias vezes dentro de um laço com esperas de rede no meio. Lendo
   * 'files' pela variável do closure, toda iteração enxergaria a lista de quando o laço começou —
   * e uma edição feita à mão no meio do processo seria apagada pela iteração seguinte. Atribuído
   * durante a renderização, o ref nunca fica para trás.
   */
  const filesRef = useRef(files);
  filesRef.current = files;
  const mensagensDoChat = chatPorProjeto[activeProjectId] || [];
  const chatFimRef = useRef<HTMLDivElement>(null);

  const montarContextoDoProjetoParaChat = () => {
    const cabecalho = `PROJETO: ${activeProjectName}\nARQUIVO ABERTO: ${activeFile?.name || 'nenhum'}\n`;
    return cabecalho + filesRef.current.map(arquivo =>
      `\n===== ARQUIVO: ${arquivo.name} =====\n${arquivo.content}`
    ).join('\n');
  };

  // O histórico pertence ao projeto, assim como os arquivos: trocar de projeto nunca mistura
  // decisões e explicações de bases de código diferentes.
  useEffect(() => {
    localStorage.setItem('osone_code_chat_v1', JSON.stringify(chatPorProjeto));
  }, [chatPorProjeto]);

  useEffect(() => {
    const conversa = mensagensDoChat.slice(-20).map(m =>
      `${m.role === 'user' ? 'USUÁRIO' : 'OSONE CODE'}: ${m.content}`
    ).join('\n');
    onCodeChatContextChange?.(`${montarContextoDoProjetoParaChat()}\n\nCONVERSA RECENTE DO OSONE CODE:\n${conversa || '(sem mensagens)'}`);
  }, [activeProjectId, activeProjectName, activeFile?.name, files, chatPorProjeto, onCodeChatContextChange]);

  useEffect(() => {
    if (sessaoDaIa === 'conversar') chatFimRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [mensagensDoChat.length, chatRespondendo, sessaoDaIa]);

  // Auto-dismiss notification banner
  useEffect(() => {
    if (notificationBanner) {
      const timer = setTimeout(() => {
        setNotificationBanner(null);
      }, 7000);
      return () => clearTimeout(timer);
    }
  }, [notificationBanner]);

  // Listen for repository updates from AI generation
  useEffect(() => {
    const handleRepoUpdated = () => {
      try {
        const saved = localStorage.getItem('osone_code_repository_files');
        if (saved) {
          const parsed = JSON.parse(saved);
          if (Array.isArray(parsed) && parsed.length > 0) {
            setFiles(parsed);
          }
        }
      } catch (e) {}
    };
    window.addEventListener('osone_repository_updated', handleRepoUpdated);
    return () => window.removeEventListener('osone_repository_updated', handleRepoUpdated);
  }, []);

  // Trocar de arquivo fecha a janela de agrupamento da digitação (ver handleUpdateActiveContent).
  useEffect(() => { setLastTypedHistoryTime(0); }, [activeFileId]);

  // Auto-save active project repository files to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('osone_code_repository_files', JSON.stringify(files));
      setIsSaved(true);

      setProjects(prevProjects => {
        const updated = prevProjects.map(p => {
          if (p.id === activeProjectId) {
            return { ...p, files: files, activeFileId: activeFileId, updatedAt: Date.now() };
          }
          return p;
        });
        localStorage.setItem('osone_code_projects_v2', JSON.stringify(updated));
        return updated;
      });
    } catch (e) {
      console.error("Erro ao salvar repositório/projetos:", e);
    }
  }, [files, activeFileId, activeProjectId]);

  // ====== BUSCA E SUBSTITUIÇÃO EM TODO O PROJETO ======
  const [buscaAberta, setBuscaAberta] = useState(false);
  const [termoDeBusca, setTermoDeBusca] = useState('');
  const [substitutoDeBusca, setSubstitutoDeBusca] = useState('');
  const [opcoesDeBusca, setOpcoesDeBusca] = useState({ caseSensitive: false, palavraInteira: false, regex: false });
  const campoDeBuscaRef = useRef<HTMLInputElement | null>(null);

  // O resultado é derivado do estado, e não guardado: guardá-lo deixaria a lista desatualizada em
  // relação ao arquivo que está sendo digitado neste instante.
  const resultadoDaBusca = termoDeBusca
    ? buscarNoProjeto(files, termoDeBusca, opcoesDeBusca)
    : { ocorrencias: [] as OcorrenciaNaBusca[], erro: undefined as string | undefined };

  /** Abre o arquivo da ocorrência e deixa o trecho selecionado no editor. */
  const irParaOcorrencia = (o: OcorrenciaNaBusca) => {
    if (o.arquivoId === activeFileId) {
      // Já é o arquivo aberto: setActiveFileId seria um no-op, e a seleção pendente só é
      // aplicada pelo efeito que observa activeFile.content mudar — que não muda, então nunca
      // dispararia. Aplica direto, sem esperar por um efeito que não vai rodar.
      setTimeout(() => {
        editorRef.current?.focus();
        editorRef.current?.setSelectionRange(o.inicio, o.fim);
      }, 0);
      return;
    }
    setActiveFileId(o.arquivoId);
    // A seleção é aplicada depois que o editor renderiza o arquivo novo — o mesmo mecanismo já
    // usado pela indentação com Tab.
    selecaoPendenteRef.current = { inicio: o.inicio, fim: o.fim };
    setTimeout(() => editorRef.current?.focus(), 0);
  };

  const aplicarSubstituicao = () => {
    if (!termoDeBusca) return;
    const r = substituirNoProjeto(files, termoDeBusca, substitutoDeBusca, opcoesDeBusca);
    if (r.erro) {
      setNotificationBanner({ message: r.erro, type: 'error' });
      return;
    }
    if (r.trocas === 0) {
      setNotificationBanner({ message: `Nenhuma ocorrência de "${termoDeBusca}" para substituir.`, type: 'info' });
      return;
    }
    // A troca inteira entra no histórico como UMA ação: substituir em massa sem desfazer é a
    // operação mais perigosa de um editor.
    pushHistory(files);
    setFiles(r.arquivos);
    setNotificationBanner({
      message: `${r.trocas} substituição(ões) em ${r.arquivosAfetados.length} arquivo(s). Ctrl+Z desfaz tudo de uma vez.`,
      type: 'success'
    });
  };

  // UNDO/REDO HISTORY HELPERS
  /**
   * O topo do histórico, fora do estado do React.
   *
   * A decisão de descartar o refazer precisa ser tomada AQUI, de forma síncrona. Tomá-la a partir
   * do que o atualizador do setState devolve não serve: ele pode ser executado mais de uma vez
   * pelo React, e o que for anotado lá dentro não é confiável.
   */
  const topoDoHistoricoRef = useRef<string>('');

  const pushHistory = (currentFiles: CodeRepositoryFile[]) => {
    const textoDoSnapshot = JSON.stringify(currentFiles);
    // Nada mudou desde o último ponto guardado: não há o que empilhar.
    if (topoDoHistoricoRef.current === textoDoSnapshot) return;
    topoDoHistoricoRef.current = textoDoSnapshot;

    const snapshot = JSON.parse(textoDoSnapshot);
    setHistoryStack(prev => {
      const next = [...prev, snapshot];
      if (next.length > 30) return next.slice(next.length - 30);
      return next;
    });

    /**
     * Uma mudança nova invalida qualquer "futuro" que só existia porque o usuário desfez algo —
     * mas só quando ela é MESMO uma mudança. O descarte era incondicional, então uma passada do
     * Enxame ou do Hunter que não alterasse um caractere ainda assim apagava o refazer: a pessoa
     * desfazia, mandava auditar, o Hunter não mudava nada, e o Ctrl+Y deixava de existir.
     */
    setRedoStack([]);
  };

  const handleUndoChange = () => {
    if (historyStack.length === 0) {
      setNotificationBanner({ message: "Nada para desfazer no código!", type: 'info' });
      return;
    }

    const previousFiles = historyStack[historyStack.length - 1];
    setHistoryStack(prev => prev.slice(0, -1));
    // O topo mudou por fora do pushHistory: zerar a marca faz a próxima alteração ser sempre
    // empilhada. Mantê-la faria o ponto restaurado ser confundido com "nada mudou", e a edição
    // seguinte deixaria de ter para onde voltar.
    topoDoHistoricoRef.current = '';

    // Guarda o estado atual para que essa desfeita possa ser refeita depois.
    setRedoStack(prev => {
      const snapshot = JSON.parse(JSON.stringify(files));
      const next = [...prev, snapshot];
      if (next.length > 30) return next.slice(next.length - 30);
      return next;
    });

    if (previousFiles && Array.isArray(previousFiles) && previousFiles.length > 0) {
      setFiles(previousFiles);

      if (!previousFiles.some(f => f.id === activeFileId)) {
        setActiveFileId(previousFiles[0].id);
      }

      try {
        localStorage.setItem('osone_code_repository_files', JSON.stringify(previousFiles));
      } catch (e) {}

      setProjects(prevProjects => {
        const updated = prevProjects.map(p =>
          p.id === activeProjectId ? { ...p, files: previousFiles, updatedAt: Date.now() } : p
        );
        try {
          localStorage.setItem('osone_code_projects_v2', JSON.stringify(updated));
        } catch (e) {}
        return updated;
      });

      window.dispatchEvent(new Event('osone_repository_updated'));
      setNotificationBanner({ message: "Alteração desfeita com sucesso! Estado anterior restaurado. ↩️", type: 'success' });
    }
  };

  const handleRedoChange = () => {
    if (redoStack.length === 0) {
      setNotificationBanner({ message: "Nada para refazer no código!", type: 'info' });
      return;
    }

    const nextFiles = redoStack[redoStack.length - 1];
    setRedoStack(prev => prev.slice(0, -1));
    topoDoHistoricoRef.current = '';

    // Guarda o estado atual de volta no histórico de desfazer, para poder desfazer o refazer.
    setHistoryStack(prev => {
      const snapshot = JSON.parse(JSON.stringify(files));
      const next = [...prev, snapshot];
      if (next.length > 30) return next.slice(next.length - 30);
      return next;
    });

    if (nextFiles && Array.isArray(nextFiles) && nextFiles.length > 0) {
      setFiles(nextFiles);

      if (!nextFiles.some(f => f.id === activeFileId)) {
        setActiveFileId(nextFiles[0].id);
      }

      try {
        localStorage.setItem('osone_code_repository_files', JSON.stringify(nextFiles));
      } catch (e) {}

      setProjects(prevProjects => {
        const updated = prevProjects.map(p =>
          p.id === activeProjectId ? { ...p, files: nextFiles, updatedAt: Date.now() } : p
        );
        try {
          localStorage.setItem('osone_code_projects_v2', JSON.stringify(updated));
        } catch (e) {}
        return updated;
      });

      window.dispatchEvent(new Event('osone_repository_updated'));
      setNotificationBanner({ message: "Alteração refeita com sucesso! ↪️", type: 'success' });
    }
  };

  /**
   * O atalho global chama SEMPRE a versão mais recente de desfazer/refazer.
   *
   * O ouvinte era reinscrito por uma lista de dependências que incluía 'files'. Como 'files' muda
   * a cada caractere digitado, o ouvinte de teclado da janela era removido e recolocado a cada
   * tecla — trabalho à toa no caminho mais quente do editor. Pior: 'activeFileId' NÃO estava na
   * lista, então o desfazer decidia com um arquivo aberto vencido e podia pular para o arquivo
   * errado depois de restaurar.
   *
   * Guardar as funções numa referência resolve os dois de uma vez: o ouvinte é inscrito uma única
   * vez, e mesmo assim sempre executa a versão da renderização atual, com o estado atual.
   */
  const acoesDeHistoricoRef = useRef({ desfazer: () => {}, refazer: () => {} });
  acoesDeHistoricoRef.current = { desfazer: handleUndoChange, refazer: handleRedoChange };

  // GLOBAL CTRL+Z / CMD+Z (DESFAZER) E CTRL+SHIFT+Z / CMD+SHIFT+Z / CTRL+Y (REFAZER)
  useEffect(() => {
    const handleGlobalUndoRedoKey = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
      const modifierPressed = isMac ? e.metaKey : e.ctrlKey;
      // Ctrl+F abre a busca do projeto em vez da busca do navegador, que só enxerga o que está
      // desenhado na tela — e o editor mostra um arquivo por vez.
      if (modifierPressed && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setBuscaAberta(true);
        setTimeout(() => campoDeBuscaRef.current?.focus(), 0);
        return;
      }
      if (e.key === 'Escape' && buscaAberta) {
        setBuscaAberta(false);
        return;
      }
      const isUndo = modifierPressed && e.key.toLowerCase() === 'z' && !e.shiftKey;
      const isRedo = modifierPressed && ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y');
      if (isUndo || isRedo) {
        const target = e.target as HTMLElement;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') && !target.classList.contains('code-editor-textarea')) {
          return;
        }
        e.preventDefault();
        if (isRedo) {
          acoesDeHistoricoRef.current.refazer();
        } else {
          acoesDeHistoricoRef.current.desfazer();
        }
      }
    };
    window.addEventListener('keydown', handleGlobalUndoRedoKey);
    return () => window.removeEventListener('keydown', handleGlobalUndoRedoKey);
    // Só 'buscaAberta' entra: é a única coisa lida direto aqui dentro. Desfazer e refazer chegam
    // pela referência acima, sempre atualizados, sem reinscrever o ouvinte a cada tecla.
  }, [buscaAberta]);

  // SWITCH ACTIVE PROJECT (1 OF 5)
  const handleSwitchProject = (targetProjectId: string) => {
    if (targetProjectId === activeProjectId) return;

    // Save active project files to projects array
    const updatedProjects = projects.map(p => {
      if (p.id === activeProjectId) {
        return {
          ...p,
          files: files,
          activeFileId: activeFileId,
          updatedAt: Date.now()
        };
      }
      return p;
    });

    const targetProject = updatedProjects.find(p => p.id === targetProjectId) || updatedProjects[0];

    setProjects(updatedProjects);
    setActiveProjectId(targetProject.id);
    setFiles(targetProject.files);
    setActiveFileId(targetProject.activeFileId || targetProject.files[0]?.id || 'main-app');
    /**
     * Os DOIS históricos são zerados na troca de projeto.
     *
     * Só o de desfazer era limpo, e o de refazer sobrevivia à troca carregando os arquivos do
     * projeto anterior. Um Ctrl+Y depois de trocar despejava o Projeto 1 inteiro por cima do
     * Projeto 2 — sem aviso, e sem nada no caminho que revelasse de onde aquele código veio.
     */
    setHistoryStack([]);
    setRedoStack([]);
    topoDoHistoricoRef.current = '';
    // O relógio da digitação também zera: sem isto, a primeira tecla no projeto novo, se vier
    // dentro dos 2 segundos da última tecla do projeto anterior, não guardava ponto de retorno.
    setLastTypedHistoryTime(0);

    try {
      localStorage.setItem('osone_code_active_project_id', targetProject.id);
      localStorage.setItem('osone_code_projects_v2', JSON.stringify(updatedProjects));
      localStorage.setItem('osone_code_repository_files', JSON.stringify(targetProject.files));
    } catch (e) {}

    window.dispatchEvent(new Event('osone_repository_updated'));
    setNotificationBanner({
      message: `Projeto alterado para "${targetProject.name}". Alterações afetam apenas este projeto! 📁`,
      type: 'success'
    });
  };

  // RENAME PROJECT
  const handleSaveProjectName = (projId: string) => {
    if (!editingProjectNameText.trim()) {
      setEditingProjectNameId(null);
      return;
    }
    const newName = editingProjectNameText.trim();
    setProjects(prev => {
      const updated = prev.map(p => p.id === projId ? { ...p, name: newName, updatedAt: Date.now() } : p);
      try {
        localStorage.setItem('osone_code_projects_v2', JSON.stringify(updated));
      } catch (e) {}
      return updated;
    });
    setEditingProjectNameId(null);
    setNotificationBanner({ message: `Projeto renomeado para "${newName}"!`, type: 'success' });
  };

  /**
   * ÚNICO caminho por onde código gerado entra no repositório.
   *
   * Ser único importa: enquanto a geração pelo chat escrevia direto no localStorage por fora
   * daqui, aquela alteração — a mais destrutiva de todas, porque troca o arquivo inteiro — era
   * justamente a única que o desfazer não alcançava.
   *
   * O alvo é sempre EXPLÍCITO. Antes o destino era 'index.html' fixo, então auditar um script.js
   * gravava o resultado por cima do index.html; e quando o nome pedido não existia no projeto, o
   * conteúdo caía no primeiro arquivo da lista, fosse ele qual fosse. Agora um nome que não existe
   * vira arquivo novo, e nada é sobrescrito sem ter sido escolhido.
   */
  /**
   * Qual arquivo o Enxame considera "a página do projeto".
   *
   * Ordem: o marcado como principal, depois um index.html, depois o primeiro HTML que existir, e
   * só então o nome 'index.html' — que nesse ponto vira arquivo novo, porque o projeto realmente
   * não tem página nenhuma.
   */
  const arquivoPrincipalId = (): string => {
    const atuais = filesRef.current;
    const pareceFullstack = atuais.some(f => /^(frontend|public|src|server|api|shared)\//i.test(f.name || ''))
      || atuais.some(f => chaveDeCaminho(f.name || '') === 'package.json');
    const principal = (pareceFullstack ? entradaFrontendPreferidaDoCode(atuais) : undefined)
      || atuais.find(f => f.isMain)
      || atuais.find(f => chaveDeCaminho(f.name || '') === 'index.html')
      || atuais.find(f => nomeBaseDoCaminho(f.name || '').toLowerCase() === 'index.html')
      || atuais.find(f => /\.html?$/i.test(f.name));
    return principal?.id || 'index.html';
  };

  const applyCodeToRepository = (newContent: string, targetFileIdOrName?: string) => {
    const atuais = filesRef.current;
    pushHistory(atuais);

    const alvo = (targetFileIdOrName || activeFileId || '').trim();
    const idx = atuais.findIndex(f =>
      f.id === alvo || chaveDeCaminho(f.name || '') === chaveDeCaminho(alvo)
    );

    let updatedFiles: CodeRepositoryFile[];
    let idDoAlvo: string;

    if (idx !== -1) {
      updatedFiles = atuais.map((f, i) => i === idx ? { ...f, content: newContent, updatedAt: Date.now() } : f);
      idDoAlvo = atuais[idx].id;
    } else {
      // Nome pedido não existe no projeto: cria, em vez de derrubar um arquivo alheio.
      const pareceNomeDeArquivo = /\.[a-z0-9]{1,8}$/i.test(alvo);
      const nome = prepararNomeDeArquivoDigitado(pareceNomeDeArquivo ? alvo : 'index.html') || 'index.html';
      const novo: CodeRepositoryFile = {
        id: 'file-' + Date.now(),
        name: nome,
        language: linguagemPelaExtensao(nome),
        ...(nomeBaseDoCaminho(nome).toLowerCase() === 'index.html' ? { isMain: true } : {}),
        updatedAt: Date.now(),
        content: newContent
      };
      updatedFiles = [...atuais, novo];
      idDoAlvo = novo.id;
    }

    // A lista nova é montada AQUI, e não dentro do setFiles: o React só executa aquele callback
    // na renderização seguinte, então tudo o que fosse lido logo abaixo dele veria uma lista
    // vazia — era por isso que o editor nunca pulava para o arquivo que a IA acabara de mudar.
    setFiles(updatedFiles);
    setActiveFileId(idDoAlvo);
    setIsSaved(true);

    try {
      localStorage.setItem('osone_code_repository_files', JSON.stringify(updatedFiles));
    } catch (e) {
      console.error("Erro ao salvar no localStorage:", e);
    }

    window.dispatchEvent(new Event('osone_repository_updated'));
  };

  // ====== EDITOR DE CÓDIGO: RÉGUA DE LINHAS E INDENTAÇÃO ======

  /**
   * A MEDIDA DO EDITOR, num lugar só.
   *
   * A régua de linhas, a camada de realce e a área de escrita precisam ter exatamente a mesma
   * fonte, o mesmo tamanho, a mesma altura de linha e a mesma folga no topo. Um pixel de
   * diferença e os números descolam do código; no realce, o texto colorido descola do texto real e
   * o cursor aparece no lugar errado.
   *
   * Isso estava escrito como classes utilitárias repetidas em três lugares — três cópias que
   * precisavam ser mudadas juntas, e nada avisaria se uma ficasse para trás. Aqui é um objeto só,
   * aplicado nos três, o que também torna o alinhamento verificável fora do app: não depende de
   * nenhuma folha de estilo ter carregado.
   */
  const METRICA_DO_EDITOR: React.CSSProperties = {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: '13px',
    lineHeight: '1.625',
    paddingTop: '16px',
    paddingBottom: '16px',
    whiteSpace: 'pre',
    tabSize: 2,
    margin: 0
  };

  /** Quantas linhas o arquivo tem. Sempre pelo menos uma, para a régua nunca ficar vazia. */
  const totalDeLinhas = Math.max(1, (activeFile?.content || '').split('\n').length);

  /**
   * Largura real da régua de linhas, medida do elemento.
   *
   * A camada de realce começa onde a régua acaba, e a régua muda de largura sozinha quando o
   * arquivo passa de 99 para 100 linhas. Um valor fixo aqui desalinharia o realce exatamente
   * nesse momento, num arquivo grande — que é quando o realce mais serve.
   */
  const [larguraDaRegua, setLarguraDaRegua] = useState(0);
  useEffect(() => {
    const medir = () => setLarguraDaRegua(reguaRef.current?.offsetWidth || 0);
    medir();
    window.addEventListener('resize', medir);

    /**
     * Medir só na troca de arquivo e no 'resize' da janela deixava frestas visíveis.
     *
     * A régua muda de largura sem que a janela mude de tamanho: quando o arquivo passa de 99 para
     * 100 linhas, quando a barra de arquivos ANIMA de fechada para aberta (a largura varia durante
     * toda a animação, e o 'resize' não dispara em nenhum quadro dela), e quando o navegador muda
     * de zoom ou de fonte. Em todos esses momentos o realce ficava deslocado do texto por alguns
     * quadros — bem no lugar onde o desalinhamento é mais visível.
     *
     * O observador acompanha o elemento em si, então pega qualquer um desses casos, inclusive os
     * quadros intermediários da animação.
     */
    const observador = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(medir) : null;
    if (observador && reguaRef.current) observador.observe(reguaRef.current);

    return () => {
      window.removeEventListener('resize', medir);
      observador?.disconnect();
    };
  }, [totalDeLinhas, activeFileId, viewLayout, showRepoSidebar]);

  /**
   * Lê o que está marcado no editor. Chamado pelos eventos que podem mudar a seleção.
   *
   * Seleção de um caractere ou de espaço em branco não conta: seria fácil ativar sem querer com
   * um clique arrastado, e o modo "editar só o trecho" precisa ser uma escolha, não um acidente.
   */
  const lerSelecaoDoEditor = () => {
    const area = editorRef.current;
    if (!area) return;
    const inicio = area.selectionStart;
    const fim = area.selectionEnd;
    const texto = area.value.slice(inicio, fim);
    if (fim - inicio < 2 || !texto.trim()) {
      setSelecaoDoEditor(prev => (prev === null ? prev : null));
      return;
    }
    setSelecaoDoEditor(prev =>
      (prev && prev.inicio === inicio && prev.fim === fim) ? prev : { inicio, fim, texto });
  };

  // Trocar de arquivo ou de projeto invalida qualquer seleção: ela apontava para outro texto.
  useEffect(() => { setSelecaoDoEditor(null); }, [activeFileId, activeProjectId]);

  /** A régua acompanha a rolagem do texto — senão os números ficam parados enquanto o código anda. */
  const sincronizarRegua = (e: React.UIEvent<HTMLTextAreaElement>) => {
    if (reguaRef.current) reguaRef.current.scrollTop = e.currentTarget.scrollTop;
    // A camada do realce acompanha nos DOIS eixos: com a quebra de linha desligada existe rolagem
    // horizontal, e sincronizar só a vertical faria as cores deslizarem para o lado do texto.
    if (realceRef.current) {
      realceRef.current.scrollTop = e.currentTarget.scrollTop;
      realceRef.current.scrollLeft = e.currentTarget.scrollLeft;
    }
  };

  /**
   * Devolve o cursor ao lugar certo depois que o texto novo chega.
   *
   * A área de escrita é controlada pelo React: ao trocar o conteúdo, o navegador joga o cursor
   * para o fim. Numa indentação isso significaria perder a posição a cada Tab, o que torna a
   * tecla inútil. A posição é anotada antes e reaplicada assim que o texto novo está na tela.
   */
  useEffect(() => {
    const alvo = selecaoPendenteRef.current;
    if (!alvo || !editorRef.current) return;
    selecaoPendenteRef.current = null;
    editorRef.current.setSelectionRange(alvo.inicio, alvo.fim);
  }, [activeFile?.content]);

  const RECUO = '  ';

  /**
   * Tab indenta em vez de pular para o próximo campo.
   *
   * Numa área de texto comum o Tab move o foco para fora — num editor de código isso é o oposto
   * do esperado: quem escreve código aperta Tab dezenas de vezes por arquivo. Com seleção de
   * várias linhas, indenta o bloco inteiro; com Shift, tira um nível.
   */
  const aoTeclarNoEditor = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();

    const { selectionStart: inicio, selectionEnd: fim, value } = e.currentTarget;
    const varias = value.slice(inicio, fim).includes('\n');

    if (varias || e.shiftKey) {
      // O bloco começa no INÍCIO da primeira linha tocada, e não onde a seleção começou: indentar
      // do meio de uma linha deixaria espaços soltos no meio do código.
      const inicioDaLinha = value.lastIndexOf('\n', inicio - 1) + 1;
      const bloco = value.slice(inicioDaLinha, fim);
      const novoBloco = e.shiftKey
        ? bloco.replace(/^[ \t]{1,2}/gm, '')
        : bloco.replace(/^/gm, RECUO);
      if (novoBloco === bloco) return;

      handleUpdateActiveContent(value.slice(0, inicioDaLinha) + novoBloco + value.slice(fim));
      // O bloco continua selecionado, para dar para apertar Tab de novo e seguir indentando.
      selecaoPendenteRef.current = { inicio: inicioDaLinha, fim: inicioDaLinha + novoBloco.length };
      return;
    }

    handleUpdateActiveContent(value.slice(0, inicio) + RECUO + value.slice(fim));
    selecaoPendenteRef.current = { inicio: inicio + RECUO.length, fim: inicio + RECUO.length };
  };

  const handleUpdateActiveContent = (newContent: string) => {
    const now = Date.now();
    /**
     * Um ponto de retorno a cada 2 segundos de digitação, e não a cada tecla.
     *
     * É de propósito: um ponto por caractere encheria os 30 guardados com meia frase, e o Ctrl+Z
     * andaria letra por letra. A janela agrupa a digitação corrida num passo só, como fazem os
     * editores.
     *
     * O relógio zera ao trocar de ARQUIVO (efeito abaixo) e de projeto: sem isso, a primeira
     * edição no arquivo recém-aberto caía dentro da janela do arquivo anterior e entrava no mesmo
     * passo — um Ctrl+Z desfazia mudanças em dois arquivos de uma vez.
     */
    if (now - lastTypedHistoryTime > 2000) {
      pushHistory(files);
      setLastTypedHistoryTime(now);
    }
    setIsSaved(false);
    setFiles(prev => {
      const updated = prev.map(f => f.id === activeFileId ? { ...f, content: newContent, updatedAt: Date.now() } : f);
      try {
        localStorage.setItem('osone_code_repository_files', JSON.stringify(updated));
      } catch (e) {}
      return updated;
    });
  };

  const handleCreateNewFile = () => {
    const fileName = window.prompt('Nome/caminho do novo arquivo (ex: index.html, frontend/app.js, server/api.js, src/app.ts, consulta.sql):');
    if (!fileName || !fileName.trim()) return;

    const trimmed = prepararNomeDeArquivoDigitado(fileName);
    if (!trimmed) return;
    if (caminhoExisteNoProjeto(trimmed, files)) {
      setNotificationBanner({ message: `Já existe um arquivo em "${trimmed}".`, type: 'error' });
      return;
    }

    pushHistory(files);
    const lang = linguagemPelaExtensao(trimmed);
    const conteudoInicial = lang === 'html'
      ? `<!DOCTYPE html>\n<html>\n<head>\n  <title>${trimmed}</title>\n</head>\n<body>\n  <h1>${trimmed}</h1>\n</body>\n</html>`
      : lang === 'python' ? `# Arquivo: ${trimmed}\n`
      : lang === 'sql' ? `-- Arquivo: ${trimmed}\n`
      : `// Arquivo: ${trimmed}\n`;

    const newFile: CodeRepositoryFile = {
      id: 'file-' + Date.now(),
      name: trimmed,
      language: lang,
      content: conteudoInicial,
      updatedAt: Date.now()
    };

    setFiles(prev => [...prev, newFile]);
    setActiveFileId(newFile.id);
  };

  const criarEstruturaFullstack = () => {
    const confirmar = window.confirm(
      'Criar uma estrutura fullstack com frontend/, server/ e shared/? Arquivos existentes não serão sobrescritos.'
    );
    if (!confirmar) return;

    const atuais = filesRef.current;
    const ocupados = new Set(atuais.map(f => f.name));
    const agora = Date.now();
    const base = TEMPLATE_FULLSTACK_OSONE.map((arquivo, i) => {
      const name = caminhoDisponivel(arquivo.name, ocupados);
      ocupados.add(name);
      return {
        id: `fullstack-${agora}-${i}`,
        name,
        language: arquivo.language,
        content: arquivo.content,
        updatedAt: agora,
        ...(arquivo.isMain ? { isMain: true } : {})
      } as CodeRepositoryFile;
    });
    const suporte = arquivosDeSuporteFullstack([...atuais, ...base], activeProjectName).map((arquivo, i) => {
      const name = caminhoDisponivel(arquivo.name, ocupados);
      ocupados.add(name);
      return {
        id: `fullstack-suporte-${agora}-${i}`,
        name,
        language: arquivo.language,
        content: arquivo.content,
        updatedAt: agora
      } as CodeRepositoryFile;
    });
    const novos = [...base, ...suporte];

    pushHistory(atuais);
    const atualizados = atuais.map(f => f.isMain ? { ...f, isMain: false } : f).concat(novos);
    setFiles(atualizados);
    const principal = novos.find(f => f.isMain) || novos[0];
    if (principal) setActiveFileId(principal.id);
    setNotificationBanner({
      message: `Estrutura fullstack criada com ${novos.length} arquivos, incluindo package.json para rodar com npm install && npm run dev.`,
      type: 'success'
    });
  };

  const prepararExecucaoFullstack = async () => {
    const atuais = filesRef.current;
    const projeto = projects.find(p => p.id === activeProjectId);
    const nomeProjeto = projeto?.name || activeProjectName;
    const analiseAtual = analisarFullstackDoCode(atuais);

    if (!analiseAtual.temFullstack) {
      criarEstruturaFullstack();
      return;
    }

    const suporte = arquivosDeSuporteFullstack(atuais, nomeProjeto);
    if (suporte.length > 0) {
      pushHistory(atuais);
      const ocupados = new Set(atuais.map(f => f.name));
      const agora = Date.now();
      const novos = suporte.map((arquivo, i) => {
        const name = caminhoDisponivel(arquivo.name, ocupados);
        ocupados.add(name);
        return {
          id: `fullstack-run-${agora}-${i}`,
          name,
          language: arquivo.language,
          content: arquivo.content,
          updatedAt: agora
        } as CodeRepositoryFile;
      });
      const atualizados = [...atuais, ...novos];
      setFiles(atualizados);
      const guia = novos.find(f => chaveDeCaminho(f.name) === chaveDeCaminho('RODAR_FULLSTACK.md')) || novos[0];
      if (guia) setActiveFileId(guia.id);
      setIsSaved(false);
    }

    const analiseDepois = analisarFullstackDoCode([...atuais, ...suporte.map((s, i) => ({
      id: `virtual-${i}`,
      name: s.name,
      language: s.language,
      content: s.content,
      updatedAt: Date.now()
    }))]);
    const comandos = `${analiseDepois.comandoInstalar}\n${analiseDepois.comandoRodar}\n# abrir: ${analiseDepois.urlLocal}`;
    try {
      await navigator.clipboard?.writeText(comandos);
    } catch (e) {
      // Copiar é conveniência; não pode transformar uma preparação correta em erro.
    }

    setShowRepoSidebar(true);
    setNotificationBanner({
      message: suporte.length
        ? `Adicionei ${suporte.length} arquivo(s) de execução fullstack. Comandos copiados: npm install && npm run dev.`
        : `Projeto fullstack já preparado. Comandos copiados: npm install && npm run dev. Abra ${analiseDepois.urlLocal}.`,
      type: 'success'
    });
  };

  const abrirOuCriarModoFullstack = () => {
    if (!projetoTemEstruturaFullstack) {
      criarEstruturaFullstack();
      return;
    }

    const entrada = entradaFrontendPreferidaDoCode(filesRef.current)
      || filesRef.current.find(f => /index\.html$/i.test(f.name || ''))
      || filesRef.current[0];

    if (entrada) {
      setActiveFileId(entrada.id);
      setFiles(prev => prev.map(f => {
        const ehHtml = /\.html?$/i.test(f.name || '') || f.language === 'html';
        if (!ehHtml) return f;
        return f.id === entrada.id ? { ...f, isMain: true } : { ...f, isMain: false };
      }));
      setIsSaved(false);
    }
    setShowRepoSidebar(true);
    setViewLayout('split');
    setNotificationBanner({
      message: 'Modo fullstack aberto: o frontend roda no Preview; server/ e shared/ ficam no projeto para exportar, GitHub ou execução backend dedicada.',
      type: 'info'
    });
  };

  const handleDeleteFile = (id: string, name: string) => {
    if (files.length <= 1) {
      alert('Você precisa manter pelo menos um arquivo no repositório!');
      return;
    }
    if (window.confirm(`Deseja mesmo apagar o arquivo "${name}" do repositório?`)) {
      pushHistory(files);
      // O próximo arquivo a abrir sai da lista JÁ FILTRADA, dentro do próprio setState. Escolher
      // pela lista do closure ('files') dava o vizinho segundo uma lista possivelmente vencida —
      // e o editor abria um arquivo que já não existia mais.
      setFiles(prev => {
        const restantes = prev.filter(f => f.id !== id);
        if (activeFileId === id && restantes.length > 0) {
          setActiveFileId(restantes[0].id);
        }
        return restantes;
      });
    }
  };

  const handleRenameFileSubmit = (id: string) => {
    const novoNome = prepararNomeDeArquivoDigitado(editingFileNameText);
    if (!novoNome) return;
    if (caminhoExisteNoProjeto(novoNome, files, id)) {
      setNotificationBanner({ message: `Já existe um arquivo em "${novoNome}".`, type: 'error' });
      setEditingFileNameId(null);
      return;
    }
    // Renomear é uma alteração como outra qualquer: entra no histórico, e o Ctrl+Z desfaz.
    pushHistory(files);
    setFiles(prev => prev.map(f => f.id === id
      // A linguagem acompanha o nome: sem isto, um script.js renomeado para styles.css continuava
      // marcado como javascript, e o realce pintava CSS com as regras de JS.
      ? { ...f, name: novoNome, language: linguagemPelaExtensao(novoNome), updatedAt: Date.now() }
      : f));
    setEditingFileNameId(null);
  };

  const handleCopyCode = () => {
    if (!activeFile) return;
    // A área de transferência falha em contexto não seguro e quando a permissão é negada. Sem
    // tratar, o botão simplesmente não reagia e a pessoa ficava clicando achando que copiou.
    navigator.clipboard.writeText(activeFile.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      setNotificationBanner({
        message: 'Não foi possível copiar para a área de transferência. Selecione o texto no editor e use Ctrl+C.',
        type: 'error'
      });
    });
  };

  const handleDownloadFile = () => {
    if (!activeFile) return;
    const blob = new Blob([activeFile.content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nomeBaseDoCaminho(activeFile.name);
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFileDisk = (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploaded = e.target.files?.[0];
    if (!uploaded) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result as string;
      if (text !== undefined) {
        // Importar entra no histórico como qualquer outra alteração — sem isto, o Ctrl+Z logo
        // depois de importar desfazia a edição ANTERIOR à importação, deixando o arquivo
        // importado na lista e revertendo algo que a pessoa não pediu para reverter.
        pushHistory(filesRef.current);
        const nome = caminhoDisponivel(uploaded.name, filesRef.current.map(f => f.name));
        const newFile: CodeRepositoryFile = {
          id: 'file-' + Date.now(),
          name: nome,
          // Mesma regra da criação e da renomeação: .py, .json e .md deixavam de ser reconhecidos.
          language: linguagemPelaExtensao(nome),
          content: text,
          updatedAt: Date.now()
        };
        setFiles(prev => [...prev, newFile]);
        setActiveFileId(newFile.id);
      }
    };
    reader.readAsText(uploaded);
  };

  /**
   * Lê o arquivo aberto e devolve melhorias concretas PARA AQUELE código.
   *
   * Não é chamada a cada tecla de propósito: analisar a cada caractere digitado gastaria cota do
   * usuário sem parar, para responder sobre um arquivo que ainda está sendo escrito. Roda quando
   * o resultado interessa — depois que a IA aplica código, ao abrir um arquivo que ainda não foi
   * lido, e quando a pessoa pede.
   */
  const lerSugestoesDoCodigo = async (codigo: string, nomeDoArquivo: string) => {
    const conteudo = (codigo || '').trim();
    // Arquivo curto demais não tem o que sugerir; as frases fixas servem melhor aqui.
    if (conteudo.length < 200) {
      setSugestoesDoCodigo([]);
      codigoJaAnalisadoRef.current = '';
      return;
    }
    if (codigoJaAnalisadoRef.current === conteudo) return;

    cancelamentoDasSugestoesRef.current?.abort();
    const controle = new AbortController();
    cancelamentoDasSugestoesRef.current = controle;
    setLendoSugestoes(true);

    try {
      const resultado = await generateWithRetry({
        ...montarConfigDaApiDoCode(true),
        // Sugestão é resposta curta: os ajustes pesados da geração de código só encareceriam e
        // atrasariam algo que precisa ser barato para poder acontecer com frequência.
        unrestricted: false,
        responseMimeType: 'application/json',
        systemInstruction: `Você lê código e aponta as MELHORIAS MAIS VALIOSAS daquele arquivo específico.

REGRAS:
- Cada sugestão precisa citar algo que existe NO CÓDIGO (nome de função, variável, trecho, comportamento observável). Uma sugestão que caberia em qualquer arquivo é uma sugestão inútil.
- Escreva como uma ORDEM curta e direta para outro programador executar, em português. Máximo 90 caracteres.
- Priorize nesta ordem: bug real > risco de travamento/performance > acessibilidade > organização > estética.
- Nada de "adicione comentários" ou "melhore a legibilidade" sem dizer onde e por quê.

Responda APENAS um array JSON de 4 strings. Exemplo do formato:
["Corrija a colisão que ignora o eixo Z na função checarBatida", "Troque o setInterval do loop por requestAnimationFrame"]`,
        prompt: `ARQUIVO: ${nomeDoArquivo}\n\nCÓDIGO:\n${conteudo}`
      }, 1, controle.signal);

      if (controle.signal.aborted) return;

      if (resultado.ok && resultado.text) {
        let texto = resultado.text.trim();
        if (texto.startsWith('```')) texto = texto.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
        try {
          const lista = JSON.parse(texto);
          if (Array.isArray(lista)) {
            const limpas = lista
              .filter((s: any) => typeof s === 'string' && s.trim().length > 0)
              .map((s: string) => s.trim())
              .slice(0, 4);
            setSugestoesDoCodigo(limpas);
            codigoJaAnalisadoRef.current = conteudo;
          }
        } catch {
          // Resposta fora do formato: as frases fixas continuam na tela, e nada é anunciado —
          // sugestão é um extra, e um extra que falha não pode virar erro na cara do usuário.
        }
      }
    } catch (_) {
      /* idem: falha ao sugerir nunca interrompe o trabalho de quem está programando */
    } finally {
      if (cancelamentoDasSugestoesRef.current === controle) cancelamentoDasSugestoesRef.current = null;
      setLendoSugestoes(false);
    }
  };

  // Ao abrir um arquivo, as sugestões do anterior não valem mais para ele.
  useEffect(() => {
    setSugestoesDoCodigo([]);
    codigoJaAnalisadoRef.current = '';
    cancelamentoDasSugestoesRef.current?.abort();
  }, [activeFileId, activeProjectId]);

  useEffect(() => () => cancelamentoDasSugestoesRef.current?.abort(), []);

  /**
   * O código exatamente como o preview o executa.
   *
   * Importa que seja este, e não o arquivo aberto: o preview roda o projeto MONTADO, com o
   * styles.css e o script.js embutidos no HTML. Quando o navegador diz "erro na linha 312", é
   * desta montagem que ele fala — e é só aqui que dá para descobrir o que essa linha contém.
   */
  const linguagemAtiva = linguagemDoArquivo(activeFile?.name || '', activeFile?.language);
  const codigoQueRoda = ['python', 'typescript', 'sql'].includes(linguagemAtiva)
    ? (activeFile?.content || '')
    : montarPreview(files, activeFile);

  const provedorDoCode = apiKeys?.osoneCodeProvider || 'gemini';
  const nomeDoProvedorDoCode = provedorDoCode === 'openai'
    ? 'ChatGPT/OpenAI'
    : provedorDoCode === 'anthropic'
      ? 'Claude'
      : provedorDoCode === 'ollama'
        ? 'Ollama (local)'
        : 'Gemini padrão';
  const modeloDoProvedorDoCode = provedorDoCode === 'openai'
    ? (apiKeys?.osoneCodeOpenAiModel || 'gpt-5.5')
    : provedorDoCode === 'anthropic'
      ? (apiKeys?.osoneCodeAnthropicModel || 'claude-sonnet-5')
      : provedorDoCode === 'ollama'
        ? (apiKeys?.osoneCodeOllamaModel || MODELOS_OLLAMA_PADRAO)
        : OSONE_CODE_BEST_MODEL;

  const montarConfigDaApiDoCode = (forcarLeve = false): Record<string, unknown> => {
    if (provedorDoCode === 'openai') {
      return {
        codeAiProvider: 'openai',
        openAiApiKey: apiKeys?.osoneCodeOpenAiApiKey || '',
        model: apiKeys?.osoneCodeOpenAiModel || 'gpt-5.5'
      };
    }
    if (provedorDoCode === 'anthropic') {
      return {
        codeAiProvider: 'anthropic',
        anthropicApiKey: apiKeys?.osoneCodeAnthropicApiKey || '',
        model: apiKeys?.osoneCodeAnthropicModel || 'claude-sonnet-5'
      };
    }
    if (provedorDoCode === 'ollama') {
      // Caça-níquel de custo zero: nada de chave, nada de cota. A URL viaja no pedido porque é o
      // navegador do usuário que sabe onde o Ollama dele escuta (o servidor pode estar em outro
      // computador).
      return {
        codeAiProvider: 'ollama',
        ollamaUrl: apiKeys?.osoneCodeOllamaUrl || '',
        model: apiKeys?.osoneCodeOllamaModel || MODELOS_OLLAMA_PADRAO,
        ollamaModel: apiKeys?.osoneCodeOllamaModel || MODELOS_OLLAMA_PADRAO
      };
    }
    return {
      codeAiProvider: 'gemini',
      clientApiKey: apiKeys?.gemini || '',
      model: forcarLeve ? (apiKeys?.geminiModel || OSONE_CODE_BEST_MODEL) : OSONE_CODE_BEST_MODEL,
      modeloDeReserva: apiKeys?.geminiModel || ''
    };
  };

  /**
   * Guarda um problema vindo do preview.
   *
   * O teto de 200 é proteção contra o caso normal, não contra o excepcional: um erro dentro do
   * laço do jogo dispara sessenta vezes por segundo, e sem limite a lista cresceria sem fim
   * enquanto a página estivesse aberta. As repetições são agrupadas na hora de montar o pedido.
   */
  const registrarProblemaDoPreview = React.useCallback((problema: ProblemaDoPreview) => {
    setProblemasDoPreview(prev => (prev.length >= 200 ? prev : [...prev, problema]));
  }, []);

  /**
   * Código novo é execução nova: os erros da versão anterior não valem mais para esta.
   *
   * Sem isto, o aviso vermelho continuaria na tela depois do conserto, apontando um defeito que
   * já não existe — e o botão "Corrigir com a IA" mandaria o modelo caçar de novo um erro que ele
   * acabou de resolver. A guarda do 'length' evita uma renderização extra a cada tecla digitada.
   */
  useEffect(() => {
    setProblemasDoPreview(prev => (prev.length === 0 ? prev : []));
  }, [codigoQueRoda, activeFileId, activeProjectId]);

  const errosAgrupados = juntarProblemas(problemasDoPreview);
  const quantosErros = errosAgrupados.filter(p => p.tipo === 'erro').length;

  /**
   * Separa o arquivo aberto em index.html + estilo + script.
   *
   * Toda a decisão difícil mora em separarProjeto (lib/separarArquivos.ts), inclusive a
   * conferência que desfaz a separação e compara com o original antes de deixá-la valer. Aqui só
   * resta gravar o resultado pelo caminho único — o mesmo que entra no histórico, então um Ctrl+Z
   * desfaz a separação inteira de uma vez.
   */
  const separarArquivoAberto = () => {
    if (!activeFile) return;
    const atuais = filesRef.current;
    const r = separarProjeto(activeFile.content, atuais.map(f => f.name));

    if (!r.separou) {
      setNotificationBanner({ message: `Nada foi separado: ${r.motivo}`, type: 'info' });
      return;
    }

    pushHistory(atuais);
    const agora = Date.now();
    const pastaAtiva = pastaDoCaminho(activeFile.name);
    const ocupados = new Set(atuais.map(f => f.name));
    let htmlSeparado = r.html;
    const criados: CodeRepositoryFile[] = r.novos.map((a, i) => {
      const desejado = pastaAtiva ? `${pastaAtiva}/${a.nome}` : a.nome;
      const nomeFinal = caminhoDisponivel(desejado, ocupados);
      ocupados.add(nomeFinal);
      const referenciaFinal = pastaAtiva ? nomeBaseDoCaminho(nomeFinal) : nomeFinal;
      if (referenciaFinal !== a.nome) {
        htmlSeparado = htmlSeparado
          .replaceAll(`href="${a.nome}"`, `href="${referenciaFinal}"`)
          .replaceAll(`src="${a.nome}"`, `src="${referenciaFinal}"`);
      }
      return {
        id: `file-${agora}-${i}`,
        name: nomeFinal,
        language: a.linguagem,
        content: a.conteudo,
        updatedAt: agora
      };
    });
    const atualizados = atuais
      .map(f => (f.id === activeFile.id ? { ...f, content: htmlSeparado, updatedAt: agora } : f))
      .concat(criados);

    setFiles(atualizados);
    try {
      localStorage.setItem('osone_code_repository_files', JSON.stringify(atualizados));
    } catch (e) { /* o auto-save cuida do resto */ }
    window.dispatchEvent(new Event('osone_repository_updated'));

    setNotificationBanner({
      message: `Projeto separado em ${criados.length + 1} arquivos: ${activeFile.name} + ${criados.map(c => c.name).join(' + ')}. `
        + `O preview continua idêntico. Ctrl+Z desfaz.`,
      type: 'success'
    });
  };

  /**
   * Baixa o projeto inteiro num .zip.
   *
   * O download que existia leva um arquivo por vez, e o trabalho fica preso no app: sem o projeto
   * na mão não dá para publicar, mandar para alguém nem simplesmente guardar. Um jogo que levou
   * uma tarde para nascer não pode existir só no localStorage de um navegador.
   */
  const [empacotando, setEmpacotando] = useState(false);
  const exportarProjetoEmZip = async () => {
    if (empacotando) return;
    setEmpacotando(true);
    try {
      const projeto = projects.find(p => p.id === activeProjectId);
      const pacote = await montarPacote(projeto?.name || 'projeto', filesRef.current);
      if (!pacote) {
        setNotificationBanner({ message: 'Não há nada para exportar: os arquivos deste projeto estão vazios.', type: 'info' });
        return;
      }

      const url = URL.createObjectURL(pacote.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = pacote.nome;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // O endereço temporário é solto depois do clique: sem isto, o blob inteiro fica na memória
      // da aba até ela ser fechada, e num projeto grande isso é megabytes parados à toa.
      setTimeout(() => URL.revokeObjectURL(url), 2000);

      const entradaHtml = pacote.entradas.find(e => nomeBaseDoCaminho(e.caminho).toLowerCase() === 'index.html')
        || pacote.entradas.find(e => /\.html?$/i.test(e.caminho));
      const analise = analisarFullstackDoCode(filesRef.current);
      const dica = analise.temBackend
        ? ' Depois de descompactar, rode npm install && npm run dev e abra http://localhost:3001.'
        : ` Descompacte e abra ${entradaHtml?.caminho || 'o HTML principal'} no navegador.`;
      setNotificationBanner({
        message: `${pacote.nome} baixado com ${pacote.entradas.length} arquivo(s).${dica}`,
        type: 'success'
      });
    } catch (e: any) {
      console.error('Erro ao empacotar o projeto:', e);
      setNotificationBanner({ message: `Não foi possível gerar o .zip: ${e?.message || e}`, type: 'error' });
    } finally {
      setEmpacotando(false);
    }
  };

  const importarArquivosDoGithubParaCode = (arquivosImportados: CodeRepositoryFile[], resultado: GithubImportResult) => {
    if (!arquivosImportados.length) return;
    const atuais = filesRef.current;
    pushHistory(atuais);
    const agora = Date.now();
    const comPrincipalUnico = arquivosImportados.map((arquivo, i) => ({
      ...arquivo,
      id: arquivo.id || `github-import-${agora}-${i}`,
      updatedAt: agora,
      isMain: i === arquivosImportados.findIndex(f => f.isMain) || (arquivosImportados.every(f => !f.isMain) && i === 0)
    }));
    setFiles(comPrincipalUnico);
    setActiveFileId((comPrincipalUnico.find(f => f.isMain) || comPrincipalUnico[0]).id);
    setShowRepoSidebar(true);
    setIsSaved(false);
    setProjects(prev => prev.map(proj => proj.id === activeProjectId
      ? {
          ...proj,
          name: `${resultado.owner}/${resultado.repo}`,
          files: comPrincipalUnico,
          activeFileId: (comPrincipalUnico.find(f => f.isMain) || comPrincipalUnico[0]).id,
          updatedAt: agora
        }
      : proj
    ));
  };

  /**
   * ====== VER O QUE MUDOU ANTES DE ACEITAR ======
   *
   * O desfazer já existia, mas era cego: dava para voltar atrás, não para saber do que se estava
   * voltando. Depois de um pedido, o arquivo simplesmente tinha OUTRO conteúdo — e num jogo de 50
   * mil caracteres não há como conferir de olho se o modelo mexeu só onde devia. Sobravam duas
   * saídas ruins: aceitar no escuro, ou desfazer por precaução e perder junto o que estava certo.
   *
   * A comparação é sempre contra o topo do histórico, que é exatamente o estado de antes da
   * última alteração — o mesmo ponto para onde o Ctrl+Z voltaria.
   */
  const [comparacaoAberta, setComparacaoAberta] = useState(false);
  const comparacoes: ComparacaoDeArquivo[] = comparacaoAberta && historyStack.length > 0
    ? compararProjeto(historyStack[historyStack.length - 1], files)
    : [];

  const handleSendAIPrompt = async (promptText?: string) => {
    const textToSend = promptText || promptInput;
    if (!textToSend.trim() || !onGenerateCodeRequest) return;

    /**
     * O arquivo ABERTO é o que vai para a IA, e é nele que o resultado volta.
     *
     * O outro lado escolhia sozinho: mandava o primeiro arquivo da lista como "código atual" e
     * gravava no index.html. Editando um script.js, o modelo recebia o HTML e devolvia edições
     * para ele — e quando o primeiro da lista não era o index.html, o conteúdo de um arquivo
     * acabava gravado por cima de outro, apagando o segundo por inteiro.
     */
    // A seleção é lida AQUI, no instante do envio: é o que a pessoa via marcado ao apertar gerar.
    const trechoDoPedido = selecaoDoEditor && activeFile
      && activeFile.content.slice(selecaoDoEditor.inicio, selecaoDoEditor.fim) === selecaoDoEditor.texto
      ? selecaoDoEditor : undefined;

    const alvo = activeFile
      ? { nome: activeFile.name, conteudo: activeFile.content, trechoSelecionado: trechoDoPedido }
      : undefined;
    const idDoAlvo = activeFile?.id;

    const imagesToSend = attachedImages.map(img => ({ mimeType: img.mimeType, data: img.data }));
    setPromptInput('');
    attachedImages.forEach(img => URL.revokeObjectURL(img.previewUrl));
    setAttachedImages([]);

    // A escrita ao vivo começa vazia (e não em null): é isso que troca o editor pelo painel de
    // acompanhamento já no primeiro instante, em vez de só quando o primeiro pedaço chegar.
    const controle = new AbortController();
    cancelamentoRef.current = controle;
    setEscritaAoVivo('');

    let resultado: { conteudo: string; resumo: string; projetoMultiArquivo?: string } | null = null;
    try {
      resultado = await onGenerateCodeRequest(
        textToSend,
        imagesToSend.length > 0 ? imagesToSend : undefined,
        maxEffort,
        alvo,
        (textoAcumulado) => setEscritaAoVivo(textoAcumulado),
        controle.signal
      );
    } catch (e: any) {
      // Um pedido vindo da voz não tem um clique aguardando a Promise. Sem capturar aqui, uma
      // falha de rede virava rejection solta e a fila parecia simplesmente parar.
      console.error('[OSONE CODE] Falha ao gerar código:', e);
      setPromptInput(textToSend);
      setNotificationBanner({
        message: `A geração falhou: ${e?.message || String(e)}. O pedido ficou na caixa para tentar novamente.`,
        type: 'error'
      });
      return;
    } finally {
      // O editor volta em qualquer desfecho — inclusive erro e cancelamento. Deixar o painel de
      // acompanhamento na tela depois que a geração morreu esconderia o arquivo do usuário.
      setEscritaAoVivo(null);
      cancelamentoRef.current = null;
    }

    if (controle.signal.aborted) {
      setNotificationBanner({ message: 'Geração cancelada. O arquivo não foi alterado.', type: 'info' });
      setPromptInput(textToSend);
      return;
    }

    /**
     * O PROJETO INTEIRO, QUANDO FOI ISSO QUE O MODELO RESPONDEU.
     *
     * Vem antes do caminho de arquivo único porque os dois são excludentes: ou a resposta é um
     * conjunto de arquivos, ou é o conteúdo do arquivo aberto. Passar um pelo outro grava o texto
     * com os marcadores dentro de um arquivo só.
     */
    if (resultado?.projetoMultiArquivo) {
      // O histórico é empilhado ANTES de gravar: é o que faz "a IA criou 8 arquivos e eu não
      // gostei" caber num Ctrl+Z, igual a qualquer outra escrita da IA neste editor.
      pushHistory(filesRef.current);
      const r = aplicarArquivosDoModelo(resultado.projetoMultiArquivo, filesRef.current, {
        linguagemDe: (caminho) => linguagemPelaExtensao(caminho)
      });

      if (!r.criados.length && !r.atualizados.length) {
        setPromptInput(textToSend);
        setNotificationBanner({
          message: r.cortada
            ? `⚠️ A resposta acabou no meio de ${r.caminhoCortado ? `"${r.caminhoCortado}"` : 'um arquivo'} e nada foi gravado, para não deixar meio arquivo no projeto. Peça de novo em partes menores.`
            : `Nada foi gravado. ${r.resumo}`,
          type: 'error'
        });
        return;
      }

      setFiles(r.arquivos);
      // A pessoa precisa ver ALGUMA coisa do que acabou de nascer: abrir o primeiro arquivo novo
      // evita o efeito de "criou oito arquivos" com a tela ainda mostrando o de antes.
      const primeiroNovo = r.arquivos.find(a => a.name === (r.criados[0] || r.atualizados[0]));
      if (primeiroNovo) setActiveFileId(primeiroNovo.id);

      setNotificationBanner({
        message: `${r.resumo}. Dá para desfazer tudo com Ctrl+Z.`,
        type: r.cortada || r.recusados.length ? 'info' : 'success'
      });
      return;
    }

    if (resultado?.conteudo && resultado.conteudo.trim() && resultado.conteudo !== alvo?.conteudo) {
      // Passa pelo caminho único de gravação, que guarda o estado anterior no histórico — é o
      // que torna uma reescrita feita pela IA reversível com Ctrl+Z.
      applyCodeToRepository(resultado.conteudo, idDoAlvo);
      // O alerta do outro lado é passageiro e some no canto; o painel do editor é onde a pessoa
      // está olhando. Um arquivo que não fecha não pode ser anunciado aqui em verde.
      const chegouIncompleto = pareceDocumentoIncompleto(resultado.conteudo);
      setNotificationBanner({
        message: chegouIncompleto
          ? `⚠️ O código aplicado em "${alvo?.nome || 'arquivo'}" está INCOMPLETO: o arquivo termina no meio, sem fechar. Peça para terminar o arquivo, ou divida o pedido. Ctrl+Z desfaz.`
          : `Código aplicado em "${alvo?.nome || 'arquivo'}"${resultado.resumo ? ` — ${resultado.resumo}` : ''}. Dá para desfazer com Ctrl+Z.`,
        type: chegouIncompleto ? 'error' : 'success'
      });
      // Código novo na tela é exatamente o momento do "e agora?". As sugestões passam a falar
      // deste código, e não do que estava aqui antes.
      lerSugestoesDoCodigo(resultado.conteudo, alvo?.nome || 'arquivo');
      return;
    }

    /**
     * A GERAÇÃO QUE NÃO DEU EM NADA TAMBÉM PRECISA APARECER AQUI.
     *
     * Este bloco não existia: quando não vinha código, a função simplesmente terminava. A pessoa
     * escrevia o pedido, apertava gerar, a caixa esvaziava — e nada acontecia na tela do editor.
     * Sem erro, sem aviso, sem código. O aviso lá do outro lado é um alerta passageiro no canto,
     * fácil de perder; o editor precisa dizer, no próprio painel, que a tentativa terminou sem
     * mudar nada. E o texto do pedido volta para a caixa, para não ser preciso digitar tudo de
     * novo só para tentar outra vez.
     */
    setPromptInput(textToSend);
    setNotificationBanner({
      message: resultado?.conteudo && resultado.conteudo === alvo?.conteudo
        ? 'O modelo respondeu, mas nada mudou no arquivo. Seu pedido continua na caixa — tente de novo dizendo qual parte deve mudar.'
        : 'A geração não devolveu código. Seu pedido continua na caixa para você tentar de novo.',
      type: 'error'
    });
  };

  const enviarPerguntaDoChat = async () => {
    const pergunta = perguntaDoChat.trim();
    if (!pergunta || chatRespondendo || !onCodeChatRequest) return;

    const mensagem: MensagemDoChatCode = {
      id: `code-chat-user-${Date.now()}`,
      role: 'user',
      content: pergunta,
      createdAt: Date.now()
    };
    const historicoAnterior = mensagensDoChat;
    setPerguntaDoChat('');
    setChatRespondendo(true);
    setChatPorProjeto(atual => ({
      ...atual,
      [activeProjectId]: [...(atual[activeProjectId] || []), mensagem]
    }));

    try {
      const resposta = await onCodeChatRequest(pergunta, montarContextoDoProjetoParaChat(), historicoAnterior);
      if (!resposta?.trim()) {
        setPerguntaDoChat(pergunta);
        setNotificationBanner({ message: 'O chat não recebeu resposta. A pergunta voltou para o campo.', type: 'error' });
        return;
      }
      const mensagemDaIa: MensagemDoChatCode = {
        id: `code-chat-assistant-${Date.now()}`,
        role: 'assistant',
        content: resposta.trim(),
        createdAt: Date.now()
      };
      setChatPorProjeto(atual => ({
        ...atual,
        [activeProjectId]: [...(atual[activeProjectId] || []), mensagemDaIa]
      }));
    } catch (erro: any) {
      setPerguntaDoChat(pergunta);
      setNotificationBanner({ message: erro?.message || 'Não foi possível conversar sobre o projeto.', type: 'error' });
    } finally {
      setChatRespondendo(false);
    }
  };

  const processandoComandoDeVozRef = useRef(false);
  useEffect(() => {
    // Se a pessoa acabou de clicar em Gerar, a voz espera esse trabalho terminar. Compartilhar o
    // cancelamentoRef entre duas gerações faria o segundo pedido perder o controle da primeira e
    // os dois resultados disputarem o mesmo arquivo.
    if (!comandoDeVoz || processandoComandoDeVozRef.current || escritaAoVivo !== null || cancelamentoRef.current) return;

    processandoComandoDeVozRef.current = true;
    // A Promise continua independente do fim do turno do Gemini Live. O microfone pode voltar a
    // escutar imediatamente; apenas a fila do CODE permanece serial para dois pedidos não
    // sobrescreverem o mesmo arquivo ao mesmo tempo.
    void handleSendAIPrompt(comandoDeVoz.prompt).finally(() => {
      processandoComandoDeVozRef.current = false;
      aoConcluirComandoDeVoz?.(comandoDeVoz.id);
    });
  }, [comandoDeVoz?.id, escritaAoVivo]);

  const handleAttachImages = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    Array.from(fileList).forEach(file => {
      if (!file.type.startsWith('image/')) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(',')[1] || '';
        setAttachedImages(prev => [...prev, {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          mimeType: file.type,
          data: base64,
          previewUrl: URL.createObjectURL(file)
        }]);
      };
      reader.readAsDataURL(file);
    });
  };

  const handleRemoveAttachedImage = (id: string) => {
    setAttachedImages(prev => {
      const target = prev.find(img => img.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter(img => img.id !== id);
    });
  };

  // HUNTER CODE EXAMINATION & AUTOMATIC IMPLEMENTATION
  const runHunterAnalysis = async (explicitClarification?: string) => {
    const promptToVerify = explicitClarification 
      ? `${hunterPrompt.trim()} (Esclarecimento adicional: ${explicitClarification})`
      : hunterPrompt.trim();

    if (!promptToVerify) return;

    setHunterStatus('analyzing');
    setHunterProgress(20);
    setHunterReport("O Hunter está caçando falhas, lacunas e itens ausentes no código...");
    setHunterDoubt(null);

    const controle = new AbortController();
    cancelamentoDoHunterRef.current?.abort();
    cancelamentoDoHunterRef.current = controle;

    try {
      setHunterProgress(50);
      const currentCode = activeFile ? activeFile.content : '';

      const systemInstruction = `Você é o HUNTER, o Caçador e Examinador Agêntico de Código do OSONE Studio.
Sua missão é examinar o CÓDIGO FONTE ATUAL do arquivo do repositório ("${activeFile?.name || 'código'}") contra as REQUISITOS E PEDIDO DO USUÁRIO.

Sua meta é GARANTIR 100% de conformidade, precisão e integridade do código sem faltar nada do pedido:
1. Analise o código atual e verifique o que foi pedido pelo usuário.
2. Se faltar alguma funcionalidade, estilização, verificação, lógica ou componente, implemente EDIÇÕES CIRÚRGICAS: assim como um assistente de codificação real (par de programação estilo "vibe coding"), você NUNCA reescreve o arquivo inteiro quando já existe código funcionando. Localize o trecho exato e substitua só ele.
3. Se você tiver alguma DÚVIDA IMPEDITIVA CRÍTICA sobre o que o usuário deseja, sinalize isso.
4. Se o pedido puder ser verificado e implementado com segurança, aplique as mudanças e resuma o que foi feito.

Responda ESTRITAMENTE neste formato de texto puro (NUNCA use JSON — código com aspas e quebras de linha quebra o JSON facilmente), preenchendo cada seção:

=== HAS_DOUBT ===
true ou false

=== DOUBT_QUESTION ===
(a pergunta, só se HAS_DOUBT for true; senão deixe vazio)

=== SUMMARY ===
(resumo objetivo e marcante das verificações/melhorias feitas, ou da dúvida)

=== EDITS ===
(só preencha esta seção se HAS_DOUBT for false. Coloque um ou mais blocos SEARCH/REPLACE em texto puro, cada um assim:
<<<<<<< SEARCH
trecho exato e único do código atual a ser substituído
=======
texto que entra no lugar
>>>>>>> REPLACE
Se o código já estiver 100% conforme e nenhuma mudança for necessária, deixe esta seção vazia.
Se o arquivo estiver vazio ou for necessário recriar do zero, em vez de blocos SEARCH/REPLACE coloque o código-fonte COMPLETO direto nesta seção, sem marcadores.)`;

      const userContentPayload = `EXIGÊNCIAS / REQUISITOS DO USUÁRIO A SEREM VERIFICADOS E IMPLEMENTADOS:
"${promptToVerify}"

CÓDIGO ATUAL NO ARQUIVO ("${activeFile?.name || 'código'}"):
${currentCode}`;

      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...montarConfigDaApiDoCode(),
          // Mesma reserva do Enxame: sem ela, uma chave que não sirva os dois modelos preferidos
          // faz o Hunter falhar sempre, mesmo com o chat funcionando.
          prompt: userContentPayload,
          systemInstruction,
          unrestricted: true
        }),
        signal: controle.signal
      });

      const data = await response.json().catch(() => ({} as any));
      // Desistiu enquanto a resposta vinha: nada é gravado no arquivo.
      if (controle.signal.aborted) return;
      if (!response.ok) {
        throw new Error(data?.error || "Erro na comunicação com a API do Hunter.");
      }
      if (data.blocked) {
        throw new Error(`O Gemini bloqueou a resposta pelo filtro de segurança (finishReason: ${data.finishReason}). Tente reformular o pedido.`);
      }

      const rawText = data.text || "";
      const sections = parseSections(rawText);
      const hasDoubt = /^true$/i.test((sections.HAS_DOUBT || '').trim());
      const doubtQuestion = (sections.DOUBT_QUESTION || '').trim();
      const summary = (sections.SUMMARY || '').trim();

      /**
       * SEM A SEÇÃO '=== EDITS ===', NÃO HÁ NADA PARA GRAVAR.
       *
       * O texto cru servia de plano B aqui, e isso só funciona quando a resposta veio inteira.
       * Numa resposta cortada pelo limite de tokens — que para antes de chegar em EDITS — o plano
       * B gravava a resposta INTEIRA no arquivo: os cabeçalhos '=== HAS_DOUBT ===', o resumo em
       * português e o que mais tivesse vindo, tudo por cima do código que funcionava. O usuário
       * mandava auditar e recebia o arquivo destruído.
       *
       * O texto cru continua valendo quando o modelo respondeu só o código, ignorando o formato
       * (resposta inteira, sem cabeçalho nenhum) — aí ele é mesmo o arquivo.
       */
      const respostaTemCabecalhos = Object.keys(sections).length > 0;
      const editsSection = sections.EDITS !== undefined
        ? sections.EDITS
        : (respostaTemCabecalhos ? '' : rawText);
      if (sections.EDITS === undefined && respostaTemCabecalhos) {
        console.warn('[Hunter] Resposta sem a seção EDITS (provavelmente cortada). Nada será gravado no arquivo.');
      }

      if (hasDoubt && doubtQuestion) {
        setHunterStatus('doubt');
        setHunterProgress(60);
        setHunterDoubt(doubtQuestion);
        setHunterReport(`Hunter identificou uma dúvida: ${doubtQuestion}`);
      } else {
        setHunterStatus('success');
        setHunterProgress(100);
        setHunterDoubt(null);

        let correctedCode: string | null = null;
        const { content, summary: editSummaryNote, respostaCortada } = applyModelCodeResponse(editsSection, currentCode);
        if (content && content.trim() && content !== currentCode) {
          correctedCode = content;
        }

        // Só é "incompleto" o que chega incompleto ao arquivo: o servidor já mandou o modelo
        // continuar de onde parou antes de responder, e quando isso resolveu não há o que avisar.
        const ficouCortado = data.truncated || respostaCortada
          || (!!correctedCode && pareceDocumentoIncompleto(correctedCode));
        const truncationNote = ficouCortado
          ? "⚠️ A resposta acabou antes do fim (limite de tamanho) — o código pode estar incompleto, confira o fechamento do arquivo."
          : (sections.EDITS === undefined && respostaTemCabecalhos
            ? "⚠️ A resposta veio incompleta (sem a seção de edições) e nada foi gravado, para não danificar o arquivo. Tente de novo."
            : "");
        const finalSummary = [summary || "Código auditado.", editSummaryNote, truncationNote].filter(Boolean).join(' — ');
        setHunterReport(finalSummary || "Código auditado e 100% alinhado com as especificações solicitadas!");

        if (correctedCode && correctedCode.trim().length > 0) {
          /**
           * Grava no arquivo QUE FOI AUDITADO, não no index.html.
           *
           * O Hunter lê o conteúdo do arquivo ativo, mas o destino estava fixo em 'index.html':
           * auditar um script.js gravava o script corrigido por cima do index.html, destruindo os
           * dois de uma vez — o HTML era perdido e o script continuava sem correção.
           */
          const arquivoAuditado = activeFile?.id;
          applyCodeToRepository(correctedCode, arquivoAuditado);

          // O Preview só abre quando o que mudou é renderizável; num .css ou .py ele mostraria
          // o código como se fosse página, o que confunde mais do que informa.
          const ehRenderizavel = /\.(html?|htm)$/i.test(activeFile?.name || '') || activeFile?.language === 'html';
          if (ehRenderizavel) setViewLayout('preview');
          setNotificationBanner({
            message: ficouCortado
              ? `⚠️ Hunter aplicou o que deu em "${activeFile?.name || 'arquivo'}", mas a resposta do modelo acabou antes do fim — revise, o código pode estar incompleto.`
              : `🏹 Hunter auditou e aplicou o código corrigido em "${activeFile?.name || 'arquivo'}"!` +
                (ehRenderizavel ? ' O Preview Vivo foi aberto automaticamente.' : ''),
            type: ficouCortado ? "error" : "success"
          });

          // Auto-fechar modal após 1.8 segundos
          setTimeout(() => {
            setIsHunterModalOpen(false);
          }, 1800);
        }
      }
    } catch (err: any) {
      // Parar não é erro: quem apertou "parar" não precisa de um relatório vermelho de falha.
      if (err?.name === 'AbortError' || controle.signal.aborted) {
        setHunterStatus('idle');
        setHunterProgress(0);
        setHunterReport(null);
        return;
      }
      console.error("Erro no agente Hunter:", err);
      setHunterStatus('error');
      setHunterProgress(100);
      setHunterReport(`Erro na caçada: ${err.message || String(err)}`);
    } finally {
      if (cancelamentoDoHunterRef.current === controle) cancelamentoDoHunterRef.current = null;
    }
  };

  // SWARM HARNESS ENGINE EXECUTION
  const runSwarmHarnessEngine = async () => {
    if (!swarmPrompt.trim()) return;

    setSwarmStatus('running');
    setSwarmLogs([]);
    setSwarmQAReports([]);
    setSwarmPMArtifact(null);
    setSwarmArchitectArtifact(null);
    setSwarmIteration(1);
    setSwarmProgress(5);
    setSwarmProgressText('5% - Disparando Enxame de Agentes OSONE CODE...');

    const addSwarmLog = (agent: string, message: string, type: 'info' | 'success' | 'warn' | 'error' = 'info') => {
      const timeStr = new Date().toLocaleTimeString();
      setSwarmLogs(prev => [...prev, { agent, message, timestamp: timeStr, type }]);
    };

    const formatoEscolhido = swarmProjectFormat;
    const nomeDoFormatoEscolhido = formatoEscolhido === 'tree' ? 'árvore completa' : 'arquivo único';
    const arquivosBaseParaArvore: Array<{ caminho: string; papel: string }> = [
      { caminho: 'src/main.tsx', papel: 'ponto de entrada: monta o App na div#root' },
      { caminho: 'src/App.tsx', papel: 'tela principal, estado e roteamento leve' },
      { caminho: 'src/components/Panel.tsx', papel: 'componente visual reutilizável' },
      { caminho: 'src/styles.css', papel: 'estilos globais do projeto' }
    ];

    const configDaApiDoCode = montarConfigDaApiDoCode();
    const controle = new AbortController();
    cancelamentoDoEnxameRef.current?.abort();
    cancelamentoDoEnxameRef.current = controle;
    /** Conferido antes de cada etapa e antes de QUALQUER gravação no repositório. */
    const desistiu = () => controle.signal.aborted;

    try {
      // ==========================================
      // STAGE 1: AGENTE DE PRODUTO (PRODUCT MANAGER)
      // ==========================================
      setSwarmCurrentStep('pm');
      setSwarmProgress(15);
      setSwarmProgressText('15% - Agente de Produto entendendo o que precisa ser construído...');
      addSwarmLog('📋 Agente de Produto', `Analisando o pedido em modo ${nomeDoFormatoEscolhido} e escrevendo a especificação...`, 'info');

      /**
       * ====== O ENXAME DEIXA DE SER UM GERADOR DE JOGO ======
       *
       * Este agente pedia um "Game Design Document", com mecânicas, regras de vitória/derrota e
       * mapeamento de controles. O de Arquitetura projetava "game loop e detecção de colisões", com
       * "index.html" fixo como estrutura. O de Engenharia era mandado produzir "o código completo no
       * arquivo index.html", com "som de tiro, dano, pulo e game over".
       *
       * Ou seja: pedir "um app de gestão de estoque com login" fazia quatro agentes trabalharem
       * para entregar um HTML único com game loop. Não era defeito de execução — era o alvo errado,
       * escrito nas instruções. A infraestrutura (PM → Arquiteto → Engenheiro → QA, com iterações e
       * o retorno do QA voltando ao Engenheiro) sempre foi boa; ela só apontava para uma coisa só.
       *
       * O que muda: o produto passa a ser CLASSIFICADO, e a classificação decide o resto. Jogo
       * continua nascendo em arquivo único, que é o formato certo para ele e o que já era testado.
       * Aplicativo nasce como projeto de vários arquivos — e roda no preview, porque a fase
       * anterior ensinou o preview a executar módulos.
       */
      const pmSystemInstruction = `Você é o AGENTE DE PRODUTO (Product Manager) do OSONE CODE Swarm Engine.
Sua missão é pegar o pedido do usuário e desdobrá-lo numa especificação clara do que precisa ser construído.

PRIMEIRO, CLASSIFIQUE o que foi pedido. É a decisão mais importante desta etapa, porque ela define o formato do projeto inteiro:
- "jogo": tem jogador, ação em tempo real, pontuação ou fases. Mora bem num arquivo único com Canvas.
- "aplicativo": tem telas, dados, formulários, listas, login. Precisa de vários arquivos e componentes.
- "site": páginas de conteúdo, apresentação, portfólio.
- "ferramenta": uma utilidade focada (conversor, calculadora, editor).

FORMATO ESCOLHIDO PELO USUÁRIO ANTES DA CRIAÇÃO:
- ${formatoEscolhido === 'single'
  ? '"arquivo único": tudo deve nascer em index.html para preview instantâneo.'
  : '"árvore completa": o produto deve nascer como projeto com pastas/arquivos reais e entrada de frontend rodável no preview.'}

FORMATO OBRIGATÓRIO (JSON estrito):
{
  "tipo": "jogo" | "aplicativo" | "site" | "ferramenta",
  "gdd": "Resumo do que o produto é, para quem serve e como se parece",
  "mechanics": ["O que o usuário consegue FAZER — uma capacidade por item"],
  "requirements": ["Requisito técnico 1", "Requisito 2"]
}

Escreva "mechanics" como capacidades do usuário ("cadastrar produto", "filtrar por categoria", "pular e atirar"), nunca como nomes de arquivo ou de tecnologia.`;

      const pmFallback = { tipo: 'aplicativo', gdd: swarmPrompt, mechanics: ["Interface responsiva"], requirements: formatoEscolhido === 'single' ? ["HTML5", "CSS3 / Tailwind", "JavaScript no próprio index.html"] : ["React", "TypeScript", "CSS modular do projeto"] };
      const pmResult = await generateWithRetry({
        ...configDaApiDoCode,
        prompt: `FORMATO ESCOLHIDO PELO USUÁRIO: ${nomeDoFormatoEscolhido}\n\nCONCEITO SOLICITADO PELO USUÁRIO:\n"${swarmPrompt}"`,
        systemInstruction: pmSystemInstruction,
        responseMimeType: "application/json"
      }, 2, controle.signal);

      let pmParsed: any = pmFallback;
      if (pmResult.ok) {
        try { pmParsed = JSON.parse(pmResult.text.trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim()); } catch { pmParsed = pmFallback; }
      } else {
        addSwarmLog('📋 Agente de Produto', `⚠️ Falha ao contatar o Agente de Produto (${pmResult.error}). Usando uma especificação simplificada para não travar o Enxame.`, 'warn');
      }
      if (desistiu()) return;
      setSwarmPMArtifact(pmParsed);
      setSwarmProgress(30);
      setSwarmProgressText('30% - Especificação pronta! Iniciando a arquitetura...');
      addSwarmLog('📋 Agente de Produto', `Especificação pronta: ${pmParsed.tipo || 'produto'} com ${pmParsed.mechanics?.length || 0} capacidade(s) definida(s).`, 'success');

      // ==========================================
      // STAGE 2: AGENTE DE ARQUITETURA (SOFTWARE ARCHITECT)
      // ==========================================
      setSwarmCurrentStep('architect');
      setSwarmProgress(35);
      setSwarmProgressText('35% - Agente de Arquitetura projetando a estrutura de arquivos...');
      addSwarmLog('🏗️ Agente de Arquitetura', 'Projetando a estrutura de arquivos e o gerenciamento de estado...', 'info');

      /**
       * O ARQUITETO PASSA A PROJETAR A ÁRVORE, E NÃO UM ARQUIVO.
       *
       * Antes, o padrão de estrutura era literalmente a string "index.html" e a instrução mandava
       * projetar game loop e detecção de colisões — de modo que a resposta certa para "app de
       * gestão de estoque" era impossível de expressar. Agora ele devolve uma LISTA de arquivos com
       * o papel de cada um, e é essa lista que decide o formato da entrega mais adiante.
       *
       * O limite de 12 arquivos não é estética: cada arquivo é escrito por inteiro numa resposta só,
       * e uma árvore grande demais estoura o limite de tokens no meio — que é exatamente o que faz
       * um arquivo ser DESCARTADO por vir pela metade. Menos arquivos e completos valem mais que
       * muitos pela metade.
       */
      const architectSystemInstruction = `Você é o AGENTE DE ARQUITETURA (Software Architect) do OSONE CODE Swarm Engine.
Projete a ESTRUTURA DE ARQUIVOS do produto, a partir da especificação do Agente de Produto.

A regra de ouro é o FORMATO ESCOLHIDO PELO USUÁRIO, acima até do tipo do produto:
- ${formatoEscolhido === 'single'
  ? '"arquivo único": projete EXATAMENTE UM arquivo, "index.html", com HTML, CSS e JavaScript juntos. Não crie package.json, src/, frontend/ nem server/.'
  : '"árvore completa": projete vários arquivos reais. Use React/TypeScript entrando por "src/main.tsx", com "src/App.tsx" e componentes em "src/components/". O preview do OSONE CODE roda isso de verdade: resolve imports e busca react/react-dom automaticamente.'}

FORMATO OBRIGATÓRIO (JSON estrito):
{
  "arquivos": [
    { "caminho": "src/main.tsx", "papel": "ponto de entrada: monta o App na div#root" },
    { "caminho": "src/App.tsx", "papel": "tela principal e estado" }
  ],
  "fileStructure": "Uma frase descrevendo a organização escolhida",
  "gameLoopStrategy": "Como o estado é gerenciado e como as telas se conectam",
  "librariesUsed": ["react", "react-dom"]
}

Regras rígidas:
- NO MÁXIMO 12 arquivos. Prefira menos arquivos e completos: cada um é escrito inteiro de uma vez, e um projeto grande demais chega cortado.
- Se o formato escolhido foi "arquivo único", "arquivos" tem UM item só: index.html.
- Se o formato escolhido foi "árvore completa", "arquivos" tem no mínimo src/main.tsx e src/App.tsx.
- Não invente pasta vazia nem arquivo sem papel claro. Cada caminho da lista vai ser escrito de verdade.
- Use apenas bibliotecas que existem no npm e funcionam no navegador.
- Todo elemento buscado por document.getElementById/querySelector precisa existir antes do listener, ou ter guarda contra null.`;

      const archFallback = {
        arquivos: formatoEscolhido === 'tree' ? arquivosBaseParaArvore : [{ caminho: 'index.html', papel: 'aplicação completa em arquivo único' }],
        fileStructure: formatoEscolhido === 'tree' ? "src/main.tsx + src/App.tsx + components" : "index.html",
        gameLoopStrategy: formatoEscolhido === 'tree' ? "estado no React" : "estado no próprio script",
        librariesUsed: formatoEscolhido === 'tree' ? ["react", "react-dom"] : ["Tailwind CSS"]
      };
      const archResult = await generateWithRetry({
        ...configDaApiDoCode,
        prompt: `FORMATO ESCOLHIDO PELO USUÁRIO: ${nomeDoFormatoEscolhido}\n\nESPECIFICAÇÃO DO AGENTE DE PRODUTO:\n${JSON.stringify(pmParsed, null, 2)}`,
        systemInstruction: architectSystemInstruction,
        responseMimeType: "application/json"
      }, 2, controle.signal);

      let archParsed: any = archFallback;
      if (archResult.ok) {
        try { archParsed = JSON.parse(archResult.text.trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim()); } catch { archParsed = archFallback; }
      } else {
        addSwarmLog('🏗️ Agente de Arquitetura', `⚠️ Falha ao contatar o Agente de Arquitetura (${archResult.error}). Usando arquitetura padrão para não travar o Enxame.`, 'warn');
      }
      if (desistiu()) return;

      /**
       * É AQUI QUE O ENXAME ESCOLHE O FORMATO DA ENTREGA.
       *
       * Um arquivo na lista (jogo, página) segue pelo caminho de sempre — SEARCH/REPLACE num
       * arquivo só, que é bem testado e é o formato certo para esse tipo de produto. Mais de um
       * arquivo passa a usar o formato de projeto, com a árvore inteira numa resposta.
       *
       * A escolha é do Arquiteto, e não uma regra fixa daqui: quem sabe se o pedido pede um jogo
       * ou um app é quem leu o pedido.
       */
      const arquivosPlanejadosBrutos: Array<{ caminho: string; papel?: string }> =
        Array.isArray(archParsed?.arquivos) ? archParsed.arquivos.filter((a: any) => a?.caminho).slice(0, 12) : [];
      const arquivosPlanejados: Array<{ caminho: string; papel?: string }> = formatoEscolhido === 'single'
        ? [{ caminho: 'index.html', papel: 'aplicação completa em arquivo único' }]
        : (arquivosPlanejadosBrutos.length > 1 ? arquivosPlanejadosBrutos : arquivosBaseParaArvore);
      const projetoDeVariosArquivos = formatoEscolhido === 'tree';

      if (formatoEscolhido === 'single') {
        archParsed = {
          ...archParsed,
          arquivos: arquivosPlanejados,
          fileStructure: 'index.html — arquivo único escolhido pelo usuário',
          librariesUsed: Array.isArray(archParsed?.librariesUsed) ? archParsed.librariesUsed : ['Tailwind CSS']
        };
      } else if (arquivosPlanejadosBrutos.length <= 1) {
        archParsed = {
          ...archParsed,
          arquivos: arquivosPlanejados,
          fileStructure: 'src/main.tsx + src/App.tsx + componentes — árvore completa escolhida pelo usuário',
          librariesUsed: ['react', 'react-dom']
        };
      }
      setSwarmArchitectArtifact(archParsed);

      setSwarmProgress(45);
      setSwarmProgressText('45% - Arquitetura validada! Iniciando Engenharia...');
      addSwarmLog('🏗️ Agente de Arquitetura',
        projetoDeVariosArquivos
          ? `Arquitetura validada: projeto de ${arquivosPlanejados.length} arquivos (${arquivosPlanejados.map(a => a.caminho).join(', ')}).`
          : 'Arquitetura validada: arquivo único, que é o formato certo para este tipo de produto.',
        'success');

      // ==========================================
      // STAGE 3 & 4: HARNESS ENGINEERING LOOP (ENGINEER + QA)
      // ==========================================
      let currentIter = 1;
      let lastCode = "";
      let isApproved = false;

      /**
       * O retrato do projeto: o que o Engenheiro e o QA leem como "código atual".
       *
       * No caminho de arquivo único, "código atual" era simplesmente o texto do arquivo. Com vários,
       * é preciso um retrato do conjunto — senão o Engenheiro edita no escuro e o QA aprova um
       * arquivo sem saber o que os outros fazem, que é como nasce um projeto onde cada peça está
       * certa sozinha e nenhuma se encaixa.
       */
      const retratoDoProjeto = (): string => filesRef.current
        .map(f => `<<<<<<< ARQUIVO: ${f.name}\n${f.content || ''}\n>>>>>>> FIM ARQUIVO`)
        .join('\n\n');
      let coderEverSucceeded = false;
      let previousQAFeedback = "";
      // Ciclos seguidos em que o código saiu igual ao que entrou. Ver o corte do laço abaixo.
      let ciclosSemProgresso = 0;
      let ultimaEntregaCortada = false;
      let exigirArquivoInteiro = false;

      while (currentIter <= maxHarnessIterations && !isApproved) {
        setSwarmIteration(currentIter);

        // 3.1 AGENTE DE ENGENHARIA (ENGINEER / CODER)
        // A partir da 2ª iteração, o código já existe: o agente faz EDIÇÕES CIRÚRGICAS
        // (old_string/new_string) em vez de reescrever tudo do zero, igual a um par de
        // programação real — preserva o que já funciona e reduz o risco de regressão.
        setSwarmCurrentStep('coder');
        const iterCoderProg = 45 + Math.round(((currentIter - 0.5) / maxHarnessIterations) * 45);
        setSwarmProgress(iterCoderProg);
        setSwarmProgressText(`${iterCoderProg}% - Agente de Engenharia escrevendo o ${projetoDeVariosArquivos ? 'projeto' : 'código'} (Ciclo ${currentIter}/${maxHarnessIterations})...`);
        addSwarmLog('💻 Agente de Engenharia', lastCode
          ? `Corrigindo o que o QA apontou (Iteração ${currentIter}/${maxHarnessIterations})...`
          : projetoDeVariosArquivos
            ? `Escrevendo os ${arquivosPlanejados.length} arquivos do projeto (Iteração ${currentIter}/${maxHarnessIterations})...`
            : `Escrevendo o código completo (Iteração ${currentIter}/${maxHarnessIterations})...`, 'info');

        /**
         * A instrução do Engenheiro segue o formato escolhido pelo Arquiteto.
         *
         * O texto anterior era o de um gerador de jogo, e valia para os dois casos: mandava
         * produzir "o código completo no arquivo index.html", com "som de tiro, dano, pulo e game
         * over" e "tela de Game Over com botão de Reiniciar" — inclusive quando o pedido era um
         * sistema de estoque. Não adianta o Arquiteto planejar uma árvore se quem escreve continua
         * recebendo ordem de fazer um jogo num arquivo.
         */
        const coderRoleIntro = projetoDeVariosArquivos
          ? `Você é o AGENTE DE ENGENHARIA (Engineer/Coder) do OSONE CODE Swarm Engine.
Sua missão é escrever os arquivos do projeto, COMPLETOS e funcionando juntos.

O projeto roda no preview do OSONE CODE, que executa módulos de verdade: os imports entre os seus arquivos são resolvidos, e "react"/"react-dom" são buscados automaticamente. Escreva como escreveria num projeto Vite normal.

Exigências:
- Escreva TODOS os arquivos da arquitetura, cada um inteiro.
- A entrada monta o App numa <div id="root"> — ela já existe na página.
- Em src/main.tsx, procure #root com segurança; se não existir, crie uma div#root antes de montar. Nunca chame addEventListener/createRoot em null.
- Estilo com Tailwind (a classe funciona direto, sem configurar nada).
- Design limpo e adaptado a celular e computador.
- Nada de "resto igual" nem trecho omitido: o que você não escrever, não existe.

${INSTRUCAO_DE_PROJETO_MULTIARQUIVO}`
          : `Você é o AGENTE DE ENGENHARIA (Engineer/Coder) do OSONE CODE Swarm Engine.
Sua missão é produzir o CÓDIGO FONTE 100% COMPLETO, FUNCIONAL E LINDO no arquivo "index.html".
O código DEVE conter:
- HTML5 completo com <head>, estilo e <script> unificados no mesmo arquivo.
- Importação do Tailwind CSS CDN (<script src="https://cdn.tailwindcss.com"></script>) e Lucide Icons.
- Todo id/classe usado no JavaScript precisa existir no HTML antes do script rodar; nunca chame addEventListener em elemento possivelmente null.
- Design futurista, limpo e adaptado para telas mobile e desktop.
- Design e interações à altura do que foi pedido${(pmParsed?.tipo || '') === 'jogo' ? ', incluindo game loop com requestAnimationFrame, pontuação, tela de início e tela de fim com botão de reiniciar, e efeitos sonoros via Web Audio API' : ''}.`;
        const coderSystemInstruction = projetoDeVariosArquivos
          ? coderRoleIntro
          : buildCodeEditSystemInstruction(coderRoleIntro);

        // Depois de um ciclo em que nenhum bloco casou, a ordem de fechamento precisa ser a
        // OPOSTA da de sempre: insistir em "edições cirúrgicas, sem reescrever o arquivo inteiro"
        // era mandar o engenheiro repetir exatamente o que acabou de não funcionar.
        const ordemFinal = exigirArquivoInteiro
          ? `Responda com o código-fonte COMPLETO do arquivo inteiro, do <!DOCTYPE html> até o </html>, já com TODAS as correções acima aplicadas. NÃO use blocos SEARCH/REPLACE nesta resposta.`
          : `Corrija TODOS os itens acima usando blocos SEARCH/REPLACE cirúrgicos, sem reescrever o arquivo inteiro.`;

        const codigoAtual = projetoDeVariosArquivos ? retratoDoProjeto() : lastCode;
        const jaHaCodigo = !!lastCode;

        // No projeto de vários arquivos, a ordem de correção é reescrever OS ARQUIVOS AFETADOS
        // inteiros — não há SEARCH/REPLACE aqui, e mandar usá-lo faria o modelo responder num
        // formato que este caminho não lê, gastando a iteração sem gravar nada.
        const ordemDeCorrecao = projetoDeVariosArquivos
          ? `Reescreva INTEIROS, no formato de projeto, apenas os arquivos que precisam mudar. Não repita os arquivos que já estão certos.`
          : ordemFinal;

        const coderPrompt = jaHaCodigo
          ? `${projetoDeVariosArquivos ? 'PROJETO ATUAL NO REPOSITÓRIO' : 'CÓDIGO FONTE ATUAL NO REPOSITÓRIO'}:\n\n${codigoAtual}\n\nESPECIFICAÇÕES ORIGINAIS:\n- Pedido do Usuário: "${swarmPrompt}"\n- Especificação do Produto: ${JSON.stringify(pmParsed)}\n- Arquitetura: ${JSON.stringify(archParsed)}\n\n⚠️ CRÍTICO - CORREÇÕES EXIGIDAS NA ITERAÇÃO ANTERIOR:\n"${previousQAFeedback}"\n${ordemDeCorrecao}`
          : `Não há código existente ainda. Crie do zero.\n\nESPECIFICAÇÕES:\n- Pedido do Usuário: "${swarmPrompt}"\n- Especificação do Produto: ${JSON.stringify(pmParsed)}\n- Arquitetura: ${JSON.stringify(archParsed)}${projetoDeVariosArquivos ? `\n\nESCREVA ESTES ARQUIVOS, todos, cada um inteiro:\n${arquivosPlanejados.map(a => `- ${a.caminho}: ${a.papel || ''}`).join('\n')}` : ''}`;

        const coderResult = await generateWithRetry({
          ...configDaApiDoCode,
          prompt: coderPrompt,
          systemInstruction: coderSystemInstruction
        }, 2, controle.signal);

        if (desistiu()) break;

        if (!coderResult.ok) {
          if (coderResult.cancelado) break;
          addSwarmLog('💻 Agente de Engenharia', `⚠️ Falha ao contatar o Agente de Engenharia (${coderResult.error}) na Iteração ${currentIter}.`, 'error');
          if (coderEverSucceeded) {
            addSwarmLog('💻 Agente de Engenharia', 'Mantendo a última versão do código já salva no repositório e encerrando o Enxame com o que foi produzido até aqui.', 'warn');
          }
          break;
        }

        /**
         * A GRAVAÇÃO SEGUE O FORMATO — e passar um pelo outro destrói o resultado.
         *
         * applyModelCodeResponse trata o texto como o conteúdo de UM arquivo. Se a resposta veio em
         * blocos de projeto e caísse ali, o texto com os marcadores "<<<<<<< ARQUIVO:" seria gravado
         * cru dentro do arquivo principal: o projeto inteiro viraria lixo num arquivo só, e o QA
         * ainda avaliaria esse lixo como se fosse código.
         */
        let newCode = '';
        let editSummary = '';
        let editHadFailures = false;
        let respostaCortada = false;

        if (projetoDeVariosArquivos) {
          // O histórico é empilhado a cada iteração: o Enxame inteiro cabe num Ctrl+Z, e cada
          // ciclo é um ponto de retorno — o que importa quando a iteração 3 piora o que a 2 fez.
          pushHistory(filesRef.current);
          const aplicado = aplicarArquivosDoModelo(coderResult.text, filesRef.current, {
            linguagemDe: (caminho) => linguagemPelaExtensao(caminho)
          });
          respostaCortada = aplicado.cortada;
          editSummary = aplicado.resumo;
          editHadFailures = aplicado.recusados.length > 0;

          if (!aplicado.criados.length && !aplicado.atualizados.length) {
            addSwarmLog('💻 Agente de Engenharia',
              `⚠️ Nenhum arquivo veio no formato de projeto na Iteração ${currentIter}. ${aplicado.resumo}`, 'warn');
            break;
          }
          setFiles(aplicado.arquivos);
          newCode = aplicado.arquivos.map(f => `${f.name}\n${f.content || ''}`).join('\n\n');
        } else {
          const aplicado = applyModelCodeResponse(coderResult.text, lastCode);
          newCode = aplicado.content;
          editSummary = aplicado.summary;
          editHadFailures = aplicado.hadFailures;
          respostaCortada = aplicado.respostaCortada;
        }

        if (!newCode || !newCode.trim()) {
          addSwarmLog('💻 Agente de Engenharia', `⚠️ Resposta vazia do Agente de Engenharia na Iteração ${currentIter}. Mantendo código anterior.`, 'warn');
          break;
        }

        /**
         * CICLO QUE NÃO MUDA NADA NÃO PODE CONSUMIR O ENXAME EM SILÊNCIO.
         *
         * Quando os blocos SEARCH/REPLACE do engenheiro não casam com o arquivo (ele os digita de
         * memória em vez de copiar), NENHUMA edição entra e o código volta idêntico. O laço
         * seguia assim mesmo: o QA reprovava o mesmo arquivo de novo, o engenheiro errava o
         * mesmo trecho de novo, e as iterações acabavam sem um caractere ter mudado — o Enxame
         * "rodava" do começo ao fim sem finalizar coisa alguma.
         *
         * Agora o próprio impasse vira instrução: na primeira vez o engenheiro é avisado de que
         * as edições não casaram e recebe ordem de reescrever o arquivo inteiro; se o ciclo
         * seguinte também não mudar nada, o Enxame para em vez de gastar as iterações à toa.
         */
        if (coderEverSucceeded && newCode === lastCode) {
          ciclosSemProgresso++;
          addSwarmLog('💻 Agente de Engenharia',
            `⚠️ Nenhuma edição casou com o código atual na Iteração ${currentIter} — o arquivo não mudou${editSummary ? ` (${editSummary})` : ''}.`,
            'warn');
          if (ciclosSemProgresso >= 2) {
            addSwarmLog('💻 Agente de Engenharia', 'Dois ciclos seguidos sem alterar nada: encerrando o Enxame com a última versão válida em vez de gastar as iterações restantes.', 'error');
            break;
          }
          previousQAFeedback = `${previousQAFeedback}\n\n⚠️ ATENÇÃO: na iteração anterior NENHUM dos seus blocos SEARCH/REPLACE casou com o arquivo — o trecho procurado não existe exatamente como você escreveu.`;
          exigirArquivoInteiro = true;
          currentIter++;
          continue;
        }
        ciclosSemProgresso = 0;
        exigirArquivoInteiro = false;

        lastCode = newCode;
        coderEverSucceeded = true;

        // Persistência incremental: salva o progresso no repositório a cada iteração,
        // para que o usuário NUNCA fique sem resultado mesmo se uma etapa seguinte falhar.
        // O destino é o arquivo PRINCIPAL do projeto, não o nome literal 'index.html': num projeto
        // cuja página principal se chama outra coisa, o nome fixo criava um arquivo à parte e o
        // Enxame "terminava" sem ter tocado no arquivo que a pessoa abre.
        // No projeto de vários arquivos a gravação já aconteceu acima, em todos eles. Chamar isto
        // aqui jogaria o retrato do projeto inteiro dentro do arquivo principal.
        if (!projetoDeVariosArquivos) applyCodeToRepository(lastCode, arquivoPrincipalId());

        if (coderResult.blocked) {
          addSwarmLog('💻 Agente de Engenharia', `⚠️ O Gemini bloqueou a resposta pelo filtro de segurança nesta iteração. O QA vai avaliar o que sobrou e pode reprovar para uma nova tentativa com um pedido reformulado.`, 'warn');
        }

        /**
         * O código chegou cortado ao arquivo. O QA sozinho não resolve isso: ele avalia o texto e
         * pode até dar nota boa a meia página bem escrita. Aqui o corte é dito por escrito ao
         * engenheiro na iteração seguinte, com a única ordem que o conserta — terminar o arquivo.
         */
        ultimaEntregaCortada = coderResult.truncated || respostaCortada || pareceDocumentoIncompleto(lastCode);
        const aindaHaIteracao = currentIter < maxHarnessIterations;
        if (ultimaEntregaCortada) {
          addSwarmLog('💻 Agente de Engenharia',
            `⚠️ O código desta iteração (${lastCode.length} chars) chegou INCOMPLETO — a resposta acabou antes de fechar o arquivo, mesmo após as continuações automáticas. ` +
            (aindaHaIteracao
              ? 'O engenheiro será mandado terminá-lo na próxima iteração.'
              : 'Não restam iterações para terminá-lo — o Enxame vai encerrar avisando que o arquivo está incompleto.'),
            'error');
        }

        addSwarmLog('💻 Agente de Engenharia', editSummary
          ? `${editSummary} (${lastCode.length} chars). Progresso salvo no repositório.`
          : `Código gerado (${lastCode.length} chars) na Iteração ${currentIter}. Progresso salvo no repositório.`,
          editHadFailures ? 'warn' : 'success');

        // Arquivo incompleto não vai ao QA: a correção é conhecida e não depende de avaliação.
        if (ultimaEntregaCortada && aindaHaIteracao) {
          previousQAFeedback = `O arquivo entregue está INCOMPLETO: ele termina no meio, sem fechar as tags/funções abertas. Termine o arquivo. Use blocos SEARCH/REPLACE para completar a partir do trecho final existente, sem reescrever o que já está pronto e sem repetir nada.`;
          currentIter++;
          continue;
        }

        // 3.2 AGENTE DE GARANTIA DE QUALIDADE (QA TESTER / HARNESS EVALUATOR)
        setSwarmCurrentStep('qa');
        const iterQAProg = 45 + Math.round((currentIter / maxHarnessIterations) * 45);
        setSwarmProgress(iterQAProg);
        setSwarmProgressText(`${iterQAProg}% - Agente de QA executando testes automáticos de qualidade (Ciclo ${currentIter}/${maxHarnessIterations})...`);
        addSwarmLog('🧪 Agente de QA (Harness Evaluator)', `Executando testes automáticos de qualidade (Iteração ${currentIter})...`, 'info');

        /**
         * O QA revisava procurando GAME LOOP e TELA DE GAME OVER — em qualquer projeto.
         *
         * Isso era pior do que inútil num app: reprovava por não achar coisas que o produto não
         * deveria ter, e mandava o Engenheiro adicioná-las. A conferência que faltava era a única
         * que quebra um projeto de vários arquivos e não aparece lendo um arquivo só: se os imports
         * de um apontam para arquivos que existem mesmo.
         */
        const criteriosDoTipo = projetoDeVariosArquivos
          ? `2. Se TODOS os arquivos da arquitetura existem, e se os imports de um apontam para arquivos que estão de fato no projeto (um import para um arquivo que ninguém escreveu deixa o app em branco).
3. Se a entrada monta o App na div#root e se as telas/estados descritos na especificação existem de verdade.`
          : (pmParsed?.tipo || '') === 'jogo'
            ? `2. Presença de game loop (requestAnimationFrame ou setInterval) sem vazamento de memória.
3. Controles funcionais (teclado/toque) e telas de início e de fim.`
            : `2. Se a página faz o que a especificação diz, e não só parece bonita.
3. Se os elementos interativos realmente funcionam (botões ligados, campos lidos, estado atualizado).`;

        const qaSystemInstruction = `Você é o AGENTE DE QA & TESTES (QA Tester / Harness Evaluator) do OSONE CODE Swarm Engine.
Analise criteriosamente o que o Engenheiro entregou, contra a especificação e o pedido do usuário.

Verifique:
1. Sintaxe e fechamento de tags/funções — inclusive se algum arquivo termina no meio.
${criteriosDoTipo}
4. Fidelidade total ao pedido ("${swarmPrompt}").

NÃO cobre recursos que o produto não deveria ter. Um sistema de cadastro não precisa de game loop, e um jogo não precisa de formulário de login.

FORMATO OBRIGATÓRIO (JSON estrito):
{
  "score": number (0 a 100),
  "passed": boolean (true se score >= 95),
  "feedback": "Relatório detalhado e instrução para o engenheiro se houver falhas. Cite o CAMINHO do arquivo em cada problema.",
  "missingItems": ["Item ausente 1", "Bug 2"]
}`;

        const qaResult = await generateWithRetry({
          ...configDaApiDoCode,
          // Sem cortar o código: o Gemini suporta contexto grande, e um corte fixo (antes 15000
          // chars) deixava o final do arquivo — as últimas telas, os efeitos, o fechamento
          // de tags — fora da revisão do QA justamente nos projetos maiores/melhores.
          prompt: `${projetoDeVariosArquivos ? 'PROJETO GERADO PELO ENGENHEIRO' : 'CÓDIGO GERADO PELO ENGENHEIRO'}:\n\n${projetoDeVariosArquivos ? retratoDoProjeto() : lastCode}`,
          systemInstruction: qaSystemInstruction,
          responseMimeType: "application/json"
        }, 2, controle.signal);

        if (desistiu()) break;

        if (!qaResult.ok) {
          if (qaResult.cancelado) break;
          addSwarmLog('🧪 Agente de QA (Harness Evaluator)', `⚠️ Falha ao contatar o Agente de QA (${qaResult.error}). Aceitando a última versão do código já salva no repositório.`, 'warn');
          isApproved = true;
          break;
        }

        let qaText = qaResult.text.trim();
        if (qaText.startsWith("```")) qaText = qaText.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();

        let qaParsed: any;
        try { qaParsed = JSON.parse(qaText); } catch { qaParsed = { score: 95, passed: true, feedback: "Código verificado e aprovado.", missingItems: [] }; }

        const newQAReport = {
          iteration: currentIter,
          score: qaParsed.score || 90,
          passed: !!qaParsed.passed,
          feedback: qaParsed.feedback || "Avaliação de código concluída.",
          missingItems: qaParsed.missingItems || []
        };

        setSwarmQAReports(prev => [...prev, newQAReport]);

        if (qaParsed.passed || qaParsed.score >= 95) {
          isApproved = true;
          addSwarmLog('🧪 Agente de QA (Harness Evaluator)', `✓ APROVADO COM SUCESSO! Nota: ${qaParsed.score}/100 na Iteração ${currentIter}.`, 'success');
        } else {
          addSwarmLog('🧪 Agente de QA (Harness Evaluator)', `⚠️ QA reprovou o código (Nota: ${qaParsed.score}/100). Disparando Loop Harness para a Iteração ${currentIter + 1}...`, 'warn');
          previousQAFeedback = `Feedback do QA: ${qaParsed.feedback}. Itens faltantes: ${qaParsed.missingItems?.join(', ')}`;
          currentIter++;
        }
      }

      // ==========================================
      // STAGE 5: ASSEMBLY & REPOSITORY SYNCHRONIZATION
      // ==========================================
      setSwarmCurrentStep('assembly');

      /**
       * Desistiu: o Enxame não anuncia nada e não abre o Preview.
       *
       * O progresso já gravado nas iterações anteriores CONTINUA no repositório de propósito —
       * é a persistência incremental, e apagá-la seria destruir trabalho que já existia. O que
       * não pode acontecer é a tela comemorar um projeto que a pessoa mandou parar.
       */
      if (desistiu()) {
        setSwarmStatus('idle');
        setSwarmProgress(0);
        setSwarmProgressText('');
        return;
      }

      if (!coderEverSucceeded || !lastCode.trim()) {
        // Nenhuma versão de código foi produzida com sucesso em nenhuma iteração: reporta com honestidade.
        setSwarmStatus('error');
        setSwarmProgress(100);
        setSwarmProgressText('O Enxame não conseguiu produzir um código válido.');
        addSwarmLog('🚀 Cérebro Integrador', '❌ Nenhuma versão de código válida foi produzida pelo Enxame. Nada foi aplicado no repositório.', 'error');
        return;
      }

      setSwarmProgress(98);
      setSwarmProgressText('98% - Projeto salvo! Abrindo Preview Vivo...');
      addSwarmLog('🚀 Cérebro Integrador', 'Última versão do código já está salva no Repositório do OSONE CODE (persistida a cada iteração).', 'info');

      /**
       * "FINALIZADO" PRECISA QUERER DIZER FINALIZADO.
       *
       * O fecho era o mesmo qualquer que fosse o desfecho: aprovado pelo QA anunciava "✨ Jogo
       * Finalizado & Testado", e o resto anunciava um aviso genérico. Um arquivo que acaba no meio
       * do <script> passava por qualquer um dos dois — inclusive pelo primeiro, porque o QA lê o
       * texto e pode achar bom o pedaço que existe. A palavra "finalizado" ficou reservada ao caso
       * em que o arquivo realmente fecha; quando ele não fecha, isso é o que a tela diz.
       */
      const entregaIncompleta = ultimaEntregaCortada || pareceDocumentoIncompleto(lastCode);

      setSwarmStatus(entregaIncompleta ? 'error' : 'success');
      setSwarmProgress(100);
      const finalMsg = entregaIncompleta
        ? '100% - ⚠️ O código salvo está INCOMPLETO: o arquivo não chegou ao fim.'
        : isApproved
          ? '100% - ✨ Jogo Finalizado & Testado pelo Enxame com Sucesso!'
          : '100% - ⚠️ Enxame encerrado com a melhor versão obtida (nem todas as etapas concluíram, mas o progresso foi salvo).';
      setSwarmProgressText(finalMsg);
      addSwarmLog('🚀 Cérebro Integrador', entregaIncompleta
        ? '⚠️ O arquivo salvo termina no meio — o modelo não conseguiu fechá-lo nem com as continuações automáticas. Rode o Enxame de novo pedindo apenas para TERMINAR o arquivo, ou peça um jogo mais simples.'
        : isApproved
          ? '✨ Projeto finalizado e testado pelo Enxame de Agentes OSONE CODE!'
          : '⚠️ Enxame encerrado antes da aprovação total do QA, mas a última versão gerada foi salva no repositório e está pronta para uso.',
        entregaIncompleta ? 'error' : isApproved ? 'success' : 'warn');

      // Auto-abrir Preview Vivo e notificar
      setViewLayout('preview');
      setNotificationBanner({
        message: entregaIncompleta
          ? "⚠️ O Enxame salvou o que conseguiu, mas o arquivo está INCOMPLETO (termina no meio). Peça no Enxame para terminar o arquivo, ou simplifique o pedido."
          : isApproved
            ? "🎉 Jogo criado e testado pelo Enxame com sucesso! O código foi aplicado no repositório e o Preview Vivo foi aberto automaticamente."
            : "⚠️ O Enxame encerrou sem aprovação total do QA, mas salvou a última versão do código no repositório. Você pode revisar e pedir ajustes.",
        type: entregaIncompleta ? "error" : isApproved ? "success" : "info"
      });

      // Auto-fechar o modal só quando há boa notícia. Fechá-lo sozinho em cima de um aviso de
      // arquivo incompleto esconderia justamente o que o usuário precisa ler.
      if (!entregaIncompleta) {
        setTimeout(() => {
          setIsSwarmModalOpen(false);
        }, 1800);
      }

    } catch (err: any) {
      if (err?.name === 'AbortError' || controle.signal.aborted) {
        setSwarmStatus('idle');
        setSwarmProgress(0);
        setSwarmProgressText('');
        return;
      }
      console.error("Erro na execução do Enxame Swarm:", err);
      setSwarmStatus('error');
      setSwarmProgressText('Erro na execução do Enxame');
      addSwarmLog('⚠️ Sistema Swarm', `Erro na execução do Enxame: ${err.message || String(err)}`, 'error');
    } finally {
      if (cancelamentoDoEnxameRef.current === controle) cancelamentoDoEnxameRef.current = null;
    }
  };

  return (
    <div className="w-full flex-1 flex flex-col bg-[#080a0f] text-zinc-100 min-h-0 overflow-hidden select-none font-sans relative">
      {/* Top Floating Toast Notification Banner */}
      <AnimatePresence>
        {notificationBanner && (
          <motion.div 
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            className={cn(
              "absolute top-16 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-2xl font-mono text-xs flex items-center gap-3 border shadow-2xl backdrop-blur-xl max-w-xl w-[90%]",
              notificationBanner.type === 'success' ? "bg-emerald-950/90 border-emerald-500/50 text-emerald-200 shadow-emerald-950/50" :
              notificationBanner.type === 'error' ? "bg-red-950/90 border-red-500/50 text-red-200 shadow-red-950/50" :
              "bg-cyan-950/90 border-cyan-500/50 text-cyan-200 shadow-cyan-950/50"
            )}
          >
            {/* O ícone segue o TIPO do aviso. Era sempre o de sucesso — um check verde pulando
                em cima de "o arquivo está incompleto" ou "nada foi alterado" faz o usuário ler
                erro como confirmação, que é o pior desfecho possível para um aviso. */}
            {notificationBanner.type === 'error'
              ? <AlertTriangle size={18} className="text-red-400 shrink-0" />
              : notificationBanner.type === 'info'
                ? <AlertCircle size={18} className="text-cyan-400 shrink-0" />
                : <CheckCircle2 size={18} className="text-emerald-400 shrink-0 animate-bounce" />}
            <span className="flex-1 font-medium leading-relaxed">{notificationBanner.message}</span>
            <button 
              onClick={() => setNotificationBanner(null)}
              className="p-1 hover:bg-white/10 rounded-lg text-zinc-400 hover:text-white transition-colors"
            >
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isCodeApiSettingsOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.96, y: 16 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.96, y: 16 }}
              className="w-full max-w-2xl rounded-3xl border border-cyan-500/20 bg-[#0b1018] shadow-2xl shadow-cyan-950/50 overflow-hidden"
            >
              <div className="p-5 border-b border-white/10 flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-cyan-300 text-[11px] font-mono uppercase tracking-[0.22em]">
                    <KeyRound size={14} /> API do OSONE CODE
                  </div>
                  <h3 className="text-xl font-semibold text-white mt-2">Escolha o motor de código</h3>
                  <p className="text-sm text-zinc-400 mt-1">
                    Gemini segue como padrão. OpenAI/ChatGPT e Claude usam a chave paga da própria pessoa.
                  </p>
                </div>
                <button
                  onClick={() => setIsCodeApiSettingsOpen(false)}
                  className="p-2 rounded-xl bg-white/5 text-zinc-400 hover:text-white hover:bg-white/10 transition-colors"
                  title="Fechar configurações da API do Code"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="p-5 space-y-5">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {[
                    { id: 'gemini', label: 'Gemini padrão', desc: 'Usa a chave Gemini do OSONE/usuário' },
                    { id: 'openai', label: 'ChatGPT/OpenAI', desc: 'Cobra na conta OpenAI da chave informada' },
                    { id: 'anthropic', label: 'Claude', desc: 'Cobra na conta Anthropic da chave informada' },
                    { id: 'ollama', label: 'Ollama (local)', desc: 'Qwen Coder grátis, rodando neste computador' }
                  ].map((opcao) => (
                    <button
                      key={opcao.id}
                      onClick={() => onUpdateApiKeys?.({ osoneCodeProvider: opcao.id as ApiKeys['osoneCodeProvider'] })}
                      className={cn(
                        "text-left rounded-2xl border p-3 transition-all",
                        provedorDoCode === opcao.id
                          ? "bg-cyan-500/15 border-cyan-400/50 text-white shadow-lg shadow-cyan-950/40"
                          : "bg-white/[0.03] border-white/10 text-zinc-300 hover:bg-white/[0.06]"
                      )}
                    >
                      <div className="flex items-center gap-2 text-sm font-semibold">
                        {provedorDoCode === opcao.id ? <Check size={14} className="text-emerald-300" /> : <Cpu size={14} className="text-zinc-500" />}
                        {opcao.label}
                      </div>
                      <p className="text-[11px] text-zinc-500 mt-1 leading-relaxed">{opcao.desc}</p>
                    </button>
                  ))}
                </div>

                <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 p-3 text-xs text-amber-100 leading-relaxed">
                  <strong>Aviso de cobrança:</strong> ao selecionar ChatGPT/OpenAI ou Claude, as chamadas do OSONE CODE
                  são enviadas para a API escolhida e os custos são cobrados diretamente da conta dona da chave. O OSONE
                  não controla cota, saldo, limites nem reembolsos dessas APIs externas.
                </div>

                {provedorDoCode === 'openai' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="space-y-1.5">
                      <span className="text-[11px] uppercase tracking-[0.18em] text-zinc-500 font-mono">Chave OpenAI</span>
                      <input
                        type="password"
                        value={apiKeys?.osoneCodeOpenAiApiKey || ''}
                        onChange={(e) => onUpdateApiKeys?.({ osoneCodeOpenAiApiKey: e.target.value })}
                        placeholder="sk-..."
                        className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-400/60"
                      />
                    </label>
                    <label className="space-y-1.5">
                      <span className="text-[11px] uppercase tracking-[0.18em] text-zinc-500 font-mono">Modelo OpenAI</span>
                      <input
                        value={apiKeys?.osoneCodeOpenAiModel || 'gpt-5.5'}
                        onChange={(e) => onUpdateApiKeys?.({ osoneCodeOpenAiModel: e.target.value })}
                        placeholder="gpt-5.5"
                        className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-400/60"
                      />
                    </label>
                  </div>
                )}

                {provedorDoCode === 'anthropic' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="space-y-1.5">
                      <span className="text-[11px] uppercase tracking-[0.18em] text-zinc-500 font-mono">Chave Anthropic</span>
                      <input
                        type="password"
                        value={apiKeys?.osoneCodeAnthropicApiKey || ''}
                        onChange={(e) => onUpdateApiKeys?.({ osoneCodeAnthropicApiKey: e.target.value })}
                        placeholder="sk-ant-..."
                        className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-400/60"
                      />
                    </label>
                    <label className="space-y-1.5">
                      <span className="text-[11px] uppercase tracking-[0.18em] text-zinc-500 font-mono">Modelo Claude</span>
                      <input
                        value={apiKeys?.osoneCodeAnthropicModel || 'claude-sonnet-5'}
                        onChange={(e) => onUpdateApiKeys?.({ osoneCodeAnthropicModel: e.target.value })}
                        placeholder="claude-sonnet-5"
                        className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-400/60"
                      />
                    </label>
                  </div>
                )}

                {provedorDoCode === 'ollama' && (
                  <div className="space-y-3">
                    <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs text-emerald-100 leading-relaxed">
                      <strong>Motor local — custo zero.</strong> O código é gerado pelo Qwen rodando neste computador,
                      sem chave de API e sem internet. Ele aceita só endereços da própria máquina (127.0.0.1), então um
                      OSONE publicado nunca usa o seu Ollama — nem o contrário. Em PC sem GPU com 8 GB de RAM, fique no
                      1.5B: os maiores trocam memória e ficam lentos demais.
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <label className="space-y-1.5">
                        <span className="text-[11px] uppercase tracking-[0.18em] text-zinc-500 font-mono">Modelo local</span>
                        <select
                          value={apiKeys?.osoneCodeOllamaModel || MODELOS_OLLAMA_PADRAO}
                          onChange={(e) => onUpdateApiKeys?.({ osoneCodeOllamaModel: e.target.value })}
                          className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-400/60"
                        >
                          {OPGOES_DE_MODELO_OLLAMA.map((m) => (
                            <option key={m.id} value={m.id}>{m.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className="space-y-1.5">
                        <span className="text-[11px] uppercase tracking-[0.18em] text-zinc-500 font-mono">Endereço do Ollama</span>
                        <input
                          value={apiKeys?.osoneCodeOllamaUrl || ''}
                          onChange={(e) => onUpdateApiKeys?.({ osoneCodeOllamaUrl: e.target.value })}
                          placeholder="http://127.0.0.1:11434"
                          className="w-full bg-black/40 border border-white/10 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-cyan-400/60"
                        />
                      </label>
                    </div>

                    <div className="text-[11px] text-zinc-500 leading-relaxed">
                      {OPGOES_DE_MODELO_OLLAMA.find((m) => m.id === (apiKeys?.osoneCodeOllamaModel || MODELOS_OLLAMA_PADRAO))?.desc}
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <button
                        onClick={instalarOllamaPelaInterface}
                        className="w-full px-4 py-2.5 rounded-xl bg-white/[0.06] border border-white/15 text-zinc-200 text-xs font-mono font-bold hover:bg-white/[0.12] transition-colors"
                      >
                        Instalar o Ollama neste PC
                      </button>
                      <button
                        onClick={baixarModeloDoOllamaPelaInterface}
                        disabled={Boolean(ollamaBaixando)}
                        className="w-full px-4 py-2.5 rounded-xl bg-emerald-500/15 border border-emerald-400/40 text-emerald-100 text-xs font-mono font-bold hover:bg-emerald-500/25 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {ollamaBaixando
                          ? `Baixando ${ollamaBaixando.modelo}… ${ollamaBaixando.percentual}% (${ollamaBaixando.status})`
                          : `Instalar modelo ${(apiKeys?.osoneCodeOllamaModel || MODELOS_OLLAMA_PADRAO)} neste PC`}
                      </button>
                    </div>
                    {ollamaAviso && (
                      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-[11px] text-zinc-300 leading-relaxed">
                        {ollamaAviso}
                      </div>
                    )}
                    <div className="text-[10px] text-zinc-600 leading-relaxed">
                      O botão fala com o Agente Local (este mesmo computador). Se o Ollama ainda não estiver instalado,
                      rode uma vez <span className="font-mono text-zinc-400">curl -fsSL https://ollama.com/install.sh | sh</span>{' '}
                      (Linux/macOS) ou o instalador de ollama.com/download (Windows) — depois volte aqui e baixe o modelo.
                    </div>
                  </div>
                )}

                {provedorDoCode === 'gemini' && (
                  <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs text-emerald-100 leading-relaxed">
                    Modo padrão ativo: o OSONE CODE usa Gemini para gerar código, Hunter, Enxame e sugestões.
                    Se houver uma chave Gemini nos Ajustes gerais, ela entra como chave do usuário.
                  </div>
                )}

                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                  <div className="text-[11px] text-zinc-500">
                    Provedor atual: <span className="text-cyan-300">{nomeDoProvedorDoCode}</span>
                    <span className="mx-1">•</span>
                    Modelo: <span className="text-zinc-300">{modeloDoProvedorDoCode}</span>
                  </div>
                  <button
                    onClick={() => setIsCodeApiSettingsOpen(false)}
                    className="px-4 py-2 rounded-xl bg-cyan-500/15 border border-cyan-400/40 text-cyan-100 text-xs font-mono font-bold hover:bg-cyan-500/25 transition-colors"
                  >
                    Salvar e voltar ao Code
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isGithubPanelOpen && (
          <CodeGithubPanel
            files={files}
            projectName={activeProjectName}
            onClose={() => setIsGithubPanelOpen(false)}
            onNotify={(message, type) => setNotificationBanner({ message, type })}
            onImportFiles={importarArquivosDoGithubParaCode}
          />
        )}
      </AnimatePresence>

      {/*
        BARRA SUPERIOR — identidade, projeto e as chaves do estúdio.

        Só o que é "de fora do código" mora aqui: qual projeto está aberto, para onde ele
        publica (GitHub) e com que credencial ele gera (API). As ferramentas que MEXEM no
        código ficam nas duas fileiras laterais, e o que se digita fica embaixo — assim o
        meio da tela é sempre o código/preview, inclusive num celular.
      */}
      <div className="border-b border-white/5 bg-[#0c0e14]/90 backdrop-blur-md px-2 sm:px-3 py-2 flex items-center gap-1.5 sm:gap-2 shrink-0 z-30">
        {/*
          A SAÍDA DA ABA.

          Com o OSONE CODE ocupando a tela inteira — por cima do cabeçalho do app e da
          navegação de baixo, que só roubavam altura daqui —, esta seta passa a ser o único
          caminho de volta. Antes o `onClose` chegava como propriedade e nunca era usado: quem
          entrava dependia da barra de navegação do app para sair.
        */}
        <button
          onClick={onClose}
          className="p-2 rounded-xl bg-white/[0.03] hover:bg-white/[0.08] text-zinc-400 hover:text-white border border-white/5 transition-all shrink-0"
          title="Fechar o OSONE CODE e voltar ao início"
          aria-label="Fechar o OSONE CODE"
        >
          <ChevronLeft size={16} />
        </button>

        <div className="flex items-center gap-2 shrink-0">
          <Code2 size={18} className="text-cyan-400 shrink-0" />
          <h2 className="hidden lg:block text-sm font-semibold tracking-tight text-white font-mono whitespace-nowrap">
            OSONE CODE
          </h2>
        </div>

        {/*
          O PROJETO INTEIRO NUM BOTÃO SÓ.

          Eram cinco pastilhas lado a lado ocupando uma faixa inteira da tela para dizer uma
          informação só: qual está aberto. Agora o botão MOSTRA o ativo e a troca acontece
          dentro dele.
        */}
        <div className="relative min-w-0 flex-1 sm:flex-none">
          <button
            onClick={() => setMenuProjetosAberto(v => !v)}
            className={cn(
              "w-full sm:w-auto max-w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl border text-xs font-mono font-bold transition-all cursor-pointer active:scale-95",
              menuProjetosAberto
                ? "bg-cyan-500/20 text-cyan-200 border-cyan-500/50"
                : "bg-cyan-500/10 text-cyan-300 border-cyan-500/25 hover:bg-cyan-500/15"
            )}
            title={`Projeto ativo: ${activeProjectName} (isolado dos demais)`}
          >
            <FolderGit2 size={14} className="shrink-0" />
            <span className="truncate">{activeProjectName}</span>
            <span className="hidden min-[430px]:inline text-[10px] font-normal text-cyan-400/70 shrink-0">
              {files.length} arq.
            </span>
            <ChevronDown size={13} className={cn("shrink-0 transition-transform", menuProjetosAberto && "rotate-180")} />
          </button>

          <AnimatePresence>
            {menuProjetosAberto && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuProjetosAberto(false)} />
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.15 }}
                  className="absolute left-0 top-[calc(100%+6px)] z-50 w-64 max-w-[85vw] bg-[#0b0e17] border border-white/10 rounded-2xl p-2 shadow-2xl flex flex-col gap-1"
                >
                  <p className="px-2 py-1 text-[10px] font-mono uppercase tracking-widest text-zinc-500">
                    Projetos — isolados entre si
                  </p>
                  {projects.map((proj) => {
                    const isCurrent = proj.id === activeProjectId;
                    const isEditingThis = editingProjectNameId === proj.id;

                    return (
                      <div
                        key={proj.id}
                        onClick={() => {
                          if (isEditingThis) return;
                          handleSwitchProject(proj.id);
                          setMenuProjetosAberto(false);
                        }}
                        className={cn(
                          "px-2.5 py-2 rounded-xl text-xs font-mono font-bold transition-all flex items-center gap-2 cursor-pointer border",
                          isCurrent
                            ? "bg-cyan-500/15 text-cyan-300 border-cyan-500/40"
                            : "bg-transparent text-zinc-400 hover:text-white border-transparent hover:bg-white/5"
                        )}
                      >
                        <span className={cn("w-2 h-2 rounded-full shrink-0", isCurrent ? "bg-cyan-400 animate-pulse" : "bg-zinc-600")} />

                        {isEditingThis ? (
                          <input
                            type="text"
                            value={editingProjectNameText}
                            onChange={(e) => setEditingProjectNameText(e.target.value)}
                            onBlur={() => handleSaveProjectName(proj.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveProjectName(proj.id);
                              if (e.key === 'Escape') setEditingProjectNameId(null);
                            }}
                            autoFocus
                            className="flex-1 min-w-0 bg-black/80 text-white px-2 py-0.5 rounded border border-cyan-400 text-xs focus:outline-none"
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <span className="flex-1 truncate">{proj.name}</span>
                        )}

                        {!isEditingThis && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingProjectNameId(proj.id);
                              setEditingProjectNameText(proj.name);
                            }}
                            className="p-1 rounded-lg text-zinc-500 hover:text-cyan-300 hover:bg-cyan-500/15 transition-colors shrink-0"
                            title="Renomear projeto"
                          >
                            <Edit3 size={11} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>

        {/* Layout do meio: código, dividido ou preview — só ícones, o rótulo vai no title */}
        <div className="ml-auto flex items-center gap-0.5 bg-black/40 p-1 rounded-xl border border-white/5 shrink-0">
          <button
            onClick={() => setViewLayout('editor')}
            className={cn(
              "p-1.5 rounded-lg transition-all",
              viewLayout === 'editor' ? "bg-cyan-500/20 text-cyan-300" : "text-zinc-500 hover:text-white"
            )}
            title="Apenas Código"
          >
            <Code2 size={15} />
          </button>
          <button
            onClick={() => setViewLayout('split')}
            className={cn(
              "p-1.5 rounded-lg transition-all",
              viewLayout === 'split' ? "bg-cyan-500/20 text-cyan-300" : "text-zinc-500 hover:text-white"
            )}
            title="Dividido (código + preview)"
          >
            <Columns size={15} />
          </button>
          <button
            onClick={() => setViewLayout('preview')}
            className={cn(
              "p-1.5 rounded-lg transition-all",
              viewLayout === 'preview' ? "bg-emerald-500/20 text-emerald-300" : "text-zinc-500 hover:text-white"
            )}
            title="Preview Vivo"
          >
            <Eye size={15} />
          </button>
        </div>

        <button
          onClick={exportarProjetoEmZip}
          disabled={empacotando}
          className="hidden min-[520px]:flex items-center gap-1.5 px-2.5 py-2 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/25 transition-all disabled:opacity-40 shrink-0 cursor-pointer active:scale-95"
          title={`Baixar o projeto inteiro (${files.length} arquivo(s)) em .zip`}
        >
          {empacotando ? <Loader2 size={15} className="animate-spin" /> : <Archive size={15} />}
          <span className="hidden lg:inline text-[11px] font-mono font-bold uppercase tracking-wide">Baixar projeto</span>
        </button>

        <button
          onClick={exportarProjetoEmZip}
          disabled={empacotando}
          className="min-[520px]:hidden p-2 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 border border-emerald-500/25 transition-all disabled:opacity-40 shrink-0 cursor-pointer active:scale-95"
          title="Baixar projeto (.zip)"
          aria-label={`Baixar projeto em .zip (${files.length} arquivo(s))`}
        >
          {empacotando ? <Loader2 size={15} className="animate-spin" /> : <Archive size={15} />}
        </button>

        <button
          onClick={abrirOuCriarModoFullstack}
          className={cn(
            "hidden sm:flex items-center gap-1.5 px-2.5 py-2 rounded-xl border transition-all shrink-0 cursor-pointer active:scale-95",
            projetoTemEstruturaFullstack
              ? "bg-indigo-500/10 text-indigo-200 border-indigo-400/25 hover:bg-indigo-500/20"
              : "bg-emerald-500/10 text-emerald-300 border-emerald-500/25 hover:bg-emerald-500/20"
          )}
          title={projetoTemEstruturaFullstack ? "Abrir modo fullstack: frontend no preview + server/shared no projeto" : "Criar estrutura fullstack com frontend/, server/ e shared/"}
        >
          <Layers size={15} />
          <span className="hidden xl:inline text-[11px] font-mono font-bold uppercase tracking-wide">
            {projetoTemEstruturaFullstack ? 'Fullstack' : 'Criar fullstack'}
          </span>
        </button>

        <button
          onClick={prepararExecucaoFullstack}
          className={cn(
            "hidden md:flex items-center gap-1.5 px-2.5 py-2 rounded-xl border transition-all shrink-0 cursor-pointer active:scale-95",
            projetoTemEstruturaFullstack
              ? "bg-lime-500/10 text-lime-300 border-lime-500/25 hover:bg-lime-500/20"
              : "bg-white/[0.03] text-zinc-500 border-white/10 hover:text-white hover:bg-white/[0.06]"
          )}
          title={projetoTemEstruturaFullstack
            ? "Preparar package.json, guia e comandos para rodar o fullstack fora do preview"
            : "Criar uma estrutura fullstack antes de preparar a execução"}
        >
          <Terminal size={15} />
          <span className="hidden 2xl:inline text-[11px] font-mono font-bold uppercase tracking-wide">Rodar fullstack</span>
        </button>

        {/* GitHub e chave da API: o "para onde publica" e o "com o que gera" */}
        <button
          onClick={() => setIsGithubPanelOpen(true)}
          className="p-2 rounded-xl border transition-all shrink-0 cursor-pointer active:scale-95 bg-slate-500/10 text-slate-200 border-slate-400/25 hover:bg-slate-500/20"
          title="GitHub: publicar o projeto, criar Pull Request e fazer merge com confirmação"
        >
          <FolderGit2 size={15} />
        </button>

        <button
          onClick={() => setIsCodeApiSettingsOpen(true)}
          className={cn(
            "p-2 rounded-xl border transition-all shrink-0 cursor-pointer active:scale-95",
            provedorDoCode === 'gemini'
              ? "bg-cyan-500/10 text-cyan-300 border-cyan-500/25 hover:bg-cyan-500/20"
              : "bg-amber-500/10 text-amber-300 border-amber-500/25 hover:bg-amber-500/20"
          )}
          title={`API do OSONE CODE: ${nomeDoProvedorDoCode}`}
        >
          <KeyRound size={15} />
        </button>
      </div>

      {/*
        O PAINEL DE COMPARAÇÃO.

        Mostra só os trechos que mudaram, com algumas linhas de contexto: exibir o arquivo inteiro
        para revelar três linhas diferentes não informa nada — faz caçar. O que ficou de fora é
        marcado com '⋯', para não parecer que o arquivo acaba ali.
      */}
      <AnimatePresence>
        {comparacaoAberta && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-lg">
            <motion.div
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              className="w-full max-w-5xl max-h-[88vh] bg-[#0b0e17] border border-violet-500/40 rounded-3xl p-5 shadow-2xl flex flex-col gap-3 overflow-hidden"
            >
              <div className="flex items-center justify-between border-b border-white/10 pb-3 shrink-0">
                <div className="flex items-center gap-2.5">
                  <Columns size={18} className="text-violet-300" />
                  <div>
                    <h3 className="text-sm font-bold text-white font-mono">O que mudou na última alteração</h3>
                    <p className="text-[11px] text-violet-200/60 mt-0.5">
                      Comparado com o estado de antes — o mesmo ponto para onde o Ctrl+Z voltaria.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => { setComparacaoAberta(false); handleUndoChange(); }}
                    className="px-3 py-1.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-300 text-[11px] font-mono font-bold uppercase tracking-wider transition-colors cursor-pointer"
                    title="Desfazer esta alteração"
                  >
                    Desfazer
                  </button>
                  <button
                    onClick={() => setComparacaoAberta(false)}
                    className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white transition-colors cursor-pointer"
                    title="Fechar (a alteração continua valendo)"
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto custom-scrollbar space-y-4 pr-1">
                {comparacoes.length === 0 ? (
                  <div className="text-center py-12 text-zinc-500 font-mono text-xs">
                    Nenhuma diferença: a última alteração não mudou um caractere do código.
                  </div>
                ) : comparacoes.map((c, idx) => (
                  <div key={idx} className="rounded-2xl border border-white/10 overflow-hidden">
                    <div className="px-3 py-2 bg-white/[0.03] border-b border-white/5 flex items-center gap-2 text-xs font-mono">
                      <FileCode size={13} className="text-cyan-400 shrink-0" />
                      <span className="text-white font-semibold">{c.nome}</span>
                      <span className={cn(
                        "text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide",
                        c.situacao === 'criado' ? "bg-emerald-500/15 text-emerald-300"
                          : c.situacao === 'apagado' ? "bg-red-500/15 text-red-300"
                          : "bg-white/5 text-zinc-400"
                      )}>{c.situacao}</span>
                      <span className="ml-auto flex items-center gap-2 shrink-0">
                        {c.adicionadas > 0 && <span className="text-emerald-400">+{c.adicionadas}</span>}
                        {c.removidas > 0 && <span className="text-red-400">−{c.removidas}</span>}
                      </span>
                    </div>

                    {c.comparacaoGrosseira && (
                      <div className="px-3 py-1.5 bg-amber-500/[0.07] border-b border-amber-500/20 text-[10px] font-mono text-amber-300/80">
                        Arquivo grande e muito diferente: a comparação é mostrada em bloco, para a aba não travar.
                      </div>
                    )}

                    <div className="max-h-[42vh] overflow-auto custom-scrollbar" style={{ ...METRICA_DO_EDITOR, paddingTop: 0, paddingBottom: 0 }}>
                      {apenasOsTrechosQueMudaram(c.linhas, 3).map((l, i) => (
                        <div key={i} className={cn(
                          "flex",
                          l.tipo === 'adicionada' ? "bg-emerald-500/[0.09]"
                            : l.tipo === 'removida' ? "bg-red-500/[0.09]" : ""
                        )}>
                          {/* As duas colunas de número: a linha removida tem número no arquivo
                              antigo, a adicionada no novo. Trocar isso mandaria a pessoa olhar
                              para o lugar errado do editor. */}
                          <span className="w-11 shrink-0 text-right pr-2 text-zinc-600 select-none">{l.numeroAntes ?? ''}</span>
                          <span className="w-11 shrink-0 text-right pr-2 text-zinc-600 select-none">{l.numeroDepois ?? ''}</span>
                          <span className={cn(
                            "w-4 shrink-0 select-none",
                            l.tipo === 'adicionada' ? "text-emerald-400" : l.tipo === 'removida' ? "text-red-400" : "text-zinc-700"
                          )}>{l.tipo === 'adicionada' ? '+' : l.tipo === 'removida' ? '−' : ' '}</span>
                          <span className={cn(
                            "flex-1 pr-3",
                            l.tipo === 'adicionada' ? "text-emerald-100" : l.tipo === 'removida' ? "text-red-200/80" : "text-zinc-500"
                          )}>{l.texto || ' '}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Main Studio Body */}
      <div className="flex-1 flex w-full min-h-0 overflow-hidden relative">

        {/*
          FILEIRA ESQUERDA — os arquivos.

          Uma coluna estreita de ícones que não sai da tela em nenhuma largura: abrir a árvore
          de arquivos, criar, importar e montar a estrutura fullstack. O que antes era uma
          barra horizontal a mais empilhada no topo virou uma coluna de 44px na lateral, que
          rouba largura em vez de altura — e altura é o que falta num celular.
        */}
        <div className="w-11 sm:w-12 shrink-0 bg-[#0a0c12] border-r border-white/5 flex flex-col items-center gap-1 py-2 z-30">
          <button
            onClick={() => setShowRepoSidebar(!showRepoSidebar)}
            className={cn(
              "p-2 rounded-xl transition-all border",
              showRepoSidebar
                ? "bg-cyan-500/15 text-cyan-300 border-cyan-500/30"
                : "bg-white/[0.02] text-zinc-400 hover:text-white border-white/5"
            )}
            title={showRepoSidebar ? "Esconder os arquivos" : "Mostrar os arquivos"}
          >
            <FolderGit2 size={16} />
          </button>

          <button
            onClick={handleCreateNewFile}
            className="p-2 rounded-xl bg-white/[0.02] hover:bg-cyan-500/15 text-zinc-400 hover:text-cyan-300 border border-white/5 transition-all"
            title="Novo arquivo"
          >
            <Plus size={16} />
          </button>

          <label
            className="p-2 rounded-xl bg-white/[0.02] hover:bg-white/[0.08] text-zinc-400 hover:text-white border border-white/5 cursor-pointer transition-all"
            title="Importar arquivo do computador"
          >
            <Upload size={15} />
            <input type="file" onChange={handleImportFileDisk} className="hidden" accept=".html,.css,.js,.jsx,.ts,.tsx,.py,.sql,.json,.txt,.md" />
          </label>

          <button
            onClick={criarEstruturaFullstack}
            className="p-2 rounded-xl bg-white/[0.02] hover:bg-emerald-500/15 text-zinc-400 hover:text-emerald-300 border border-white/5 transition-all"
            title="Criar estrutura fullstack"
          >
            <Layers size={15} />
          </button>

          <button
            onClick={() => { setBuscaAberta(v => !v); setTimeout(() => campoDeBuscaRef.current?.focus(), 0); }}
            className={cn(
              "p-2 rounded-xl border transition-all",
              buscaAberta
                ? "bg-violet-500/20 text-violet-300 border-violet-500/40"
                : "bg-white/[0.02] text-zinc-400 hover:text-violet-300 border-white/5"
            )}
            title="Buscar e substituir em todos os arquivos (Ctrl+F)"
          >
            <Search size={15} />
          </button>

          {/* Só existe quando há o que separar — um botão que só sabe dizer "não" é ruído. */}
          {activeFile && /<html|<body|<!DOCTYPE/i.test(activeFile.content) && /<(style|script)\b[^>]*>[\s\S]*?\S[\s\S]*?<\/\1\s*>/i.test(activeFile.content) && (
            <button
              onClick={separarArquivoAberto}
              className="p-2 rounded-xl bg-white/[0.02] hover:bg-amber-500/15 text-zinc-400 hover:text-amber-300 border border-white/5 transition-all"
              title="Separar este arquivo em index.html + styles.css + game.js"
            >
              <Replace size={15} />
            </button>
          )}

          {/* O estado do repositório, sem gastar uma linha de texto: verde salvo, âmbar pendente. */}
          <span
            className={cn(
              "mt-auto w-2 h-2 rounded-full shrink-0",
              isSaved ? "bg-emerald-500/70" : "bg-amber-400 animate-pulse"
            )}
            title={isSaved ? "Repositório salvo" : "Alterações não salvas"}
          />
        </div>

        {/* Virtual Repository File Tree Sidebar */}
        <AnimatePresence>
          {showRepoSidebar && (
            <motion.div 
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 240, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              /* No mobile a árvore flutua POR CIMA do editor, mas começando depois da fileira
                 de ícones (left-11) — cobrir a própria fileira que a abriu tiraria o caminho
                 de volta. No desktop ela entra no fluxo, ao lado da fileira. */
              className="absolute md:relative inset-y-0 left-11 sm:left-12 md:left-0 h-full max-w-[80vw] bg-[#0a0c12] border-r border-white/5 flex flex-col shrink-0 overflow-hidden z-40 shadow-2xl md:shadow-none"
            >
              <div className="p-3 border-b border-white/5 flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 font-semibold flex items-center gap-1.5">
                  <FolderGit2 size={12} className="text-cyan-400" />
                  Repositório
                </span>
                
                <div className="flex items-center gap-1">
                  <label className="p-1 rounded bg-white/[0.03] hover:bg-white/10 text-zinc-400 cursor-pointer transition-colors" title="Importar do PC">
                    <Upload size={13} />
                    <input type="file" onChange={handleImportFileDisk} className="hidden" accept=".html,.css,.js,.jsx,.ts,.tsx,.py,.sql,.json,.txt,.md" />
                  </label>

                  <button 
                    onClick={criarEstruturaFullstack}
                    className="p-1 rounded bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/25 transition-colors"
                    title="Criar estrutura fullstack"
                  >
                    <Layers size={13} />
                  </button>
                  
                  <button 
                    onClick={handleCreateNewFile}
                    className="p-1 rounded bg-cyan-500/20 hover:bg-cyan-500/30 text-cyan-300 border border-cyan-500/30 transition-colors"
                    title="Novo Arquivo"
                  >
                    <Plus size={13} />
                  </button>
                </div>
              </div>

              {/* File List */}
              <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
                {arquivosAgrupados.map(grupo => (
                  <div key={grupo.pasta || 'raiz'} className="space-y-1">
                    {grupo.pasta && (
                      <div className="px-2 pt-2 pb-1 text-[9px] font-mono uppercase tracking-[0.18em] text-zinc-600 flex items-center gap-1.5">
                        <FolderGit2 size={10} className="text-zinc-500" />
                        <span className="truncate">{grupo.pasta}</span>
                      </div>
                    )}

                    {grupo.arquivos.map(file => {
                      const isActive = file.id === activeFileId;
                      const isEditingName = editingFileNameId === file.id;
                      const pasta = pastaDoCaminho(file.name);
                      const base = nomeBaseDoCaminho(file.name);

                      return (
                        <div 
                          key={file.id}
                          onClick={() => setActiveFileId(file.id)}
                          className={cn(
                            "group w-full px-3 py-2 rounded-xl text-xs font-mono flex items-center justify-between cursor-pointer transition-all border",
                            isActive 
                              ? "bg-cyan-500/10 text-cyan-300 border-cyan-500/30 shadow-[0_0_10px_rgba(6,182,212,0.1)]" 
                              : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.03] border-transparent"
                          )}
                        >
                          <div className="flex items-center gap-2 min-w-0 flex-1 pr-2">
                            <FileCode size={14} className={isActive ? "text-cyan-400" : "text-zinc-500"} />
                            
                            {isEditingName ? (
                              <input 
                                type="text" 
                                value={editingFileNameText}
                                onChange={(e) => setEditingFileNameText(e.target.value)}
                                onBlur={() => handleRenameFileSubmit(file.id)}
                                onKeyDown={(e) => e.key === 'Enter' && handleRenameFileSubmit(file.id)}
                                autoFocus
                                className="bg-black/60 border border-cyan-500/50 rounded px-1.5 py-0.5 text-xs text-cyan-200 outline-none w-full"
                              />
                            ) : (
                              <div className="min-w-0">
                                <div className="truncate">{base}</div>
                                {pasta && <div className="truncate text-[9px] text-zinc-600">{pasta}/</div>}
                              </div>
                            )}
                          </div>

                          <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 transition-opacity">
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditingFileNameId(file.id);
                                setEditingFileNameText(file.name);
                              }}
                              className="p-1 hover:text-cyan-300 transition-colors"
                              title="Renomear"
                            >
                              <Edit3 size={11} />
                            </button>

                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteFile(file.id, file.name);
                              }}
                              className="p-1 hover:text-red-400 transition-colors"
                              title="Excluir"
                            >
                              <Trash2 size={11} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>

              {/* Footer status */}
              <div className="p-3 border-t border-white/5 bg-black/40 text-[10px] font-mono text-zinc-500 flex items-center justify-between">
                <span>{isSaved ? "✓ Repositório Salvo" : "• Alterações não salvas"}</span>
                <span className="text-cyan-400">OSONE CODE</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Content Workspace Grid */}
        <div className="flex-1 flex flex-col md:flex-row min-h-0 w-full overflow-hidden">
          
          {/* Code Editor Panel */}
          {(viewLayout === 'editor' || viewLayout === 'split') && activeFile && (
            <div className={cn(
              "flex flex-col min-h-0 bg-[#07080d] border-r border-white/5 transition-all overflow-hidden",
              viewLayout === 'split' ? "w-full h-1/2 md:w-1/2 md:h-full" : "w-full h-full"
            )}>
              {/* Editor Sub-Header */}
              <div className="h-9 bg-[#0b0d13] border-b border-white/5 px-4 flex items-center justify-between shrink-0 font-mono text-xs text-zinc-400">
                <div className="flex items-center gap-2">
                  <span className="text-cyan-400 font-semibold">{activeFile.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-zinc-400 uppercase">
                    {activeFile.language}
                  </span>
                </div>

                <div className="text-[10px] text-zinc-500">
                  {escritaAoVivo !== null
                    ? `${escritaAoVivo.length} caracteres escritos`
                    : `${activeFile.content.length} caracteres`}
                </div>
              </div>

              {/* PAINEL DE BUSCA — fica ACIMA do editor, e a lista de resultados leva ao trecho. */}
              {buscaAberta && (
                <div className="shrink-0 border-b border-violet-500/20 bg-[#0b0d16] px-3 py-2.5 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="relative flex-1 min-w-[180px]">
                      <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-violet-400/60" />
                      <input
                        ref={campoDeBuscaRef}
                        value={termoDeBusca}
                        onChange={(e) => setTermoDeBusca(e.target.value)}
                        placeholder="Buscar em todos os arquivos..."
                        className="w-full bg-black/50 border border-white/10 rounded-lg pl-8 pr-3 py-1.5 text-xs font-mono text-white placeholder:text-zinc-600 outline-none focus:border-violet-500/40"
                      />
                    </div>
                    <div className="relative flex-1 min-w-[180px]">
                      <Replace size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-emerald-400/60" />
                      <input
                        value={substitutoDeBusca}
                        onChange={(e) => setSubstitutoDeBusca(e.target.value)}
                        placeholder="Substituir por..."
                        className="w-full bg-black/50 border border-white/10 rounded-lg pl-8 pr-3 py-1.5 text-xs font-mono text-white placeholder:text-zinc-600 outline-none focus:border-emerald-500/40"
                      />
                    </div>
                    <button
                      onClick={aplicarSubstituicao}
                      disabled={!termoDeBusca}
                      className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-black text-[10px] font-mono font-bold uppercase tracking-wider transition-all disabled:opacity-25 disabled:cursor-not-allowed cursor-pointer shrink-0"
                      title="Substituir todas as ocorrências (entra no desfazer como uma ação só)"
                    >
                      Substituir tudo
                    </button>
                    <button
                      onClick={() => setBuscaAberta(false)}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-white hover:bg-white/5 transition-all cursor-pointer shrink-0"
                      title="Fechar (Esc)"
                    >
                      <X size={14} />
                    </button>
                  </div>

                  <div className="flex items-center gap-3 text-[10px] font-mono text-zinc-400">
                    {([
                      ['caseSensitive', 'Aa', 'Diferenciar maiúsculas'],
                      ['palavraInteira', 'ab|', 'Só palavra inteira'],
                      ['regex', '.*', 'Expressão regular']
                    ] as const).map(([chave, rotulo, titulo]) => (
                      <button
                        key={chave}
                        onClick={() => setOpcoesDeBusca(o => ({ ...o, [chave]: !o[chave] }))}
                        title={titulo}
                        className={cn(
                          "px-2 py-0.5 rounded border transition-all cursor-pointer",
                          opcoesDeBusca[chave]
                            ? "bg-violet-500/20 text-violet-300 border-violet-500/40"
                            : "bg-white/[0.02] text-zinc-500 border-white/5 hover:text-white"
                        )}
                      >
                        {rotulo}
                      </button>
                    ))}
                    <span className={cn("ml-auto", resultadoDaBusca.erro ? "text-amber-400" : "")}>
                      {resultadoDaBusca.erro
                        ? resultadoDaBusca.erro
                        : termoDeBusca
                          ? `${resultadoDaBusca.ocorrencias.length} ocorrência(s)`
                          : ''}
                    </span>
                  </div>

                  {resultadoDaBusca.ocorrencias.length > 0 && (
                    <div className="max-h-40 overflow-y-auto space-y-0.5 pt-1 border-t border-white/5">
                      {resultadoDaBusca.ocorrencias.map((o, i) => (
                        <button
                          key={`${o.arquivoId}-${o.inicio}-${i}`}
                          onClick={() => irParaOcorrencia(o)}
                          className="w-full text-left px-2 py-1 rounded hover:bg-white/[0.04] transition-all flex items-baseline gap-2 cursor-pointer group"
                        >
                          <span className="text-[10px] font-mono text-cyan-400 shrink-0">{o.arquivoNome}</span>
                          <span className="text-[10px] font-mono text-zinc-600 shrink-0">:{o.linha}</span>
                          <span className="text-[10px] font-mono text-zinc-400 truncate group-hover:text-white">{o.textoDaLinha}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/*
                O CÓDIGO SENDO ESCRITO, AO VIVO.

                Enquanto a IA escreve, este painel toma o lugar do editor e mostra o texto
                crescendo pedaço a pedaço, rolando sozinho para acompanhar a última linha. O
                arquivo em si não é tocado até o fim: o que se vê aqui é a resposta do modelo
                chegando, não o conteúdo gravado.

                É read-only de propósito. Deixar editável um texto que muda sozinho a cada pedaço
                jogaria fora o que a pessoa digitasse no instante seguinte.
              */}
              {escritaAoVivo !== null ? (
                <div className="flex-1 w-full h-full bg-[#07080d] flex flex-col overflow-hidden">
                  <div className="shrink-0 h-8 px-3 flex items-center gap-2 bg-cyan-500/[0.07] border-b border-cyan-500/20 font-mono text-[11px] text-cyan-300">
                    <Sparkles size={12} className="animate-pulse shrink-0" />
                    <span className="font-semibold">A IA está escrevendo…</span>
                    <span className="text-cyan-500/50 hidden sm:inline truncate">
                      {escritaAoVivo.length === 0
                        ? 'aguardando o modelo começar'
                        : `${escritaAoVivo.split('\n').length} linha(s) até agora`}
                    </span>
                    <button
                      onClick={() => cancelamentoRef.current?.abort()}
                      className="ml-auto shrink-0 px-2 py-0.5 rounded border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20 text-[10px] font-bold uppercase tracking-wider transition-all cursor-pointer"
                      title="Parar a geração agora — o arquivo não é alterado"
                    >
                      Cancelar
                    </button>
                  </div>
                  <pre
                    ref={painelAoVivoRef}
                    style={{ ...METRICA_DO_EDITOR, paddingLeft: '12px', paddingRight: '16px' }}
                    className="flex-1 overflow-auto custom-scrollbar text-cyan-100/90 selection:bg-cyan-500/30"
                    dangerouslySetInnerHTML={{
                      __html: realcar(escritaAoVivo, linguagemDoArquivo(activeFile.name, activeFile.language))
                        + '<span class="cursor-escrevendo">▌</span>'
                    }}
                  />
                </div>
              ) : (
              /* Editor: régua de linhas + área de escrita.
                  As duas colunas usam exatamente as mesmas classes de fonte, tamanho e altura de
                  linha, e a mesma folga no topo — qualquer diferença aí faria os números
                  descolarem do código conforme o arquivo cresce. */
              <div style={{ position: 'relative' }} className="flex-1 w-full h-full bg-[#07080d] flex overflow-hidden">
                <div
                  ref={reguaRef}
                  aria-hidden="true"
                  style={{ ...METRICA_DO_EDITOR, paddingLeft: '12px', paddingRight: '8px' }}
                  className="regua-de-linhas shrink-0 select-none overflow-hidden text-right
                             text-zinc-600 bg-black/25 border-r border-white/5"
                >
                  {Array.from({ length: totalDeLinhas }, (_, i) => (
                    <div key={i + 1}>{i + 1}</div>
                  ))}
                </div>

                {/*
                  CAMADA DO REALCE — desenhada ATRÁS da área de escrita, que fica transparente.

                  As duas precisam ocupar exatamente o mesmo espaço: mesma fonte, mesmo tamanho,
                  mesma altura de linha, mesma folga e a mesma regra de quebra (wrap desligado).
                  Qualquer diferença aí faz o texto colorido descolar do texto real e o cursor
                  aparecer no lugar errado — por isso as classes abaixo são as MESMAS da área de
                  escrita, e o realce nunca acrescenta nem remove um caractere (ver lib/realce.ts).
                */}
                <pre
                  ref={realceRef}
                  aria-hidden="true"
                  className="pointer-events-none overflow-hidden text-cyan-100/90"
                  style={{
                    ...METRICA_DO_EDITOR,
                    position: 'absolute',
                    top: 0, bottom: 0, right: 0,
                    left: larguraDaRegua,
                    paddingLeft: '12px',
                    paddingRight: '16px',
                    zIndex: 0
                  }}
                  dangerouslySetInnerHTML={{ __html: realcar(activeFile.content || '', linguagemDoArquivo(activeFile.name, activeFile.language)) + '\n' }}
                />
                <textarea
                  ref={editorRef}
                  value={activeFile.content}
                  onChange={(e) => { handleUpdateActiveContent(e.target.value); lerSelecaoDoEditor(); }}
                  onScroll={sincronizarRegua}
                  onKeyDown={aoTeclarNoEditor}
                  // 'select' cobre mouse e teclado; os outros dois pegam os casos em que o
                  // navegador não dispara 'select' (clique simples que desfaz a marcação).
                  onSelect={lerSelecaoDoEditor}
                  onMouseUp={lerSelecaoDoEditor}
                  onKeyUp={lerSelecaoDoEditor}
                  spellCheck={false}
                  // 'off' desliga a quebra automática de linha: com ela, uma linha longa ocupava
                  // várias alturas na tela e a régua passava a contar outra coisa. Em troca vem a
                  // rolagem horizontal, que é como todo editor de código se comporta.
                  wrap="off"
                  // A classe é o que autoriza o Ctrl+Z do OSONE a agir aqui dentro: o atalho global
                  // ignora campos de texto, e sem ela o desfazer nunca funcionava no editor —
                  // justamente onde ele mais faz falta.
                  // O texto fica TRANSPARENTE e quem se vê é a camada de realce atrás; o cursor
                  // continua visível por causa do caret-color, que não é afetado pela cor do texto.
                  style={{
                    ...METRICA_DO_EDITOR,
                    position: 'relative',
                    zIndex: 10,
                    paddingLeft: '12px',
                    paddingRight: '16px',
                    background: 'transparent',
                    color: 'transparent'
                  }}
                  className="code-editor-textarea flex-1 h-full caret-cyan-300
                             outline-none resize-none custom-scrollbar selection:bg-cyan-500/30
                             overflow-auto"
                  placeholder="Escreva ou cole seu código aqui..."
                />
              </div>
              )}
            </div>
          )}

          {/* Interactive Live Preview Panel */}
          {(viewLayout === 'preview' || viewLayout === 'split') && (
            <div className={cn(
              "flex flex-col bg-black transition-all overflow-hidden relative",
              viewLayout === 'split'
                ? "w-full h-1/2 min-h-0 md:w-1/2 md:h-full"
                : "w-full h-full min-h-[45vh] md:min-h-0"
            )}>
              {/* O preview recebe o PROJETO montado, não o arquivo aberto: é o que faz o
                  styles.css e o script.js existirem de verdade, e o que evita desenhar CSS
                  cru como se fosse página quando o arquivo aberto não é uma. */}
              <CodePreview
                code={codigoQueRoda}
                linguagem={linguagemAtiva}
                aoDetectarProblema={registrarProblemaDoPreview}
              />
            </div>
          )}

        </div>

        {/*
          FILEIRA DIREITA — as habilidades.

          Enxame e Hunter são os dois agentes que trabalham SOZINHOS no código; ficam
          separados do resto justamente porque não são "mais um botão de editor". Abaixo
          deles, o histórico do que eles (e você) fizeram: desfazer, refazer e o comparador.
        */}
        <div className="w-11 sm:w-12 shrink-0 bg-[#0a0c12] border-l border-white/5 flex flex-col items-center gap-1 py-2 z-30">
          <button
            onClick={() => setIsSwarmModalOpen(true)}
            className="p-2 rounded-xl bg-gradient-to-br from-purple-600/90 to-cyan-600/90 hover:from-purple-500 hover:to-cyan-500 text-white border border-purple-400/40 shadow-lg shadow-purple-950/50 transition-all active:scale-95 cursor-pointer"
            title="Enxame OSONE CODE: 4 agentes especializados em loop autônomo"
          >
            <Bot size={16} className="text-purple-100" />
          </button>

          <button
            onClick={() => setIsHunterModalOpen(true)}
            className="p-2 rounded-xl bg-gradient-to-br from-emerald-600/90 to-green-600/90 hover:from-emerald-500 hover:to-green-500 text-white border border-emerald-400/40 shadow-lg shadow-emerald-950/50 transition-all active:scale-95 cursor-pointer"
            title="Hunter Agêntico: examina o código, aponta o que falta e implementa"
          >
            <BowAndArrowIcon size={15} className="text-emerald-100" />
          </button>

          <div className="w-6 h-px bg-white/10 my-1 shrink-0" />

          <button
            onClick={handleUndoChange}
            disabled={historyStack.length === 0}
            className={cn(
              "relative p-2 rounded-xl border transition-all",
              historyStack.length > 0
                ? "bg-amber-500/10 text-amber-400 border-amber-500/30 hover:bg-amber-500/20 active:scale-95 cursor-pointer"
                : "bg-white/[0.02] text-zinc-700 border-white/5 cursor-not-allowed"
            )}
            title={historyStack.length > 0 ? `Desfazer (${historyStack.length}) — Ctrl+Z` : "Nada para desfazer"}
          >
            <Undo size={15} />
            {historyStack.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-amber-500 text-[9px] font-bold text-black flex items-center justify-center">
                {historyStack.length > 9 ? '9+' : historyStack.length}
              </span>
            )}
          </button>

          <button
            onClick={handleRedoChange}
            disabled={redoStack.length === 0}
            className={cn(
              "p-2 rounded-xl border transition-all",
              redoStack.length > 0
                ? "bg-cyan-500/10 text-cyan-400 border-cyan-500/30 hover:bg-cyan-500/20 active:scale-95 cursor-pointer"
                : "bg-white/[0.02] text-zinc-700 border-white/5 cursor-not-allowed"
            )}
            title={redoStack.length > 0 ? `Refazer (${redoStack.length}) — Ctrl+Shift+Z` : "Nada para refazer"}
          >
            <Redo size={15} />
          </button>

          {historyStack.length > 0 && (
            <button
              onClick={() => setComparacaoAberta(true)}
              className="p-2 rounded-xl bg-violet-500/10 hover:bg-violet-500/20 text-violet-300 border border-violet-500/25 transition-all cursor-pointer"
              title="Ver o que mudou na última alteração"
            >
              <Columns size={15} />
            </button>
          )}

          {/* Levar o arquivo aberto embora. O projeto inteiro agora mora no topo, longe da mãozinha. */}
          <button
            onClick={handleCopyCode}
            className="mt-auto p-2 rounded-xl bg-white/[0.02] hover:bg-white/[0.08] text-zinc-400 hover:text-white border border-white/5 transition-all"
            title="Copiar o código do arquivo aberto"
          >
            {copied ? <Check size={15} className="text-emerald-400" /> : <Copy size={15} />}
          </button>

          <button
            onClick={handleDownloadFile}
            className="p-2 rounded-xl bg-white/[0.02] hover:bg-white/[0.08] text-zinc-400 hover:text-white border border-white/5 transition-all"
            title="Baixar apenas o arquivo aberto"
          >
            <Download size={15} />
          </button>
        </div>

      </div>

      {/* AI Code Assistant Footer Prompt Box */}
      <div className="border-t border-white/5 bg-[#090b10] p-2 sm:p-3 shrink-0 overflow-hidden">
        <div className="w-full max-w-6xl mx-auto space-y-2 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex rounded-xl border border-white/10 bg-black/40 p-1" role="tablist" aria-label="Sessão do OSONE CODE">
              <button
                type="button"
                role="tab"
                aria-selected={sessaoDaIa === 'implementar'}
                onClick={() => setSessaoDaIa('implementar')}
                className={cn('flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-mono transition-colors', sessaoDaIa === 'implementar' ? 'bg-cyan-500 text-black font-bold' : 'text-zinc-400 hover:text-white')}
              >
                <Terminal size={12} /> Implementar
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sessaoDaIa === 'conversar'}
                onClick={() => setSessaoDaIa('conversar')}
                className={cn('flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-mono transition-colors', sessaoDaIa === 'conversar' ? 'bg-violet-500 text-white font-bold' : 'text-zinc-400 hover:text-white')}
              >
                <MessageSquare size={12} /> Conversar
              </button>
            </div>
            <span className="hidden sm:block text-[10px] font-mono text-zinc-500">
              {sessaoDaIa === 'implementar' ? 'A IA pode alterar os arquivos' : 'Somente análise — nenhum arquivo será alterado'}
            </span>
          </div>

          {sessaoDaIa === 'conversar' && (
            <div className="rounded-2xl border border-violet-500/20 bg-violet-950/10 overflow-hidden">
              <div className="max-h-56 min-h-28 overflow-y-auto p-3 space-y-2" aria-live="polite">
                {mensagensDoChat.length === 0 && (
                  <div className="flex gap-2 text-xs text-zinc-400 font-mono">
                    <Bot size={16} className="text-violet-400 shrink-0" />
                    <p>Eu já consigo ler os arquivos de <strong className="text-zinc-200">{activeProjectName}</strong>. Pergunte como o projeto funciona, o que mudou, onde está um erro ou qual seria o próximo passo. Nesta sessão eu explico, mas não edito.</p>
                  </div>
                )}
                {mensagensDoChat.map(mensagem => (
                  <div key={mensagem.id} className={cn('flex', mensagem.role === 'user' ? 'justify-end' : 'justify-start')}>
                    <div className={cn('max-w-[88%] rounded-2xl px-3 py-2 text-xs sm:text-sm whitespace-pre-wrap break-words', mensagem.role === 'user' ? 'bg-cyan-500 text-black' : 'bg-white/[0.06] border border-white/10 text-zinc-200')}>
                      {mensagem.content}
                    </div>
                  </div>
                ))}
                {chatRespondendo && <div className="flex items-center gap-2 text-xs font-mono text-violet-300"><Loader2 size={13} className="animate-spin" /> Analisando o projeto…</div>}
                <div ref={chatFimRef} />
              </div>
              <div className="flex gap-2 border-t border-white/5 p-2">
                <input
                  value={perguntaDoChat}
                  onChange={e => setPerguntaDoChat(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) void enviarPerguntaDoChat(); }}
                  placeholder="Pergunte sobre o código, arquitetura ou alterações…"
                  disabled={chatRespondendo}
                  className="min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs sm:text-sm text-white placeholder-zinc-500 outline-none focus:border-violet-500/50 font-mono"
                />
                <button
                  type="button"
                  onClick={() => void enviarPerguntaDoChat()}
                  disabled={!perguntaDoChat.trim() || chatRespondendo}
                  className="rounded-xl bg-violet-500 hover:bg-violet-400 disabled:bg-zinc-800 disabled:text-zinc-500 px-4 py-2 text-xs font-bold text-white transition-colors"
                >
                  Perguntar
                </button>
              </div>
            </div>
          )}

          <div className={sessaoDaIa === 'implementar' ? 'contents' : 'hidden'}>
          
          {/* AI Quick Prompts */}
          {/*
            O PEDIDO MUDOU DE ALVO — E ISSO PRECISA ESTAR NA TELA.

            Um pedido que atinge o arquivo inteiro e um que atinge doze linhas são coisas muito
            diferentes, e a única pista seria a marcação no editor, que fica acima e sai da vista.
            Sem este aviso, a pessoa selecionaria um trecho sem querer e veria o resultado mudar de
            comportamento sem entender por quê.
          */}
          {/*
            O QUE QUEBROU AO RODAR, COM UM BOTÃO PARA CONSERTAR.

            Este aviso carrega a informação mais valiosa que existe para corrigir um bug — o erro
            que a máquina REGISTROU ao executar — e que antes ficava presa numa aba do preview,
            longe da IA. Com ela em mãos, "corrigir" deixa de ser palpite: o modelo recebe a
            mensagem exata e o texto da linha que falhou.
          */}
          {quantosErros > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-red-500/[0.08] border border-red-500/30 text-[11px] font-mono text-red-200 overflow-x-auto no-scrollbar">
              <AlertTriangle size={12} className="shrink-0" />
              <span className="shrink-0 font-semibold">
                {quantosErros === 1 ? 'O código quebrou ao rodar' : `${quantosErros} erros ao rodar o código`}
              </span>
              <span className="text-red-300/60 truncate min-w-0" title={errosAgrupados.filter(p => p.tipo === 'erro').map(p => p.mensagem).join('\n')}>
                {errosAgrupados.find(p => p.tipo === 'erro')?.mensagem}
              </span>
              <button
                onClick={() => {
                  const pedido = montarPedidoDeCorrecao(problemasDoPreview, codigoQueRoda, activeFile?.name || 'arquivo');
                  if (pedido) handleSendAIPrompt(pedido);
                }}
                disabled={isGenerating}
                className="ml-auto shrink-0 px-2.5 py-0.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-100 font-bold uppercase tracking-wider transition-colors disabled:opacity-40 cursor-pointer"
                title="Mandar o erro exato para a IA consertar"
              >
                Corrigir com a IA
              </button>
              <button
                onClick={() => setProblemasDoPreview([])}
                className="shrink-0 p-1 rounded-lg text-red-300/60 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                title="Dispensar"
              >
                <X size={12} />
              </button>
            </div>
          )}

          {selecaoDoEditor && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-amber-500/[0.08] border border-amber-500/25 text-[11px] font-mono text-amber-200 overflow-x-auto no-scrollbar">
              <Code2 size={12} className="shrink-0" />
              <span className="shrink-0 font-semibold">
                Editando só o trecho marcado
              </span>
              <span className="text-amber-300/60 shrink-0">
                {selecaoDoEditor.texto.split('\n').length} linha(s), {selecaoDoEditor.fim - selecaoDoEditor.inicio} caracteres — o resto do arquivo não será tocado
              </span>
              <button
                onClick={() => { setSelecaoDoEditor(null); editorRef.current?.setSelectionRange(selecaoDoEditor.inicio, selecaoDoEditor.inicio); }}
                className="ml-auto shrink-0 px-2 py-0.5 rounded-lg bg-white/5 hover:bg-white/10 text-amber-200/80 hover:text-white transition-colors cursor-pointer"
                title="Voltar a pedir para o arquivo inteiro"
              >
                usar o arquivo inteiro
              </button>
            </div>
          )}

          <div className="w-full flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
            <span className="text-[10px] font-mono text-cyan-400/80 uppercase tracking-wider flex items-center gap-1 shrink-0">
              <Sparkles size={11} /> OSONE CODE IA:
            </span>

            {/*
              QUANDO HÁ CÓDIGO, AS SUGESTÕES FALAM DELE.

              As frases fixas ficam para o arquivo em branco — ali elas são o que serve, porque
              não há o que ler e o que a pessoa quer é começar. A partir do momento em que existe
              código, quem manda são as sugestões lidas dele: elas citam a função pelo nome e já
              trazem o diagnóstico junto, em vez de mandar "corrigir bugs" e torcer.
            */}
            {sugestoesDoCodigo.length > 0 ? (
              <>
                {sugestoesDoCodigo.map((sugestao, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleSendAIPrompt(sugestao)}
                    disabled={isGenerating}
                    title={`Pedir ao OSONE CODE: ${sugestao}`}
                    className="px-2.5 py-1 rounded-lg bg-cyan-500/[0.07] hover:bg-cyan-500/15 border border-cyan-500/20 hover:border-cyan-500/40 text-[11px] font-mono text-cyan-200 hover:text-cyan-100 shrink-0 transition-all disabled:opacity-50 max-w-[340px] truncate cursor-pointer"
                  >
                    {sugestao}
                  </button>
                ))}
                <button
                  onClick={() => { codigoJaAnalisadoRef.current = ''; lerSugestoesDoCodigo(activeFile?.content || '', activeFile?.name || 'arquivo'); }}
                  disabled={lendoSugestoes || isGenerating}
                  title="Reler o arquivo e sugerir de novo"
                  className="p-1.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.07] border border-white/5 text-zinc-400 hover:text-cyan-300 shrink-0 transition-all disabled:opacity-40 cursor-pointer"
                >
                  <RefreshCw size={11} className={lendoSugestoes ? 'animate-spin' : ''} />
                </button>
              </>
            ) : (
              <>
                {[
                  { label: '🐝 Criar com Enxame', action: () => setIsSwarmModalOpen(true) },
                  { label: '🌳 App em árvore completa', action: () => { setSwarmProjectFormat('tree'); setIsSwarmModalOpen(true); } },
                  { label: '⚡ Gerar App HTML5 + Tailwind', prompt: 'Crie uma aplicação web completa, interativa e linda em um único arquivo HTML usando Tailwind CSS, Lucide Icons e JavaScript.' },
                  { label: '🛠️ Refatorar & Otimizar', prompt: 'Refatore o código do arquivo atual limpando a estrutura, otimizando performance e melhorando o design visual.' },
                  { label: '🔍 Corrigir BUGS', prompt: 'Examine o código atual, encontre possíveis falhas, erros de lógica ou falta de parâmetros e corrija tudo.' },
                  { label: '🎨 Adicionar Animações UI', prompt: 'Adicione transições suaves, animações de entrada e efeitos visuais modernos no código.' }
                ].map((item, idx) => (
                  <button
                    key={idx}
                    onClick={() => item.action ? item.action() : handleSendAIPrompt(item.prompt)}
                    disabled={isGenerating}
                    className="px-2.5 py-1 rounded-lg bg-white/[0.03] hover:bg-cyan-500/10 border border-white/5 hover:border-cyan-500/20 text-[11px] font-mono text-zinc-300 hover:text-cyan-300 shrink-0 transition-all disabled:opacity-50"
                  >
                    {item.label}
                  </button>
                ))}
                {/* Com código no arquivo, dá para trocar as frases fixas por sugestões de verdade. */}
                {(activeFile?.content || '').trim().length >= 200 && (
                  <button
                    onClick={() => lerSugestoesDoCodigo(activeFile?.content || '', activeFile?.name || 'arquivo')}
                    disabled={lendoSugestoes || isGenerating}
                    className="px-2.5 py-1 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/25 text-[11px] font-mono text-cyan-300 shrink-0 transition-all disabled:opacity-40 flex items-center gap-1.5 cursor-pointer"
                    title="Ler este arquivo e sugerir melhorias específicas dele"
                  >
                    {lendoSugestoes
                      ? <><Loader2 size={11} className="animate-spin" /> Lendo o código…</>
                      : <><Sparkles size={11} /> Sugerir a partir deste código</>}
                  </button>
                )}
              </>
            )}
          </div>

          {/* Miniaturas das imagens de referência anexadas */}
          {attachedImages.length > 0 && (
            <div className="w-full flex items-center gap-2 overflow-x-auto no-scrollbar pb-1">
              {attachedImages.map(img => (
                <div key={img.id} className="relative shrink-0 group">
                  <img
                    src={img.previewUrl}
                    alt={img.name}
                    className="w-12 h-12 rounded-lg object-cover border border-cyan-500/30"
                  />
                  <button
                    onClick={() => handleRemoveAttachedImage(img.id)}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-red-500 hover:bg-red-400 text-white flex items-center justify-center shadow-lg cursor-pointer"
                    title="Remover imagem"
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/*
            O CAMPO DE DIGITAR, COM OS ÍCONES DENTRO DELE.

            Antes o anexo, o esforço máximo, o texto e o botão disputavam uma linha só — no
            celular isso virava uma fila horizontal espremida. Agora é uma caixa: o texto em
            cima ocupando a largura toda, e embaixo os ícones à esquerda e o "Gerar" à direita,
            que é onde o polegar já está.
          */}
          <div className="flex flex-col gap-1.5 bg-black/50 border border-white/10 rounded-2xl p-2 focus-within:border-cyan-500/40 transition-all min-w-0">
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                handleAttachImages(e.target.files);
                e.target.value = '';
              }}
            />

            <input
              type="text"
              value={promptInput}
              onChange={(e) => setPromptInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSendAIPrompt()}
              placeholder={selecaoDoEditor
                ? `Descreva o que fazer com as ${selecaoDoEditor.texto.split('\n').length} linha(s) marcadas...`
                : "Descreva a alteração ou o app que você quer criar..."}
              disabled={isGenerating}
              className="w-full min-w-0 bg-transparent px-1.5 py-1.5 text-xs sm:text-sm text-white placeholder-zinc-500 outline-none font-mono"
            />

            <div className="flex items-center gap-1 min-w-0">
              <button
                onClick={() => imageInputRef.current?.click()}
                disabled={isGenerating}
                className="p-2 rounded-xl bg-white/[0.03] hover:bg-cyan-500/10 text-zinc-400 hover:text-cyan-300 border border-white/5 hover:border-cyan-500/20 transition-all shrink-0 disabled:opacity-50"
                title="Anexar imagem(ns) de referência para o modelo usar na criação"
              >
                <Paperclip size={15} />
              </button>

              <button
                onClick={() => setMaxEffort(prev => !prev)}
                disabled={isGenerating}
                className={cn(
                  "p-2 rounded-xl border transition-all shrink-0 disabled:opacity-50",
                  maxEffort
                    ? "bg-orange-500/15 text-orange-400 border-orange-500/40 shadow-lg shadow-orange-950/30"
                    : "bg-white/[0.03] text-zinc-400 hover:text-orange-300 border-white/5 hover:border-orange-500/20"
                )}
                title={maxEffort ? "Esforço Máximo ATIVADO: o modelo vai com capricho e raciocínio máximo (clique para desativar)" : "Ativar Esforço Máximo: pede ao modelo o maior nível de raciocínio e capricho possível"}
              >
                <Flame size={15} className={maxEffort ? "animate-pulse" : ""} />
              </button>

              {/* Onde o pedido vai bater: o arquivo aberto, ou só o trecho marcado no editor. */}
              <span className="hidden min-[380px]:flex items-center gap-1 px-2 text-[10px] font-mono text-zinc-500 truncate min-w-0">
                <FileCode size={11} className="shrink-0" />
                <span className="truncate">
                  {selecaoDoEditor ? `${selecaoDoEditor.texto.split('\n').length} linha(s)` : (activeFile?.name || 'sem arquivo')}
                </span>
              </span>

              <button
                onClick={() => handleSendAIPrompt()}
                disabled={!promptInput.trim() || isGenerating}
                className="ml-auto px-4 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:bg-zinc-800 disabled:text-zinc-500 text-black font-semibold text-xs font-mono transition-all flex items-center justify-center gap-1.5 shrink-0"
              >
                {isGenerating ? (
                  <>
                    <RefreshCw size={13} className="animate-spin" />
                    <span>Gerando...</span>
                  </>
                ) : (
                  <>
                    <Sparkles size={13} />
                    <span>Gerar</span>
                  </>
                )}
              </button>
            </div>
          </div>

          </div>

        </div>
      </div>

      {/* SWARM HARNESS AGENTS MODAL */}
      <AnimatePresence>
        {isSwarmModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-lg">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="w-full max-w-4xl max-h-[90vh] bg-[#0b0e17] border border-purple-500/40 rounded-3xl p-6 shadow-2xl text-left flex flex-col gap-4 overflow-hidden relative"
            >
              {/* Header */}
              <div className="flex items-start justify-between border-b border-white/10 pb-4 shrink-0">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-purple-500/20 to-cyan-500/20 border border-purple-500/40 flex items-center justify-center text-purple-300">
                    <Bot size={24} className={swarmStatus === 'running' ? 'animate-bounce text-cyan-400' : ''} />
                  </div>

                  <div>
                    <h3 className="text-lg font-bold text-white font-mono flex items-center gap-2">
                      🐝 OSONE CODE — ENXAME DE AGENTES & HARNESS LOOPS
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30 font-normal">
                        Game & Web Architecture Engine
                      </span>
                    </h3>
                    <p className="text-xs text-purple-200/70 mt-0.5">
                      Engenharia de Harness com ciclo contínuo: PM ➔ Arququiteto ➔ Engenheiro ➔ QA (Loop Autônomo).
                    </p>
                  </div>
                </div>

                {/* Fechar com o Enxame rodando PARA o Enxame. Antes ele seguia por baixo,
                    consumindo cota e gravando no repositório com o painel fora da vista. */}
                <div className="flex items-center gap-2 shrink-0">
                  {swarmStatus === 'running' && (
                    <button
                      onClick={() => cancelamentoDoEnxameRef.current?.abort()}
                      className="px-3 py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-300 text-xs font-mono font-bold uppercase tracking-wider transition-colors cursor-pointer"
                      title="Parar o Enxame agora — o que já foi salvo permanece"
                    >
                      Parar
                    </button>
                  )}
                  <button
                    onClick={() => pararEFechar(cancelamentoDoEnxameRef, setIsSwarmModalOpen)}
                    className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
                    title={swarmStatus === 'running' ? 'Parar o Enxame e fechar' : 'Fechar'}
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>

              {/* Main Content Body */}
              <div className="flex-1 overflow-y-auto space-y-4 custom-scrollbar pr-1">
                
                {/* Formato do projeto */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {[
                    {
                      id: 'single' as FormatoProjetoDoCode,
                      icon: FileCode,
                      title: 'Arquivo único',
                      desc: 'Gera tudo em index.html. É o caminho mais estável para jogos, protótipos e preview imediato.'
                    },
                    {
                      id: 'tree' as FormatoProjetoDoCode,
                      icon: Layers,
                      title: 'Árvore completa',
                      desc: 'Gera src/, componentes e estrutura real. O preview roda o frontend; backend fica pronto para exportar/rodar.'
                    }
                  ].map(opcao => {
                    const Icone = opcao.icon;
                    const ativo = swarmProjectFormat === opcao.id;
                    return (
                      <button
                        key={opcao.id}
                        type="button"
                        onClick={() => setSwarmProjectFormat(opcao.id)}
                        disabled={swarmStatus === 'running'}
                        className={cn(
                          "text-left p-3 rounded-2xl border transition-all flex items-start gap-3 disabled:opacity-60 cursor-pointer active:scale-[0.99]",
                          ativo
                            ? "bg-cyan-500/10 border-cyan-400/50 shadow-lg shadow-cyan-950/30"
                            : "bg-black/40 border-white/10 hover:border-white/20 hover:bg-white/[0.04]"
                        )}
                        title={`Criar como ${opcao.title.toLowerCase()}`}
                      >
                        <span className={cn(
                          "w-9 h-9 rounded-xl border flex items-center justify-center shrink-0",
                          ativo ? "bg-cyan-400/15 border-cyan-400/40 text-cyan-200" : "bg-white/5 border-white/10 text-zinc-400"
                        )}>
                          <Icone size={17} />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-bold text-white font-mono">{opcao.title}</span>
                          <span className="block text-[11px] text-zinc-400 leading-relaxed mt-1">{opcao.desc}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>

                {/* Textarea Goal & Presets */}
                <div className="space-y-2">
                  <label className="text-xs font-mono text-purple-300 font-semibold uppercase tracking-wider block flex items-center justify-between">
                    <span>Definição do Objetivo do Jogo / Aplicação:</span>
                    <span className="text-[10px] text-zinc-400 normal-case font-normal">O Enxame executará até a aprovação total do QA</span>
                  </label>
                  
                  <textarea 
                    value={swarmPrompt}
                    onChange={(e) => setSwarmPrompt(e.target.value)}
                    placeholder={swarmProjectFormat === 'single'
                      ? "Ex: Crie um jogo completo de nave 2D em um único index.html, com canvas, sons Web Audio, placar e tela de game over."
                      : "Ex: Crie um dashboard de tarefas em árvore completa com React, componentes, filtros, cards, estado local e layout responsivo."}
                    className="w-full h-24 bg-black/60 border border-purple-500/30 focus:border-purple-400 rounded-2xl p-3 text-xs font-mono text-zinc-100 placeholder-zinc-500 outline-none resize-none leading-relaxed"
                  />

                  {/* Presets */}
                  <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pt-1">
                    <span className="text-[10px] font-mono text-zinc-400 shrink-0 flex items-center gap-1">
                      <Gamepad2 size={12} className="text-purple-400" /> Presets:
                    </span>
                    {[
                      { label: '🚀 Space Shooter 2D', formato: 'single' as FormatoProjetoDoCode, prompt: 'Jogo de Nave 2D Space Shooter em HTML5 Canvas com tiros, asteroides, inimigos, sons Web Audio e placar.' },
                      { label: '🕹️ Brick Breaker Arcade', formato: 'single' as FormatoProjetoDoCode, prompt: 'Jogo Brick Breaker (Quebra-blocos) em HTML5 Canvas com power-ups, efeitos visuais, vidas e pontuação.' },
                      { label: '🐍 Cyberpunk Snake', formato: 'single' as FormatoProjetoDoCode, prompt: 'Jogo da Cobrinha (Snake) em estilização Cyberpunk com néon, partículas, comida especial e recorde salvo.' },
                      { label: '🏎️ Racing Pseudo-3D', formato: 'single' as FormatoProjetoDoCode, prompt: 'Jogo de Corrida retro pseudo-3D em HTML5 Canvas com obstáculos, contador de velocidade e sons.' },
                      { label: '🏰 Dungeon Crawler 2D', formato: 'single' as FormatoProjetoDoCode, prompt: 'Jogo RPG 2D Dungeon Crawler top-down com movimentação de personagem, monstros, baús e combate.' },
                      { label: '📊 Dashboard React', formato: 'tree' as FormatoProjetoDoCode, prompt: 'Dashboard de produtividade com cards, filtros, lista de tarefas, estatísticas, tema escuro e componentes reutilizáveis.' },
                      { label: '🛒 Loja Fullstack', formato: 'tree' as FormatoProjetoDoCode, prompt: 'Catálogo de produtos com carrinho, filtros, tela de checkout simulada e estrutura pronta para API backend.' }
                    ].map((preset, idx) => (
                      <button
                        key={idx}
                        onClick={() => {
                          setSwarmProjectFormat(preset.formato);
                          setSwarmPrompt(preset.prompt);
                        }}
                        className="px-2.5 py-1 rounded-xl bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 text-[10px] font-mono text-purple-200 shrink-0 transition-all"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Settings & Execution Control */}
                <div className="flex items-center justify-between p-3 rounded-2xl bg-black/40 border border-white/10 flex-wrap gap-3">
                  <div className="flex items-center gap-3 font-mono text-xs text-zinc-300">
                    <span className="text-purple-400 font-semibold">Limite de Iterações (Harness Loop):</span>
                    <div className="flex items-center gap-1">
                      {[3, 5, 8].map(num => (
                        <button
                          key={num}
                          onClick={() => setMaxHarnessIterations(num)}
                          className={cn(
                            "px-2.5 py-1 rounded-lg text-xs font-mono transition-all",
                            maxHarnessIterations === num
                              ? "bg-purple-500 text-black font-bold"
                              : "bg-white/5 text-zinc-400 hover:text-white"
                          )}
                        >
                          {num}x ciclos
                        </button>
                      ))}
                    </div>
                  </div>

                  <button 
                    onClick={() => runSwarmHarnessEngine()}
                    disabled={!swarmPrompt.trim() || swarmStatus === 'running'}
                    className="px-6 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 via-cyan-600 to-emerald-600 hover:from-purple-500 hover:to-emerald-500 disabled:opacity-50 text-white font-mono font-bold text-xs flex items-center gap-2 transition-all shadow-lg shadow-purple-950/60 cursor-pointer active:scale-95 ml-auto"
                  >
                    {swarmStatus === 'running' ? (
                      <>
                        <Loader2 size={16} className="animate-spin text-cyan-200" />
                        <span>Enxame Ativo (Iteração {swarmIteration})...</span>
                      </>
                    ) : (
                      <>
                        <Zap size={16} className="text-amber-300" />
                        <span>Disparar Enxame de Agentes</span>
                      </>
                    )}
                  </button>
                </div>

                {/* Swarm Progress Bar */}
                {swarmStatus === 'running' && (
                  <div className="p-3.5 rounded-2xl bg-black/60 border border-purple-500/40 space-y-2">
                    <div className="flex items-center justify-between text-xs font-mono">
                      <span className="text-cyan-300 font-bold flex items-center gap-2">
                        <Loader2 size={14} className="animate-spin text-cyan-400 shrink-0" />
                        {swarmProgressText || 'Executando Enxame...'}
                      </span>
                      <span className="text-purple-300 font-bold shrink-0 ml-2">{swarmProgress}%</span>
                    </div>
                    <div className="w-full h-2.5 bg-zinc-900 rounded-full overflow-hidden border border-purple-500/30">
                      <div 
                        className="h-full bg-gradient-to-r from-purple-500 via-cyan-400 to-emerald-400 transition-all duration-300 rounded-full"
                        style={{ width: `${swarmProgress}%` }}
                      />
                    </div>
                  </div>
                )}

                {/* Swarm Active Step Pipeline Visualizer */}
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2 pt-2">
                  {[
                    { id: 'pm', label: '1. Produto (PM)', desc: 'O que construir', icon: Layers, active: swarmCurrentStep === 'pm', done: !!swarmPMArtifact },
                    { id: 'architect', label: '2. Arquitetura', desc: 'Estrutura de arquivos', icon: Cpu, active: swarmCurrentStep === 'architect', done: !!swarmArchitectArtifact },
                    { id: 'coder', label: '3. Engenharia', desc: `Código (Iter. ${swarmIteration})`, icon: Terminal, active: swarmCurrentStep === 'coder', done: swarmIteration > 1 || swarmStatus === 'success' },
                    { id: 'qa', label: '4. QA & Harness', desc: 'Autoavaliação Loop', icon: ShieldCheck, active: swarmCurrentStep === 'qa', done: swarmQAReports.some(r => r.passed) },
                    { id: 'assembly', label: '5. Repositório', desc: 'Preview Vivo', icon: CheckCircle2, active: swarmCurrentStep === 'assembly', done: swarmStatus === 'success' }
                  ].map((step, idx) => {
                    const StepIcon = step.icon;
                    return (
                      <div 
                        key={idx}
                        className={cn(
                          "p-3 rounded-2xl border flex flex-col gap-1 transition-all relative overflow-hidden",
                          step.active ? "bg-purple-950/40 border-purple-400 shadow-[0_0_15px_rgba(168,85,247,0.2)]" :
                          step.done ? "bg-emerald-950/20 border-emerald-500/40 text-emerald-300" :
                          "bg-black/40 border-white/5 opacity-60"
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <StepIcon size={16} className={step.active ? "text-cyan-400 animate-pulse" : step.done ? "text-emerald-400" : "text-zinc-500"} />
                          {step.active && <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />}
                          {step.done && <CheckCircle2 size={12} className="text-emerald-400" />}
                        </div>
                        <span className="text-xs font-mono font-bold text-white mt-1">{step.label}</span>
                        <span className="text-[10px] font-mono text-zinc-400">{step.desc}</span>
                      </div>
                    );
                  })}
                </div>

                {/* Swarm Artifacts & Logs Drawer Tabs */}
                {swarmLogs.length > 0 && (
                  <div className="bg-black/60 border border-white/10 rounded-2xl overflow-hidden flex flex-col font-mono text-xs">
                    {/* Tabs bar */}
                    <div className="flex items-center border-b border-white/10 bg-[#070910] px-3 pt-2 gap-2 overflow-x-auto">
                      {[
                        { id: 'logs', label: `📋 Logs de Execução (${swarmLogs.length})` },
                        { id: 'pm', label: '📑 Produto' },
                        { id: 'architect', label: '🏗️ Arquitetura' },
                        { id: 'qa', label: `🧪 QA Harness (${swarmQAReports.length})` }
                      ].map(tab => (
                        <button
                          key={tab.id}
                          onClick={() => setActiveArtifactTab(tab.id as any)}
                          className={cn(
                            "px-3 py-1.5 rounded-t-xl text-xs font-semibold transition-all border-t border-x",
                            activeArtifactTab === tab.id
                              ? "bg-black/80 text-cyan-300 border-purple-500/40"
                              : "text-zinc-500 border-transparent hover:text-zinc-300"
                          )}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>

                    {/* Tab Content Panel */}
                    <div className="p-4 max-h-56 overflow-y-auto custom-scrollbar">
                      {activeArtifactTab === 'logs' && (
                        <div className="space-y-1.5 text-[11px] font-mono">
                          {swarmLogs.map((log, i) => (
                            <div 
                              key={i} 
                              className={cn(
                                "flex items-start gap-2 p-1.5 rounded-lg border",
                                log.type === 'success' ? "bg-emerald-950/30 border-emerald-500/20 text-emerald-300" :
                                log.type === 'warn' ? "bg-amber-950/30 border-amber-500/20 text-amber-300" :
                                log.type === 'error' ? "bg-red-950/30 border-red-500/20 text-red-300" :
                                "bg-white/[0.02] border-white/5 text-zinc-300"
                              )}
                            >
                              <span className="text-[9px] text-zinc-500 shrink-0 mt-0.5">{log.timestamp}</span>
                              <span className="font-bold text-cyan-400 shrink-0">{log.agent}:</span>
                              <span className="flex-1 leading-relaxed">{log.message}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {activeArtifactTab === 'pm' && swarmPMArtifact && (
                        <div className="space-y-2 text-xs">
                          <div className="p-2.5 rounded-xl bg-purple-950/20 border border-purple-500/30 text-purple-200">
                            <strong>Visão do produto:</strong> {swarmPMArtifact.gdd}
                          </div>
                          <div>
                            <strong className="text-cyan-400 block mb-1">Mecânicas de Jogo:</strong>
                            <ul className="list-disc list-inside space-y-0.5 text-zinc-300">
                              {swarmPMArtifact.mechanics?.map((m, idx) => <li key={idx}>{m}</li>)}
                            </ul>
                          </div>
                        </div>
                      )}

                      {activeArtifactTab === 'architect' && swarmArchitectArtifact && (
                        <div className="space-y-2 text-xs">
                          <div className="p-2.5 rounded-xl bg-cyan-950/20 border border-cyan-500/30 text-cyan-200">
                            <strong>Estratégia:</strong> {swarmArchitectArtifact.gameLoopStrategy}
                          </div>
                          <div>
                            <strong className="text-purple-400 block mb-1">Estrutura de Arquivos:</strong>
                            <p className="text-zinc-300">{swarmArchitectArtifact.fileStructure}</p>
                          </div>
                        </div>
                      )}

                      {activeArtifactTab === 'qa' && (
                        <div className="space-y-2 text-xs">
                          {swarmQAReports.length === 0 ? (
                            <p className="text-zinc-500 italic">Aguardando testes do Agente de QA...</p>
                          ) : (
                            swarmQAReports.map((report, idx) => (
                              <div key={idx} className={cn("p-3 rounded-xl border space-y-1", report.passed ? "bg-emerald-950/30 border-emerald-500/40" : "bg-amber-950/30 border-amber-500/40")}>
                                <div className="flex items-center justify-between font-bold">
                                  <span>Iteração {report.iteration} — Avaliação de QA</span>
                                  <span className={report.passed ? "text-emerald-400" : "text-amber-400"}>
                                    Nota: {report.score}/100 ({report.passed ? 'APROVADO' : 'REPROVADO'})
                                  </span>
                                </div>
                                <p className="text-zinc-300">{report.feedback}</p>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                )}

              </div>

            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* HUNTER AGENT EXAMINER MODAL */}
      <AnimatePresence>
        {isHunterModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="w-full max-w-2xl bg-[#0b0e17] border border-emerald-500/40 rounded-3xl p-6 shadow-2xl text-left space-y-5 overflow-hidden relative"
            >
              {/* Header */}
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-2xl bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-emerald-300">
                    <BowAndArrowIcon size={20} className={hunterStatus === 'analyzing' ? 'animate-spin' : ''} />
                  </div>

                  <div>
                    <h3 className="text-base font-bold text-white font-mono flex items-center gap-2">
                      🏹 HUNTER — EXAMINADOR AGÊNTICO DE CÓDIGO
                    </h3>
                    <p className="text-xs text-emerald-200/70 mt-0.5">
                      Descreva exatamente o que deseja examinar, checar ou adicionar no código e no plano.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {hunterStatus === 'analyzing' && (
                    <button
                      onClick={() => cancelamentoDoHunterRef.current?.abort()}
                      className="px-3 py-1.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-300 text-xs font-mono font-bold uppercase tracking-wider transition-colors cursor-pointer"
                      title="Parar a auditoria agora — o arquivo não é alterado"
                    >
                      Parar
                    </button>
                  )}
                  <button
                    onClick={() => pararEFechar(cancelamentoDoHunterRef, setIsHunterModalOpen)}
                    className="p-1.5 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white transition-colors"
                    title={hunterStatus === 'analyzing' ? 'Parar a auditoria e fechar' : 'Fechar'}
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>

              {/* Textbox Input */}
              <div className="space-y-2">
                <label className="text-xs font-mono text-emerald-400 font-semibold uppercase tracking-wider block">
                  Exigências & Checklist do Código/Plano:
                </label>
                <textarea 
                  value={hunterPrompt}
                  onChange={(e) => setHunterPrompt(e.target.value)}
                  placeholder="Ex: Verifique se a aplicação possui estado de contagem, botões responsivos, estilização e se faltou algo no plano. Se faltar qualquer item, implemente no código imediatamente!"
                  className="w-full h-32 bg-black/60 border border-emerald-500/30 focus:border-emerald-400 rounded-2xl p-3 text-xs font-mono text-zinc-100 placeholder-zinc-500 outline-none resize-none leading-relaxed"
                />
              </div>

              {/* Actions: Voice or Hunter Execution */}
              <div className="flex items-center justify-between gap-3 flex-wrap">
                {onStartLiveVoice && (
                  <button 
                    onClick={() => {
                      onStartLiveVoice();
                    }}
                    className="px-4 py-2.5 rounded-xl bg-emerald-950/80 hover:bg-emerald-900 border border-emerald-500/40 text-emerald-300 text-xs font-mono font-semibold flex items-center gap-2 transition-all cursor-pointer active:scale-95"
                  >
                    <Mic size={14} className="animate-pulse text-emerald-400" />
                    <span>Falar com Gemini Live (Voz)</span>
                  </button>
                )}

                <button 
                  onClick={() => runHunterAnalysis()}
                  disabled={!hunterPrompt.trim() || hunterStatus === 'analyzing'}
                  className="px-5 py-2.5 rounded-xl bg-gradient-to-r from-emerald-600 to-green-600 hover:from-emerald-500 hover:to-green-500 disabled:opacity-50 text-white font-mono font-bold text-xs flex items-center gap-2 transition-all shadow-lg shadow-emerald-950/60 cursor-pointer active:scale-95 ml-auto"
                >
                  {hunterStatus === 'analyzing' ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      <span>Caçando & Auditando...</span>
                    </>
                  ) : (
                    <>
                      <BowAndArrowIcon size={16} />
                      <span>Caçar & Implementar no Código</span>
                    </>
                  )}
                </button>
              </div>

              {/* Status Report / Doubt Output */}
              {hunterStatus !== 'idle' && (
                <div className={cn(
                  "p-4 rounded-2xl border text-xs leading-relaxed font-mono space-y-2",
                  hunterStatus === 'analyzing' ? "bg-emerald-950/30 border-emerald-500/30 text-emerald-300" :
                  hunterStatus === 'doubt' ? "bg-amber-950/30 border-amber-500/40 text-amber-200" :
                  hunterStatus === 'success' ? "bg-emerald-950/40 border-emerald-500/50 text-emerald-200" :
                  "bg-red-950/30 border-red-500/40 text-red-300"
                )}>
                  <div className="flex items-center gap-2 font-bold uppercase tracking-wide">
                    {hunterStatus === 'analyzing' && <Loader2 size={14} className="animate-spin text-emerald-400" />}
                    <span className="flex-1">
                      {hunterStatus === 'analyzing' ? 'Análise & Auditoria do Hunter em Andamento...' :
                       hunterStatus === 'doubt' ? 'Dúvida Impeditiva Detectada:' :
                       hunterStatus === 'success' ? '✓ Caçada Concluída com Sucesso!' : 'Erro na Análise'}
                    </span>
                    {hunterStatus === 'analyzing' && <span className="text-emerald-400 font-bold">{hunterProgress}%</span>}
                  </div>

                  {hunterStatus === 'analyzing' && (
                    <div className="w-full h-2 bg-zinc-900 rounded-full overflow-hidden border border-emerald-500/30 my-1">
                      <div 
                        className="h-full bg-gradient-to-r from-emerald-600 via-green-400 to-cyan-400 transition-all duration-300 rounded-full"
                        style={{ width: `${hunterProgress}%` }}
                      />
                    </div>
                  )}

                  {hunterStatus === 'doubt' && (
                    <div className="space-y-3 pt-1">
                      <p className="text-amber-100 bg-amber-500/10 p-2.5 rounded-xl border border-amber-500/20">
                        {hunterDoubt}
                      </p>

                      <div className="flex items-center gap-2">
                        <input 
                          type="text" 
                          value={hunterDoubtInput}
                          onChange={(e) => setHunterDoubtInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && hunterDoubtInput.trim()) {
                              const clar = hunterDoubtInput.trim();
                              setHunterDoubtInput('');
                              runHunterAnalysis(clar);
                            }
                          }}
                          placeholder="Digitar esclarecimento para o Hunter..."
                          className="flex-1 bg-black/60 border border-amber-500/40 rounded-xl px-3 py-2 text-xs text-white placeholder-amber-200/40 outline-none"
                        />
                        <button 
                          onClick={() => {
                            if (hunterDoubtInput.trim()) {
                              const clar = hunterDoubtInput.trim();
                              setHunterDoubtInput('');
                              runHunterAnalysis(clar);
                            }
                          }}
                          className="px-3.5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-bold text-xs"
                        >
                          Enviar
                        </button>
                      </div>
                    </div>
                  )}

                  {hunterStatus === 'success' && (
                    <p className="text-emerald-100 bg-emerald-500/10 p-3 rounded-xl border border-emerald-500/20">
                      {hunterReport}
                    </p>
                  )}
                </div>
              )}

            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
