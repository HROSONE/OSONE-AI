/**
 * OSONE CODE com modelo LOCAL via Ollama (Qwen Coder e companhia).
 *
 * Este arquivo é o ÚNICO dono das regras do provedor 'ollama' no OSONE CODE, justamente para
 * poder ser conferido por um script determinístico (`scripts/conferir-ollama-code.mjs`) sem
 * precisar de placa de vídeo nem de servidor rodando. As mesmas regras valem nos dois lados:
 *
 * - Lado SERVIDOR (server.ts): chama `http://127.0.0.1:11434/api/generate` para escrever o
 *   código. O servidor escuta em 0.0.0.0 quando instalado, então a URL do Ollama VEM NO PEDIDO
 *   feito pela interface (que está na mesma máquina da placa) — nunca é assumida. Se vier um
 *   endereço que não seja a própria máquina, o pedido é recusado: um OSONE público acessível
 *   pela internet não pode ser usado como ponte para atacar o Ollama de quem o hospeda.
 *
 * - Lado INSTALAÇÃO (src/localAgentService.ts): rotas do Agente Local baixam e sobem o Ollama
 *   e puxam o modelo Qwen escolhido pelo usuário, com progresso observável (o download de um
 *   Qwen tem gigabytes; sem progresso seria "travou" ou "instalou"?).
 */

/**
 * O padrão é o 1.5B de propósito: quem instala um motor local normalmente NÃO tem placa de
 * vídeo — é a máquina de 8 GB de RAM em que o 7B trocaria memória o tempo todo. O usuário pode
 * subir de tamanho na interface quando o hardware aguenta; o contrário (o app empurrar um modelo
 * que não cabe) é o erro que este padrão evita.
 */
export const MODELOS_OLLAMA_PADRAO = 'qwen2.5-coder:1.5b';

/** Modelos Qwen Coder oferecidos na interface, do leve ao pesado. */
export const OPGOES_DE_MODELO_OLLAMA: Array<{ id: string; label: string; desc: string }> = [
  { id: 'qwen2.5-coder:1.5b', label: 'Qwen2.5 Coder 1.5B', desc: '~1 GB de RAM. Padrão: roda até em PC sem GPU com 8 GB.' },
  { id: 'qwen2.5-coder:3b', label: 'Qwen2.5 Coder 3B', desc: '~2,5 GB. Mais qualidade; apertado em 8 GB de RAM sem GPU.' },
  { id: 'qwen2.5-coder:7b', label: 'Qwen2.5 Coder 7B', desc: '~5 GB. Melhor custo-benefício para programar.' },
  { id: 'qwen2.5-coder:14b', label: 'Qwen2.5 Coder 14B', desc: '~10 GB. Raciocínio forte, pede placa maior.' },
  { id: 'qwen2.5-coder:32b', label: 'Qwen2.5 Coder 32B', desc: '~20 GB. Qualidade próxima dos modelos pagos.' },
];

/** A porta padrão do Ollama é sempre esta; só o endereço pode mudar. */
const PORTA_OLLAMA = 11434;

/** Normaliza 'localhost' → loopback numérico e garante a porta quando ela não veio. */
export function normalizarEnderecoDoOllama(bruto: string): string {
  const limpo = String(bruto || '').trim().replace(/\/+$/, '');
  if (!limpo) return `http://127.0.0.1:${PORTA_OLLAMA}`;
  try {
    const url = new URL(/^https?:\/\//i.test(limpo) ? limpo : `http://${limpo}`);
    if (!url.port) url.port = String(PORTA_OLLAMA);
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    return url.origin;
  } catch {
    return `http://127.0.0.1:${PORTA_OLLAMA}`;
  }
}

/**
 * Diz se um endereço aponta para a PRÓPRIA máquina (loopback).
 *
 * É a guarda de segurança do provedor local: aceita 127.x.x.x, ::1 e localhost; recusa IPs de
 * rede, nomes de domínio e qualquer coisa malformada. Sem isso, um OSONE publicado poderia ser
 * instruído (por prompt injetado ou por quem alcança a API) a gerar requisições contra serviços
 * internos de quem o serve — SSRF puro.
 */
export function ehEnderecoLocalDoOllama(bruto: string): boolean {
  const limpo = String(bruto || '').trim();
  if (!limpo) return true; // vazio = padrão loopback, que é local
  try {
    // Bare IPv6 (ex.: "::1" ou "[::1]:11434") precisa de colchetes antes de virar URL válida.
    const brutoComColchetes = /^\[?[0-9a-fA-F:]*:[0-9a-fA-F:]*\]?(:\d+)?$/.test(limpo) && limpo.includes(':') && !/^https?:\/\//i.test(limpo)
      ? `http://${limpo.startsWith('[') ? limpo : `[${limpo}]`}`
      : null;
    const url = new URL(brutoComColchetes ?? (/^https?:\/\//i.test(limpo) ? limpo : `http://${limpo}`));
    const h = url.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    if (h === '::1' || h === '[::1]' || h === '[::ffff:127.0.0.1]') return true;
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    return false;
  } catch {
    return false;
  }
}

/** Nome amigável do sistema operacional para as mensagens de instalação do Ollama. */
export function nomeDoSistemaParaInstalacao(platform: NodeJS.Platform | string): string {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  return 'Linux';
}

/**
 * Constrói o corpo do pedido `/api/generate` do Ollama.
 *
 * Num servidor remoto compartilhado, um único pedido gigante estouraria a memória e a GPU de
 * todo mundo; por isso o teto de tokens de saída tem um MÁXIMO configurable por variável de
 * ambiente (padrão sensato para uma RTX 3060), e `num_ctx` fica explícito para o modelo não
 * herdar uma janela minúscula de outros usuários da máquina.
 */
export function montarPedidoOllama(opcoes: {
  modelo: string;
  prompt: string;
  systemInstruction?: string;
  stream?: boolean;
  numCtx?: number;
  temperatura?: number;
  tetoDeTokens?: number;
}): Record<string, unknown> {
  const tetoConfigurado = Number(process.env.OSONE_OLLAMA_MAX_TOKENS || 8192);
  const teto = Math.max(512, Math.min(Number(opcoes.tetoDeTokens ?? tetoConfigurado) || tetoConfigurado, tetoConfigurado));
  const corpo: Record<string, unknown> = {
    model: opcoes.modelo,
    prompt: opcoes.prompt,
    stream: opcoes.stream !== false,
    options: {
      num_ctx: Number(opcoes.numCtx ?? 8192),
      temperature: Number(opcoes.temperatura ?? 0.2),
      num_predict: teto,
    },
  };
  if (opcoes.systemInstruction) corpo.system = String(opcoes.systemInstruction);
  return corpo;
}

/**
 * Extrai texto e motivo de parada de UMA linha JSON do fluxo `/api/generate` do Ollama.
 * Linhas vazias ou de progresso de carregamento do modelo são ignoradas em silêncio.
 */
export function lerPecacoDoFluxoOllama(linhaJson: string): { texto: string; done: boolean; motivo?: string } {
  let dado: any;
  try {
    dado = JSON.parse(linhaJson);
  } catch {
    return { texto: '', done: false };
  }
  return {
    texto: typeof dado?.response === 'string' ? dado.response : '',
    done: dado?.done === true,
    motivo: typeof dado?.done_reason === 'string' ? dado.done_reason : undefined,
  };
}

/**
 * Emenda a continuação no texto cortado, descontando a repetição que o modelo faz ao retomar.
 * Mesma regra do caminho Gemini/OpenAI/Anthropic, reimplementada aqui porque os motores locais
 * também param no meio de arquivos grandes.
 */
export function emendarContinuacaoLocal(inicio: string, continuacao: string): string {
  if (!inicio) return continuacao;
  if (!continuacao) return inicio;
  const maximo = Math.min(600, inicio.length, continuacao.length);
  for (let n = maximo; n >= 1; n--) {
    if (inicio.endsWith(continuacao.slice(0, n))) return inicio + continuacao.slice(n);
  }
  return inicio + continuacao;
}

/** Os motivos de parada do Ollama que significam "a resposta NÃO coube na resposta". */
export function motivoIndicaCorte(motivo?: string): boolean {
  return motivo === 'length' || motivo === 'stop_token';
}

/**
 * Monta o comando de instalação do Ollama POR SISTEMA OPERACIONAL.
 *
 * Windows e macOS usam o instalador oficial (.exe / .pkg baixados do site); Linux usa o script
 * oficial `curl | sh`. Os três comandos voltam a executar o app/debian certo depois de instalar,
 * e nenhum deles toca na pasta de instalação do OSONE.
 */
export function comandoDeInstalacaoDoOllama(platform: NodeJS.Platform | string): { command: string; metodo: string } | null {
  if (platform === 'win32') {
    return {
      command:
        'powershell -NoProfile -ExecutionPolicy Bypass -Command "' +
        "$ProgressPreference='SilentlyContinue'; " +
        "Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile \"$env:TEMP\\OllamaSetup.exe\"; " +
        "Start-Process -FilePath \"$env:TEMP\\OllamaSetup.exe\" -ArgumentList '/VERYSILENT','/NORESTART' -Wait; " +
        "$p = Join-Path $env:LOCALAPPDATA 'Programs\\Ollama\\ollama.exe'; " +
        "if (Test-Path $p) { & $p serve }\"",
      metodo: 'instalador oficial (OllamaSetup.exe)',
    };
  }
  if (platform === 'darwin') {
    return {
      command:
        "curl -fsSL -o \"/tmp/Ollama-darwin.pkg\" https://ollama.com/download/Ollama-darwin.pkg && " +
        "(sudo installer -pkg \"/tmp/Ollama-darwin.pkg\" -target / || installer -pkg \"/tmp/Ollama-darwin.pkg\" -target ~/Applications 2>/dev/null || true) && " +
        "(open -a Ollama || /usr/local/bin/ollama serve)",
      metodo: 'pacote oficial (.pkg)',
    };
  }
  if (platform === 'linux') {
    return {
      command:
        "(curl -fsSL https://ollama.com/install.sh | sh) || " +
        "((command -v systemctl >/dev/null 2>&1 && sudo -n systemctl status ollama >/dev/null 2>&1) || ollama serve)",
      metodo: 'script oficial de instalação',
    };
  }
  return null;
}

/** Valida o nome de um modelo antes de passá-lo ao binário `ollama pull`. */
export function nomeDeModeloValido(modelo: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/.test(String(modelo || '').trim());
}

/** Lista de verificação rápida do estado esperado do Ollama no computador. */
export interface EstadoDoOllama {
  plataforma: string;
  instalado: boolean;
  caminhoDoBinario?: string;
  servidorRespondendo: boolean;
  endpointVerificado: string;
  modelosBaixados: string[];
  qwenDisponivel: boolean;
  mensagem: string;
}
