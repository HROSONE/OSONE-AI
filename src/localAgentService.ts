import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import vm from 'vm';
import crypto from 'crypto';
import { exec, execFile, execSync, spawn } from 'child_process';
import { Request, Response, NextFunction, Router } from 'express';
import {
  ehEndereco, normalizarEndereco, pareceNomeDePrograma, NAVEGADORES_DO_AGENTE, NOME_DO_PERFIL
} from './lib/navegadorDoAgente';
import { SondaDeDisco, CaminhoResolvido, resolverCaminho } from './lib/caminhoDoSistema';
import {
  MODELOS_OLLAMA_PADRAO,
  comandoDeInstalacaoDoOllama,
  nomeDeModeloValido,
} from './lib/ollama';

// ============================================================================
// SEÇÃO 1: CONFIGURAÇÃO E INICIALIZAÇÃO
// ============================================================================

const CONFIG_PATH = path.join(process.cwd(), 'config.json');
const AUDIT_LOG_PATH = path.join(process.cwd(), 'audit.log');
const TRASH_DIR_PATH = path.join(process.cwd(), 'trash');

/**
 * Caminho real da instalação do OSONE que está rodando agora — a ÚNICA coisa que o agente é
 * proibido de apagar/sobrescrever.
 *
 * Precisa funcionar nos dois formatos em que este código roda, e eles não compartilham as
 * mesmas variáveis: o bundle de produção é CommonJS (tem __dirname, e process.cwd() é inútil
 * porque o app empacotado o aponta para a pasta de dados do usuário), enquanto em
 * desenvolvimento o tsx executa como módulo ES, onde __dirname simplesmente não existe e
 * referenciá-lo derruba o processo no carregamento. Por isso a verificação por typeof, e não
 * um uso direto: em dev caímos em process.cwd(), que é a raiz do projeto (nada faz chdir
 * nesse modo), e em produção usamos __dirname (<instalação>/dist) subindo um nível.
 */
export const OSONE_INSTALL_DIR: string = typeof __dirname !== 'undefined'
  ? path.resolve(__dirname, '..')
  : process.cwd();

/** Diretório onde comandos e aberturas devem acontecer por padrão: a casa do usuário. */
const USER_HOME_DIR = os.homedir();

/**
 * Nomes que se referem ao próprio OSONE. Fechar qualquer um deles derrubaria o processo que
 * está executando a ação, então são recusados explicitamente.
 */
const OWN_PROCESS_NAMES = new Set(['osone', 'osone g5', 'osone-app', 'osone.exe', 'node', 'electron']);

/** Expande '~' para a pasta do usuário e normaliza o caminho. */
function expandHomePath(inputPath: string): string {
  const raw = String(inputPath || '').trim();
  if (raw === '~') return USER_HOME_DIR;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(USER_HOME_DIR, raw.slice(2));
  }
  return raw;
}

/**
 * Nomes possíveis das pastas padrão do usuário, POR IDIOMA.
 *
 * Um sistema em português nomeia as pastas "Documentos" e "Área de Trabalho"; a configuração
 * antiga assumia os nomes em inglês ("Documents", "Desktop") e portanto apontava para pastas
 * que sequer existem nessas máquinas — o agente falhava em qualquer operação nelas. Aqui
 * testamos os nomes reais no disco e usamos o primeiro que existir de fato.
 */
const WELL_KNOWN_FOLDER_ALIASES: Record<string, string[]> = {
  downloads: ['Downloads', 'Descargas', 'Transferências', 'Baixados'],
  desktop: ['Desktop', 'Área de Trabalho', 'Area de Trabalho', 'Escritorio', 'Escritório'],
  documents: ['Documents', 'Documentos'],
  pictures: ['Pictures', 'Imagens', 'Fotos'],
  music: ['Music', 'Música', 'Musicas', 'Músicas'],
  videos: ['Videos', 'Vídeos'],
  home: [''],
};

/**
 * Converte o que o modelo mandou num caminho ABSOLUTO real do disco.
 *
 * Aceita tanto um caminho completo ("/home/user/projetos", "C:\\Users\\x\\Downloads", "~/x")
 * quanto um apelido de pasta conhecida ("downloads", "documentos", "área de trabalho"). Antes
 * só apelidos em inglês eram aceitos, e qualquer caminho real era recusado — que é a razão de
 * o agente "não achar os caminhos" e falhar ao criar, escrever ou apagar qualquer coisa.
 */
/**
 * A sonda que deixa a resolução de caminho PERGUNTAR AO DISCO em vez de adivinhar.
 *
 * As regras moram em lib/caminhoDoSistema.ts, separadas justamente para poderem ser conferidas
 * contra um disco de mentira, com as pastas exatas de cada caso. Aqui só se liga o disco real.
 */
const sondaDoDisco: SondaDeDisco = {
  existe: (caminho) => { try { return fs.existsSync(caminho); } catch { return false; } },
  listar: (pasta) => { try { return fs.readdirSync(pasta); } catch { return []; } },
  casa: USER_HOME_DIR,
  ehWindows: process.platform === 'win32'
};

/** Como o caminho foi resolvido, para quem precisa CONTAR isso ao usuário. */
export function resolverCaminhoDetalhado(input: string): CaminhoResolvido {
  return resolverCaminho(String(input || ''), sondaDoDisco, { apelidosDePastas: WELL_KNOWN_FOLDER_ALIASES });
}

export function resolveAnyPath(input: string): string {
  return resolverCaminhoDetalhado(input).caminho;
}

/**
 * Categorias de extensões de arquivo para organização automática
 */
export const FILE_CATEGORIES: Record<string, string[]> = {
  Imagens: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.tiff', '.ico', '.heic'],
  Documentos: ['.pdf', '.docx', '.doc', '.txt', '.rtf', '.odt', '.epub', '.md', '.pages', '.tex'],
  Planilhas: ['.xlsx', '.xls', '.csv', '.ods', '.tsv', '.numbers'],
  Videos: ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.webm', '.flv', '.m4v'],
  Audio: ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma'],
  Compactados: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.tgz'],
  Instaladores: ['.exe', '.msi', '.deb', '.rpm', '.appimage', '.dmg', '.pkg', '.iso'],
  Outros: [] // Categoria padrão caso a extensão não coincida
};

export interface LocalAgentConfig {
  port: number;
  token: string;
  allowedOrigin: string;
  apps: Record<string, { win32?: string; linux?: string; processName?: { win32?: string; linux?: string } }>;
  allowedFolders: Record<string, string>;
}

export let CONFIG: LocalAgentConfig = {
  port: 3000,
  token: '',
  allowedOrigin: '*',
  apps: {
    spotify: {
      win32: 'start spotify:',
      linux: 'spotify',
      processName: {
        win32: 'Spotify.exe',
        linux: 'spotify'
      }
    },
    vscode: {
      win32: 'code',
      linux: 'code',
      processName: {
        win32: 'Code.exe',
        linux: 'code'
      }
    },
    filemanager: {
      win32: 'explorer',
      linux: 'xdg-open .',
      processName: {
        win32: 'explorer.exe',
        linux: 'nautilus'
      }
    },
    terminal: {
      win32: 'start cmd',
      linux: 'gnome-terminal',
      processName: {
        win32: 'cmd.exe',
        linux: 'gnome-terminal'
      }
    },
    browser: {
      win32: 'start https://google.com',
      linux: 'xdg-open https://google.com',
      processName: {
        win32: 'chrome.exe',
        linux: 'chrome'
      }
    }
  },
  allowedFolders: {
    downloads: '~/Downloads',
    desktop: '~/Desktop',
    documents: '~/Documents'
  }
};

/**
 * Carrega ou gera o arquivo config.json
 */
export function initializeConfig(): LocalAgentConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const fileData = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(fileData);
      CONFIG = { ...CONFIG, ...parsed };
    }
  } catch (err: any) {
    console.warn('[CONFIG WARNING] Erro ao ler config.json. Usando padrão.', err.message);
  }

  // Se o token não existir, estiver vazio, OU ainda for o valor padrão inseguro que já esteve
  // hardcoded neste projeto (mesmo texto em toda instalação = qualquer um lendo o código no
  // GitHub tinha acesso de terminal a qualquer computador rodando o agente), gera um novo
  // token criptograficamente forte e único para esta instalação.
  const INSECURE_LEGACY_TOKENS = new Set(['osone-local-agent-secret-token']);
  if (!CONFIG.token || CONFIG.token.trim() === '' || INSECURE_LEGACY_TOKENS.has(CONFIG.token.trim())) {
    CONFIG.token = crypto.randomBytes(32).toString('hex');
    saveConfig();
    console.warn('[SECURITY] Token do Agente Local ausente ou inseguro foi substituído por um novo token forte gerado automaticamente. Atualize o campo "Token do Agente Local" nas Configurações do OSONE com o novo valor salvo em config.json.');
  }

  // Garante que o diretório da lixeira local exista
  if (!fs.existsSync(TRASH_DIR_PATH)) {
    try {
      fs.mkdirSync(TRASH_DIR_PATH, { recursive: true });
    } catch (err: any) {
      console.error('[TRASH INIT ERROR]', err.message);
    }
  }

  return CONFIG;
}

/**
 * Salva as configurações atuais no arquivo config.json
 */
export function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, 2), 'utf8');
  } catch (err: any) {
    console.error('[CONFIG SAVE ERROR]', err.message);
  }
}

// ============================================================================
// SEÇÃO 2: AUDITORIA E LOGS (audit.log)
// ============================================================================

export function logAudit(level: 'INFO' | 'WARN' | 'ERROR' | 'SECURITY', action: string, message: string, metadata: any = null) {
  const timestamp = new Date().toISOString();
  const metaStr = metadata ? ` | ${JSON.stringify(metadata)}` : '';
  const logLine = `[${timestamp}] [${level}] [${action}] ${message}${metaStr}\n`;

  console.log(`[AUDIT ${level}] ${action}: ${message}`);

  try {
    fs.appendFileSync(AUDIT_LOG_PATH, logLine, 'utf8');
  } catch (err: any) {
    console.error('[AUDIT WRITE ERROR]', err.message);
  }
}

// ============================================================================
// SEÇÃO 3: SEGURANÇA DE CAMINHOS (JAIL DE DIRETÓRIO)
// ============================================================================

export function resolveSafePath(folderKey: string, relativeSubPath: string = '') {
  if (!folderKey || typeof folderKey !== 'string') {
    throw new Error('Pasta não especificada ou inválida.');
  }

  // A CHAVE continua restrita à lista autorizada (downloads/desktop/documents) — é isso que
  // mantém o jail. O que muda é como o CAMINHO dessa chave é resolvido: ver comentário abaixo.
  if (!CONFIG.allowedFolders[folderKey]) {
    throw new Error(`Pasta '${folderKey}' não está na lista de allowedFolders autorizadas.`);
  }

  /**
   * Pergunta ao disco onde a pasta REALMENTE está, em vez de usar o caminho fixo em inglês de
   * CONFIG.allowedFolders[folderKey] (ex: sempre "~/Downloads").
   *
   * Esta função é a única parte do agente que ainda fazia isso — handleFileTrash e o resto já
   * tinham migrado para resolveAnyPath por causa do mesmo problema: numa instalação em
   * português, a pasta de downloads real chama-se "Transferências" ou "Descargas", não
   * "Downloads". Sem esta troca, /organize/plan e /organize/execute criavam um "~/Downloads"
   * vazio e organizavam ELE — zero arquivos, nenhuma explicação — enquanto a pasta de verdade,
   * cheia de arquivos, nunca era tocada. resolveAnyPath só usa o nome em inglês como ÚLTIMO
   * recurso, quando nenhuma variante localizada existe no disco ainda.
   */
  const baseDir = path.resolve(resolveAnyPath(folderKey));

  if (!fs.existsSync(baseDir)) {
    try {
      fs.mkdirSync(baseDir, { recursive: true });
    } catch (err) {
      throw new Error(`Pasta base '${folderKey}' (${baseDir}) não existe e não pôde ser criada.`);
    }
  }

  const cleanSubPath = relativeSubPath ? String(relativeSubPath).trim() : '';
  const targetPath = path.resolve(baseDir, cleanSubPath);

  const isExactBase = targetPath === baseDir;
  const isInsideBase = targetPath.startsWith(baseDir + path.sep);

  if (!isExactBase && !isInsideBase) {
    logAudit('SECURITY', 'PATH_TRAVERSAL_BLOCKED', `Tentativa de saída do jail bloqueada para folderKey=${folderKey}`, {
      subPath: relativeSubPath,
      resolvedTarget: targetPath,
      baseDir
    });
    throw new Error('Acesso Negado: Tentativa de Path Traversal ou acesso fora do diretório permitido.');
  }

  return { baseDir, targetPath };
}

// ============================================================================
// SEÇÃO 4: CATEGORIZAÇÃO DE ARQUIVOS
// ============================================================================

export function getCategoryForFile(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (!ext) return 'Outros';

  for (const [category, extensions] of Object.entries(FILE_CATEGORIES)) {
    if (extensions.includes(ext)) {
      return category;
    }
  }

  return 'Outros';
}

// ============================================================================
// SEÇÃO 5: EXPRESS ROUTER & MIDDLEWARE DE SEGURANÇA
// ============================================================================

initializeConfig();

export const agentRouter = Router();

/**
 * GET /provision-token — entrega o token deste agente para a própria interface do OSONE, para
 * que o usuário não precise abrir o config.json à mão. No app empacotado (.exe) esse arquivo
 * fica na pasta de dados do sistema, que o usuário praticamente nunca encontra — era por isso
 * que o Agente Local parecia "só funcionar no npm run dev".
 *
 * Fica ANTES do middleware de autenticação (é justamente o que fornece a credencial), então a
 * proteção aqui é a origem da requisição: apenas o próprio computador (loopback) pode obter o
 * token. Pedidos vindos da rede são recusados, mesmo o servidor escutando em 0.0.0.0.
 */
agentRouter.get('/provision-token', (req: Request, res: Response) => {
  const remote = req.socket.remoteAddress || '';
  const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';

  if (!isLoopback) {
    logAudit('SECURITY', 'TOKEN_PROVISION_DENIED', `Pedido de token recusado: origem não é a máquina local`, { ip: remote });
    return res.status(403).json({
      error: 'O token do Agente Local só pode ser obtido a partir do próprio computador onde o OSONE está instalado.'
    });
  }

  if (!CONFIG.token || CONFIG.token.trim() === '') {
    CONFIG.token = crypto.randomBytes(32).toString('hex');
    saveConfig();
    logAudit('INFO', 'TOKEN_GENERATED', 'Token do Agente Local gerado sob demanda pela interface do OSONE.');
  }

  logAudit('INFO', 'TOKEN_PROVISIONED', 'Token do Agente Local entregue à interface local do OSONE.', { ip: remote });
  return res.status(200).json({ token: CONFIG.token, platform: process.platform });
});

// Middleware de Autenticação por Token Bearer
agentRouter.use((req: Request, res: Response, next: NextFunction) => {
  // Preflight OPTIONS responde diretamente
  if (req.method === 'OPTIONS') {
    return next();
  }

  const authHeader = req.headers['authorization'] || '';
  const expected = `Bearer ${CONFIG.token}`;
  // Comparação em tempo constante: "===" vaza, pelo tempo de resposta, em qual posição a
  // string recebida deixa de bater com o token — uma diferença pequena, mas real, para quem
  // já alcança esta rota (ela deveria ser só a máquina local, mas essa é a última linha de
  // defesa se algum dia não for). timingSafeEqual exige buffers do MESMO tamanho; o
  // comprimento em si não é segredo, então checá-lo antes não vaza nada de novo.
  const tokenMatch = authHeader.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));

  if (!tokenMatch) {
    logAudit('SECURITY', 'AUTH_FAILED', `Tentativa de acesso não autorizada em ${req.originalUrl}`, {
      ip: req.socket.remoteAddress,
      receivedAuthHeader: authHeader ? 'Presente mas Inválido' : 'Ausente'
    });
    return res.status(401).json({ error: 'Não autorizado. Token de autenticação Bearer inválido ou ausente.' });
  }

  next();
});

/**
 * GET /status
 */
const handleStatus = (req: Request, res: Response) => {
  const isWindows = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  return res.status(200).json({
    status: 'online',
    agentName: 'osone-local-agent',
    version: '2.0.0',
    // Informação de plataforma detalhada: o modelo precisa saber exatamente em que sistema
    // está para não misturar sintaxe (ex: mandar comando de PowerShell numa máquina Linux).
    platform: process.platform,
    osName: isWindows ? 'Windows' : isMac ? 'macOS' : 'Linux',
    osRelease: os.release(),
    shell: isWindows ? 'cmd/powershell' : 'bash/sh',
    pathSeparator: path.sep,
    homeDir: USER_HOME_DIR,
    userName: os.userInfo().username,
    defaultWorkingDir: USER_HOME_DIR,
    protectedPath: OSONE_INSTALL_DIR,
    // Caminhos REAIS das pastas do usuário, já resolvidos no disco e com o nome que elas
    // têm neste sistema (num Linux em português, "Documentos" e "Área de Trabalho", não
    // "Documents"/"Desktop"). Assim o modelo não precisa adivinhar nem tentar caminhos.
    userFolders: (() => {
      const out: Record<string, string> = {};
      for (const key of Object.keys(WELL_KNOWN_FOLDER_ALIASES)) {
        const resolved = resolveAnyPath(key);
        if (fs.existsSync(resolved)) out[key] = resolved;
      }
      return out;
    })(),
    availableApps: Object.keys(CONFIG.apps || {}),
    installedApps: listarAppsInstalados().slice(0, 120),
    openStrategy: 'Use /api/agent/open-any para app, pasta, arquivo ou URL. A abertura roda a partir da pasta do usuário, nunca da pasta OSONE-AI, e tenta fallbacks por plataforma.',
    allowedFolders: Object.keys(CONFIG.allowedFolders || {}),
    // Em qual tela o agente está trabalhando agora — a sua ou a dele. Vai no status porque quem
    // abre a aba precisa saber disso antes de mandar qualquer coisa, e não depois.
    areaParalela: estadoDaArea()
  });
};

/**
 * POST /open-app
 */
const handleOpenApp = async (req: Request, res: Response) => {
  const { appName } = req.body || {};

  if (!appName || typeof appName !== 'string') {
    return res.status(400).json({
      error: 'Nome do aplicativo (appName) é obrigatório.',
      availableApps: Object.keys(CONFIG.apps || {})
    });
  }

  const appEntry = CONFIG.apps[appName];
  if (!appEntry) {
    // Compatibilidade para quem ainda chama a rota antiga /open-app: se não está na allowlist,
    // não empurramos o modelo para "procurar nos arquivos" ou "abrir no navegador". Usamos o
    // resolvedor universal, que consulta PATH/atalhos/apps instalados e abre pelo sistema.
    try {
      const r = await abrirAlvoUniversal(appName, req.body?.path);
      logAudit('INFO', 'APP_OPEN_SUCCESS_FALLBACK', `Aplicativo '${appName}' aberto fora da allowlist`, r);
      return res.status(200).json({ ...r, appName, via: 'resolvedor-universal' });
    } catch (err: any) {
      logAudit('WARN', 'APP_OPEN_REJECTED', `Aplicativo '${appName}' não está na allowlist e não foi resolvido`, { appName, erro: err?.message });
      return res.status(400).json({
        error: `Não encontrei '${appName}' na allowlist nem nos aplicativos detectáveis desta máquina: ${err?.message || err}`,
        availableApps: Object.keys(CONFIG.apps || {}),
        installedApps: listarAppsInstalados().slice(0, 80)
      });
    }
  }

  const platformKey = process.platform === 'win32' ? 'win32' : 'linux';
  const command = appEntry[platformKey];

  if (!command) {
    logAudit('WARN', 'APP_OPEN_NO_COMMAND', `Nenhum comando configurado para plataforma '${platformKey}' no app '${appName}'`);
    return res.status(400).json({
      error: `Nenhum comando configurado para a plataforma '${platformKey}' no aplicativo '${appName}'.`
    });
  }

  try {
    await runShell(command, 4000, USER_HOME_DIR, ambienteGrafico());
    logAudit('INFO', 'APP_OPEN_SUCCESS', `Aplicativo '${appName}' aberto com sucesso`, { command });
    return res.status(200).json({
      message: `Comando enviado para abrir '${appName}'.`,
      appName,
      platform: platformKey,
      command
    });
  } catch (err: any) {
    // A allowlist é só o primeiro caminho. Se ela envelheceu, tenta o resolvedor novo antes de
    // devolver erro — especialmente importante em Windows, onde um app pode existir como atalho,
    // App Execution Alias, instalação da Microsoft Store ou .exe em Program Files.
    try {
      const r = await abrirAlvoUniversal(appName, req.body?.path);
      logAudit('WARN', 'APP_OPEN_FALLBACK_SUCCESS', `Comando configurado falhou; fallback abriu '${appName}'`, { command, fallback: r });
      return res.status(200).json({ ...r, appName, via: 'fallback-da-allowlist', comandoOriginal: command });
    } catch (fallbackErr: any) {
      logAudit('ERROR', 'APP_OPEN_FAILED', `Falha ao abrir app '${appName}': ${err.message}`, { command, fallback: fallbackErr?.message });
      return res.status(500).json({
        error: `Falha ao abrir '${appName}' pelo comando configurado e pelo fallback: ${fallbackErr?.message || fallbackErr}`,
        command,
        availableApps: Object.keys(CONFIG.apps || {}),
        installedApps: listarAppsInstalados().slice(0, 80)
      });
    }
  }
};

/**
 * POST /organize/plan
 */
const handleOrganizePlan = (req: Request, res: Response) => {
  try {
    const { folderKey } = req.body || {};

    const { baseDir } = resolveSafePath(folderKey, '');

    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    const plan = [];

    for (const entry of entries) {
      if (entry.isDirectory()) continue;

      const fileName = entry.name;
      const category = getCategoryForFile(fileName);
      const fromPath = path.join(baseDir, fileName);
      const toFolder = path.join(baseDir, category);
      const toPath = path.join(toFolder, fileName);

      plan.push({
        file: fileName,
        extension: path.extname(fileName).toLowerCase(),
        category,
        from: fromPath,
        toFolder,
        to: toPath
      });
    }

    logAudit('INFO', 'ORGANIZE_PLAN_GENERATED', `Plano de organização gerado para folderKey=${folderKey}`, {
      folderKey,
      totalFilesFound: plan.length
    });

    return res.status(200).json({
      folderKey,
      baseDir,
      totalFiles: plan.length,
      plan
    });

  } catch (err: any) {
    logAudit('ERROR', 'ORGANIZE_PLAN_FAILED', err.message);
    return res.status(400).json({ error: err.message });
  }
};

/**
 * POST /organize/execute
 */
const handleOrganizeExecute = (req: Request, res: Response) => {
  try {
    const { folderKey, plan, confirmed } = req.body || {};

    if (confirmed !== true) {
      return res.status(400).json({
        error: 'Confirmação necessária para executar a organização de arquivos. Envie confirmed: true.'
      });
    }

    if (!Array.isArray(plan) || plan.length === 0) {
      return res.status(400).json({ error: 'O plano fornecido está vazio ou é inválido.' });
    }

    const results = [];

    for (const item of plan) {
      try {
        if (!item || !item.file) {
          results.push({ file: 'desconhecido', status: 'error', error: 'Item de plano inválido' });
          continue;
        }

        const fileName = String(item.file);
        
        const { targetPath: safeSource } = resolveSafePath(folderKey, fileName);
        
        if (!fs.existsSync(safeSource)) {
          results.push({ file: fileName, status: 'skipped', error: 'Arquivo fonte não encontrado (pode ter sido movido)' });
          continue;
        }

        const category = getCategoryForFile(fileName);
        const { targetPath: safeToFolder } = resolveSafePath(folderKey, category);

        if (!fs.existsSync(safeToFolder)) {
          fs.mkdirSync(safeToFolder, { recursive: true });
        }

        let destFileName = fileName;
        let safeDest = path.join(safeToFolder, destFileName);
        let counter = 1;

        const nameWithoutExt = path.basename(fileName, path.extname(fileName));
        const ext = path.extname(fileName);

        while (fs.existsSync(safeDest)) {
          destFileName = `${nameWithoutExt} (${counter})${ext}`;
          safeDest = path.join(safeToFolder, destFileName);
          counter++;
        }

        try {
          fs.renameSync(safeSource, safeDest);
        } catch (renameErr: any) {
          if (renameErr.code === 'EXDEV') {
            fs.copyFileSync(safeSource, safeDest);
            fs.unlinkSync(safeSource);
          } else {
            throw renameErr;
          }
        }

        results.push({
          file: fileName,
          status: 'moved',
          category,
          from: safeSource,
          to: safeDest
        });

      } catch (fileErr: any) {
        results.push({
          file: item.file || 'desconhecido',
          status: 'error',
          error: fileErr.message
        });
      }
    }

    const movedCount = results.filter(r => r.status === 'moved').length;
    logAudit('INFO', 'ORGANIZE_EXECUTED', `Organização concluída em folderKey=${folderKey}: ${movedCount} movidos de ${results.length}`, {
      folderKey,
      movedCount,
      totalCount: results.length
    });

    return res.status(200).json({
      message: `Organização concluída. ${movedCount} arquivo(s) movidos com sucesso.`,
      folderKey,
      results
    });

  } catch (err: any) {
    logAudit('ERROR', 'ORGANIZE_EXECUTE_FAILED', err.message);
    return res.status(400).json({ error: err.message });
  }
};

/**
 * POST /file/trash
 */
const handleFileTrash = (req: Request, res: Response) => {
  try {
    const { folderKey, fileName } = req.body || {};

    if (!fileName || typeof fileName !== 'string') {
      return res.status(400).json({ error: 'O nome do arquivo (fileName) é obrigatório.' });
    }

    // Aceita qualquer arquivo do computador: caminho absoluto direto em fileName, ou pasta
    // (absoluta/apelido em qualquer idioma) + nome. A jail antiga só aceitava três apelidos em
    // inglês, apontando para pastas que nem existem num sistema em português — motivo real de
    // "não consegue apagar nada". A confirmação por parâmetro também saiu: o dono da máquina
    // concedeu acesso total, e a exclusão é reversível (vai para a lixeira do agente).
    const safeSource = path.isAbsolute(expandHomePath(fileName))
      ? path.resolve(expandHomePath(fileName))
      : path.join(resolveAnyPath(folderKey || 'home'), fileName);

    if (isProtectedInstallPath(safeSource)) {
      logAudit('SECURITY', 'TRASH_BLOCKED_SELF', `Exclusão bloqueada dentro da instalação do OSONE`, { safeSource });
      return res.status(403).json({ error: `Bloqueado: '${safeSource}' faz parte da instalação do OSONE em uso, o único lugar protegido.` });
    }

    if (!fs.existsSync(safeSource)) {
      return res.status(404).json({ error: `Arquivo não encontrado: '${safeSource}'. Use list_path para conferir o caminho real antes de apagar.` });
    }

    if (!fs.existsSync(TRASH_DIR_PATH)) {
      fs.mkdirSync(TRASH_DIR_PATH, { recursive: true });
    }

    const timestampPrefix = `${Date.now()}_`;
    const trashFileName = `${timestampPrefix}${path.basename(fileName)}`;
    const trashDest = path.join(TRASH_DIR_PATH, trashFileName);

    try {
      fs.renameSync(safeSource, trashDest);
    } catch (renameErr: any) {
      if (renameErr.code === 'EXDEV') {
        fs.copyFileSync(safeSource, trashDest);
        fs.unlinkSync(safeSource);
      } else {
        throw renameErr;
      }
    }

    logAudit('INFO', 'FILE_TRASHED', `Arquivo '${fileName}' de '${folderKey}' movido para a lixeira do agente`, {
      folderKey,
      originalName: fileName,
      trashPath: trashDest
    });

    return res.status(200).json({
      message: `Arquivo '${fileName}' movido para a lixeira do agente.`,
      status: 'trashed',
      folderKey,
      originalFile: fileName,
      trashPath: trashDest
    });

  } catch (err: any) {
    logAudit('ERROR', 'FILE_TRASH_FAILED', err.message);
    return res.status(400).json({ error: err.message });
  }
};

/**
 * POST /close-app - Fecha um aplicativo local autorizado na allowlist
 */
const handleCloseApp = (req: Request, res: Response) => {
  const appId = (req.body?.appId || req.body?.appName || '').toString().trim();

  if (!appId) {
    return res.status(400).json({
      error: 'ID/nome do aplicativo (appId) é obrigatório.',
      availableApps: Object.keys(CONFIG.apps || {})
    });
  }

  const appEntry = CONFIG.apps[appId];
  if (!appEntry) {
    logAudit('WARN', 'APP_CLOSE_REJECTED', `Aplicativo '${appId}' não está na allowlist`, { appId });
    return res.status(400).json({
      error: `Aplicativo '${appId}' não existe na allowlist do config.json.`,
      availableApps: Object.keys(CONFIG.apps || {})
    });
  }

  const platformKey = process.platform === 'win32' ? 'win32' : 'linux';
  const processName = appEntry.processName?.[platformKey] || (platformKey === 'win32' ? `${appId}.exe` : appId);

  const command = platformKey === 'win32' 
    ? `taskkill /IM ${processName} /F` 
    : `pkill -f ${processName}`;

  exec(command, (error, stdout, stderr) => {
    if (error) {
      logAudit('ERROR', 'APP_CLOSE_FAILED', `Falha ao fechar app '${appId}' (Processo: ${processName}): ${error.message}`, { command, processName });
    } else {
      logAudit('INFO', 'APP_CLOSE_SUCCESS', `Aplicativo '${appId}' fechado com sucesso (Processo: ${processName})`, { command, processName });
    }
  });

  return res.status(200).json({
    message: `Comando enviado para fechar '${appId}'.`,
    appId,
    processName,
    platform: platformKey
  });
};

/**
 * POST /create-folder - Cria uma subpasta dentro de uma das pastas autorizadas em allowedFolders
 */
const handleCreateFolder = (req: Request, res: Response) => {
  try {
    const { parentFolder, folderName } = req.body || {};

    if (!parentFolder || typeof parentFolder !== 'string') {
      return res.status(400).json({ error: 'Pasta pai (parentFolder) é obrigatória.' });
    }

    if (!folderName || typeof folderName !== 'string') {
      return res.status(400).json({ error: 'Nome da pasta (folderName) é obrigatório.' });
    }

    // Qualquer caminho do computador é aceito (absoluto, com '~', ou apelido de pasta
    // conhecida em português/inglês). A única recusa é escrever dentro da instalação do OSONE.
    const safeFolderPath = path.join(resolveAnyPath(parentFolder), folderName);

    if (isProtectedInstallPath(safeFolderPath)) {
      logAudit('SECURITY', 'FOLDER_CREATE_BLOCKED_SELF', `Criação bloqueada dentro da instalação do OSONE`, { safeFolderPath });
      return res.status(403).json({ error: `Bloqueado: '${safeFolderPath}' fica dentro da instalação do OSONE em uso, o único lugar protegido.` });
    }

    if (!fs.existsSync(safeFolderPath)) {
      fs.mkdirSync(safeFolderPath, { recursive: true });
    }

    logAudit('INFO', 'FOLDER_CREATED', `Pasta '${folderName}' criada com sucesso em '${parentFolder}'`, {
      parentFolder,
      folderName,
      createdPath: safeFolderPath
    });

    return res.status(200).json({
      message: `Pasta '${folderName}' criada com sucesso em '${parentFolder}'.`,
      parentFolder,
      folderName,
      path: safeFolderPath
    });

  } catch (err: any) {
    logAudit('ERROR', 'FOLDER_CREATE_FAILED', err.message);
    return res.status(400).json({ error: err.message });
  }
};

/**
 * POST /write-file - Cria ou escreve um arquivo em uma pasta autorizada em allowedFolders
 */
const handleWriteFile = (req: Request, res: Response) => {
  try {
    const { folder, fileName, content } = req.body || {};

    if (!folder || typeof folder !== 'string' || !folder.trim()) {
      return res.status(400).json({ error: 'O parâmetro folder é obrigatório.' });
    }

    if (!fileName || typeof fileName !== 'string' || !fileName.trim()) {
      return res.status(400).json({ error: 'O parâmetro fileName é obrigatório.' });
    }

    if (content === undefined || content === null) {
      return res.status(400).json({ error: 'O parâmetro content é obrigatório.' });
    }

    const fileContent = String(content);

    // Qualquer pasta do computador serve (caminho absoluto, com '~', ou apelido conhecido em
    // português/inglês). Só a instalação do OSONE é protegida contra escrita.
    const destDir = resolveAnyPath(folder);
    const caminhoValidado = path.join(destDir, fileName);

    if (isProtectedInstallPath(caminhoValidado)) {
      logAudit('SECURITY', 'WRITE_FILE_BLOCKED_SELF', `Escrita bloqueada dentro da instalação do OSONE`, { caminhoValidado });
      return res.status(403).json({ error: `Bloqueado: '${caminhoValidado}' fica dentro da instalação do OSONE em uso, o único lugar protegido.` });
    }

    // Cria a pasta de destino se ainda não existir, para o pedido não falhar por um detalhe.
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    const fileExists = fs.existsSync(caminhoValidado);

    // Escrever arquivo
    fs.writeFileSync(caminhoValidado, fileContent, 'utf8');

    if (fileExists) {
      logAudit('WARN', 'FILE_OVERWRITE', `AÇÃO SENSÍVEL: Arquivo '${fileName}' foi sobrescrito em '${folder}'`, {
        folder,
        fileName,
        path: caminhoValidado,
        contentLength: fileContent.length
      });
    } else {
      logAudit('INFO', 'FILE_CREATE', `Arquivo '${fileName}' criado com sucesso em '${folder}'`, {
        folder,
        fileName,
        path: caminhoValidado,
        contentLength: fileContent.length
      });
    }

    return res.status(200).json({
      message: fileExists
        ? `Arquivo '${fileName}' sobrescrito com sucesso em '${folder}'.`
        : `Arquivo '${fileName}' criado com sucesso em '${folder}'.`,
      folder,
      fileName,
      overwritten: fileExists,
      path: caminhoValidado
    });

  } catch (err: any) {
    logAudit('ERROR', 'WRITE_FILE_FAILED', err.message);
    return res.status(400).json({ error: err.message });
  }
};

/**
 * Um arquivo é texto legível ou é binário?
 *
 * Sem esta checagem, mandar um .png ou um .zip para o modelo despeja megabytes de lixo no
 * contexto dele — caro, inútil, e capaz de estourar o limite de tokens sozinho. O teste do byte
 * zero é o mesmo que o `git` usa para decidir isso, e acerta na prática para todo formato comum.
 */
const pareceBinario = (buffer: Buffer): boolean => {
  const amostra = buffer.subarray(0, 8000);
  return amostra.includes(0);
};

/**
 * Teto de UMA leitura. Não é o teto do arquivo: o que não couber é pedido por faixa de linhas.
 *
 * O primeiro valor (512 KB) foi escolhido de olho no contexto do modelo e não sobreviveu ao caso
 * real mais importante — o próprio App.tsx do OSONE tem 770 KB, então "leia seu próprio código"
 * devolvia dois terços do arquivo e nada avisava que faltava o resto. Ler tudo de uma vez também
 * não é a resposta: 770 KB numa única resposta de ferramenta é contexto queimado à toa.
 *
 * A saída é a faixa de linhas: cada pedido traz um pedaço legível e diz onde parou, e o modelo
 * pede o resto quando precisa. 256 KB por vez é o suficiente para uns 6 mil linhas de código.
 */
const LIMITE_DE_LEITURA_BYTES = 256 * 1024;

/**
 * POST /read-file — LÊ o conteúdo de um arquivo de texto do computador.
 *
 * Existia escrita (`/write-file`) e listagem (`/path/list`), mas não leitura: o OSONE conseguia
 * ACHAR e ABRIR um arquivo, e criar outro por cima, mas nunca ver o que já estava escrito. Na
 * prática isso obrigava o usuário a compartilhar a tela para o modelo ler pela câmera o que
 * poderia simplesmente ter lido do disco — e tornava impossível qualquer edição consciente, já
 * que escrever sem ler antes é sempre sobrescrever às cegas.
 */
const handleReadFile = (req: Request, res: Response) => {
  try {
    const alvo = (req.body?.target || '').toString().trim();
    if (!alvo) return res.status(400).json({ error: "Informe 'target' com o arquivo a ler." });

    const caminho = path.resolve(resolveAnyPath(alvo));
    if (!fs.existsSync(caminho)) {
      return res.status(404).json({ error: `O arquivo '${caminho}' não existe.` });
    }

    const stats = fs.statSync(caminho);
    if (stats.isDirectory()) {
      return res.status(400).json({ error: `'${caminho}' é uma pasta, não um arquivo. Use a ação 'listar' para ver o que há dentro dela.` });
    }

    const buffer = fs.readFileSync(caminho);
    if (pareceBinario(buffer)) {
      return res.status(400).json({
        error: `'${caminho}' é um arquivo binário (${stats.size} bytes), não texto legível. Não há conteúdo de texto para ler.`
      });
    }

    /**
     * O corte é por LINHA, nunca por byte.
     *
     * Cortar no byte 262144 tem duas consequências ruins, e as duas são silenciosas. A primeira é
     * partir um caractere multibyte no meio — em português isso acontece em qualquer "ç" ou "ã"
     * que caia na fronteira, e o modelo recebe um caractere corrompido. A segunda é pior para o
     * uso principal desta rota: a última linha vem pela metade, o modelo a copia achando que é o
     * texto real do arquivo, usa como 'buscar' numa edição, e a edição é recusada por não bater —
     * sem nada indicando que a causa foi o corte da leitura.
     */
    const todasAsLinhas = buffer.toString('utf8').split('\n');
    const total = todasAsLinhas.length;

    const pedidoInicio = Number(req.body?.linhaInicial);
    const pedidoFim = Number(req.body?.linhaFinal);
    const temFaixa = Number.isFinite(pedidoInicio) || Number.isFinite(pedidoFim);

    // Faixa em base 1, como o usuário e os editores contam linhas — não base 0.
    let inicio = Number.isFinite(pedidoInicio) ? Math.max(1, Math.floor(pedidoInicio)) : 1;
    let fim = Number.isFinite(pedidoFim) ? Math.min(total, Math.floor(pedidoFim)) : total;
    if (inicio > total) {
      return res.status(400).json({
        error: `O arquivo tem ${total} linhas; a linha inicial pedida (${inicio}) está além do fim.`,
        totalDeLinhas: total
      });
    }
    if (fim < inicio) fim = total;

    // Mesmo com faixa explícita, o orçamento de bytes vale: pedir 1..999999 num arquivo enorme
    // não pode devolver o arquivo inteiro por um detalhe de formulação.
    const selecionadas: string[] = [];
    let bytes = 0;
    let ultimaLinhaLida = inicio - 1;
    for (let i = inicio; i <= fim; i++) {
      const linha = todasAsLinhas[i - 1] ?? '';
      const custo = Buffer.byteLength(linha, 'utf8') + 1;
      if (bytes + custo > LIMITE_DE_LEITURA_BYTES && selecionadas.length > 0) break;
      selecionadas.push(linha);
      bytes += custo;
      ultimaLinhaLida = i;
    }

    const faltaDepois = ultimaLinhaLida < total;
    const conteudo = selecionadas.join('\n');

    logAudit('INFO', 'FILE_READ', `Arquivo lido: '${caminho}'`, {
      path: caminho, bytes: buffer.length, linhas: `${inicio}-${ultimaLinhaLida}/${total}`
    });

    return res.status(200).json({
      path: caminho,
      content: conteudo,
      sizeBytes: stats.size,
      totalDeLinhas: total,
      linhaInicial: inicio,
      linhaFinal: ultimaLinhaLida,
      truncated: faltaDepois || inicio > 1,
      ...(faltaDepois
        ? {
            aviso: `Você leu as linhas ${inicio} a ${ultimaLinhaLida} de ${total}. O arquivo NÃO acabou aqui. ` +
              `Para continuar, chame 'ler_arquivo' de novo com linhaInicial=${ultimaLinhaLida + 1}. ` +
              `Não conclua nada sobre o que existe ou não no arquivo antes de ler o resto.`
          }
        : temFaixa
          ? { aviso: `Linhas ${inicio} a ${ultimaLinhaLida} de ${total} (fim do arquivo).` }
          : {})
    });
  } catch (err: any) {
    logAudit('ERROR', 'FILE_READ_FAILED', err.message);
    return res.status(500).json({ error: `Não foi possível ler o arquivo: ${err.message}` });
  }
};

/**
 * POST /edit-file — troca um trecho EXATO por outro, preservando o resto do arquivo.
 *
 * A alternativa que existia era reescrever o arquivo inteiro com `/write-file`, o que exige o
 * modelo reproduzir de memória tudo que não queria mudar — e é assim que trabalho alheio some
 * numa "edição". Aqui, o que não foi citado não é tocado.
 *
 * Uma ocorrência ambígua é RECUSADA em vez de resolvida por chute: se o trecho aparece cinco
 * vezes, o modelo não disse qual delas queria, e trocar a primeira é adivinhação silenciosa.
 * A recusa devolve a contagem, para ele reenviar um trecho maior que inclua o contexto único.
 */
const handleEditFile = (req: Request, res: Response) => {
  try {
    const alvo = (req.body?.target || '').toString().trim();
    const buscar = req.body?.search;
    const substituir = req.body?.replace;
    const todas = req.body?.all === true;

    if (!alvo) return res.status(400).json({ error: "Informe 'target' com o arquivo a editar." });
    if (typeof buscar !== 'string' || buscar === '') {
      return res.status(400).json({ error: "Informe 'search' com o trecho exato a ser substituído." });
    }
    if (typeof substituir !== 'string') {
      return res.status(400).json({ error: "Informe 'replace' com o texto que entra no lugar (use string vazia para apagar o trecho)." });
    }

    const caminho = path.resolve(resolveAnyPath(alvo));
    if (!fs.existsSync(caminho)) {
      return res.status(404).json({ error: `O arquivo '${caminho}' não existe.` });
    }
    if (isProtectedInstallPath(caminho)) {
      logAudit('SECURITY', 'EDIT_FILE_BLOCKED_SELF', `Edição bloqueada dentro da instalação do OSONE`, { caminho });
      return res.status(403).json({ error: `Bloqueado: '${caminho}' fica dentro da instalação do OSONE em uso, o único lugar protegido.` });
    }

    const stats = fs.statSync(caminho);
    if (stats.isDirectory()) {
      return res.status(400).json({ error: `'${caminho}' é uma pasta, não um arquivo.` });
    }

    const buffer = fs.readFileSync(caminho);
    if (pareceBinario(buffer)) {
      return res.status(400).json({ error: `'${caminho}' é um arquivo binário; não dá para editar como texto.` });
    }

    const original = buffer.toString('utf8');
    const ocorrencias = original.split(buscar).length - 1;

    if (ocorrencias === 0) {
      return res.status(404).json({
        error: `O trecho procurado não existe em '${caminho}'. Leia o arquivo primeiro (ação 'ler_arquivo') e copie o texto EXATO, com a mesma indentação e quebras de linha.`
      });
    }
    if (ocorrencias > 1 && !todas) {
      return res.status(409).json({
        error: `O trecho aparece ${ocorrencias} vezes em '${caminho}' — não dá para saber qual você quer. Envie um trecho maior, que inclua as linhas em volta e seja único, ou passe 'todas=true' para trocar todas as ocorrências.`,
        ocorrencias
      });
    }

    const novo = todas ? original.split(buscar).join(substituir) : original.replace(buscar, substituir);
    fs.writeFileSync(caminho, novo, 'utf8');

    logAudit('WARN', 'FILE_EDIT', `AÇÃO SENSÍVEL: arquivo '${caminho}' editado`, {
      path: caminho, ocorrencias: todas ? ocorrencias : 1, bytesAntes: original.length, bytesDepois: novo.length
    });

    return res.status(200).json({
      success: true,
      path: caminho,
      substituicoes: todas ? ocorrencias : 1,
      message: `Arquivo '${path.basename(caminho)}' editado: ${todas ? ocorrencias : 1} trecho(s) substituído(s). O resto do arquivo ficou intacto.`
    });
  } catch (err: any) {
    logAudit('ERROR', 'FILE_EDIT_FAILED', err.message);
    return res.status(500).json({ error: `Não foi possível editar o arquivo: ${err.message}` });
  }
};

/**
 * SERVIDORES DE PREVIEW — "abre isso num localhost".
 *
 * Um jogo ou site gerado precisa rodar em http:// de verdade, não em file://: módulos ES, fetch,
 * canvas com textura e praticamente todo import moderno são bloqueados pelo navegador na origem
 * file://, e o resultado é uma página em branco que parece código quebrado sem ser.
 *
 * Servido pelo http nativo do Node, de propósito: `python -m http.server` não existe em toda
 * máquina Windows e `npx serve` exige rede e download na primeira vez — os dois falham justamente
 * no computador de quem só quer ver o jogo abrir.
 */
const servidoresDePreview = new Map<string, { servidor: http.Server; porta: number; pasta: string }>();

const TIPOS_POR_EXTENSAO: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp4': 'video/mp4',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8'
};

/**
 * POST /serve-folder — sobe (ou reaproveita) um servidor estático para uma pasta.
 *
 * Só escuta em 127.0.0.1: um servidor de arquivos aberto em 0.0.0.0 exporia a pasta inteira para
 * a rede local, e isso não é o que alguém pede ao dizer "abre num localhost".
 */
const handleServeFolder = async (req: Request, res: Response) => {
  try {
    const alvo = (req.body?.folder || '').toString().trim();
    if (!alvo) return res.status(400).json({ error: "Informe 'folder' com a pasta a servir." });

    const pasta = path.resolve(resolveAnyPath(alvo));
    if (!fs.existsSync(pasta) || !fs.statSync(pasta).isDirectory()) {
      return res.status(404).json({ error: `A pasta '${pasta}' não existe.` });
    }

    const jaAberto = servidoresDePreview.get(pasta);
    if (jaAberto) {
      return res.status(200).json({ url: `http://127.0.0.1:${jaAberto.porta}`, porta: jaAberto.porta, pasta, reaproveitado: true });
    }

    const servidor = http.createServer((requisicao, resposta) => {
      try {
        const caminhoPedido = decodeURIComponent((requisicao.url || '/').split('?')[0]);
        // path.join normaliza ".." — comparar o resultado com a raiz é o que impede
        // "GET /../../.ssh/id_rsa" de sair da pasta servida.
        const destino = path.join(pasta, caminhoPedido);
        if (destino !== pasta && !destino.startsWith(pasta + path.sep)) {
          resposta.writeHead(403); return resposta.end('Fora da pasta servida.');
        }
        let arquivo = destino;
        if (fs.existsSync(arquivo) && fs.statSync(arquivo).isDirectory()) arquivo = path.join(arquivo, 'index.html');
        if (!fs.existsSync(arquivo)) {
          resposta.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          return resposta.end(`Não encontrado: ${caminhoPedido}`);
        }
        resposta.writeHead(200, { 'Content-Type': TIPOS_POR_EXTENSAO[path.extname(arquivo).toLowerCase()] || 'application/octet-stream' });
        return resposta.end(fs.readFileSync(arquivo));
      } catch (e: any) {
        resposta.writeHead(500); return resposta.end(String(e?.message || e));
      }
    });

    const porta: number = await new Promise((resolve, reject) => {
      servidor.on('error', reject);
      // Porta 0 = o sistema escolhe uma livre. Fixar um número daria conflito com o que já
      // estivesse ocupando aquela porta na máquina do usuário.
      servidor.listen(0, '127.0.0.1', () => resolve((servidor.address() as any).port));
    });

    servidoresDePreview.set(pasta, { servidor, porta, pasta });
    logAudit('INFO', 'PREVIEW_SERVER', `Servidor de preview aberto para '${pasta}'`, { pasta, porta });

    return res.status(200).json({ url: `http://127.0.0.1:${porta}`, porta, pasta, reaproveitado: false });
  } catch (err: any) {
    return res.status(500).json({ error: `Não foi possível abrir o servidor local: ${err.message}` });
  }
};

/**
 * POST /check-project — procura, numa pasta de projeto estático, os defeitos que deixam a
 * página EM BRANCO.
 *
 * Isto não julga se o jogo é divertido nem se o código é bonito: é uma checagem determinística,
 * sem modelo nenhum envolvido, dos três jeitos mais comuns de um projeto gerado nascer morto —
 * e os três se parecem exatamente igual para o usuário (tela preta, sem mensagem):
 *
 *   1. JS COM ERRO DE SINTAXE. É o efeito clássico da resposta cortada no meio do arquivo: uma
 *      chave que não fecha e o navegador não executa NADA daquele script.
 *   2. FALTA index.html. Sem ele o servidor devolve 404 na raiz.
 *   3. REFERÊNCIA A ARQUIVO QUE NÃO EXISTE. O html chama "game.js" e o modelo gravou "main.js";
 *      a página carrega vazia e o erro fica escondido no console.
 *
 * O que ele NÃO pega: bug de lógica, jogo injogável, física errada. Para isso não há atalho
 * honesto sem de fato rodar o jogo — e dizer que pega seria pior do que não ter a checagem.
 */
const erroDeSintaxeNoJs = (codigo: string, nome: string): string | null => {
  /**
   * `new vm.Script` compila sem executar nada — é a checagem de sintaxe do próprio Node, sem
   * rodar uma linha do jogo. A ressalva é que ela usa a gramática de script clássico, onde
   * `import`/`export` de topo são inválidos por definição; um projeto moderno perfeitamente
   * correto seria reprovado por isso. Por isso o módulo é compilado embrulhado numa função
   * assíncrona, forma que aceita a sintaxe de módulo e ainda pega chave sem fechar — que é o
   * defeito real atrás de uma resposta cortada.
   */
  const tentar = (fonte: string): string | null => {
    try { new vm.Script(fonte, { filename: nome }); return null; }
    catch (e: any) { return e?.message || String(e); }
  };
  const direto = tentar(codigo);
  if (!direto) return null;
  if (!/^\s*(import|export)\s/m.test(codigo)) return direto;
  return tentar(`(async () => {\n${codigo.replace(/^\s*(import|export)\b.*$/gm, '')}\n})`);
};

const handleCheckProject = (req: Request, res: Response) => {
  try {
    const alvo = (req.body?.folder || '').toString().trim();
    if (!alvo) return res.status(400).json({ error: "Informe 'folder' com a pasta do projeto." });

    const pasta = path.resolve(resolveAnyPath(alvo));
    if (!fs.existsSync(pasta) || !fs.statSync(pasta).isDirectory()) {
      return res.status(404).json({ error: `A pasta '${pasta}' não existe.` });
    }

    const problemas: Array<{ arquivo: string; problema: string }> = [];

    const listarRecursivo = (dir: string, prefixo = ''): string[] => {
      const saida: string[] = [];
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        if (item.name === 'node_modules' || item.name.startsWith('.')) continue;
        const rel = prefixo ? `${prefixo}/${item.name}` : item.name;
        if (item.isDirectory()) saida.push(...listarRecursivo(path.join(dir, item.name), rel));
        else saida.push(rel);
      }
      return saida;
    };

    const arquivos = listarRecursivo(pasta);

    if (!arquivos.some(a => a.toLowerCase() === 'index.html')) {
      problemas.push({ arquivo: 'index.html', problema: "Não existe um 'index.html' na raiz do projeto — o servidor não tem o que abrir." });
    }

    for (const rel of arquivos) {
      const completo = path.join(pasta, rel);
      const ext = path.extname(rel).toLowerCase();

      if (ext === '.js' || ext === '.mjs') {
        const codigo = fs.readFileSync(completo, 'utf8');
        const erro = erroDeSintaxeNoJs(codigo, rel);
        if (erro) problemas.push({ arquivo: rel, problema: `Erro de sintaxe no JavaScript: ${erro}` });
      }

      if (ext === '.html') {
        const html = fs.readFileSync(completo, 'utf8');
        const referencias = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
        for (const ref of referencias) {
          // Só referências locais: http(s), //cdn, data: e âncoras não são arquivos desta pasta.
          if (/^(https?:)?\/\//i.test(ref) || ref.startsWith('data:') || ref.startsWith('#') || ref.startsWith('mailto:')) continue;
          const limpo = ref.split('?')[0].split('#')[0].replace(/^\.?\//, '');
          if (!limpo) continue;
          if (!fs.existsSync(path.join(pasta, limpo))) {
            problemas.push({ arquivo: rel, problema: `Aponta para '${ref}', que não existe na pasta do projeto.` });
          }
        }
      }
    }

    return res.status(200).json({
      pasta,
      arquivos,
      ok: problemas.length === 0,
      problemas,
      resumo: problemas.length === 0
        ? `Nenhum defeito estrutural: ${arquivos.length} arquivo(s), JavaScript sem erro de sintaxe e nenhuma referência quebrada.`
        : `${problemas.length} problema(s) que impediriam o projeto de abrir.`
    });
  } catch (err: any) {
    return res.status(500).json({ error: `Não foi possível conferir o projeto: ${err.message}` });
  }
};

/**
 * GET /audit/logs
 */
const handleAuditLogs = (req: Request, res: Response) => {
  try {
    if (!fs.existsSync(AUDIT_LOG_PATH)) {
      return res.status(200).json({ logs: [] });
    }

    const content = fs.readFileSync(AUDIT_LOG_PATH, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    const lastLines = lines.slice(-100);

    return res.status(200).json({ logs: lastLines });
  } catch (err) {
    return res.status(500).json({ error: 'Falha ao ler audit.log' });
  }
};

// ============================================================================
// SEÇÃO 6: ABRIR QUALQUER APP/ARQUIVO/PASTA/URL SEM PRECISAR DE ALLOWLIST
// ============================================================================

function runShell(
  cmd: string,
  timeoutMs: number = 10000,
  cwd: string = USER_HOME_DIR,
  /**
   * Ambiente do processo. Existe por causa da ÁREA PARALELA: o que decide se um comando age na
   * tela do usuário ou na tela do agente é uma única variável (DISPLAY), e ela viaja pelo
   * ambiente. Sem este parâmetro, todo comando gráfico iria para a tela de quem está usando o
   * computador — que é exatamente o que a área paralela existe para evitar.
   */
  env: NodeJS.ProcessEnv = process.env
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const workingDir = fs.existsSync(cwd) ? cwd : USER_HOME_DIR;
    exec(cmd, { timeout: timeoutMs, windowsHide: true, cwd: workingDir, env }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr?.toString().trim() || error.message));
      resolve({ stdout: stdout?.toString() || '', stderr: stderr?.toString() || '' });
    });
  });
}

/**
 * Como runShell, mas roda o binário direto (sem passar por um shell), com argumentos como
 * array. Usado quando o texto envolvido vem de linguagem natural do usuário/IA e não pode ser
 * interpolado numa string de comando de shell (aspas, '$()', ';' etc. quebrariam o comando ou,
 * pior, seriam interpretados como injeção de shell).
 */
function execFileShellSafe(
  bin: string,
  args: string[],
  timeoutMs: number = 10000,
  maxBuffer: number = 1024 * 1024,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer, env }, (error: any, stdout, stderr) => {
      if (error) {
        /**
         * A mensagem do erro vem do PRÓPRIO erro; o stderr entra só como contexto.
         *
         * Antes o stderr tinha prioridade, e programas que escrevem avisos inofensivos ali
         * faziam o aviso se passar pela causa da falha. O resultado era uma mensagem que parecia
         * diagnóstico e apontava para o lugar errado, escondendo o motivo real (tempo esgotado,
         * buffer estourado).
         */
        const e: any = new Error(error.killed ? `tempo esgotado após ${timeoutMs}ms` : error.message);
        e.code = error.code || (error.killed ? 'ETIMEDOUT' : undefined);
        e.saidaDeErro = stderr?.toString().trim() || '';
        e.encerradoPorTempo = !!error.killed;
        return reject(e);
      }
      resolve({ stdout: stdout?.toString() || '', stderr: stderr?.toString() || '' });
    });
  });
}

/**
 * Nomes "conceito" de aplicativo (o jeito que um usuário ou a IA naturalmente pede, ex:
 * "notepad", "explorer", "calculadora") mapeados para candidatos reais por plataforma. Sem
 * isso, um pedido para abrir o "notepad" ou o "explorer" em uma máquina Linux tentaria abrir
 * literalmente um arquivo com esse nome (que não existe) em vez do editor de texto ou
 * gerenciador de arquivos equivalente. No Linux, onde não existe um único programa padrão
 * garantido, tenta uma lista de candidatos comuns em ordem até um deles existir no PATH.
 */
const APP_CONCEPT_ALIASES: Record<string, { win32: string; darwin: string; linux: string[] }> = {
  notepad: { win32: 'notepad', darwin: 'open -e', linux: ['gedit', 'gnome-text-editor', 'kate', 'xed', 'mousepad', 'leafpad'] },
  texteditor: { win32: 'notepad', darwin: 'open -e', linux: ['gedit', 'gnome-text-editor', 'kate', 'xed', 'mousepad', 'leafpad'] },
  bloco_de_notas: { win32: 'notepad', darwin: 'open -e', linux: ['gedit', 'gnome-text-editor', 'kate', 'xed', 'mousepad', 'leafpad'] },
  notas: { win32: 'notepad', darwin: 'open -e', linux: ['gedit', 'gnome-text-editor', 'kate', 'xed', 'mousepad', 'leafpad'] },
  explorer: { win32: 'explorer', darwin: 'open', linux: ['nautilus', 'dolphin', 'pcmanfm', 'thunar', 'nemo', 'xdg-open'] },
  filemanager: { win32: 'explorer', darwin: 'open', linux: ['nautilus', 'dolphin', 'pcmanfm', 'thunar', 'nemo', 'xdg-open'] },
  gerenciador_de_arquivos: { win32: 'explorer', darwin: 'open', linux: ['nautilus', 'dolphin', 'pcmanfm', 'thunar', 'nemo', 'xdg-open'] },
  calculator: { win32: 'calc', darwin: 'open -a Calculator', linux: ['gnome-calculator', 'kcalc', 'qalculate-gtk', 'xcalc'] },
  calculadora: { win32: 'calc', darwin: 'open -a Calculator', linux: ['gnome-calculator', 'kcalc', 'qalculate-gtk', 'xcalc'] },
  terminal: { win32: 'start cmd', darwin: 'open -a Terminal', linux: ['gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'] },
  chrome: { win32: 'chrome', darwin: 'open -a "Google Chrome"', linux: ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'] },
  google_chrome: { win32: 'chrome', darwin: 'open -a "Google Chrome"', linux: ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'] },
  navegador: { win32: 'https://google.com', darwin: 'open https://google.com', linux: ['xdg-open https://google.com', 'google-chrome-stable https://google.com', 'firefox https://google.com'] },
  browser: { win32: 'https://google.com', darwin: 'open https://google.com', linux: ['xdg-open https://google.com', 'google-chrome-stable https://google.com', 'firefox https://google.com'] },
  edge: { win32: 'msedge', darwin: 'open -a "Microsoft Edge"', linux: ['microsoft-edge', 'microsoft-edge-stable'] },
  firefox: { win32: 'firefox', darwin: 'open -a Firefox', linux: ['firefox'] },
  vscode: { win32: 'code', darwin: 'code', linux: ['code', 'codium'] },
  vs_code: { win32: 'code', darwin: 'code', linux: ['code', 'codium'] },
  code: { win32: 'code', darwin: 'code', linux: ['code', 'codium'] },
  visual_studio_code: { win32: 'code', darwin: 'code', linux: ['code', 'codium'] },
  whatsapp: { win32: 'WhatsApp', darwin: 'open -a WhatsApp', linux: ['whatsapp-for-linux', 'xdg-open https://web.whatsapp.com'] },
  spotify: { win32: 'spotify:', darwin: 'open -a Spotify', linux: ['spotify'] },
};

/**
 * Aliases que abrem "um lugar" (gerenciador de arquivos, terminal) e portanto recebem um
 * caminho. Antes eles usavam "." — o diretório do processo, que no app empacotado é a pasta do
 * próprio OSONE, e era exatamente por isso que o terminal e o explorador abriam sempre dentro
 * da pasta do app em vez do lugar pedido.
 */
const LOCATION_ALIASES = new Set(['explorer', 'filemanager', 'gerenciador_de_arquivos', 'terminal']);

type AppDetectado = { nome: string; origem: string; caminho?: string; comando?: string };

function normalizarNomeDeApp(nome: string): string {
  return String(nome || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\.(lnk|url|desktop|exe|appimage)$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function caminhoExiste(caminho: string): boolean {
  try { return fs.existsSync(caminho); } catch { return false; }
}

function listarRecursivoLimitado(
  raiz: string,
  aceitar: (arquivo: string) => boolean,
  limite = 500,
  profundidadeMaxima = 5
): string[] {
  const achados: string[] = [];
  const visitar = (dir: string, profundidade: number) => {
    if (achados.length >= limite || profundidade > profundidadeMaxima || !caminhoExiste(dir)) return;
    let itens: fs.Dirent[] = [];
    try { itens = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of itens) {
      if (achados.length >= limite) break;
      const caminho = path.join(dir, item.name);
      if (item.isDirectory()) visitar(caminho, profundidade + 1);
      else if (item.isFile() && aceitar(caminho)) achados.push(caminho);
    }
  };
  visitar(raiz, 0);
  return achados;
}

function pastasDoStartMenuWindows(): string[] {
  return [
    process.env.ProgramData ? path.join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : '',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs') : '',
  ].filter(Boolean);
}

function atalhosWindows(): AppDetectado[] {
  if (process.platform !== 'win32') return [];
  const out: AppDetectado[] = [];
  for (const pasta of pastasDoStartMenuWindows()) {
    for (const arquivo of listarRecursivoLimitado(pasta, p => /\.(lnk|url)$/i.test(p), 700, 8)) {
      out.push({ nome: path.basename(arquivo).replace(/\.(lnk|url)$/i, ''), origem: 'start-menu', caminho: arquivo });
    }
  }
  return out;
}

function executaveisWindowsBasicos(): AppDetectado[] {
  if (process.platform !== 'win32') return [];
  const raizes = [
    process.env.ProgramFiles || '',
    process.env['ProgramFiles(x86)'] || '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : '',
  ].filter(Boolean);
  const out: AppDetectado[] = [];
  for (const raiz of raizes) {
    for (const arquivo of listarRecursivoLimitado(raiz, p => /\.exe$/i.test(p), 900, 4)) {
      const base = path.basename(arquivo, '.exe');
      // Evita poluir o contexto com helpers/uninstallers que o usuário não chama como app.
      if (/^(unins|uninstall|setup|update|crash|helper|elevate|service|broker)/i.test(base)) continue;
      out.push({ nome: base, origem: 'program-files', caminho: arquivo });
    }
  }
  return out;
}

function appsDesktopLinux(): AppDetectado[] {
  if (process.platform !== 'linux') return [];
  const pastas = [
    '/usr/share/applications',
    '/var/lib/flatpak/exports/share/applications',
    path.join(USER_HOME_DIR, '.local/share/applications'),
    path.join(USER_HOME_DIR, '.local/share/flatpak/exports/share/applications'),
  ];
  const out: AppDetectado[] = [];
  for (const pasta of pastas) {
    for (const arquivo of listarRecursivoLimitado(pasta, p => /\.desktop$/i.test(p), 700, 2)) {
      try {
        const texto = fs.readFileSync(arquivo, 'utf8');
        const nome = texto.match(/^Name(?:\[pt_BR\]|\[pt\])?=(.+)$/m)?.[1]
          || texto.match(/^Name=(.+)$/m)?.[1]
          || path.basename(arquivo, '.desktop');
        const execLinha = texto.match(/^Exec=(.+)$/m)?.[1]?.replace(/%[fFuUdDnNickvm]/g, '').trim();
        out.push({ nome, origem: 'desktop-entry', caminho: arquivo, comando: execLinha });
      } catch { /* ignora entrada quebrada */ }
    }
  }
  return out;
}

let cacheAppsInstalados: { quando: number; platform: NodeJS.Platform; apps: AppDetectado[] } | null = null;

function listarAppsInstalados(): AppDetectado[] {
  if (cacheAppsInstalados && cacheAppsInstalados.platform === process.platform && Date.now() - cacheAppsInstalados.quando < 60_000) {
    return cacheAppsInstalados.apps;
  }
  const configurados: AppDetectado[] = Object.keys(CONFIG.apps || {}).map(nome => ({ nome, origem: 'config' }));
  const aliases: AppDetectado[] = Object.keys(APP_CONCEPT_ALIASES).map(nome => ({ nome: nome.replace(/_/g, ' '), origem: 'alias' }));
  const detectados = process.platform === 'win32'
    ? [...atalhosWindows(), ...executaveisWindowsBasicos()]
    : process.platform === 'linux'
      ? appsDesktopLinux()
      : [];
  const vistos = new Set<string>();
  const apps = [...configurados, ...aliases, ...detectados].filter(app => {
    const chave = `${normalizarNomeDeApp(app.nome)}|${app.origem}|${app.caminho || app.comando || ''}`;
    if (!normalizarNomeDeApp(app.nome) || vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
  cacheAppsInstalados = { quando: Date.now(), platform: process.platform, apps };
  return apps;
}

function encontrarAppDetectado(alvo: string): AppDetectado | null {
  const procurado = normalizarNomeDeApp(alvo);
  if (!procurado) return null;
  const apps = listarAppsInstalados();
  return apps.find(a => normalizarNomeDeApp(a.nome) === procurado)
    || apps.find(a => normalizarNomeDeApp(a.nome).includes(procurado))
    || apps.find(a => procurado.includes(normalizarNomeDeApp(a.nome)));
}

function limparNomeExecutavel(alvo: string): string {
  return String(alvo || '').trim().replace(/[&|<>^"`;$]/g, '').split(/\s+/)[0];
}

function quoteCmdArg(valor: string): string {
  return `"${String(valor).replace(/"/g, '""')}"`;
}

function quotePosixArg(valor: string): string {
  return `'${String(valor).replace(/'/g, `'\\''`)}'`;
}

/** Verifica rapidamente (comando que sempre retorna na hora) se um binário existe no PATH. */
function binaryExists(binary: string): Promise<boolean> {
  const clean = limparNomeExecutavel(binary);
  if (!clean) return Promise.resolve(false);
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('where.exe', [clean], { timeout: 2000, windowsHide: true }, (error) => resolve(!error));
    });
  }
  return new Promise((resolve) => {
    exec(`command -v ${quotePosixArg(clean)}`, { timeout: 2000 }, (error) => resolve(!error));
  });
}

/**
 * Abre um endereço numa instância PRÓPRIA do navegador, na tela do agente.
 *
 * A decisão de QUAL navegador e com QUE argumentos mora em lib/navegadorDoAgente.ts, junto com a
 * explicação de por que um perfil separado é obrigatório aqui. Este trecho só lança.
 */
async function abrirEnderecoNaAreaDoAgente(url: string): Promise<{ navegador: string } | { error: string }> {
  const perfil = path.join(os.tmpdir(), NOME_DO_PERFIL);
  try { fs.mkdirSync(perfil, { recursive: true }); } catch { /* já existe, ou sem permissão — o navegador reclama e dizemos qual foi */ }

  const endereco = normalizarEndereco(url);

  for (const navegador of NAVEGADORES_DO_AGENTE) {
    if (!(await binaryExists(navegador.bin))) continue;
    const filho = spawn(navegador.bin, navegador.argumentos(perfil, endereco), {
      detached: true, stdio: 'ignore', env: ambienteGrafico(), cwd: USER_HOME_DIR
    });
    filho.unref();
    return { navegador: navegador.bin };
  }
  return {
    error: `Nenhum navegador encontrado para abrir na tela do agente (procurei: ${NAVEGADORES_DO_AGENTE.map(n => n.bin).join(', ')}). ` +
      `Instale um deles, ou desligue a tela do agente para usar o navegador padrão do sistema.`
  };
}

function launchDetached(command: string, cwd: string = USER_HOME_DIR): void {
  const workingDir = fs.existsSync(cwd) ? cwd : USER_HOME_DIR;
  /**
   * O ambiente gráfico vai junto, e é ISTO que faz o programa nascer na tela do agente em vez da
   * sua. Abrir é o único momento em que se decide de que lado a janela vai existir: depois de
   * aberta, ela não muda de servidor gráfico.
   */
  const child = spawn(command, {
    shell: true, detached: true, stdio: 'ignore', cwd: workingDir, env: ambienteGrafico()
  });
  child.unref();
}

/**
 * Tenta, em ordem, cada candidato de comando cujo binário existe no PATH, e lança o primeiro
 * encontrado em segundo plano (sem esperar ele fechar).
 */
async function tryCommandsInOrder(commands: string[], cwd: string = USER_HOME_DIR): Promise<{ command: string }> {
  for (const cmd of commands) {
    const binary = cmd.split(' ')[0];
    if (await binaryExists(binary)) {
      launchDetached(cmd, cwd);
      return { command: cmd };
    }
  }
  throw new Error(`Nenhum dos programas testados está instalado (${commands.join(', ')}).`);
}

async function rodarPrimeiroQueFuncionar(commands: string[], cwd: string = USER_HOME_DIR): Promise<{ command: string; tentativas: string[] }> {
  const tentativas: string[] = [];
  let ultimoErro = '';
  for (const command of commands.filter(Boolean)) {
    tentativas.push(command);
    try {
      await runShell(command, 5000, cwd, ambienteGrafico());
      return { command, tentativas };
    } catch (err: any) {
      ultimoErro = err?.message || String(err);
    }
  }
  throw new Error(`Nenhuma forma de abertura funcionou. Tentativas: ${tentativas.join(' | ')}${ultimoErro ? `. Último erro: ${ultimoErro}` : ''}`);
}

async function abrirAppDetectado(app: AppDetectado, alvo: string): Promise<{ command: string; appDetectado: AppDetectado; tentativas: string[] }> {
  const platform = process.platform;
  if (platform === 'win32') {
    if (app.caminho) {
      const command = `start "" ${quoteCmdArg(app.caminho)}`;
      const r = await rodarPrimeiroQueFuncionar([command], USER_HOME_DIR);
      return { ...r, appDetectado: app };
    }
  } else if (platform === 'linux') {
    if (app.caminho?.endsWith('.desktop')) {
      const id = path.basename(app.caminho);
      const tentativas = [];
      if (await binaryExists('gtk-launch')) tentativas.push(`gtk-launch ${quotePosixArg(id.replace(/\.desktop$/i, ''))}`);
      if (app.comando) tentativas.push(app.comando.replace(/[;&|`$<>]/g, '').trim());
      const r = await rodarPrimeiroQueFuncionar(tentativas, USER_HOME_DIR);
      return { ...r, appDetectado: app };
    }
    if (app.comando) {
      const r = await rodarPrimeiroQueFuncionar([app.comando.replace(/[;&|`$<>]/g, '').trim()], USER_HOME_DIR);
      return { ...r, appDetectado: app };
    }
  }
  throw new Error(`Encontrei '${app.nome}' (${app.origem}), mas não consegui montar um comando seguro para abrir.`);
}

async function abrirAlvoUniversal(targetRaw: string, pathRaw?: string): Promise<any> {
  const target = String(targetRaw || '').trim();
  if (!target) throw new Error("Parâmetro 'target' é obrigatório (nome de app, caminho de arquivo/pasta ou URL).");

  const platform = process.platform;
  const conceptKey = target.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '_');
  const alias = APP_CONCEPT_ALIASES[conceptKey];

  const requestedPath = pathRaw ? resolverCaminhoDetalhado(String(pathRaw)) : null;
  const openAtDir = requestedPath?.existe ? requestedPath.caminho : USER_HOME_DIR;

  if (areaParalela && ehEndereco(target)) {
    const r = await abrirEnderecoNaAreaDoAgente(target);
    if ('error' in r) throw new Error(r.error);
    logAudit('INFO', 'OPEN_ANY_SUCCESS', `'${target}' aberto na área do agente via ${r.navegador}`, { target, navegador: r.navegador });
    return {
      message: `'${target}' aberto na tela do agente (${r.navegador}).`,
      target,
      navegador: r.navegador,
      resumo: `Abri "${target}" numa janela própria do ${r.navegador}, na sua tela. Ela pode levar alguns segundos para aparecer.`
    };
  }

  if (alias) {
    const isLocationAlias = LOCATION_ALIASES.has(conceptKey);
    if (platform === 'linux') {
      const candidates = (conceptKey === 'terminal' || !isLocationAlias)
        ? alias.linux
        : alias.linux.map(bin => `${bin} ${quotePosixArg(openAtDir)}`);
      const { command } = await tryCommandsInOrder(candidates, openAtDir);
      logAudit('INFO', 'OPEN_ANY_SUCCESS', `'${target}' aberto com sucesso via alias`, { target, command, cwd: openAtDir });
      return { message: `'${target}' aberto com sucesso.`, target, path: isLocationAlias ? openAtDir : undefined, command };
    }

    const command = platform === 'win32'
      ? conceptKey === 'terminal'
        ? `start "" cmd /K "cd /d ${quoteCmdArg(openAtDir)}"`
        : isLocationAlias
          ? `start "" ${alias.win32} ${quoteCmdArg(openAtDir)}`
          : `start "" ${alias.win32}`
      : isLocationAlias ? `${alias.darwin} ${quoteCmdArg(openAtDir)}` : `${alias.darwin}`;
    await runShell(command, 4000, USER_HOME_DIR, ambienteGrafico());
    logAudit('INFO', 'OPEN_ANY_SUCCESS', `'${target}' aberto com sucesso via alias`, { target, command, cwd: openAtDir });
    return { message: `'${target}' aberto com sucesso.`, target, path: isLocationAlias ? openAtDir : undefined, command };
  }

  const resolvido = resolverCaminhoDetalhado(target);
  const expandedTarget = resolvido.existe ? resolvido.caminho : expandHomePath(target);

  if (resolvido.existe || ehEndereco(target)) {
    const command = platform === 'win32'
      ? `start "" ${quoteCmdArg(expandedTarget)}`
      : platform === 'darwin'
        ? `open ${quotePosixArg(expandedTarget)}`
        : `xdg-open ${quotePosixArg(expandedTarget)}`;
    await runShell(command, 4000, USER_HOME_DIR, ambienteGrafico());
    logAudit('INFO', 'OPEN_ANY_SUCCESS', `'${target}' aberto com sucesso`, { target, command, resolvido: expandedTarget });
    return {
      message: `'${target}' aberto com sucesso.`,
      target,
      caminhoUsado: expandedTarget,
      command,
      resumo: resolvido.comoResolveu ? `${resolvido.comoResolveu} Abri "${expandedTarget}".` : undefined
    };
  }

  const detectado = encontrarAppDetectado(target);
  if (detectado && detectado.origem !== 'alias' && detectado.origem !== 'config') {
    const r = await abrirAppDetectado(detectado, target);
    logAudit('INFO', 'OPEN_ANY_SUCCESS', `'${target}' aberto como app detectado`, { target, detectado, command: r.command });
    return {
      message: `'${target}' aberto como aplicativo instalado.`,
      target,
      command: r.command,
      tentativas: r.tentativas,
      appDetectado: detectado
    };
  }

  const nomeDeBinario = limparNomeExecutavel(target);
  const tentativas: string[] = [];
  if (nomeDeBinario && pareceNomeDePrograma(target)) {
    if (platform === 'win32') {
      if (await binaryExists(nomeDeBinario)) tentativas.push(`start "" ${quoteCmdArg(nomeDeBinario)}`);
      if (!nomeDeBinario.toLowerCase().endsWith('.exe') && await binaryExists(`${nomeDeBinario}.exe`)) {
        tentativas.push(`start "" ${quoteCmdArg(`${nomeDeBinario}.exe`)}`);
      }
      // App Execution Alias / protocolo / Store apps: mesmo sem aparecer no PATH, o shell do
      // Windows pode resolver. Fica por último porque "start" às vezes abre uma busca se o nome
      // estiver errado; primeiro tentamos PATH/atalhos/Program Files.
      tentativas.push(`start "" ${quoteCmdArg(nomeDeBinario)}`);
    } else if (platform === 'linux') {
      if (await binaryExists(nomeDeBinario)) tentativas.push(`${nomeDeBinario}`);
    } else {
      tentativas.push(`open -a ${quoteCmdArg(target)}`);
    }
  }

  if (tentativas.length) {
    const r = await rodarPrimeiroQueFuncionar(tentativas, USER_HOME_DIR);
    logAudit('INFO', 'OPEN_ANY_SUCCESS', `'${target}' aberto como programa por fallback`, { target, command: r.command });
    return { message: `'${target}' aberto como aplicativo.`, target, command: r.command, tentativas: r.tentativas };
  }

  const amostra = listarAppsInstalados().slice(0, 60).map(a => a.nome);
  throw new Error(`Não reconheci '${target}' como URL, caminho, pasta ou aplicativo instalado. Apps detectados: ${amostra.join(', ') || 'nenhum'}`);
}

/**
 * POST /open-any - Abre QUALQUER app instalado, arquivo, pasta ou URL pelo nome/caminho,
 * sem precisar estar pré-cadastrado em config.json (diferente de /open-app, que só abre
 * apps da allowlist). Usa os abridores nativos do sistema operacional, com tradução de
 * nomes-conceito de app (ex: 'notepad', 'explorer') para o equivalente real da plataforma.
 */
const handleOpenAny = async (req: Request, res: Response) => {
  try {
    const r = await abrirAlvoUniversal(req.body?.target, req.body?.path);
    return res.status(200).json(r);
  } catch (error: any) {
    const target = (req.body?.target || '').toString().trim();
    logAudit('ERROR', 'OPEN_ANY_FAILED', `Falha ao abrir '${target}': ${error.message}`, { target });
    return res.status(500).json({
      error: `Não foi possível abrir '${target}': ${error.message}`,
      installedApps: listarAppsInstalados().slice(0, 80)
    });
  }
};

// ============================================================================
// SEÇÃO 7: CONTROLE DE VOLUME DO SISTEMA
// ============================================================================

/**
 * POST /volume - Ajusta o volume do sistema. action: 'set' | 'up' | 'down' | 'mute' | 'unmute'.
 * 'set' exige 'value' (0-100). No Windows, 'set' é melhor esforço (usa nircmd se disponível
 * no PATH; caso contrário, aproxima com passos relativos), já que ajustar volume para um
 * valor exato ali normalmente depende de uma ferramenta externa. up/down/mute são sempre
 * confiáveis em qualquer plataforma suportada.
 */
const handleSetVolume = async (req: Request, res: Response) => {
  const action = (req.body?.action || '').toString();
  const value = req.body?.value;
  const platform = process.platform;

  if (!['set', 'up', 'down', 'mute', 'unmute'].includes(action)) {
    return res.status(400).json({ error: "Parâmetro 'action' deve ser 'set', 'up', 'down', 'mute' ou 'unmute'." });
  }
  if (action === 'set' && (value === undefined || isNaN(Number(value)))) {
    return res.status(400).json({ error: "Ação 'set' exige o parâmetro numérico 'value' (0-100)." });
  }

  try {
    if (platform === 'darwin') {
      if (action === 'set') {
        const v = Math.max(0, Math.min(100, Math.round(Number(value))));
        await runShell(`osascript -e "set volume output volume ${v}"`);
      } else if (action === 'mute') {
        await runShell(`osascript -e "set volume output muted true"`);
      } else if (action === 'unmute') {
        await runShell(`osascript -e "set volume output muted false"`);
      } else {
        const { stdout } = await runShell(`osascript -e "output volume of (get volume settings)"`);
        const current = parseInt(stdout.trim(), 10) || 50;
        const next = Math.max(0, Math.min(100, current + (action === 'up' ? 10 : -10)));
        await runShell(`osascript -e "set volume output volume ${next}"`);
      }
    } else if (platform === 'win32') {
      const sendKeys = (key: string, times: number = 1) => {
        const presses = Array(times).fill(`[System.Windows.Forms.SendKeys]::SendWait('${key}')`).join('; Start-Sleep -Milliseconds 80; ');
        return `Add-Type -AssemblyName System.Windows.Forms; ${presses}`;
      };
      if (action === 'up') {
        await runShell(`powershell -NoProfile -Command "${sendKeys('{VOLUME_UP}', 2)}"`);
      } else if (action === 'down') {
        await runShell(`powershell -NoProfile -Command "${sendKeys('{VOLUME_DOWN}', 2)}"`);
      } else if (action === 'mute' || action === 'unmute') {
        await runShell(`powershell -NoProfile -Command "${sendKeys('{VOLUME_MUTE}')}"`);
      } else if (action === 'set') {
        const v = Math.max(0, Math.min(100, Math.round(Number(value))));
        try {
          // Melhor esforço: usa nircmd se estiver instalado/no PATH (ajuste exato).
          await runShell(`nircmd.exe setsysvolume ${Math.round((v / 100) * 65535)}`);
        } catch {
          // Sem nircmd: aproxima com passos relativos (impreciso, mas não falha silenciosamente).
          const steps = Math.round(v / 10);
          if (steps > 0) await runShell(`powershell -NoProfile -Command "${sendKeys('{VOLUME_UP}', steps)}"`);
          logAudit('WARN', 'VOLUME_SET_APPROXIMATE', `nircmd não encontrado; volume ajustado por aproximação no Windows.`, { requestedValue: v });
        }
      }
    } else {
      // Linux: tenta PulseAudio (pactl), cai para ALSA (amixer) se indisponível.
      if (action === 'set') {
        const v = Math.max(0, Math.min(100, Math.round(Number(value))));
        try {
          await runShell(`pactl set-sink-volume @DEFAULT_SINK@ ${v}%`);
        } catch {
          await runShell(`amixer -D pulse sset Master ${v}%`);
        }
      } else if (action === 'mute') {
        try { await runShell(`pactl set-sink-mute @DEFAULT_SINK@ 1`); } catch { await runShell(`amixer -D pulse sset Master mute`); }
      } else if (action === 'unmute') {
        try { await runShell(`pactl set-sink-mute @DEFAULT_SINK@ 0`); } catch { await runShell(`amixer -D pulse sset Master unmute`); }
      } else {
        const delta = action === 'up' ? '+10%' : '-10%';
        try { await runShell(`pactl set-sink-volume @DEFAULT_SINK@ ${delta}`); } catch { await runShell(`amixer -D pulse sset Master 10%${action === 'up' ? '+' : '-'}`); }
      }
    }

    logAudit('INFO', 'VOLUME_CHANGED', `Volume ajustado: ${action}${action === 'set' ? ` (${value}%)` : ''}`, { action, value, platform });
    return res.status(200).json({ success: true, action, value, platform });
  } catch (err: any) {
    logAudit('ERROR', 'VOLUME_CHANGE_FAILED', err.message, { action, value, platform });
    return res.status(500).json({ error: `Erro ao ajustar o volume: ${err.message}` });
  }
};

// ============================================================================
// SEÇÃO 8: CHECAGEM DE SAÚDE DO SISTEMA (CPU, MEMÓRIA, DISCO, UPTIME)
// ============================================================================

/**
 * GET /system-check - Retorna um panorama do estado atual da máquina local.
 */
const handleSystemCheck = async (req: Request, res: Response) => {
  const platform = process.platform;
  const info: any = {
    platform,
    hostname: os.hostname(),
    osType: os.type(),
    osRelease: os.release(),
    uptimeSeconds: Math.round(os.uptime()),
    cpuModel: os.cpus()[0]?.model || 'desconhecido',
    cpuCount: os.cpus().length,
    loadAvg1m: platform === 'win32' ? null : os.loadavg()[0],
    totalMemMB: Math.round(os.totalmem() / 1024 / 1024),
    freeMemMB: Math.round(os.freemem() / 1024 / 1024),
  };
  info.usedMemPercent = Math.round(((info.totalMemMB - info.freeMemMB) / info.totalMemMB) * 100);

  try {
    if (platform === 'win32') {
      const { stdout } = await runShell(`wmic logicaldisk get Caption,FreeSpace,Size`);
      info.diskRaw = stdout.trim();
    } else {
      const { stdout } = await runShell(`df -h`);
      info.diskRaw = stdout.trim();
    }
  } catch {
    info.diskRaw = null;
    info.diskCheckError = 'Não foi possível consultar espaço em disco nesta máquina.';
  }

  logAudit('INFO', 'SYSTEM_CHECK', `Checagem de sistema executada`, { platform });
  return res.status(200).json(info);
};

// ============================================================================
// SEÇÃO 9: TERMINAL — EXECUÇÃO DE COMANDOS COM CONFIRMAÇÃO PARA AÇÕES IMPORTANTES
// ============================================================================

/**
 * Classifica um comando como "importante" (exige confirmação explícita do usuário) ou seguro
 * para rodar direto. Por padrão o agente tem permissão ampla — só pede confirmação para
 * categorias de comando com risco real de dano (apagar em massa, formatar, instalar/remover
 * programas, elevar privilégios, mexer em firewall/antivírus/registro, etc.). Em caso de
 * dúvida, o comando cai no bloco de "requer confirmação" (mais seguro pedir demais do que
 * de menos).
 */
function classifyCommandRisk(command: string): string | null {
  const patterns: Array<{ re: RegExp; reason: string }> = [
    { re: /\brm\s+-[a-z]*r[a-z]*f\b|\brm\s+-[a-z]*f[a-z]*r\b|\bdel\s+\/[fsq]/i, reason: 'Exclusão em massa/forçada de arquivos ou pastas.' },
    { re: /\bformat\b|\bmkfs\b|\bdiskpart\b/i, reason: 'Formatação ou particionamento de disco.' },
    { re: /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/i, reason: 'Desligamento ou reinicialização do sistema.' },
    { re: /\b(apt|apt-get|yum|dnf|brew|choco|winget|pip3?|npm)\s+(install|remove|uninstall|purge)\b/i, reason: 'Instalação ou remoção de programas/pacotes.' },
    { re: /\bsudo\b|\brunas\b/i, reason: 'Comando com elevação de privilégios administrativos.' },
    { re: /\bpasswd\b|\buseradd\b|\buserdel\b|\busermod\b|\bnet\s+user\b/i, reason: 'Alteração de usuários ou senhas do sistema.' },
    { re: /\bchmod\s+777\b|\bchown\b/i, reason: 'Alteração de permissões ou dono de arquivos.' },
    { re: /\bufw\b|\biptables\b|\bnetsh\s+advfirewall\b/i, reason: 'Alteração de regras de firewall.' },
    { re: /set-mppreference|defender/i, reason: 'Alteração de configurações de antivírus/segurança do Windows.' },
    { re: /\bregedit\b|\breg\s+(add|delete)\b/i, reason: 'Alteração do registro do Windows.' },
    { re: />\s*\/dev\/sd|dd\s+if=.*of=\/dev/i, reason: 'Escrita direta em um dispositivo de disco.' },
    { re: /\bgit\s+(push|reset\s+--hard|clean\s+-f)/i, reason: 'Operação Git potencialmente destrutiva ou que publica alterações.' },
  ];
  for (const { re, reason } of patterns) {
    if (re.test(command)) return reason;
  }
  return null;
}

/**
 * Bloqueia (não apenas pede confirmação, recusa de fato) qualquer comando que pareça tentar
 * modificar a própria instalação do OSONE — o usuário pediu acesso total ao PC "menos
 * reescrever o próprio código".
 */
function targetsOwnInstallation(command: string): boolean {
  // Só o caminho REAL da instalação conta. Antes isto usava process.cwd() (que no app
  // empacotado é a pasta de dados do usuário, não a instalação) e ainda casava com qualquer
  // texto contendo "OSONE-AI" — o que bloqueava até cópias e clones do projeto em outros
  // lugares. O usuário pode mexer livremente em clones; protegido é apenas o código que está
  // rodando agora.
  if (!command.includes(OSONE_INSTALL_DIR)) return false;
  /**
   * Três brechas fechadas aqui, testadas isoladamente antes de entrar:
   * - `cp\s+-f` só barrava cp COM a flag -f; `cp origem ${INSTALL_DIR}/arquivo` sobrescreve o
   *   destino sem `-f` da mesma forma e passava direto.
   * - `>>?\s` exigia espaço logo depois do redirecionamento; `echo x>arquivo` (sem espaço) é
   *   shell válido e não casava.
   * - `dd` e as formas de baixar-e-salvar (`curl -o`/`--output`, `wget -O`) nem apareciam na
   *   lista, apesar de serem jeitos igualmente diretos de sobrescrever um arquivo.
   */
  const writeVerbs = /\b(rm|del|rmdir|mv|move|cp|dd|sed\s+-i|truncate|shred|curl\s+(-o|--output)|wget\s+-O)\b|>>?|\btee\b/i;
  return writeVerbs.test(command);
}

/** Bloqueia apagar/sobrescrever a própria instalação, mas permite qualquer outro caminho. */
function isProtectedInstallPath(targetPath: string): boolean {
  const resolved = path.resolve(expandHomePath(targetPath));
  return resolved === OSONE_INSTALL_DIR || resolved.startsWith(OSONE_INSTALL_DIR + path.sep);
}

/**
 * POST /exec - Executa um comando de terminal na máquina local. Comandos classificados como
 * "importantes" por classifyCommandRisk() exigem 'confirmed: true' no corpo da requisição
 * (o cliente mostra um modal de confirmação para o usuário antes de reenviar com confirmed).
 */
/**
 * COMANDO DO SISTEMA ERRADO — barrado ANTES de rodar, com o certo dito na resposta.
 *
 * O sintoma que isto ataca: o agente rodando um `dir` num Linux ou um `ls` num Windows. Quando
 * isso acontecia, o shell devolvia "command not found" ou "não é reconhecido como um comando
 * interno" — mensagens que dizem QUE falhou e não POR QUE, e que não dão ao modelo nenhuma pista
 * de que o problema foi ter escolhido a família errada de comando. Sem essa pista ele costuma
 * tentar de novo com uma variação do mesmo comando errado, e a tarefa trava numa repetição.
 *
 * A checagem é conservadora de propósito: só marca comandos que são inconfundivelmente da OUTRA
 * família e que NÃO existem nesta. `ls`, por exemplo, não entra na lista de "só Linux" porque
 * quem tem Git para Windows instalado tem `ls` funcionando; já `dir`/`Get-ChildItem` num Linux
 * não existem em instalação nenhuma. Um falso positivo aqui bloquearia um comando legítimo, o que
 * é pior que a mensagem ruim que estamos consertando.
 */
const SO_EXISTE_NO_WINDOWS = [
  { re: /^\s*dir(\s|$)/i, certo: 'ls' },
  { re: /^\s*type\s+/i, certo: 'cat' },
  { re: /^\s*copy\s+/i, certo: 'cp' },
  { re: /^\s*move\s+/i, certo: 'mv' },
  { re: /^\s*del\s+/i, certo: 'rm' },
  { re: /^\s*ren\s+/i, certo: 'mv' },
  { re: /^\s*md\s+/i, certo: 'mkdir' },
  { re: /^\s*rd\s+/i, certo: 'rmdir' },
  { re: /^\s*cls(\s|$)/i, certo: 'clear' },
  { re: /^\s*tasklist(\s|$)/i, certo: 'ps aux' },
  { re: /^\s*taskkill(\s|$)/i, certo: 'kill / pkill' },
  { re: /^\s*ipconfig(\s|$)/i, certo: 'ip addr / ifconfig' },
  { re: /^\s*powershell(\s|$)/i, certo: 'bash' },
  { re: /^\s*(Get|Set|New|Remove)-[A-Z]/, certo: 'o comando equivalente de shell POSIX' },
  { re: /%[A-Za-z_]+%/, certo: '$VARIAVEL (no lugar de %VARIAVEL%)' }
];

const SO_EXISTE_NO_POSIX = [
  { re: /^\s*ls(\s|$)/, certo: 'dir' },
  { re: /^\s*cat\s+/, certo: 'type' },
  { re: /^\s*rm\s+/, certo: 'del (arquivo) ou rmdir /s (pasta)' },
  { re: /^\s*cp\s+/, certo: 'copy' },
  { re: /^\s*mv\s+/, certo: 'move' },
  { re: /^\s*touch\s+/, certo: 'type nul >' },
  { re: /^\s*chmod(\s|$)/, certo: 'icacls' },
  { re: /^\s*chown(\s|$)/, certo: 'icacls' },
  { re: /^\s*sudo(\s|$)/, certo: 'abrir o terminal como administrador' },
  { re: /^\s*apt(-get)?(\s|$)/, certo: 'winget' },
  { re: /^\s*(pkill|killall)(\s|$)/, certo: 'taskkill /IM nome.exe /F' },
  { re: /^\s*ps\s+aux/, certo: 'tasklist' },
  { re: /^\s*grep\s+/, certo: 'findstr' },
  { re: /^\s*which\s+/, certo: 'where' }
];

function comandoDeOutroSistema(command: string): { certo: string } | null {
  const ehWindows = process.platform === 'win32';
  // No Windows, um comando POSIX pode existir de verdade (Git Bash, WSL, MSYS no PATH). Só
  // acusamos quando o shell padrão é o cmd — que é o que o exec() usa aqui.
  const lista = ehWindows ? SO_EXISTE_NO_POSIX : SO_EXISTE_NO_WINDOWS;
  for (const item of lista) {
    if (item.re.test(command)) return { certo: item.certo };
  }
  return null;
}

const handleExec = async (req: Request, res: Response) => {
  const command = (req.body?.command || '').toString();
  const confirmed = req.body?.confirmed === true;

  if (!command.trim()) {
    return res.status(400).json({ error: "Parâmetro 'command' é obrigatório." });
  }

  const deOutroSistema = comandoDeOutroSistema(command);
  if (deOutroSistema) {
    const ehWindows = process.platform === 'win32';
    const nomeDoSistema = ehWindows ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
    const outro = ehWindows ? 'Linux/macOS' : 'Windows';
    logAudit('WARN', 'EXEC_SISTEMA_ERRADO', `Comando de ${outro} recusado numa máquina ${nomeDoSistema}`, { command });
    return res.status(400).json({
      error:
        `Este computador é ${nomeDoSistema} (${process.platform}), e o comando enviado é de ${outro}: "${command.trim().slice(0, 80)}". ` +
        `Nada foi executado. Aqui o equivalente é: ${deOutroSistema.certo}. ` +
        `Reescreva o comando na sintaxe de ${nomeDoSistema} e tente de novo — não repita o mesmo comando nem tente variações dele.`,
      sistemaOperacional: nomeDoSistema,
      platform: process.platform,
      shell: ehWindows ? 'cmd/powershell' : 'bash/sh',
      comandoEquivalente: deOutroSistema.certo
    });
  }

  if (targetsOwnInstallation(command)) {
    logAudit('SECURITY', 'EXEC_BLOCKED_SELF', `Comando bloqueado por tentar modificar a própria instalação do OSONE`, { command });
    return res.status(403).json({ error: `Bloqueado: este comando modificaria a própria instalação do OSONE (${OSONE_INSTALL_DIR}), a única coisa que o agente não pode alterar. Cópias e clones do projeto em outros caminhos podem ser modificados normalmente.` });
  }

  // Execução livre por decisão explícita do dono da máquina: o agente é uma ferramenta local
  // de automação pessoal e não impõe mais um gate de confirmação por categoria de comando.
  // A classificação continua sendo calculada apenas para registrar no log de auditoria quais
  // comandos foram sensíveis, permitindo revisão posterior do que foi executado.
  const risk = classifyCommandRisk(command);

  // Sem cwd explícito, o comando herdaria o diretório do processo — que no app empacotado é a
  // pasta de dados do OSONE. Era por isso que o terminal abria sempre dentro da pasta do
  // próprio app em vez do lugar pedido. O padrão agora é a casa do usuário.
  const requestedCwd = req.body?.cwd ? resolveAnyPath(String(req.body.cwd)) : USER_HOME_DIR;

  // Modo visível: abre um terminal DE VERDADE na tela rodando o comando, em vez de executá-lo
  // escondido. Sem isto o comando roda de forma invisível — o agente lê a saída, mas o usuário
  // não vê nada acontecendo e parece que nada foi feito. O terminal fica aberto no fim para
  // que a saída possa ser lida com calma.
  if (req.body?.visible === true) {
    const workDir = fs.existsSync(requestedCwd) ? requestedCwd : USER_HOME_DIR;
    try {
      if (process.platform === 'win32') {
        // /K mantém a janela aberta depois que o comando termina.
        launchDetached(`start "OSONE" cmd /K "${command.replace(/"/g, '""')}"`, workDir);
      } else if (process.platform === 'darwin') {
        const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        launchDetached(`osascript -e 'tell application "Terminal" to do script "cd ${workDir} && ${escaped}"' -e 'tell application "Terminal" to activate'`, workDir);
      } else {
        const shellCmd = `${command}; echo; echo '[OSONE] Comando finalizado. Pressione Enter para fechar.'; read`;
        const escaped = shellCmd.replace(/'/g, `'\\''`);
        await tryCommandsInOrder([
          `gnome-terminal --working-directory='${workDir}' -- bash -c '${escaped}'`,
          `konsole --workdir '${workDir}' -e bash -c '${escaped}'`,
          `xfce4-terminal --working-directory='${workDir}' -e "bash -c '${escaped}'"`,
          `xterm -hold -e bash -c '${escaped}'`
        ], workDir);
      }
      logAudit('INFO', 'EXEC_VISIBLE', `Comando aberto em terminal visível`, { command, cwd: workDir });
      return res.status(200).json({
        success: true,
        visible: true,
        message: `Comando aberto numa janela de terminal visível em '${workDir}'. A saída aparece na janela, não aqui.`
      });
    } catch (err: any) {
      return res.status(500).json({ error: `Não foi possível abrir um terminal visível: ${err.message}` });
    }
  }

  const workingDir = fs.existsSync(requestedCwd) ? requestedCwd : USER_HOME_DIR;

  exec(command, { cwd: workingDir, timeout: 120000, maxBuffer: 1024 * 1024 * 20, windowsHide: true }, (error, stdout, stderr) => {
    const success = !error;
    logAudit(success ? 'INFO' : 'ERROR', 'EXEC_COMMAND', `Comando executado: ${success ? 'sucesso' : 'falha'}`, {
      command,
      cwd: workingDir,
      sensitive: risk || null,
      exitCode: (error as any)?.code
    });

    if (error && (error as any).killed) {
      return res.status(500).json({ error: 'O comando excedeu o tempo limite de 2 minutos e foi encerrado.' });
    }

    return res.status(200).json({
      success,
      exitCode: error ? ((error as any).code ?? 1) : 0,
      stdout: (stdout || '').toString().slice(0, 20000),
      stderr: (stderr || '').toString().slice(0, 20000)
    });
  });
};

// ============================================================================
// SEÇÃO 10: CONTROLE DE MOUSE (CONTROLE POR VISÃO / GESTOS DE MÃO)
// ============================================================================

interface DimensoesDaTela { width: number; height: number; offsetX: number; offsetY: number }

/**
 * A resolução lida há pouco.
 *
 * Ela é consultada em TODO movimento de mouse, e cada consulta abre um processo — no Windows, um
 * PowerShell inteiro, que custa mais do que o movimento em si. Uma sequência de mira faz vários
 * movimentos seguidos, então esse processo repetido entrava direto no tempo que o usuário espera.
 * A resolução da tela não muda entre um movimento e o seguinte; guardá-la por alguns segundos
 * elimina o custo sem esconder uma troca de monitor, que continua aparecendo na leitura seguinte.
 */
let dimensoesEmCache: { quando: number; valor: DimensoesDaTela } | null = null;
const VALIDADE_DAS_DIMENSOES_MS = 15000;

async function lerDimensoesDaTela(): Promise<DimensoesDaTela> {
  const platform = process.platform;
  if (platform === 'linux') {
    const { stdout } = await runShell('xdotool getdisplaygeometry', 10000, USER_HOME_DIR, ambienteGrafico());
    const [width, height] = stdout.trim().split(/\s+/).map(Number);
    return { width, height, offsetX: 0, offsetY: 0 };
  }
  if (platform === 'win32') {
    const script = `Add-Type -AssemblyName System.Windows.Forms; $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen; Write-Output "$($vs.Width)|$($vs.Height)|$($vs.X)|$($vs.Y)"`;
    const { stdout } = await runShell(`powershell -NoProfile -Command "${script}"`);
    const [width, height, offsetX, offsetY] = stdout.trim().split('|').map(Number);
    return { width, height, offsetX, offsetY };
  }
  throw new Error(`Plataforma '${platform}' não suportada para leitura das dimensões de tela.`);
}

/**
 * Dimensões da tela virtual (união de todos os monitores conectados), usada para mapear a posição
 * da mão detectada pela câmera e a coordenada do clique para pixels absolutos, incluindo monitores
 * estendidos. Serve o GET /screen-info e todo movimento de mouse.
 */
async function obterDimensoesDaTela(): Promise<DimensoesDaTela> {
  const agora = Date.now();
  if (dimensoesEmCache && agora - dimensoesEmCache.quando < VALIDADE_DAS_DIMENSOES_MS) {
    return dimensoesEmCache.valor;
  }
  const valor = await lerDimensoesDaTela();
  if (Number.isFinite(valor.width) && valor.width > 0 && Number.isFinite(valor.height) && valor.height > 0) {
    dimensoesEmCache = { quando: agora, valor };
  }
  return valor;
};

const handleGetScreenInfo = async (_req: Request, res: Response) => {
  const platform = process.platform;
  try {
    const info = await obterDimensoesDaTela();
    return res.status(200).json({ ...info, monitors: 'union' });
  } catch (err: any) {
    if (platform !== 'linux' && platform !== 'win32') {
      return res.status(501).json({ error: `Controle de mouse ainda não suportado na plataforma '${platform}'.` });
    }
    logAudit('ERROR', 'SCREEN_INFO_FAILED', err.message, { platform });
    return res.status(500).json({ error: `Não foi possível obter as dimensões da tela: ${err.message}. No Linux é necessário ter o pacote 'xdotool' instalado.` });
  }
};

/** Monta o comando PowerShell que dispara um evento nativo de mouse via user32.dll (mouse_event). */
function winMouseEventCommand(flag: number, x?: number, y?: number): string {
  const moveCmd = (x !== undefined && y !== undefined)
    ? `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)},${Math.round(y)}); `
    : '';
  const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class OsoneMouse { [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extra); }'; ${moveCmd}[OsoneMouse]::mouse_event(${flag},0,0,0,0);`;
  return `powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`;
}

const WIN_MOUSEEVENTF = { LEFTDOWN: 0x0002, LEFTUP: 0x0004, RIGHTDOWN: 0x0008, RIGHTUP: 0x0010 };

/**
 * Monta um clique (down+up, opcionalmente repetido para duplo clique) como UM script PowerShell
 * só, em vez de dois `runShell` separados como o resto do arquivo fazia.
 *
 * Down e up disparados como dois processos powershell.exe independentes deixavam uma janela real
 * de falha: se o down tivesse sucesso mas o up estourasse o timeout de 3s (PowerShell frio custa
 * caro para iniciar) ou o spawn falhasse, o botão ficava fisicamente pressionado no sistema
 * operacional inteiro, sem nenhuma recuperação automática — todo movimento de mouse seguinte
 * vira arrasto/seleção em vez de clique. Com os dois mouse_event() na mesma invocação do
 * PowerShell, ou os dois disparam (mesmo processo, sem gap entre eles) ou nenhum dispara.
 */
function winMouseClickCommand(downFlag: number, upFlag: number, times = 1): string {
  const sequenciaDeCliques = Array.from({ length: times })
    .map(() => `[OsoneMouse]::mouse_event(${downFlag},0,0,0,0); [OsoneMouse]::mouse_event(${upFlag},0,0,0,0);`)
    .join(' ');
  const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class OsoneMouse { [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extra); }'; ${sequenciaDeCliques}`;
  return `powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`;
}

/**
 * POST /mouse/move - Move o cursor do sistema para coordenadas absolutas de tela (x, y),
 * podendo cobrir qualquer monitor conectado. É a base do controle por visão: cada quadro em
 * que a câmera detecta a posição da mão, o frontend chama este endpoint (com controle de taxa
 * no próprio frontend para não sobrecarregar).
 */
/**
 * Onde o cursor REALMENTE está, perguntado ao sistema operacional.
 *
 * É a única fonte de verdade disponível. Todo o resto — a coordenada que o modelo informou, a
 * conversão feita aqui — é intenção; só isto é fato. Sem essa leitura, mover o mouse é uma
 * operação cega: nada no sistema jamais compara o que foi pedido com o que aconteceu, e um erro
 * de mira fica indistinguível de um acerto.
 */
async function lerPosicaoDoCursor(): Promise<{ x: number; y: number } | null> {
  try {
    if (process.platform === 'linux') {
      const { stdout } = await runShell('xdotool getmouselocation --shell', 3000, USER_HOME_DIR, ambienteGrafico());
      const x = Number(stdout.match(/^X=(\d+)/m)?.[1]);
      const y = Number(stdout.match(/^Y=(\d+)/m)?.[1]);
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    }
    if (process.platform === 'win32') {
      const script = `Add-Type -AssemblyName System.Windows.Forms; $p = [System.Windows.Forms.Cursor]::Position; Write-Output \\"$($p.X)|$($p.Y)\\"`;
      const { stdout } = await runShell(`powershell -NoProfile -Command "${script}"`, 4000);
      const [x, y] = stdout.trim().split('|').map(Number);
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    }
  } catch (_) { /* sem leitura disponível: melhor não afirmar nada do que afirmar errado */ }
  return null;
}

/** Últimos movimentos de mouse, para diagnosticar mira errada sem depender de adivinhação. */
const historicoDeMira: Array<{ quando: string; pediuPx: { x: number; y: number }; ficouPx: { x: number; y: number } | null; desvioPx: number | null; tela: { width: number; height: number } | null }> = [];

const handleMouseMove = async (req: Request, res: Response) => {
  const x = Number(req.body?.x);
  const y = Number(req.body?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return res.status(400).json({ error: "Parâmetros 'x' e 'y' (numéricos) são obrigatórios." });
  }
  const platform = process.platform;
  const alvo = { x: Math.round(x), y: Math.round(y) };
  try {
    if (platform === 'linux') {
      await runShell(`xdotool mousemove ${alvo.x} ${alvo.y}`, 3000, USER_HOME_DIR, ambienteGrafico());
    } else if (platform === 'win32') {
      await runShell(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${alvo.x},${alvo.y})"`, 3000);
    } else {
      return res.status(501).json({ error: `Controle de mouse ainda não suportado na plataforma '${platform}'.` });
    }

    // Confere com o sistema operacional onde o cursor parou de fato.
    const real = await lerPosicaoDoCursor();
    const desvio = real ? Math.round(Math.hypot(real.x - alvo.x, real.y - alvo.y)) : null;
    let tela: { width: number; height: number } | null = null;
    try {
      const t = await obterDimensoesDaTela();
      tela = { width: t.width, height: t.height };
    } catch (_) { /* opcional */ }

    historicoDeMira.unshift({ quando: new Date().toISOString(), pediuPx: alvo, ficouPx: real, desvioPx: desvio, tela });
    if (historicoDeMira.length > 30) historicoDeMira.pop();

    if (desvio !== null && desvio > 2) {
      logAudit('WARN', 'MOUSE_MOVE_DESVIO', `Pedi (${alvo.x},${alvo.y}) e o cursor parou em (${real!.x},${real!.y}) — ${desvio}px de desvio.`, { platform });
    }

    return res.status(200).json({
      success: true,
      pediuPx: alvo,
      ficouPx: real,
      desvioPx: desvio,
      ...(tela ? { telaPx: tela } : {}),
      // O sistema operacional obedeceu exatamente? Se sim, um clique errado é erro de MIRA
      // (a coordenada escolhida) e não de execução — distinção que antes era impossível de fazer.
      execucaoExata: desvio === null ? null : desvio <= 2
    });
  } catch (err: any) {
    return res.status(500).json({ error: `Falha ao mover o cursor: ${err.message}` });
  }
};

/**
 * POST /mouse/button - Ação de botão do mouse. action: 'down' | 'up' | 'click'.
 * button: 'left' | 'right' (padrão 'left'). Usado pelo controle por visão para gestos:
 * pinça iniciando = down, soltando rápido = click, soltando após arrastar = up (o down/up
 * separados permitem que o gesto de arrastar funcione, já que o frontend manda 'down',
 * uma sequência de /mouse/move, e por fim 'up').
 */
const handleMouseButton = async (req: Request, res: Response) => {
  const action = (req.body?.action || 'click').toString();
  const button = (req.body?.button || 'left').toString();
  const double = req.body?.double === true;

  if (!['down', 'up', 'click'].includes(action)) {
    return res.status(400).json({ error: "Parâmetro 'action' deve ser 'down', 'up' ou 'click'." });
  }
  if (!['left', 'right'].includes(button)) {
    return res.status(400).json({ error: "Parâmetro 'button' deve ser 'left' ou 'right'." });
  }

  const platform = process.platform;
  const xdotoolButton = button === 'left' ? '1' : '3';
  try {
    if (platform === 'linux') {
      if (action === 'down') await runShell(`xdotool mousedown ${xdotoolButton}`, 3000, USER_HOME_DIR, ambienteGrafico());
      else if (action === 'up') await runShell(`xdotool mouseup ${xdotoolButton}`, 3000, USER_HOME_DIR, ambienteGrafico());
      else await runShell(`xdotool click ${double ? '--repeat 2 --delay 120 ' : ''}${xdotoolButton}`, 3000, USER_HOME_DIR, ambienteGrafico());
    } else if (platform === 'win32') {
      const down = button === 'left' ? WIN_MOUSEEVENTF.LEFTDOWN : WIN_MOUSEEVENTF.RIGHTDOWN;
      const up = button === 'left' ? WIN_MOUSEEVENTF.LEFTUP : WIN_MOUSEEVENTF.RIGHTUP;
      if (action === 'down') await runShell(winMouseEventCommand(down), 3000);
      else if (action === 'up') await runShell(winMouseEventCommand(up), 3000);
      else await runShell(winMouseClickCommand(down, up, double ? 2 : 1), 3000);
    } else {
      return res.status(501).json({ error: `Controle de mouse ainda não suportado na plataforma '${platform}'.` });
    }
    return res.status(200).json({ success: true, action, button });
  } catch (err: any) {
    return res.status(500).json({ error: `Falha ao executar ação de mouse '${action}': ${err.message}` });
  }
};

/** Monta o comando PowerShell que dispara a roda do mouse (scroll) via mouse_event/MOUSEEVENTF_WHEEL. */
function winMouseWheelCommand(wheelData: number, x?: number, y?: number): string {
  const moveCmd = (x !== undefined && y !== undefined)
    ? `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)},${Math.round(y)}); `
    : '';
  const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class OsoneWheel { [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extra); }'; ${moveCmd}[OsoneWheel]::mouse_event(0x0800,0,0,${Math.round(wheelData)},0);`;
  return `powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`;
}

/**
 * POST /mouse/scroll - Rola a página/janela sob o cursor (ou nas coordenadas opcionais x,y).
 * direction: 'up' | 'down'. amount: quantos "cliques" de roda (padrão 3, como um giro normal de
 * roda de mouse físico). Complementa /mouse/move e /mouse/button para o agente de visão navegar
 * em páginas e documentos longos sem depender de atalhos de teclado.
 */
const handleMouseScroll = async (req: Request, res: Response) => {
  const direction = (req.body?.direction || '').toString();
  const rawAmount = Number(req.body?.amount);
  const amount = Number.isFinite(rawAmount) ? Math.max(1, Math.min(50, Math.round(rawAmount))) : 3;
  const x = req.body?.x !== undefined ? Number(req.body.x) : undefined;
  const y = req.body?.y !== undefined ? Number(req.body.y) : undefined;

  if (!['up', 'down'].includes(direction)) {
    return res.status(400).json({ error: "Parâmetro 'direction' deve ser 'up' ou 'down'." });
  }
  if ((x !== undefined && !Number.isFinite(x)) || (y !== undefined && !Number.isFinite(y))) {
    return res.status(400).json({ error: "Parâmetros 'x' e 'y', quando informados, devem ser numéricos." });
  }

  const platform = process.platform;
  try {
    if (platform === 'linux') {
      if (x !== undefined && y !== undefined) {
        await runShell(`xdotool mousemove ${Math.round(x)} ${Math.round(y)}`, 3000, USER_HOME_DIR, ambienteGrafico());
      }
      const xdotoolButton = direction === 'up' ? '4' : '5';
      await runShell(`xdotool click --repeat ${amount} --delay 40 ${xdotoolButton}`, 6000, USER_HOME_DIR, ambienteGrafico());
    } else if (platform === 'win32') {
      const wheelData = (direction === 'up' ? 1 : -1) * 120 * amount;
      await runShell(winMouseWheelCommand(wheelData, x, y), 3000);
    } else {
      return res.status(501).json({ error: `Controle de mouse ainda não suportado na plataforma '${platform}'.` });
    }
    return res.status(200).json({ success: true, direction, amount });
  } catch (err: any) {
    return res.status(500).json({ error: `Falha ao rolar a página: ${err.message}` });
  }
};

const MAX_TYPE_TEXT_LENGTH = 4000;

/**
 * Gera o comando PowerShell que digita texto arbitrário via SendInput/KEYEVENTF_UNICODE,
 * caractere a caractere. Evita por completo as regras de escape do SendKeys (que trata
 * +^%~(){} como caracteres especiais) — essencial aqui porque o texto vem de linguagem natural
 * do usuário/IA e pode conter qualquer um desses caracteres, além de acentos e emojis. O texto
 * chega em base64 (UTF-16LE) para não precisar de nenhum escape de aspas/shell na montagem do
 * comando: o payload só contém caracteres do alfabeto base64, que são inofensivos em qualquer
 * contexto de shell ou string do PowerShell.
 */
function winTypeUnicodeCommand(base64Utf16Text: string): string {
  const csharp = [
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class OsoneKeyboard {',
    '  [StructLayout(LayoutKind.Sequential)]',
    '  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }',
    '  [StructLayout(LayoutKind.Explicit)]',
    '  struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; }',
    '  struct INPUT { public uint type; public INPUTUNION u; }',
    '  [DllImport("user32.dll")] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);',
    '  const uint KEYEVENTF_UNICODE = 0x0004;',
    '  const uint KEYEVENTF_KEYUP = 0x0002;',
    '  public static void TypeText(string text) {',
    '    int size = Marshal.SizeOf(typeof(INPUT));',
    '    foreach (char c in text) {',
    '      var down = new INPUT { type = 1, u = new INPUTUNION { ki = new KEYBDINPUT { wVk = 0, wScan = c, dwFlags = KEYEVENTF_UNICODE, time = 0, dwExtraInfo = IntPtr.Zero } } };',
    '      var up = down; up.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;',
    '      SendInput(1, new INPUT[] { down }, size);',
    '      SendInput(1, new INPUT[] { up }, size);',
    '      System.Threading.Thread.Sleep(8);',
    '    }',
    '  }',
    '}'
  ].join(' ');
  const script = `Add-Type -TypeDefinition '${csharp}'; $bytes = [Convert]::FromBase64String("${base64Utf16Text}"); $s = [System.Text.Encoding]::Unicode.GetString($bytes); [OsoneKeyboard]::TypeText($s);`;
  return `powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`;
}

/**
 * POST /keyboard/type - Digita texto livre no campo atualmente em foco (o que estiver com o
 * cursor de texto ativo na tela: uma barra de busca, um formulário, um editor). Junto de
 * /mouse/move, /mouse/button e /keyboard/key, fecha o conjunto de ações que faltava para o
 * agente de visão não só ver a tela, mas também interagir com ela como um usuário faria.
 */
const handleKeyboardType = async (req: Request, res: Response) => {
  const text = (req.body?.text ?? '').toString();
  if (!text) {
    return res.status(400).json({ error: "Parâmetro 'text' é obrigatório." });
  }
  if (text.length > MAX_TYPE_TEXT_LENGTH) {
    return res.status(400).json({ error: `Texto muito longo (máx. ${MAX_TYPE_TEXT_LENGTH} caracteres por chamada).` });
  }

  const platform = process.platform;
  try {
    if (platform === 'linux') {
      await execFileShellSafe('xdotool', ['type', '--clearmodifiers', '--delay', '12', '--', text], 20000, 1024 * 1024, ambienteGrafico());
    } else if (platform === 'win32') {
      const base64Text = Buffer.from(text, 'utf16le').toString('base64');
      await runShell(winTypeUnicodeCommand(base64Text), 20000);
    } else {
      return res.status(501).json({ error: `Digitação por teclado ainda não suportada na plataforma '${platform}'.` });
    }
    return res.status(200).json({ success: true, length: text.length });
  } catch (err: any) {
    logAudit('ERROR', 'KEYBOARD_TYPE_FAILED', err.message, { platform, length: text.length });
    return res.status(500).json({ error: `Falha ao digitar texto: ${err.message}. No Linux é necessário ter o pacote 'xdotool' instalado.` });
  }
};

/** Teclas nomeadas aceitas por /keyboard/key, mapeadas para o nome esperado por xdotool (Linux)
 * e pela sintaxe do SendKeys (Windows). */
const KEY_NAME_MAP: Record<string, { xdotool: string; sendkeys: string }> = {
  enter: { xdotool: 'Return', sendkeys: '{ENTER}' },
  tab: { xdotool: 'Tab', sendkeys: '{TAB}' },
  escape: { xdotool: 'Escape', sendkeys: '{ESC}' },
  backspace: { xdotool: 'BackSpace', sendkeys: '{BACKSPACE}' },
  delete: { xdotool: 'Delete', sendkeys: '{DELETE}' },
  arrowup: { xdotool: 'Up', sendkeys: '{UP}' },
  arrowdown: { xdotool: 'Down', sendkeys: '{DOWN}' },
  arrowleft: { xdotool: 'Left', sendkeys: '{LEFT}' },
  arrowright: { xdotool: 'Right', sendkeys: '{RIGHT}' },
  home: { xdotool: 'Home', sendkeys: '{HOME}' },
  end: { xdotool: 'End', sendkeys: '{END}' },
  pageup: { xdotool: 'Prior', sendkeys: '{PGUP}' },
  pagedown: { xdotool: 'Next', sendkeys: '{PGDN}' },
};

/**
 * POST /keyboard/key - Pressiona uma tecla nomeada (enter, tab, escape, setas, backspace...) ou
 * um único caractere alfanumérico, com modificadores opcionais (ctrl/alt/shift). Complementa
 * /keyboard/type (texto livre): usado para atalhos e navegação — Enter para enviar um
 * formulário, Ctrl+A para selecionar tudo, Tab para mudar de campo, setas para navegar em
 * listas/menus. 'key' e 'modifiers' são validados contra uma lista fechada antes de montar
 * qualquer comando, então não há risco de injeção mesmo repassando o texto vindo do modelo.
 */
const handleKeyboardKey = async (req: Request, res: Response) => {
  const rawKey = (req.body?.key || '').toString();
  const key = rawKey.toLowerCase();
  const modifiersInput: any[] = Array.isArray(req.body?.modifiers) ? req.body.modifiers : [];
  const modifiers = modifiersInput
    .map((m) => String(m).toLowerCase())
    .filter((m) => ['ctrl', 'alt', 'shift'].includes(m));

  const named = KEY_NAME_MAP[key];
  const isSingleChar = /^[a-z0-9]$/.test(key);
  if (!named && !isSingleChar) {
    return res.status(400).json({ error: `Tecla '${rawKey}' não reconhecida. Use uma tecla nomeada (${Object.keys(KEY_NAME_MAP).join(', ')}) ou um único caractere alfanumérico.` });
  }

  const platform = process.platform;
  try {
    if (platform === 'linux') {
      const keysym = named ? named.xdotool : key;
      const combo = [...modifiers, keysym].join('+');
      await runShell(`xdotool key ${combo}`, 5000, USER_HOME_DIR, ambienteGrafico());
    } else if (platform === 'win32') {
      const prefix = modifiers.map(m => m === 'ctrl' ? '^' : m === 'alt' ? '%' : '+').join('');
      const token = named ? named.sendkeys : key;
      const script = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${prefix}${token}')`;
      await runShell(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, 5000);
    } else {
      return res.status(501).json({ error: `Controle de teclado ainda não suportado na plataforma '${platform}'.` });
    }
    return res.status(200).json({ success: true, key: rawKey, modifiers });
  } catch (err: any) {
    return res.status(500).json({ error: `Falha ao pressionar a tecla '${rawKey}': ${err.message}` });
  }
};

/**
 * GET /screen/capture - Tira uma captura de tela (todos os monitores) e devolve como base64.
 * Diferente do compartilhamento de tela via WebRTC no navegador (que exige clique manual do
 * usuário por restrição do próprio navegador), esta captura roda direto no sistema operacional,
 * então pode ser chamada sob demanda a qualquer momento — inclusive fora de uma sessão de voz
 * com compartilhamento ativo — para o agente conferir o estado atual da tela.
 */
/**
 * De quantas em quantas unidades a grade é traçada, na escala 0-1000 usada para clicar.
 * 100 dá uma malha 10x10: densa o bastante para servir de régua, esparsa o bastante para não
 * cobrir a tela de linhas e atrapalhar a leitura do que está por baixo.
 */
const PASSO_DA_GRADE = 100;

/**
 * Desenha sobre a captura uma grade numerada na MESMA escala em que o clique é informado (0-1000).
 *
 * Sem ela, acertar um alvo significa estimar proporções a olho numa imagem sem nenhuma referência
 * — e errar por pouco é o resultado normal, não a exceção. Com linhas numeradas visíveis, a
 * posição passa a ser lida contra marcas concretas ("logo à direita da linha 700") em vez de
 * adivinhada.
 *
 * Falhar aqui nunca derruba a captura: uma imagem sem grade continua sendo útil, uma captura que
 * não acontece não serve para nada. Por isso todo o corpo é best-effort.
 */
async function desenharGradeDeReferencia(arquivo: string, largura: number, altura: number): Promise<void> {
  const linhas: string[] = [];
  const textos: string[] = [];

  for (let v = PASSO_DA_GRADE; v < 1000; v += PASSO_DA_GRADE) {
    const x = Math.round((v / 1000) * largura);
    const y = Math.round((v / 1000) * altura);
    linhas.push(`line ${x},0 ${x},${altura}`);
    linhas.push(`line 0,${y} ${largura},${y}`);
    // Os rótulos ficam junto às bordas para não tapar o conteúdo no meio da tela.
    textos.push(`text ${x + 4},26 '${v}'`);
    textos.push(`text 4,${y - 6} '${v}'`);
  }

  if (process.platform === 'linux') {
    const saida = `${arquivo}.grade.png`;
    await execFileShellSafe('convert', [
      arquivo,
      '-stroke', 'rgba(255,64,64,0.40)', '-strokewidth', '2', '-draw', linhas.join(' '),
      '-stroke', 'none', '-fill', 'rgba(255,64,64,0.95)', '-pointsize', '26', '-draw', textos.join(' '),
      saida
    ], 15000);
    if (fs.existsSync(saida) && fs.statSync(saida).size > 0) {
      fs.renameSync(saida, arquivo);
    }
    return;
  }

  if (process.platform === 'win32') {
    const caminho = arquivo.replace(/'/g, "''");
    const desenhos: string[] = [];
    for (let v = PASSO_DA_GRADE; v < 1000; v += PASSO_DA_GRADE) {
      const x = Math.round((v / 1000) * largura);
      const y = Math.round((v / 1000) * altura);
      desenhos.push(`$g.DrawLine($pen, ${x}, 0, ${x}, ${altura});`);
      desenhos.push(`$g.DrawLine($pen, 0, ${y}, ${largura}, ${y});`);
      desenhos.push(`$g.DrawString('${v}', $fonte, $tinta, ${x + 4}, 6);`);
      desenhos.push(`$g.DrawString('${v}', $fonte, $tinta, 4, ${y - 26});`);
    }
    // O bitmap é recriado a partir de uma cópia porque um Bitmap carregado de arquivo mantém o
    // arquivo travado no Windows, impedindo que ele seja sobrescrito logo em seguida.
    const script = [
      `Add-Type -AssemblyName System.Drawing;`,
      `$orig = [System.Drawing.Image]::FromFile('${caminho}');`,
      `$bmp = New-Object System.Drawing.Bitmap($orig);`,
      `$orig.Dispose();`,
      `$g = [System.Drawing.Graphics]::FromImage($bmp);`,
      `$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(102,255,64,64), 2);`,
      `$tinta = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(242,255,64,64));`,
      `$fonte = New-Object System.Drawing.Font('Arial', 18);`,
      ...desenhos,
      `$bmp.Save('${caminho}', [System.Drawing.Imaging.ImageFormat]::Png);`,
      `$g.Dispose(); $bmp.Dispose();`
    ].join(' ');
    await runShell(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, 20000);
  }
}

/**
 * Recorta um pedaço da captura em volta de um ponto e o amplia, com uma grade fina por cima.
 *
 * É o que transforma "quase acertou" em "acertou". Numa tela inteira, uma linha da grade a cada
 * 100 unidades cobre 144 pixels — ler a posição entre duas linhas ainda deixa margem para errar
 * por algumas dezenas de pixels, o suficiente para cair no botão vizinho. Ampliando uma janela
 * de 200 unidades para o mesmo tamanho de imagem, cada unidade fica 5 vezes maior e a grade pode
 * ser traçada de 10 em 10: o mesmo erro de leitura passa a valer poucos pixels.
 *
 * A grade da ampliação é numerada em coordenadas ABSOLUTAS da tela (a mesma escala 0-1000 do
 * clique), e não em coordenadas do recorte. Isso é deliberado: com números do recorte seria
 * preciso convertê-los de volta, e essa conversão é mais um lugar para errar. Numerada em
 * absoluto, o valor lido na ampliação já é o valor final do clique.
 */
async function ampliarRegiao(
  arquivo: string,
  tela: { width: number; height: number },
  centroX: number,
  centroY: number,
  janela: number
): Promise<{ x0: number; y0: number; x1: number; y1: number }> {
  // Janela em unidades 0-1000, presa dentro da tela para nunca recortar fora da imagem.
  const meia = janela / 2;
  let u0 = Math.max(0, Math.min(1000 - janela, centroX - meia));
  let v0 = Math.max(0, Math.min(1000 - janela, centroY - meia));
  const u1 = u0 + janela;
  const v1 = v0 + janela;

  const px = (u: number) => Math.round((u / 1000) * tela.width);
  const py = (v: number) => Math.round((v / 1000) * tela.height);
  const cropX = px(u0), cropY = py(v0);
  const cropL = Math.max(1, px(u1) - cropX), cropA = Math.max(1, py(v1) - cropY);

  // Alvo de saída: largura fixa, para a ampliação ser sempre legível independentemente do
  // tamanho da janela recortada.
  const SAIDA = 1000;
  const escala = SAIDA / cropL;
  const saidaA = Math.round(cropA * escala);

  const PASSO_FINO = 10;
  const linhas: string[] = [];
  const textos: string[] = [];
  for (let u = Math.ceil(u0 / PASSO_FINO) * PASSO_FINO; u <= u1; u += PASSO_FINO) {
    const x = Math.round(((u - u0) / janela) * SAIDA);
    const forte = u % 50 === 0;
    linhas.push(`line ${x},0 ${x},${saidaA}`);
    if (forte) textos.push(`text ${x + 4},24 '${u}'`);
  }
  for (let v = Math.ceil(v0 / PASSO_FINO) * PASSO_FINO; v <= v1; v += PASSO_FINO) {
    const y = Math.round(((v - v0) / janela) * saidaA);
    const forte = v % 50 === 0;
    linhas.push(`line 0,${y} ${SAIDA},${y}`);
    if (forte) textos.push(`text 4,${y - 6} '${v}'`);
  }

  if (process.platform === 'linux') {
    const saida = `${arquivo}.zoom.png`;
    await execFileShellSafe('convert', [
      arquivo,
      '-crop', `${cropL}x${cropA}+${cropX}+${cropY}`, '+repage',
      '-filter', 'point', '-resize', `${SAIDA}x${saidaA}!`,
      '-stroke', 'rgba(255,64,64,0.35)', '-strokewidth', '1', '-draw', linhas.join(' '),
      '-stroke', 'none', '-fill', 'rgba(255,64,64,0.95)', '-pointsize', '22', '-draw', textos.join(' '),
      saida
    ], 20000);
    if (fs.existsSync(saida) && fs.statSync(saida).size > 0) fs.renameSync(saida, arquivo);
  } else if (process.platform === 'win32') {
    const caminho = arquivo.replace(/'/g, "''");
    const desenhos: string[] = [];
    for (const l of linhas) {
      const m = l.match(/^line (\d+),(\d+) (\d+),(\d+)$/);
      if (m) desenhos.push(`$g.DrawLine($pen, ${m[1]}, ${m[2]}, ${m[3]}, ${m[4]});`);
    }
    for (const t of textos) {
      const m = t.match(/^text (\d+),(\d+) '(\d+)'$/);
      if (m) desenhos.push(`$g.DrawString('${m[3]}', $fonte, $tinta, ${m[1]}, ${m[2]});`);
    }
    const script = [
      `Add-Type -AssemblyName System.Drawing;`,
      `$orig = [System.Drawing.Image]::FromFile('${caminho}');`,
      `$bmp = New-Object System.Drawing.Bitmap(${SAIDA}, ${saidaA});`,
      `$g = [System.Drawing.Graphics]::FromImage($bmp);`,
      `$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor;`,
      `$destino = New-Object System.Drawing.Rectangle(0, 0, ${SAIDA}, ${saidaA});`,
      `$origem = New-Object System.Drawing.Rectangle(${cropX}, ${cropY}, ${cropL}, ${cropA});`,
      `$g.DrawImage($orig, $destino, $origem, [System.Drawing.GraphicsUnit]::Pixel);`,
      `$orig.Dispose();`,
      `$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(89,255,64,64), 1);`,
      `$tinta = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(242,255,64,64));`,
      `$fonte = New-Object System.Drawing.Font('Arial', 15);`,
      ...desenhos,
      `$bmp.Save('${caminho}', [System.Drawing.Imaging.ImageFormat]::Png);`,
      `$g.Dispose(); $bmp.Dispose();`
    ].join(' ');
    await runShell(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, 25000);
  }

  return { x0: u0, y0: v0, x1: u1, y1: v1 };
}

const handleScreenCapture = async (req: Request, res: Response) => {
  const platform = process.platform;
  const tmpFile = path.join(os.tmpdir(), `osone-screenshot-${crypto.randomBytes(6).toString('hex')}.png`);
  try {
    if (platform === 'win32') {
      const winPath = tmpFile.replace(/'/g, "''");
      const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size); $bmp.Save('${winPath}', [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose();`;
      await runShell(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, 15000);
    } else if (platform === 'linux') {
      const candidates = [
        `import -window root -silent "${tmpFile}"`,
        `scrot -o "${tmpFile}"`,
        `gnome-screenshot -f "${tmpFile}"`,
      ];
      let lastError = '';
      let captured = false;
      for (const cmd of candidates) {
        try {
          await runShell(cmd, 15000, USER_HOME_DIR, ambienteGrafico());
          if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 0) {
            captured = true;
            break;
          }
        } catch (err: any) {
          lastError = err.message;
        }
      }
      if (!captured) {
        throw new Error(`Nenhuma ferramenta de captura de tela disponível no sistema (tentado: ImageMagick 'import', 'scrot', 'gnome-screenshot'). ${lastError}`);
      }
    } else {
      return res.status(501).json({ error: `Captura de tela ainda não suportada na plataforma '${platform}'.` });
    }

    if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size === 0) {
      throw new Error('A captura de tela retornou vazia.');
    }
    // As dimensões vão junto com a imagem de propósito: antes a captura era devolvida "crua", e
    // quem olhasse a foto não tinha como saber a que tamanho de tela ela corresponde — uma foto
    // sem régua. Sem isso, qualquer coordenada devolvida é um chute sobre a escala.
    let tela: { width: number; height: number; offsetX: number; offsetY: number } | null = null;
    try {
      tela = await obterDimensoesDaTela();
    } catch (_) { /* a imagem sozinha ainda é útil; segue sem as dimensões */ }

    // Quando x/y vêm na requisição, a resposta deixa de ser a tela inteira e passa a ser uma
    // ampliação em volta daquele ponto — o segundo passo de uma mira em dois tempos.
    /**
     * A captura sai LIMPA por padrão; a grade vermelha só com ?grade=1.
     *
     * Ela era desenhada em toda captura para servir de régua a quem estimasse a posição a olho.
     * Como a posição passou a ser perguntada a quem olha a imagem, a grade virou o contrário de
     * ajuda: risca o conteúdo a ser reconhecido e acrescenta números que não existem na tela real
     * — e já houve tentativa de clicar nas próprias linhas.
     */
    const querGrade = String(req.query?.grade ?? '0') === '1';
    const pedeZoom = req.query?.x !== undefined && req.query?.y !== undefined;
    const zoomX = Number(req.query?.x);
    const zoomY = Number(req.query?.y);
    const janela = Math.max(40, Math.min(500, Number(req.query?.janela) || 200));

    let comGrade = false;
    let regiao: { x0: number; y0: number; x1: number; y1: number } | null = null;

    /**
     * (querGrade || pedeZoom): a ampliação é o "segundo olhar" de uma mira em dois tempos e é
     * pedida SÓ com x/y na query — não exige grade=1 junto, apesar do comentário logo acima ter
     * documentado esse comportamento desde o início. Com a condição exigindo os dois, o único
     * chamador real (capturar_tela em useLocalAgent.ts, que manda x/y mas nunca manda grade=1)
     * nunca entrava aqui: pedir para olhar de perto sempre devolvia a mesma captura de tela
     * inteira de antes, sem nenhuma ampliação nem grade.
     */
    if ((querGrade || pedeZoom) && tela && tela.width > 0 && tela.height > 0) {
      try {
        if (pedeZoom && Number.isFinite(zoomX) && Number.isFinite(zoomY)) {
          regiao = await ampliarRegiao(tmpFile, tela, zoomX, zoomY, janela);
        } else {
          await desenharGradeDeReferencia(tmpFile, tela.width, tela.height);
        }
        comGrade = true;
      } catch (err: any) {
        // Sem ImageMagick no Linux, por exemplo. A captura continua valendo — só volta a exigir
        // estimativa a olho, que é como era antes da grade existir.
        logAudit('WARN', 'SCREEN_GRID_FAILED', `Não foi possível desenhar a grade: ${err?.message || err}`, { platform });
      }
    }

    const buffer = fs.readFileSync(tmpFile);
    fs.unlink(tmpFile, () => {});

    return res.status(200).json({
      image: `data:image/png;base64,${buffer.toString('base64')}`,
      mimeType: 'image/png',
      ...(tela ? { screenWidth: tela.width, screenHeight: tela.height } : {}),
      grade: comGrade,
      ampliada: !!regiao,
      ...(regiao ? { regiao } : {}),
      // Instrução junto do dado: quem recebe a imagem precisa saber que as linhas vermelhas são
      // régua, e não parte da tela — senão pode tentar interagir com elas.
      comoUsar: regiao
        ? `AMPLIAÇÃO da região x de ${regiao.x0} a ${regiao.x1} e y de ${regiao.y0} a ${regiao.y1}, para você ler algo pequeno de perto.`
        : `Foto da tela inteira do usuário, como ela está agora. Serve para você VER o que está acontecendo — ` +
          `que janelas estão abertas, se uma ação deu certo, o que mudou. Para CLICAR em algo, não tire coordenada daqui: ` +
          `chame 'localizar' com a descrição do alvo, que devolve a coordenada pronta.`
    });
  } catch (err: any) {
    fs.unlink(tmpFile, () => {});
    logAudit('ERROR', 'SCREEN_CAPTURE_FAILED', err.message, { platform });
    return res.status(500).json({ error: `Não foi possível capturar a tela: ${err.message}. No Linux é necessário ter 'ImageMagick' (import), 'scrot' ou 'gnome-screenshot' instalado.` });
  }
};

// ============================================================================
// SEÇÃO 11: CONTROLE AMPLO DO SISTEMA (JANELAS, MÍDIA, ARQUIVOS, CONFIGURAÇÕES)
// ============================================================================

/**
 * POST /window/close - Fecha uma janela ou encerra um aplicativo pelo nome/título, sem
 * precisar que ele esteja pré-cadastrado numa allowlist (diferente de /close-app).
 */
const handleCloseWindow = async (req: Request, res: Response) => {
  const targetName = (req.body?.target || '').toString().trim();
  const force = req.body?.force === true;
  if (!targetName) {
    return res.status(400).json({ error: "Parâmetro 'target' é obrigatório (nome do app ou título da janela)." });
  }

  const platform = process.platform;
  // Remove aspas e metacaracteres de shell: o nome vem de linguagem natural do usuário e é
  // interpolado num comando, então não pode carregar ';', '&&', '|', '$(...)' etc.
  const safe = targetName.replace(/["'`;&|$<>\\]/g, '').trim();
  if (!safe) {
    return res.status(400).json({ error: 'Nome de aplicativo/janela inválido.' });
  }

  if (OWN_PROCESS_NAMES.has(safe.toLowerCase())) {
    logAudit('SECURITY', 'WINDOW_CLOSE_BLOCKED_SELF', `Recusado fechar o próprio OSONE`, { target: targetName });
    return res.status(403).json({ error: `Bloqueado: '${targetName}' encerraria o próprio OSONE, que está executando esta ação.` });
  }

  try {
    if (platform === 'win32') {
      // Tenta pelo nome do processo e, se não achar, pelo título da janela.
      const asProcess = safe.toLowerCase().endsWith('.exe') ? safe : `${safe}.exe`;
      try {
        await runShell(`taskkill ${force ? '/F ' : ''}/IM "${asProcess}"`, 8000);
      } catch {
        await runShell(`taskkill ${force ? '/F ' : ''}/FI "WINDOWTITLE eq ${safe}*"`, 8000);
      }
    } else if (platform === 'darwin') {
      await runShell(`osascript -e 'quit app "${safe}"'`, 8000);
    } else {
      // Fecha a janela educadamente (permite salvar) e só encerra o processo se necessário.
      //
      // Deliberadamente NÃO usamos 'pkill -f': essa flag casa com a linha de comando INTEIRA de
      // todo processo, então fechar "chrome" mataria qualquer processo que apenas mencionasse
      // "chrome" nos argumentos — inclusive o próprio servidor do OSONE, derrubando o app no
      // meio da ação. '-x' exige correspondência exata do nome do executável, que é o que o
      // usuário quer dizer com "feche o Spotify".
      try {
        await runShell(`wmctrl -c "${safe}"`, 6000);
      } catch {
        if (OWN_PROCESS_NAMES.has(safe.toLowerCase())) {
          throw new Error(`Recusado: '${safe}' encerraria o próprio OSONE.`);
        }
        await runShell(`${force ? 'pkill -9' : 'pkill'} -x "${safe}"`, 6000);
      }
    }
    logAudit('INFO', 'WINDOW_CLOSED', `Janela/app '${targetName}' fechado.`, { target: targetName, force, platform });
    return res.status(200).json({ success: true, message: `'${targetName}' foi fechado.` });
  } catch (err: any) {
    logAudit('ERROR', 'WINDOW_CLOSE_FAILED', err.message, { target: targetName });
    return res.status(500).json({ error: `Não foi possível fechar '${targetName}': ${err.message}. Verifique se ele está realmente aberto.` });
  }
};

/**
 * POST /media - Controla a reprodução de mídia do sistema (funciona com Spotify, YouTube no
 * navegador, players locais — qualquer app que responda às teclas de mídia do sistema).
 */
const handleMediaControl = async (req: Request, res: Response) => {
  const action = (req.body?.action || '').toString();
  const valid = ['playpause', 'play', 'pause', 'next', 'previous', 'stop'];
  if (!valid.includes(action)) {
    return res.status(400).json({ error: `Parâmetro 'action' deve ser um de: ${valid.join(', ')}.` });
  }

  const platform = process.platform;
  try {
    if (platform === 'linux') {
      const playerctlAction = action === 'previous' ? 'previous' : action === 'playpause' ? 'play-pause' : action;
      try {
        await runShell(`playerctl ${playerctlAction}`, 5000);
      } catch {
        const keyMap: Record<string, string> = {
          playpause: 'XF86AudioPlay', play: 'XF86AudioPlay', pause: 'XF86AudioPause',
          next: 'XF86AudioNext', previous: 'XF86AudioPrev', stop: 'XF86AudioStop'
        };
        await runShell(`xdotool key ${keyMap[action]}`, 5000);
      }
    } else if (platform === 'win32') {
      // Códigos de tecla virtual de mídia do Windows, disparados via user32.
      const vkMap: Record<string, number> = {
        playpause: 0xB3, play: 0xB3, pause: 0xB3, next: 0xB0, previous: 0xB1, stop: 0xB2
      };
      const vk = vkMap[action];
      const script = `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class OsoneKeys { [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo); }'; [OsoneKeys]::keybd_event(${vk},0,0,0); [OsoneKeys]::keybd_event(${vk},0,2,0);`;
      await runShell(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, 8000);
    } else {
      const osaMap: Record<string, string> = {
        playpause: 'playpause', play: 'play', pause: 'pause',
        next: 'next track', previous: 'previous track', stop: 'stop'
      };
      await runShell(`osascript -e 'tell application "Music" to ${osaMap[action]}'`, 8000);
    }
    logAudit('INFO', 'MEDIA_CONTROL', `Controle de mídia: ${action}`, { action, platform });
    return res.status(200).json({ success: true, action });
  } catch (err: any) {
    return res.status(500).json({ error: `Não foi possível controlar a mídia (${action}): ${err.message}` });
  }
};

/**
 * POST /path/delete - Apaga QUALQUER arquivo ou pasta do computador, movendo para a lixeira do
 * agente (reversível). O único caminho recusado é a própria instalação do OSONE — cópias e
 * clones do projeto em outros lugares podem ser apagados normalmente.
 */
const handleDeletePath = (req: Request, res: Response) => {
  const rawTarget = (req.body?.target || '').toString().trim();
  if (!rawTarget) {
    return res.status(400).json({ error: "Parâmetro 'target' é obrigatório (caminho do arquivo ou pasta)." });
  }

  // resolveAnyPath, não expandHomePath: expandHomePath só trata '~'. Um caminho relativo sem
  // barra/til (ex: "notas.txt", como um modelo às vezes escreve) caía em path.resolve() puro,
  // que resolve contra process.cwd() — a pasta de dados do próprio app empacotado, não a do
  // usuário. 'target' apagava (ou tentava apagar) o arquivo errado, silenciosamente.
  const targetPath = path.resolve(resolveAnyPath(rawTarget));

  if (isProtectedInstallPath(targetPath)) {
    logAudit('SECURITY', 'DELETE_BLOCKED_SELF', `Exclusão bloqueada: caminho pertence à instalação do OSONE`, { targetPath });
    return res.status(403).json({
      error: `Bloqueado: '${targetPath}' faz parte da instalação do OSONE em uso (${OSONE_INSTALL_DIR}), a única coisa que não pode ser apagada. Cópias e clones em outros caminhos podem.`
    });
  }

  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: `O caminho '${targetPath}' não existe.` });
  }

  try {
    if (!fs.existsSync(TRASH_DIR_PATH)) fs.mkdirSync(TRASH_DIR_PATH, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(TRASH_DIR_PATH, `${stamp}__${path.basename(targetPath)}`);
    // Renomear falha entre sistemas de arquivos diferentes; nesse caso copiamos e removemos.
    try {
      fs.renameSync(targetPath, destination);
    } catch {
      fs.cpSync(targetPath, destination, { recursive: true });
      fs.rmSync(targetPath, { recursive: true, force: true });
    }
    logAudit('INFO', 'PATH_DELETED', `'${targetPath}' movido para a lixeira do agente.`, { targetPath, destination });
    return res.status(200).json({
      success: true,
      message: `'${path.basename(targetPath)}' foi movido para a lixeira do OSONE (reversível).`,
      restorePath: destination
    });
  } catch (err: any) {
    logAudit('ERROR', 'PATH_DELETE_FAILED', err.message, { targetPath });
    return res.status(500).json({ error: `Não foi possível apagar '${targetPath}': ${err.message}` });
  }
};

/**
 * POST /path/manage - Move, copia ou renomeia qualquer caminho do computador (usado para
 * organizar pastas conforme o pedido do usuário).
 */
const handleManagePath = (req: Request, res: Response) => {
  const action = (req.body?.action || '').toString();
  // resolveAnyPath pelo mesmo motivo de handleDeletePath: caminho relativo sem '~' não pode cair
  // em path.resolve() puro, que resolveria contra a pasta do próprio app, não a do usuário.
  const source = path.resolve(resolveAnyPath((req.body?.source || '').toString()));
  const destination = path.resolve(resolveAnyPath((req.body?.destination || '').toString()));

  if (!['move', 'copy', 'rename'].includes(action)) {
    return res.status(400).json({ error: "Parâmetro 'action' deve ser 'move', 'copy' ou 'rename'." });
  }
  if (!req.body?.source || !req.body?.destination) {
    return res.status(400).json({ error: "Parâmetros 'source' e 'destination' são obrigatórios." });
  }
  // Copiar PARA fora da instalação é livre; apenas alterar/remover a instalação é proibido.
  if (action !== 'copy' && isProtectedInstallPath(source)) {
    return res.status(403).json({ error: `Bloqueado: '${source}' faz parte da instalação do OSONE em uso e não pode ser movida/renomeada.` });
  }
  if (isProtectedInstallPath(destination)) {
    return res.status(403).json({ error: `Bloqueado: não é permitido escrever dentro da instalação do OSONE (${OSONE_INSTALL_DIR}).` });
  }
  if (!fs.existsSync(source)) {
    return res.status(404).json({ error: `A origem '${source}' não existe.` });
  }

  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (action === 'copy') {
      fs.cpSync(source, destination, { recursive: true });
    } else {
      try {
        fs.renameSync(source, destination);
      } catch {
        fs.cpSync(source, destination, { recursive: true });
        fs.rmSync(source, { recursive: true, force: true });
      }
    }
    logAudit('INFO', 'PATH_MANAGED', `${action}: '${source}' -> '${destination}'`, { action, source, destination });
    return res.status(200).json({ success: true, action, source, destination });
  } catch (err: any) {
    logAudit('ERROR', 'PATH_MANAGE_FAILED', err.message, { action, source, destination });
    return res.status(500).json({ error: `Falha ao ${action} '${source}': ${err.message}` });
  }
};

/**
 * POST /system/settings - Abre painéis de configuração do sistema (câmera, privacidade, som,
 * rede, display, bluetooth, etc.).
 */
const handleOpenSettings = async (req: Request, res: Response) => {
  const panel = (req.body?.panel || 'main').toString().toLowerCase();
  const platform = process.platform;

  const WINDOWS_PANELS: Record<string, string> = {
    main: 'ms-settings:', camera: 'ms-settings:privacy-webcam', microphone: 'ms-settings:privacy-microphone',
    sound: 'ms-settings:sound', display: 'ms-settings:display', network: 'ms-settings:network',
    bluetooth: 'ms-settings:bluetooth', privacy: 'ms-settings:privacy', apps: 'ms-settings:appsfeatures',
    power: 'ms-settings:powersleep', update: 'ms-settings:windowsupdate', taskbar: 'ms-settings:taskbar'
  };
  const LINUX_PANELS: Record<string, string> = {
    main: '', camera: 'camera', microphone: 'sound', sound: 'sound', display: 'display',
    network: 'network', bluetooth: 'bluetooth', privacy: 'privacy', apps: 'applications',
    power: 'power', update: 'info-overview', taskbar: 'ubuntu'
  };

  try {
    if (platform === 'win32') {
      const uri = WINDOWS_PANELS[panel] || WINDOWS_PANELS.main;
      await runShell(`start "" "${uri}"`, 6000);
    } else if (platform === 'darwin') {
      await runShell(`open -a "System Settings"`, 6000);
    } else {
      const section = LINUX_PANELS[panel] ?? '';
      await tryCommandsInOrder([
        `gnome-control-center ${section}`.trim(),
        `systemsettings5 ${section}`.trim(),
        'xfce4-settings-manager',
        'gnome-control-center'
      ]);
    }
    logAudit('INFO', 'SETTINGS_OPENED', `Painel de configurações '${panel}' aberto.`, { panel, platform });
    return res.status(200).json({ success: true, panel });
  } catch (err: any) {
    return res.status(500).json({ error: `Não foi possível abrir as configurações ('${panel}'): ${err.message}` });
  }
};

/**
 * POST /path/list - Lista o conteúdo de qualquer pasta, para o agente inspecionar antes de
 * organizar/apagar em vez de agir às cegas.
 */
const handleListPath = (req: Request, res: Response) => {
  const rawTarget = (req.body?.target || '').toString().trim();
  // resolveAnyPath pelo mesmo motivo dos outros dois handlers acima; e um alvo vazio já resolve
  // para a pasta pessoal do usuário sozinho (regra 0 de resolverCaminho), sem precisar de um
  // fallback explícito para USER_HOME_DIR aqui.
  const targetPath = path.resolve(resolveAnyPath(rawTarget));

  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: `A pasta '${targetPath}' não existe.` });
  }

  try {
    const stats = fs.statSync(targetPath);
    if (!stats.isDirectory()) {
      return res.status(200).json({ path: targetPath, isDirectory: false, sizeBytes: stats.size });
    }
    const entries = fs.readdirSync(targetPath, { withFileTypes: true }).slice(0, 500).map((entry) => {
      const full = path.join(targetPath, entry.name);
      let sizeBytes: number | null = null;
      try { sizeBytes = entry.isFile() ? fs.statSync(full).size : null; } catch { /* sem permissão de leitura */ }
      return { name: entry.name, path: full, isDirectory: entry.isDirectory(), sizeBytes };
    });
    return res.status(200).json({ path: targetPath, isDirectory: true, entries });
  } catch (err: any) {
    return res.status(500).json({ error: `Não foi possível listar '${targetPath}': ${err.message}` });
  }
};

// ============================================================================
// SEÇÃO 13: A ÁREA PARALELA — O AGENTE TRABALHA NA TELA DELE, VOCÊ NA SUA
// ============================================================================

/**
 * O PROBLEMA QUE ISTO RESOLVE, E POR QUE NÃO HAVIA JEITO SEM ELE.
 *
 * Um agente que move o mouse e digita age sobre a tela que existe — a mesma em que a pessoa está
 * trabalhando. Isso obriga a uma escolha ruim: ou você para de mexer no computador enquanto ele
 * trabalha, ou vocês dois disputam o mesmo cursor e o mesmo foco de janela, e os dois erram.
 * Trazer a janela dele para frente antes de agir resolvia a correção do clique, mas ao preço de
 * tomar a sua tela.
 *
 * A ÁREA PARALELA é um segundo servidor gráfico, na memória, sem monitor. As janelas que o agente
 * abre nascem lá; o mouse e o teclado que ele usa são os de lá; a foto que ele tira é de lá. Nada
 * disso encosta na sua tela — seu cursor continua seu, seu foco continua seu, e você pode estar em
 * qualquer aba ou programa enquanto ele trabalha. Você acompanha pela imagem, dentro da aba do
 * COWORK, sem precisar sair de onde está.
 *
 * O QUE DECIDE ISSO É UMA VARIÁVEL SÓ: DISPLAY. Todo comando gráfico (xdotool, import, o próprio
 * navegador ao abrir) age no servidor gráfico que essa variável apontar. Por isso ela viaja pelo
 * ambiente de cada comando, e não por um parâmetro em cada função.
 *
 * ONDE FUNCIONA: Linux com Xvfb instalado. É uma limitação real e vale dizê-la sem rodeio — no
 * Windows não existe equivalente que aceite mouse e teclado sintéticos numa área separada de forma
 * confiável, então lá o agente continua trabalhando na tela compartilhada, trazendo a janela dele
 * para frente. A aba avisa em qual dos dois modos está.
 */

interface AreaParalela {
  display: string;
  largura: number;
  altura: number;
  /** O servidor gráfico sem monitor. */
  xvfb: any;
  /** O gerenciador de janelas, quando havia um instalado. Sem ele as janelas abrem sem moldura. */
  gerenciador: any | null;
  nomeDoGerenciador: string | null;
  desde: number;
}

let areaParalela: AreaParalela | null = null;

/** O ambiente com que os comandos gráficos rodam: a área paralela, quando ligada. */
function ambienteGrafico(): NodeJS.ProcessEnv {
  if (!areaParalela) return process.env;
  return { ...process.env, DISPLAY: areaParalela.display };
}

/** Um número de display que ainda não está em uso (o :0 é sempre o da pessoa). */
function acharDisplayLivre(): string {
  for (let n = 91; n < 120; n++) {
    if (!fs.existsSync(`/tmp/.X11-unix/X${n}`) && !fs.existsSync(`/tmp/.X${n}-lock`)) return `:${n}`;
  }
  throw new Error('Nenhum número de display livre entre :91 e :119.');
}

/**
 * Gerenciadores de janela leves, em ordem de preferência.
 *
 * Sem um gerenciador, as janelas abrem sem moldura, empilhadas no canto e sem serem gerenciáveis
 * — e o wmctrl, que lê a lista de janelas pelo padrão EWMH, não devolve nada. Dá para trabalhar
 * assim (o xdotool ainda enxerga as janelas), mas com um gerenciador tudo se comporta como numa
 * tela de verdade. Por isso: usa o que houver, e segue sem se não houver nenhum.
 */
const GERENCIADORES_LEVES = ['openbox', 'xfwm4', 'marco', 'fluxbox', 'i3', 'mutter'];

const handleDesktopStart = async (req: Request, res: Response) => {
  if (process.platform !== 'linux') {
    return res.status(501).json({
      naoSuportado: true,
      error: `A área paralela precisa de um segundo servidor gráfico e hoje só existe no Linux (com Xvfb). ` +
        `Nesta plataforma ('${process.platform}') o agente trabalha na tela compartilhada: ele traz a janela dele para frente antes de agir.`
    });
  }
  if (areaParalela) {
    return res.status(200).json({ jaEstavaLigada: true, ...estadoDaArea() });
  }

  const largura = Math.max(800, Math.min(3840, Number(req.body?.largura) || 1600));
  const altura = Math.max(600, Math.min(2160, Number(req.body?.altura) || 900));

  if (!(await binaryExists('Xvfb'))) {
    return res.status(501).json({
      faltaXvfb: true,
      error: `O Xvfb não está instalado, e é ele que cria a tela do agente. ` +
        `Instale com: sudo apt install xvfb   (ou o equivalente da sua distribuição). ` +
        `Sem ele, o agente continua funcionando — mas na sua tela, trazendo a janela dele para frente.`
    });
  }

  let display: string;
  try {
    display = acharDisplayLivre();
  } catch (err: any) {
    return res.status(500).json({ error: `Não foi possível reservar uma tela para o agente: ${err.message}` });
  }

  const xvfb = spawn('Xvfb', [display, '-screen', '0', `${largura}x${altura}x24`, '-nolisten', 'tcp'], {
    detached: true, stdio: 'ignore'
  });
  /**
   * Um Xvfb que morre logo depois de subir (versão incompatível, permissão negada em /tmp) deixaria
   * a área "ligada" e tudo falhando adiante sem ninguém saber por quê. Guardar o erro aqui é o que
   * transforma isso numa mensagem em vez de num mistério.
   */
  let morreuAoSubir = '';
  xvfb.on('error', (e: any) => { morreuAoSubir = e?.message || String(e); });
  xvfb.on('exit', (codigo: number | null) => {
    if (areaParalela && areaParalela.xvfb === xvfb) {
      logAudit('ERROR', 'DESKTOP_DIED', `A tela do agente (${display}) encerrou sozinha (código ${codigo}).`, { display });
      areaParalela = null;
      dimensoesEmCache = null;
    }
  });
  xvfb.unref();

  // O servidor gráfico leva um instante para aceitar conexões; abrir um programa antes disso
  // falha com "cannot open display", que parece falta de suporte e é só pressa.
  await new Promise(r => setTimeout(r, 800));

  if (morreuAoSubir || xvfb.exitCode !== null) {
    return res.status(500).json({
      error: `O Xvfb não conseguiu subir a tela do agente${morreuAoSubir ? `: ${morreuAoSubir}` : ' (encerrou logo ao iniciar)'}. ` +
        `O agente continua funcionando na sua tela.`
    });
  }

  const ambiente = { ...process.env, DISPLAY: display };
  let gerenciador: any = null;
  let nomeDoGerenciador: string | null = null;
  for (const wm of GERENCIADORES_LEVES) {
    if (await binaryExists(wm)) {
      gerenciador = spawn(wm, [], { detached: true, stdio: 'ignore', env: ambiente });
      gerenciador.unref();
      nomeDoGerenciador = wm;
      await new Promise(r => setTimeout(r, 500));
      break;
    }
  }

  areaParalela = { display, largura, altura, xvfb, gerenciador, nomeDoGerenciador, desde: Date.now() };
  // A resolução em cache é a da tela do usuário; com a área ligada ela deixou de valer.
  dimensoesEmCache = null;
  logAudit('INFO', 'DESKTOP_START', `Área paralela ligada em ${display} (${largura}x${altura}).`, { display, gerenciador: nomeDoGerenciador });

  return res.status(200).json(estadoDaArea());
};

function estadoDaArea() {
  if (!areaParalela) {
    return {
      ligada: false,
      suportada: process.platform === 'linux',
      explicacao: process.platform === 'linux'
        ? 'A área paralela está desligada: o agente trabalha na sua tela e traz a janela dele para frente antes de agir.'
        : `Nesta plataforma ('${process.platform}') a área paralela não existe; o agente trabalha na tela compartilhada.`
    };
  }
  return {
    ligada: true,
    suportada: true,
    display: areaParalela.display,
    largura: areaParalela.largura,
    altura: areaParalela.altura,
    gerenciadorDeJanelas: areaParalela.nomeDoGerenciador,
    desde: areaParalela.desde,
    explicacao: areaParalela.nomeDoGerenciador
      ? `O agente trabalha numa tela própria de ${areaParalela.largura}x${areaParalela.altura}. Seu mouse e seu teclado continuam só seus.`
      : `O agente trabalha numa tela própria de ${areaParalela.largura}x${areaParalela.altura}. ` +
        `Nenhum gerenciador de janelas foi encontrado, então as janelas dele abrem sem moldura — funciona, mas fica mais cru.`
  };
}

const handleDesktopStatus = (_req: Request, res: Response) => res.status(200).json(estadoDaArea());

const handleDesktopStop = (_req: Request, res: Response) => {
  if (!areaParalela) return res.status(200).json(estadoDaArea());
  const { display, xvfb, gerenciador } = areaParalela;
  // Os programas que o agente abriu morrem junto com o servidor gráfico deles — é o que se quer:
  // eles nunca existiram na tela do usuário e não devem sobrar por lá.
  try { gerenciador?.kill('SIGTERM'); } catch { /* já não estava vivo */ }
  try { xvfb?.kill('SIGTERM'); } catch { /* idem */ }
  areaParalela = null;
  dimensoesEmCache = null;
  logAudit('INFO', 'DESKTOP_STOP', `Área paralela ${display} desligada.`, { display });
  return res.status(200).json(estadoDaArea());
};

/**
 * GET /desktop/capture — a foto da tela do agente, para a aba mostrar ao vivo.
 *
 * Esta captura pode ser pedida de segundo em segundo sem incomodar ninguém, e é essa a diferença
 * que interessa: fotografar a tela do usuário repetidamente disputa recursos com o que ele está
 * fazendo, fotografar uma tela na memória não disputa com nada.
 */
function metadadosDeCaptura(req: Request) {
  return {
    captureId: crypto.randomUUID(),
    requestId: String(req.query?.requestId || ''),
    // Criado depois que o PNG foi lido: este horário descreve o frame entregue, não o começo de
    // uma operação lenta de captura.
    capturedAt: Date.now()
  };
}

function impedirCacheDeCaptura(res: Response) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

const handleDesktopCapture = async (req: Request, res: Response) => {
  if (!areaParalela) {
    return res.status(409).json({ error: 'A área paralela não está ligada.' });
  }
  const tmpFile = path.join(os.tmpdir(), `osone-area-${crypto.randomBytes(6).toString('hex')}.png`);
  try {
    await runShell(`import -window root -silent "${tmpFile}"`, 12000, USER_HOME_DIR, ambienteGrafico());
    if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size === 0) {
      throw new Error('a captura saiu vazia');
    }
    const buffer = fs.readFileSync(tmpFile);
    fs.unlink(tmpFile, () => {});
    impedirCacheDeCaptura(res);
    return res.status(200).json({
      image: `data:image/png;base64,${buffer.toString('base64')}`,
      mimeType: 'image/png',
      largura: areaParalela.largura,
      altura: areaParalela.altura,
      ...metadadosDeCaptura(req)
    });
  } catch (err: any) {
    fs.unlink(tmpFile, () => {});
    return res.status(500).json({
      error: `Não foi possível fotografar a área paralela: ${err.message}. É necessário ter o ImageMagick ('import') instalado.`
    });
  }
};

// ============================================================================
// SEÇÃO 14: JANELAS — ESCOLHER UMA E TRABALHAR DENTRO DELA
// ============================================================================

/**
 * POR QUE O AGENTE PRECISA ENXERGAR UMA JANELA, E NÃO A TELA INTEIRA.
 *
 * Até aqui a única visão disponível era a tela toda. Isso obriga o modelo a reencontrar, a cada
 * foto, qual pedaço da imagem é o programa em que ele está trabalhando — e a tela toda inclui o
 * próprio OSONE, outras janelas, notificações que aparecem por cima. Quando o usuário troca de
 * janela no meio, a foto muda inteira e o agente perde o fio sem ter feito nada errado.
 *
 * Escolhida uma janela, a foto passa a ser só dela: o conteúdo do quadro é sempre o mesmo
 * programa, as coordenadas são relativas a ele, e o que acontece fora dele deixa de ser ruído.
 * É a diferença entre "olhe a mesa inteira e ache o caderno" e "olhe o caderno".
 *
 * O QUE ISTO NÃO CONSEGUE FAZER, e é melhor dizer do que fingir: clicar numa janela que está
 * atrás de outra. Mouse e teclado do sistema agem sobre o que está NA FRENTE, em qualquer sistema
 * operacional — não existe clique invisível numa janela de fundo. Por isso o agente traz a janela
 * dele para frente antes de agir. Você não precisa manter a janela selecionada, nem ficar
 * escolhendo: ele mesmo se coloca onde precisa estar, e volta a olhar só o quadro dela.
 */

interface JanelaDoSistema {
  id: string;
  titulo: string;
  app: string;
  x: number;
  y: number;
  width: number;
  height: number;
  ativa: boolean;
}

/**
 * O identificador de janela é interpolado em comandos, então é conferido antes de qualquer uso.
 *
 * Ele vem do cliente, que o recebeu de uma listagem nossa — mas "veio de nós" não é garantia
 * nenhuma depois de dar uma volta pela rede. Aceitar só hexadecimal/decimal fecha a porta de
 * injeção sem precisar confiar em quem chamou.
 */
const idDeJanelaValido = (id: string): boolean => /^(0x)?[0-9a-fA-F]{1,16}$/.test((id || '').trim());

/** As janelas perguntadas direto ao servidor gráfico, sem depender de gerenciador de janelas. */
async function listarJanelasPeloXdotool(): Promise<JanelaDoSistema[]> {
  const env = ambienteGrafico();
  const { stdout } = await runShell('xdotool search --onlyvisible --name ".+"', 6000, USER_HOME_DIR, env);
  const ids = stdout.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 40);
  let ativa = '';
  try {
    const r = await runShell('xdotool getactivewindow', 3000, USER_HOME_DIR, env);
    ativa = r.stdout.trim();
  } catch { /* sem janela em foco: a lista continua valendo */ }

  const janelas: JanelaDoSistema[] = [];
  for (const id of ids) {
    try {
      const g = await runShell(`xdotool getwindowgeometry --shell ${Number(id)}`, 3000, USER_HOME_DIR, env);
      const n = (chave: string) => Number(g.stdout.match(new RegExp(`^${chave}=(-?\\d+)`, 'm'))?.[1]);
      const nome = await runShell(`xdotool getwindowname ${Number(id)}`, 3000, USER_HOME_DIR, env).catch(() => ({ stdout: '' }));
      const width = n('WIDTH'), height = n('HEIGHT');
      if (!Number.isFinite(width) || width <= 120 || height <= 80) continue;
      janelas.push({
        // O hexadecimal é o formato que o resto do código espera (e o wmctrl devolve).
        id: '0x' + Number(id).toString(16).padStart(8, '0'),
        titulo: nome.stdout.trim() || `Janela ${id}`,
        app: 'x11',
        x: n('X') || 0, y: n('Y') || 0, width, height,
        ativa: id === ativa
      });
    } catch { /* janela que sumiu entre a busca e a consulta: só não entra na lista */ }
  }
  return janelas;
}

async function listarJanelas(): Promise<JanelaDoSistema[]> {
  const platform = process.platform;

  if (platform === 'linux') {
    // wmctrl -lGx: id, área de trabalho, x, y, largura, altura, classe, host, título.
    let stdout = '';
    try {
      ({ stdout } = await runShell('wmctrl -lGx', 6000, USER_HOME_DIR, ambienteGrafico()));
    } catch (err) {
      /**
       * O wmctrl lê a lista pelo padrão EWMH, que quem publica é o GERENCIADOR de janelas. Numa
       * área paralela sem gerenciador instalado não há quem publique, e ele falha — mesmo com as
       * janelas ali, abertas e funcionando. O xdotool pergunta ao servidor gráfico direto, então
       * enxerga as janelas de qualquer jeito. É mais cru (uma consulta de geometria por janela),
       * e por isso é o segundo caminho e não o primeiro.
       */
      return await listarJanelasPeloXdotool();
    }
    if (!stdout.trim()) return await listarJanelasPeloXdotool();
    let ativa = '';
    try {
      const r = await runShell('xdotool getactivewindow', 3000, USER_HOME_DIR, ambienteGrafico());
      // wmctrl usa hexadecimal com zeros à esquerda; xdotool devolve decimal. Sem normalizar,
      // nenhuma janela jamais apareceria como ativa.
      ativa = '0x' + Number(r.stdout.trim()).toString(16).padStart(8, '0');
    } catch { /* sem xdotool: a lista continua útil, só não sabe qual está na frente */ }

    return stdout.split('\n').map(linha => {
      const p = linha.trim().split(/\s+/);
      if (p.length < 8) return null;
      const [id, , x, y, width, height, classe, ...resto] = p;
      // O host é o primeiro do resto; o título é tudo o que sobra (e tem espaços).
      const titulo = resto.slice(1).join(' ');
      return {
        id,
        titulo: titulo || classe,
        app: (classe.split('.').pop() || classe),
        x: Number(x), y: Number(y), width: Number(width), height: Number(height),
        ativa: id.toLowerCase() === ativa.toLowerCase()
      };
    }).filter((j): j is JanelaDoSistema =>
      // Janelas de tamanho degenerado são painéis, barras e janelas ocultas: listá-las só
      // enche a escolha do usuário de linhas em que não dá para trabalhar.
      !!j && Number.isFinite(j.width) && j.width > 120 && j.height > 80);
  }

  if (platform === 'win32') {
    const script = [
      'Add-Type @"',
      'using System;using System.Runtime.InteropServices;',
      'public struct R{public int L;public int T;public int Rr;public int B;}',
      'public class W{[DllImport(\\"user32.dll\\")]public static extern bool GetWindowRect(IntPtr h,out R r);',
      '[DllImport(\\"user32.dll\\")]public static extern IntPtr GetForegroundWindow();}',
      '"@;',
      '$fg=[W]::GetForegroundWindow();',
      'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object {',
      '$r=New-Object R; [void][W]::GetWindowRect($_.MainWindowHandle,[ref]$r);',
      'Write-Output ("{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}" -f $_.MainWindowHandle,$_.ProcessName,$r.L,$r.T,($r.Rr-$r.L),($r.B-$r.T),($(if($_.MainWindowHandle -eq $fg){1}else{0})),$_.MainWindowTitle) }'
    ].join(' ');
    const { stdout } = await runShell(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, 12000);

    return stdout.split('\n').map(linha => {
      const p = linha.trim().split('|');
      if (p.length < 8) return null;
      return {
        id: p[0], app: p[1],
        x: Number(p[2]), y: Number(p[3]), width: Number(p[4]), height: Number(p[5]),
        ativa: p[6] === '1', titulo: p.slice(7).join('|')
      };
    }).filter((j): j is JanelaDoSistema =>
      !!j && Number.isFinite(j.width) && j.width > 120 && j.height > 80);
  }

  throw new Error(`Listagem de janelas ainda não suportada na plataforma '${platform}'.`);
}

async function focarJanela(id: string): Promise<void> {
  if (!idDeJanelaValido(id)) throw new Error('Identificador de janela inválido.');
  if (process.platform === 'linux') {
    try {
      await runShell(`wmctrl -i -a ${id}`, 5000, USER_HOME_DIR, ambienteGrafico());
    } catch {
      await runShell(`xdotool windowactivate ${Number(id)}`, 5000, USER_HOME_DIR, ambienteGrafico());
    }
    return;
  }
  if (process.platform === 'win32') {
    const script = [
      'Add-Type @"',
      'using System;using System.Runtime.InteropServices;',
      'public class F{[DllImport(\\"user32.dll\\")]public static extern bool SetForegroundWindow(IntPtr h);',
      '[DllImport(\\"user32.dll\\")]public static extern bool ShowWindow(IntPtr h,int c);}',
      '"@;',
      // 9 = SW_RESTORE: uma janela minimizada precisa voltar antes de poder vir para frente.
      `[void][F]::ShowWindow([IntPtr]${Number(id)},9); [void][F]::SetForegroundWindow([IntPtr]${Number(id)});`
    ].join(' ');
    await runShell(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, 8000);
    return;
  }
  throw new Error(`Foco de janela ainda não suportado na plataforma '${process.platform}'.`);
}

/** A geometria RECÉM-LIDA da janela: ela pode ter sido movida ou redimensionada desde a listagem. */
async function geometriaDaJanela(id: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const todas = await listarJanelas().catch(() => [] as JanelaDoSistema[]);
  const achou = todas.find(j => j.id.toLowerCase() === id.toLowerCase());
  return achou ? { x: achou.x, y: achou.y, width: achou.width, height: achou.height } : null;
}

/**
 * GET /window/list — as janelas abertas, com título, aplicativo e posição.
 */
const handleWindowList = async (_req: Request, res: Response) => {
  try {
    const janelas = await listarJanelas();
    return res.status(200).json({ janelas });
  } catch (err: any) {
    return res.status(500).json({
      error: `Não foi possível listar as janelas: ${err.message}. ` +
        `No Linux é necessário ter os pacotes 'wmctrl' e 'xdotool' instalados.`
    });
  }
};

/**
 * POST /window/focus — traz uma janela para a frente, para poder agir nela.
 */
const handleWindowFocus = async (req: Request, res: Response) => {
  const id = String(req.body?.id || '').trim();
  if (!idDeJanelaValido(id)) {
    return res.status(400).json({ error: "Parâmetro 'id' inválido (identificador de janela)." });
  }
  try {
    await focarJanela(id);
    // A geometria volta junto porque quem foca vai agir logo em seguida, e agir exige saber onde
    // a janela está AGORA — trazê-la para frente é justamente um dos momentos em que ela se move.
    const geometria = await geometriaDaJanela(id);
    return res.status(200).json({ success: true, geometria });
  } catch (err: any) {
    return res.status(500).json({ error: `Não foi possível trazer a janela para frente: ${err.message}` });
  }
};

/**
 * GET /window/capture?id=... — a foto de UMA janela, e não da tela inteira.
 *
 * Por padrão a janela é trazida para frente antes da foto. Capturas internas de estabilização
 * podem enviar `focus=0&geometry=0`: elas acontecem logo depois de uma ação já focada, servem só
 * para comparar pixels e não precisam pagar outro redesenho nem relistar todas as janelas.
 */
const handleWindowCapture = async (req: Request, res: Response) => {
  const id = String(req.query?.id || '').trim();
  if (!idDeJanelaValido(id)) {
    return res.status(400).json({ error: "Parâmetro 'id' inválido (identificador de janela)." });
  }

  const platform = process.platform;
  const deveFocar = String(req.query?.focus ?? '1') !== '0';
  const deveMedirGeometria = String(req.query?.geometry ?? '1') !== '0';
  const tmpFile = path.join(os.tmpdir(), `osone-janela-${crypto.randomBytes(6).toString('hex')}.png`);
  try {
    if (deveFocar) {
      await focarJanela(id).catch(() => { /* segue: em alguns gerenciadores a foto ainda sai certa */ });
      // Só a captura que realmente pediu foco espera o gerenciador redesenhar. As fotos internas
      // de estabilização já começam depois da espera adaptativa e não podem pagar 250ms cada uma.
      await new Promise(r => setTimeout(r, 250));
    }

    let geometria = (platform === 'win32' || deveMedirGeometria)
      ? await geometriaDaJanela(id)
      : null;

    if (platform === 'linux') {
      try {
        await runShell(`import -window ${id} -silent "${tmpFile}"`, 15000, USER_HOME_DIR, ambienteGrafico());
      } catch (err: any) {
        // Sem ImageMagick, recorta a janela da tela inteira: precisa da geometria, mas funciona
        // com qualquer ferramenta de captura já instalada.
        if (!geometria) geometria = await geometriaDaJanela(id);
        if (!geometria) throw err;
        await runShell(`scrot -o "${tmpFile}" && convert "${tmpFile}" -crop ${geometria.width}x${geometria.height}+${geometria.x}+${geometria.y} +repage "${tmpFile}"`, 15000, USER_HOME_DIR, ambienteGrafico());
      }
    } else if (platform === 'win32') {
      if (!geometria) throw new Error('Não foi possível ler a posição da janela.');
      const winPath = tmpFile.replace(/'/g, "''");
      const script = `Add-Type -AssemblyName System.Drawing; $bmp = New-Object System.Drawing.Bitmap(${geometria.width}, ${geometria.height}); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(${geometria.x}, ${geometria.y}, 0, 0, $bmp.Size); $bmp.Save('${winPath}', [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose();`;
      await runShell(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, 15000);
    } else {
      return res.status(501).json({ error: `Captura de janela ainda não suportada na plataforma '${platform}'.` });
    }

    if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size === 0) {
      throw new Error('A captura da janela retornou vazia.');
    }
    const buffer = fs.readFileSync(tmpFile);
    fs.unlink(tmpFile, () => {});

    impedirCacheDeCaptura(res);
    return res.status(200).json({
      image: `data:image/png;base64,${buffer.toString('base64')}`,
      mimeType: 'image/png',
      janela: geometria,
      ...metadadosDeCaptura(req),
      /**
       * A régua vai junto da foto: quem olhar esta imagem vai apontar posições nela em 0–1000, e
       * essas posições precisam ser convertidas de volta para pixels da TELA na hora de clicar.
       * Sem dizer onde a janela está, a conversão não tem como ser feita.
       */
      comoUsar: geometria
        ? `Foto SÓ desta janela (${geometria.width}x${geometria.height}, canto em ${geometria.x},${geometria.y} da tela). ` +
          `Posições apontadas nesta imagem são relativas à JANELA, não à tela.`
        : 'Foto desta janela. A posição dela na tela não pôde ser lida.'
    });
  } catch (err: any) {
    fs.unlink(tmpFile, () => {});
    logAudit('ERROR', 'WINDOW_CAPTURE_FAILED', err.message, { platform, id });
    return res.status(500).json({
      error: `Não foi possível capturar a janela: ${err.message}. ` +
        `No Linux é necessário ter 'wmctrl', 'xdotool' e ImageMagick ('import') instalados.`
    });
  }
};

// ============================================================================
// SEÇÃO 15: OLLAMA LOCAL — INSTALAR, BAIXAR O QWEN E VERIFICAR (OSONE CODE OFFLINE)
// ============================================================================

/**
 * Ache o binário `ollama` mesmo quando ele não está no PATH do processo.
 *
 * No Windows o instalador coloca em %LOCALAPPDATA%\Programs\Ollama e não atualiza o PATH de um
 * processo que já estava aberto; no Linux com a instalação sem systemd/binário solto o mesmo
 * acontece. Sem esta busca, o OSONE concluiria "Ollama não instalado" numa máquina onde ele foi
 * instalado pelo próprio botão minutos antes.
 */
function localizarBinarioDoOllama(): string | null {
  try {
    const saida = execSync(process.platform === 'win32' ? 'where ollama' : 'command -v ollama', {
      timeout: 5000, windowsHide: true, encoding: 'utf-8'
    });
    const primeiro = saida.split(/\r?\n/).map(l => l.trim()).find(Boolean);
    if (primeiro && fs.existsSync(primeiro)) return primeiro;
  } catch { /* não está no PATH — ainda há candidatos fixos abaixo */ }

  const candidatos: string[] = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(USER_HOME_DIR, 'AppData', 'Local');
    candidatos.push(path.join(local, 'Programs', 'Ollama', 'ollama.exe'));
  } else {
    candidatos.push('/usr/local/bin/ollama', '/usr/bin/ollama', path.join(USER_HOME_DIR, '.ollama', 'bin', 'ollama'));
  }
  for (const candidato of candidatos) {
    try { if (fs.existsSync(candidato)) return candidato; } catch { /* segue procurando */ }
  }
  return null;
}

/** Roda `ollama <args>` direto no binário, sem interpolação de shell. */
async function executarOllama(args: string[], timeoutMs: number): Promise<string> {
  const bin = localizarBinarioDoOllama();
  if (!bin) throw new Error('Ollama não encontrado neste computador.');
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr?.toString().trim() || error.message));
      resolve(stdout?.toString() || '');
    });
  });
}

/** GET /ollama/status — o que existe, o que roda e quais modelos já foram baixados. */
const handleOllamaStatus = async (_req: Request, res: Response) => {
  const binario = localizarBinarioDoOllama();
  let servidorRespondendo = false;
  try {
    const resposta = await fetch('http://127.0.0.1:11434/api/version', { signal: AbortSignal.timeout(3000) });
    servidorRespondendo = resposta.ok;
  } catch { /* servidor parado é estado normal aqui, não erro */ }

  let modelosBaixados: string[] = [];
  if (binario) {
    try {
      const saida = await executarOllama(['list'], 15000);
      modelosBaixados = saida.split(/\r?\n/).slice(1)
        .map(linha => linha.trim().split(/\s+/)[0]).filter(Boolean);
    } catch (err: any) {
      logAudit('WARN', 'OLLAMA_LIST_FALHOU', `Não foi possível listar os modelos do Ollama: ${err?.message}`);
    }
  }

  const mensagem = !binario
    ? 'Ollama não está instalado neste computador. Use o botão de instalação do OSONE CODE.'
    : !servidorRespondendo
      ? 'Ollama instalado, mas o servidor não está respondendo na porta 11434.'
      : 'Servidor local pronto para gerar código.';

  logAudit('INFO', 'OLLAMA_STATUS', `Estado do Ollama consultado`, { binario, servidorRespondendo, totalModelos: modelosBaixados.length });
  return res.status(200).json({
    plataforma: process.platform,
    instalado: Boolean(binario),
    caminhoDoBinario: binario || undefined,
    servidorRespondendo,
    endpointVerificado: 'http://127.0.0.1:11434',
    modelosBaixados,
    qwenDisponivel: modelosBaixados.some(m => m.startsWith('qwen')),
    mensagem,
  });
};

interface ProgressoDeDownloadDoOllama {
  modelo: string;
  status: string;
  baixado: number;
  total: number;
  percentual: number;
  iniciadoEm: number;
  terminadoEm?: number;
  erro?: string;
}

/**
 * Um download por modelo, acompanhado pela interface.
 *
 * O `ollama pull` imprime uma linha de progresso a cada atualização — JSON puro, terminando com
 * {"done":true}. Guardamos o último estado num mapa em memória para que a tela possa perguntar
 * "quanto falta?" enquanto o processo roda desanexado, e para que um segundo clique no botão não
 * inicie um segundo download do mesmo arquivo.
 */
const downloadsDeModeloDoOllama = new Map<string, ProgressoDeDownloadDoOllama>();

function iniciarDownloadDeModeloDoOllama(modelo: string): ProgressoDeDownloadDoOllama {
  const registro: ProgressoDeDownloadDoOllama = {
    modelo, status: 'iniciando', baixado: 0, total: 0, percentual: 0, iniciadoEm: Date.now()
  };
  downloadsDeModeloDoOllama.set(modelo, registro);

  const bin = localizarBinarioDoOllama();
  if (!bin) {
    registro.status = 'erro';
    registro.erro = 'Ollama não encontrado neste computador.';
    registro.terminadoEm = Date.now();
    return registro;
  }

  const filho = spawn(bin, ['pull', modelo], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let sobraDeLinha = '';
  const absorver = (pedaco: Buffer) => {
    sobraDeLinha += pedaco.toString('utf-8');
    const linhas = sobraDeLinha.split(/\r?\n/);
    sobraDeLinha = linhas.pop() || '';
    for (const linha of linhas) {
      const texto = linha.trim();
      if (!texto.startsWith('{')) continue;
      try {
        const dado = JSON.parse(texto);
        if (typeof dado.status === 'string') registro.status = dado.status;
        if (typeof dado.completed === 'number') registro.baixado = dado.completed;
        if (typeof dado.total === 'number' && dado.total > 0) {
          registro.total = dado.total;
          registro.percentual = Math.min(100, Math.round((registro.baixado / registro.total) * 100));
        }
      } catch { /* linha parcial ou não-JSON: nada a registrar */ }
    }
  };
  filho.stdout?.on('data', absorver);
  filho.stderr?.on('data', absorver);
  filho.on('error', (err) => {
    registro.status = 'erro';
    registro.erro = err.message;
    registro.terminadoEm = Date.now();
    logAudit('ERROR', 'OLLAMA_PULL_FALHOU', `Falha ao baixar ${modelo}: ${err.message}`);
  });
  filho.on('close', (code) => {
    if (registro.status !== 'erro') {
      registro.status = code === 0 ? 'concluído' : 'falhou';
      if (code === 0) registro.percentual = 100;
    }
    registro.terminadoEm = Date.now();
    logAudit('INFO', 'OLLAMA_PULL_ENCERRADO', `Download de ${modelo} encerrou`, { code, status: registro.status });
  });
  filho.unref();
  return registro;
}

/** POST /ollama/instalar — baixa e instala o Ollama oficial neste computador. */
const handleOllamaInstalar = async (req: Request, res: Response) => {
  const binario = localizarBinarioDoOllama();
  if (binario) {
    return res.status(200).json({
      success: true, jaInstalado: true, caminho: binario,
      message: 'Ollama já está instalado neste computador.'
    });
  }

  const plano = comandoDeInstalacaoDoOllama(process.platform);
  if (!plano) {
    return res.status(501).json({ error: `Instalação automática não suportada na plataforma '${process.platform}'. Instale manualmente a partir de https://ollama.com/download.` });
  }

  // Terminal visível: a instalação mexe no sistema (baixa centenas de MB, pode pedir senha no
  // macOS/Linux) e esconder isso seria a receita perfeita para "não aconteceu nada".
  try {
    if (process.platform === 'win32') {
      launchDetached(`start "OSONE - Instalando Ollama" cmd /K "${plano.command.replace(/"/g, '""')}"`, USER_HOME_DIR);
    } else if (process.platform === 'darwin') {
      const escaped = plano.command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      launchDetached(`osascript -e 'tell application "Terminal" to do script "${escaped}"' -e 'tell application "Terminal" to activate'`, USER_HOME_DIR);
    } else {
      const shellCmd = `${plano.command}; echo; echo '[OSONE] Instalação do Ollama finalizada. Feche esta janela.']`;
      const escaped = shellCmd.replace(/'/g, `'\\''`);
      await tryCommandsInOrder([
        `gnome-terminal -- bash -c '${escaped}'`,
        `konsole -e bash -c '${escaped}'`,
        `xfce4-terminal -e "bash -c '${escaped}'"`,
        `xterm -hold -e bash -c '${escaped}'`,
      ], USER_HOME_DIR);
    }
  } catch (err: any) {
    logAudit('ERROR', 'OLLAMA_INSTALAR_FALHOU', err?.message || String(err));
    return res.status(500).json({ error: `Não foi possível abrir a instalação do Ollama: ${err?.message || err}` });
  }

  logAudit('INFO', 'OLLAMA_INSTALACAO_INICIADA', `Instalação do Ollama aberta em terminal visível`, { metodo: plano.metodo });
  return res.status(200).json({
    success: true,
    started: true,
    message: `Instalação do Ollama iniciada (${plano.metodo}) numa janela de terminal. Quando terminar, volte ao OSONE CODE e clique em "Instalar modelo Qwen".`,
  });
};

/** POST /ollama/baixar-modelo — puxa o Qwen escolhido pelo usuário, com progresso observável. */
const handleOllamaBaixarModelo = async (req: Request, res: Response) => {
  const modelo = String(req.body?.modelo || MODELOS_OLLAMA_PADRAO).trim();
  if (!nomeDeModeloValido(modelo)) {
    return res.status(400).json({ error: `Nome de modelo inválido: "${modelo.slice(0, 60)}". Use algo como "qwen2.5-coder:7b".` });
  }
  if (!localizarBinarioDoOllama()) {
    return res.status(400).json({ error: 'Ollama não está instalado neste computador. Instale-o primeiro pelo botão do OSONE CODE.' });
  }

  const existente = downloadsDeModeloDoOllama.get(modelo);
  if (existente && !existente.terminadoEm) {
    return res.status(200).json({ ...existente, emAndamento: true, message: `O download de ${modelo} já está em andamento.` });
  }

  const registro = iniciarDownloadDeModeloDoOllama(modelo);
  logAudit('INFO', 'OLLAMA_PULL_SOLICITADO', `Download do modelo ${modelo} iniciado pela interface do OSONE CODE`);
  return res.status(200).json({ ...registro, message: `Baixando ${modelo}. Acompanhe o progresso na tela do OSONE CODE.` });
};

/** GET /ollama/progresso?modelo=... — quanto falta para o download terminar. */
const handleOllamaProgresso = (req: Request, res: Response) => {
  const modelo = String(req.query?.modelo || MODELOS_OLLAMA_PADRAO).trim();
  const registro = downloadsDeModeloDoOllama.get(modelo);
  if (!registro) {
    return res.status(200).json({ modelo, status: 'inexistente', percentual: 0, mensagem: `Nenhum download de ${modelo} foi iniciado nesta sessão.` });
  }
  return res.status(200).json(registro);
};

// Mapeamento das rotas no router
agentRouter.get('/status', handleStatus);
agentRouter.post('/desktop/start', handleDesktopStart);
agentRouter.post('/desktop/stop', handleDesktopStop);
agentRouter.get('/desktop/status', handleDesktopStatus);
agentRouter.get('/desktop/capture', handleDesktopCapture);
agentRouter.get('/window/list', handleWindowList);
agentRouter.post('/window/focus', handleWindowFocus);
agentRouter.get('/window/capture', handleWindowCapture);
agentRouter.post('/window/close', handleCloseWindow);
agentRouter.post('/media', handleMediaControl);
agentRouter.post('/path/delete', handleDeletePath);
agentRouter.post('/path/manage', handleManagePath);
agentRouter.post('/path/list', handleListPath);
agentRouter.post('/system/settings', handleOpenSettings);
agentRouter.post('/open-app', handleOpenApp);
agentRouter.post('/open-any', handleOpenAny);
agentRouter.post('/close-app', handleCloseApp);
agentRouter.post('/create-folder', handleCreateFolder);
agentRouter.post('/write-file', handleWriteFile);
agentRouter.post('/read-file', handleReadFile);
agentRouter.post('/edit-file', handleEditFile);
agentRouter.post('/serve-folder', handleServeFolder);
agentRouter.post('/check-project', handleCheckProject);
agentRouter.post('/organize/plan', handleOrganizePlan);
agentRouter.post('/organize/execute', handleOrganizeExecute);
agentRouter.post('/file/trash', handleFileTrash);
agentRouter.post('/volume', handleSetVolume);
agentRouter.get('/system-check', handleSystemCheck);
agentRouter.post('/exec', handleExec);
agentRouter.get('/screen-info', handleGetScreenInfo);
agentRouter.post('/mouse/move', handleMouseMove);
agentRouter.post('/mouse/button', handleMouseButton);
agentRouter.post('/mouse/scroll', handleMouseScroll);
agentRouter.post('/keyboard/type', handleKeyboardType);
agentRouter.post('/keyboard/key', handleKeyboardKey);
agentRouter.get('/screen/capture', handleScreenCapture);

// Rotas do Ollama local (OSONE CODE com modelo na própria máquina)
agentRouter.get('/ollama/status', handleOllamaStatus);
agentRouter.post('/ollama/instalar', handleOllamaInstalar);
agentRouter.post('/ollama/baixar-modelo', handleOllamaBaixarModelo);
agentRouter.get('/ollama/progresso', handleOllamaProgresso);

/**
 * GET /diagnostico-mira — mostra os últimos movimentos de mouse: o que foi pedido, onde o cursor
 * parou de fato e o desvio entre os dois.
 *
 * Serve para responder de uma vez a pergunta que vinha sendo respondida por tentativa e erro:
 * quando o clique cai no lugar errado, a culpa é da coordenada escolhida ou da execução? Se o
 * desvio for zero, o sistema obedeceu e o problema está na mira; se não for, o problema está aqui.
 */
agentRouter.get('/diagnostico-mira', async (_req: Request, res: Response) => {
  let tela: any = null;
  try {
    tela = await obterDimensoesDaTela();
  } catch (err: any) {
    tela = { erro: err?.message || String(err) };
  }
  const cursor = await lerPosicaoDoCursor();
  const comDesvio = historicoDeMira.filter(h => h.desvioPx !== null && h.desvioPx > 2).length;

  return res.status(200).json({
    tela,
    cursorAgora: cursor,
    totalRegistrado: historicoDeMira.length,
    movimentosComDesvio: comDesvio,
    veredito: historicoDeMira.length === 0
      ? "Nenhum movimento de mouse registrado ainda. Peça ao OSONE para clicar em algo e abra este endereço de novo."
      : comDesvio === 0
        ? "O sistema operacional posicionou o cursor EXATAMENTE onde foi pedido em todos os movimentos. " +
          "Logo, cliques no lugar errado vêm da coordenada escolhida (leitura da tela), não da execução."
        : `${comDesvio} de ${historicoDeMira.length} movimentos pararam longe do pedido. O problema está na EXECUÇÃO ` +
          `(xdotool/PowerShell), não na leitura da tela — compare 'pediuPx' com 'ficouPx' abaixo.`,
    ultimosMovimentos: historicoDeMira.slice(0, 10)
  });
});
agentRouter.get('/audit/logs', handleAuditLogs);
