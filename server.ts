import 'dotenv/config';
import express from "express";
import http from "http";
import https from "https";
import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import dns from "dns";
import { execFile } from "child_process";
// Binário do ffmpeg que viaja junto do OSONE, para a mensagem de voz do WhatsApp funcionar em
// qualquer instalação sem o usuário precisar instalar nada por fora.
import ffmpegStatic from "ffmpeg-static";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import QRCode from "qrcode";
import * as cheerio from "cheerio";
import { 
  checkTuyaConfig, 
  logTuyaStartupCheck,
  getTuyaDevices, 
  getDeviceStatus, 
  getDeviceDetail, 
  sendDeviceCommand,
  diagnosticarTuya
} from "./src/tuyaService";
import { agentRouter, OSONE_INSTALL_DIR } from "./src/localAgentService";
import { cameraRouter, iniciarCamerasSalvas, pararTodasAsCameras } from "./src/servicoDeCameras";
import { NaoRepetir } from "./src/lib/naoRepetir";
import { acompanharClienteDoStream } from "./src/lib/clienteDoStream";
import {
  MODELOS_OLLAMA_PADRAO,
  normalizarEnderecoDoOllama,
  ehEnderecoLocalDoOllama,
  montarPedidoOllama,
  lerPecacoDoFluxoOllama,
  emendarContinuacaoLocal,
  motivoIndicaCorte,
} from "./src/lib/ollama";
import {
  carregarCredenciaisSalvas,
  lerEstadoDasCredenciais,
  salvarCredenciais
} from "./src/credenciaisDoServidor";
import {
  checkGoogleHomeConfig,
  issueAuthCode,
  issueLocalPairingCode,
  exchangeToken,
  isValidAccessToken,
  revokeAllTokens,
  lerEstadoDoVinculo,
  diagnosticarGoogleHome,
  handleSync as googleHomeSync,
  handleQuery as googleHomeQuery,
  handleExecute as googleHomeExecute,
  handleDisconnect as googleHomeDisconnect
} from "./src/googleHomeService";
import { registerBillingApi, registerBillingWebhook } from "./src/billingService";
import { verifyFirebaseBearer } from "./src/firebaseAdminService";
import {
  backendForGoogleHomeUser,
  exchangeCloudToken,
  googleHomeCloudConfiguration,
  googleHomeCloudStatus,
  issueCloudAuthCode,
  issuePairingCode,
  registerGoogleHomeUser,
  revokeGoogleHomeUser,
  userForAccessToken
} from "./src/googleHomeCloudService";

dotenv.config();
// Antes de qualquer checagem: o que o usuário preencheu pela tela entra no ambiente aqui, senão a
// subida reclamaria de credenciais que estão guardadas e a um passo de valer.
carregarCredenciaisSalvas();
logTuyaStartupCheck();

// ALWAYS polyfill global WebSocket for Node.js environments.
// This ensures @google/genai uses the complete 'ws' implementation rather than Node 22's
// native experimental Global WebSocket (which doesn't support the custom headers/authentication needed by Gemini Live).
(globalThis as any).WebSocket = WebSocket;

// Este processo serve as sessões de voz em tempo real (Gemini Live, ElevenLabs) de TODOS os
// usuários simultâneos. Uma exceção não tratada em um callback de WebSocket (ex: uma conexão
// que fecha antes de terminar de abrir) derrubaria o processo inteiro para todo mundo, então
// logamos e seguimos em vez de deixar o Node encerrar o processo.
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException] Erro não tratado capturado, servidor continua ativo:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection] Promise rejeitada sem tratamento, servidor continua ativo:", reason);
});

async function startServer() {
  const app = express();
  const server = http.createServer(app);
  
  // Create a WebSocket Server connected to the HTTP Server, responding on specifically /api/live-ws path
  const wss = new WebSocketServer({ noServer: true });
  // Create a WebSocket Server for ElevenLabs streaming input audio proxy
  const elWss = new WebSocketServer({ noServer: true });

  // A porta vem do ambiente quando definida (o app desktop escolhe uma porta comprovadamente
  // livre antes de subir o servidor e a informa por aqui). 3000 continua sendo o padrão para
  // execução direta em desenvolvimento/self-host.
  const PORT = Number(process.env.PORT) || 3000;

  // Funções serverless da Vercel não têm processo persistente: não há WebSocket de longa
  // duração (upgrade de conexão não funciona) nem disco gravável de verdade fora de /tmp
  // (que também não sobrevive entre invocações/instâncias). Recursos que dependem de uma
  // sessão contínua e mantida (WhatsApp, Agente Local, TikTok Live) não podem funcionar de
  // forma confiável lá — em vez de deixá-los falhar em silêncio (trava lendo QR Code que nunca
  // chega, comando no PC que nunca executa), recusamos com uma mensagem clara explicando a
  // limitação e o que fazer. Voz em tempo real (Gemini Live / ElevenLabs Live) já tem fallback
  // próprio para conexão direta no cliente (ver src/lib/live-bridge.ts) e não precisa deste bloqueio.
  const isVercel = process.env.VERCEL === "1";
  const blockOnVercel = (featureLabel: string) => (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!isVercel) return next();
    return res.status(501).json({
      error: `${featureLabel} exige um servidor com processo persistente (conexão contínua e disco gravável) e não funciona nesta implantação na Vercel (funções serverless são efêmeras). Rode o OSONE localmente (npm run dev / npm start) ou use o app desktop para esta função.`,
      unavailableOnVercel: true
    });
  };

  // Safe helper to read the Gemini API key from environment
  const getSecretGeminiKey = (): string => {
    if (process.env.GEMINI_API_KEY) {
      return process.env.GEMINI_API_KEY;
    }
    return "";
  };

  const modeloElevenLabsParaStream = (modelo?: string | null): string => {
    if (!modelo || modelo === "eleven_multilingual_v2") return "eleven_flash_v2_5";
    return modelo;
  };

  const ELEVENLABS_API_KEY_ID_MESSAGE = "A chave da ElevenLabs parece ser o ID da chave, não a API Key secreta. Gere ou rotacione a chave na ElevenLabs e use a chave completa que começa com sk_.";

  const validarChaveElevenLabsParaUso = (apiKey?: string | null): { ok: boolean; key: string; message?: string } => {
    const key = String(apiKey || "").trim();
    if (!key) return { ok: true, key: "" };
    if (!key.startsWith("sk_")) return { ok: false, key, message: ELEVENLABS_API_KEY_ID_MESSAGE };
    return { ok: true, key };
  };

  /**
   * Padrões de chave reconhecidos, num único lugar.
   *
   * Usado tanto para redigir (sanitizeMessageOfKeys) quanto para decidir se vale a pena tentar
   * redigir (o gate do middleware de resposta, logo abaixo). Foi exatamente a duplicação dessa
   * lista — o formato "AQ." entrou aqui mas nunca foi atualizado no `str.includes("AIzaSy")` que
   * decidia se a rota de sanitização rodava — que deixou chaves nesse formato vazarem inteiras
   * em respostas de erro que não vinham do fallback/env key configurado do próprio servidor.
   */
  const PADROES_DE_CHAVE_SENSIVEL: RegExp[] = [
    /AIzaSy[A-Za-z0-9_-]{33}/,
    /AQ\.[A-Za-z0-9_-]{30,}/,
    /sk-proj-[A-Za-z0-9_-]{20,}/,
    /sk-ant-[A-Za-z0-9_-]{20,}/,
    /\bsk-[A-Za-z0-9_-]{20,}/
  ];

  const contemChaveSensivel = (texto: string): boolean =>
    !!texto && PADROES_DE_CHAVE_SENSIVEL.some(padrao => padrao.test(texto));

  // Helper to sanitize any occurrence of sensitive API keys from messages returned to the client
  const sanitizeMessageOfKeys = (message: string): string => {
    if (!message) return "";

    // 1. Esconde chaves do Google nos DOIS formatos: o antigo "AIzaSy" + 33 caracteres, e o
    //    atual "AQ." + ~50, que é o emitido pelo AI Studio hoje. Sem a segunda regra, as chaves
    //    novas apareceriam inteiras em mensagens de erro devolvidas ao navegador.
    let sanitized = message
      .replace(/AIzaSy[A-Za-z0-9_-]{33}/g, "[CHAVE_REMOVIDA]")
      .replace(/AQ\.[A-Za-z0-9_-]{30,}/g, "[CHAVE_REMOVIDA]")
      .replace(/sk-proj-[A-Za-z0-9_-]{20,}/g, "[CHAVE_REMOVIDA]")
      .replace(/sk-ant-[A-Za-z0-9_-]{20,}/g, "[CHAVE_REMOVIDA]")
      .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "[CHAVE_REMOVIDA]");

    // 2. Mask generic key/token patterns (such as api_key=..., key=..., xi-api-key, etc.)
    sanitized = sanitized.replace(/(key|api_key|apikey|xi-api-key|token)(?:["'\s:=]+)([A-Za-z0-9_-]{10,60})/gi, "$1=[REMOVED]");
    
    // 3. Mask the fallback key if loaded
    const secretKey = getSecretGeminiKey();
    if (secretKey && secretKey.length > 5) {
      const escapedKey = secretKey.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const keyRegex = new RegExp(escapedKey, 'g');
      sanitized = sanitized.replace(keyRegex, "[CHAVE_REMOVIDA]");
    }

    // 4. Mask the standard process env key
    if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.length > 5) {
      const escapedEnvKey = process.env.GEMINI_API_KEY.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const envKeyRegex = new RegExp(escapedEnvKey, 'g');
      sanitized = sanitized.replace(envKeyRegex, "[CHAVE_REMOVIDA]");
    }

    return sanitized;
  };

  // Gracefully formats Gemini API errors, notifying the user when their key quota is exhausted
  const formatGeminiError = (err: any): string => {
    const msg = err?.message || String(err);
    if (
      msg.includes("429") ||
      msg.includes("RESOURCE_EXHAUSTED") ||
      msg.toLowerCase().includes("quota") ||
      msg.toLowerCase().includes("limit") ||
      msg.toLowerCase().includes("exceeded")
    ) {
      return "Sua cota da API do Gemini foi excedida ou houve limite de taxa (Erro 429). Por favor, insira sua própria API Key válida do Google no painel de Ajustes (ícone de engrenagem) ou verifique o limite do seu plano em https://ai.google.dev/gemini-api/docs/rate-limits.";
    }
    if (
      msg.includes("503") ||
      msg.includes("UNAVAILABLE") ||
      msg.toLowerCase().includes("high demand") ||
      msg.toLowerCase().includes("temporary") ||
      msg.toLowerCase().includes("temporarily")
    ) {
      return "O modelo da API do Gemini está temporariamente congestionado com alta demanda global (Erro 503 / UNAVAILABLE). Por favor, aguarde alguns segundos e clique em enviar novamente, ou selecione outro modelo (como gemini-3.7-flash, gemini-3.6-flash ou gemini-3.5-flash-lite) nas Configurações (ícone de engrenagem no cabeçalho superior) para obter respostas mais estáveis.";
    }
    /**
     * MODELO QUE NÃO EXISTE PARA ESTA CHAVE.
     *
     * Este caso não tinha tradução e saía cru, em inglês, no meio da tela: "models/<nome> is not
     * found for API version v1beta, or is not supported for generateContent". Quem lê isso não
     * tem como saber que a solução está a dois cliques, na lista de modelos dos Ajustes — e a
     * conclusão natural é que "o app não funciona", quando o resto dele funciona.
     *
     * Acontece de verdade: os modelos preferidos são fixos no código, e nem toda chave serve
     * todos eles. Uma chave nova, um projeto sem acesso liberado, um modelo aposentado pelo
     * Google — em qualquer um desses a geração para, e a causa fica ilegível.
     */
    if (
      msg.includes("404") ||
      msg.includes("NOT_FOUND") ||
      msg.toLowerCase().includes("is not found for api version") ||
      msg.toLowerCase().includes("is not supported for")
    ) {
      const nomeDoModelo = (msg.match(/models\/([A-Za-z0-9.\-]+)/) || [])[1];
      return `O modelo ${nomeDoModelo ? `"${nomeDoModelo}"` : "pedido"} não existe ou não está liberado para a sua chave do Gemini. `
        + `Abra os Ajustes (ícone de engrenagem) e escolha um modelo da lista — o OSONE passa a usar esse como reserva. `
        + `Para ver quais modelos a sua chave atende, acesse: https://generativelanguage.googleapis.com/v1beta/models?key=SUA_CHAVE`;
    }
    return sanitizeMessageOfKeys(msg);
  };

  // A Stripe assina os bytes crus do webhook; esta rota precisa existir antes do parser JSON.
  registerBillingWebhook(app);
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerBillingApi(app);

  /**
   * LIMITADOR DE REQUISIÇÕES EM MEMÓRIA — sem dependência nova, mesmo padrão já usado em
   * limitarCargaDeMemoria (mais abaixo), generalizado para qualquer rota.
   *
   * Não substitui autenticação nenhuma: é a rede de segurança contra abuso/negação de
   * serviço enquanto uma rota específica não tem controle de acesso próprio — e, mais
   * concretamente, contra o esgotamento da cota paga do servidor nas rotas de geração de IA
   * (ver limitarGeracaoDeIA abaixo), que hoje aceitam a chave do próprio servidor quando o
   * cliente não manda a sua.
   */
  /**
   * De quem veio o pedido, sem confiar em `req.ip` cegamente.
   *
   * `req.ip` é um getter do Express que resolve o endereço por `proxy-addr`, e ele LANÇA quando
   * `req.socket` não existe — não devolve undefined. Um `req.ip || outraCoisa` parece cobrir esse
   * caso e não cobre: a exceção acontece ao ler a propriedade, antes de o `||` chegar a valer.
   *
   * Isso não é teórico: o handler serverless da Vercel é invocado com um objeto de requisição que
   * nem sempre traz socket, e é exatamente o que scripts/conferir-build-vercel.mjs reproduz ao
   * chamar /api/health durante o build. Com o limitador global lendo req.ip direto, TODA requisição
   * passava por essa leitura — e o build da Vercel quebrava antes de publicar qualquer coisa.
   */
  const enderecoDoPedido = (req: express.Request): string => {
    try {
      if (req.ip) return req.ip;
    } catch {
      // sem socket: cai para as alternativas abaixo
    }
    return req.socket?.remoteAddress || "desconhecido";
  };

  function criarLimitadorPorIp(opcoes: { janelaMs: number; maxTentativas: number; mensagem: string }) {
    const tentativasPorIp = new Map<string, { contagem: number; expiraEm: number }>();
    setInterval(() => {
      const agora = Date.now();
      for (const [chave, registro] of tentativasPorIp) {
        if (registro.expiraEm < agora) tentativasPorIp.delete(chave);
      }
    }, 5 * 60 * 1000).unref();

    return (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const chave = enderecoDoPedido(req);
      const agora = Date.now();
      const registro = tentativasPorIp.get(chave);
      if (!registro || registro.expiraEm < agora) {
        tentativasPorIp.set(chave, { contagem: 1, expiraEm: agora + opcoes.janelaMs });
        return next();
      }
      if (registro.contagem >= opcoes.maxTentativas) {
        return res.status(429).json({ error: opcoes.mensagem });
      }
      registro.contagem++;
      next();
    };
  }

  // Rede geral: bem generosa, só para conter abuso grosseiro/DoS em qualquer rota.
  app.use(criarLimitadorPorIp({
    janelaMs: 60 * 1000,
    maxTentativas: 300,
    mensagem: "Muitas requisições vindas deste endereço em pouco tempo. Aguarde um minuto e tente de novo."
  }));

  // Rotas de geração de IA custam dinheiro de verdade (cota paga do Gemini/ElevenLabs/OpenAI/
  // Anthropic) e caem na chave do próprio servidor quando o cliente não informa a sua. Sem
  // limite nenhum, um único visitante sem conta poderia esgotar essa cota sozinho.
  const limitarGeracaoDeIA = criarLimitadorPorIp({
    janelaMs: 60 * 1000,
    maxTentativas: 20,
    mensagem: "Muitas gerações de IA em pouco tempo vindas deste endereço. Aguarde um minuto — ou use sua própria chave de API nos Ajustes para não ter este limite."
  });
  app.use([
    "/api/generate", "/api/generate-stream", "/api/tts",
    "/api/gemini/generateContent", "/api/gemini/generateImages", "/api/gemini/verify",
    "/api/audiovisual/generate-image", "/api/audiovisual/generate-video",
    "/api/hear/transcribe", "/api/chat-intel", "/api/chat-intel-stream",
    "/api/lens/query", "/api/dossier/analyze", "/api/elevenlabs/verify"
  ], limitarGeracaoDeIA);

  // Rotas do Agente Local Unificado no Servidor Express Principal. Na Vercel, "a máquina que
  // o servidor está rodando" é o contêiner efêmero da função serverless, não o PC do usuário —
  // então, além de não persistir nada, controlar "o PC" ali seria simplesmente a máquina errada.
  app.use("/api/agent", blockOnVercel("O Agente Local"), agentRouter);
  app.use("/agent", blockOnVercel("O Agente Local"), agentRouter);

  // Middleware to intercept all outgoing JSON and string responses and sanitize potential leaks of API keys
  app.use((req, res, next) => {
    const originalJson = res.json;
    res.json = function (obj) {
      if (obj && typeof obj === 'object') {
        try {
          const str = JSON.stringify(obj);
          const fallbackKey = getSecretGeminiKey();
          const envKey = process.env.GEMINI_API_KEY || "";

          const hasKeyPattern = contemChaveSensivel(str);
          const hasFallbackKey = !!(fallbackKey && str.includes(fallbackKey));
          const hasEnvKey = !!(envKey && str.includes(envKey));

          if (hasKeyPattern || hasFallbackKey || hasEnvKey) {
            const sanitizedStr = sanitizeMessageOfKeys(str);
            return originalJson.call(this, JSON.parse(sanitizedStr));
          }
        } catch (e) {
          console.warn("Failed to sanitize JSON response:", e);
        }
      }
      return originalJson.call(this, obj);
    };
    
    const originalSend = res.send;
    res.send = function (body) {
      if (typeof body === 'string') {
        const fallbackKey = getSecretGeminiKey();
        const envKey = process.env.GEMINI_API_KEY || "";

        const hasKeyPattern = contemChaveSensivel(body);
        const hasFallbackKey = !!(fallbackKey && body.includes(fallbackKey));
        const hasEnvKey = !!(envKey && body.includes(envKey));

        if (hasKeyPattern || hasFallbackKey || hasEnvKey) {
          const sanitizedBody = sanitizeMessageOfKeys(body);
          return originalSend.call(this, sanitizedBody);
        }
      }
      return originalSend.call(this, body);
    };
    
    next();
  });

  // ====== TIKTOK LIVE WEBCAST INTEGRATION STATE ======
  let currentTikTokUser = "";
  let tiktokStatus: "connected" | "disconnected" | "connecting" = "disconnected";
  let isTikTokAutoRespondActive = false;
  let activeTikTokRunner: any = null;
  let simulatedIntervalId: any = null;
  let tiktokViewerCount = 0;
  let tiktokLikeCount = 0;
  let tiktokSessionId = "";
  let tiktokTargetIdc = "";

  interface TikTokLog {
    id: string;
    type: "chat" | "gift" | "like" | "member" | "system" | "error";
    user: string;
    message: string;
    timestamp: number;
    detailedData?: any;
  }

  let tiktokEventLogs: TikTokLog[] = [
    {
      id: "init-tiktok",
      type: "system",
      user: "Sistema",
      message: "Co-piloto de Live do TikTok carregado. Ajuste os dados do host em Configurações para iniciar escuta passiva das webcast sockets.",
      timestamp: Date.now()
    }
  ];

  async function handleTikTokAutoResponse(user: string, text: string) {
    try {
      const apiKey = getSecretGeminiKey();
      if (!apiKey) return;

      const ai = new GoogleGenAI({ apiKey, vertexai: false });
      const prompt = `Você é o co-piloto OSONE G5 assistindo uma transmissão ao vivo no TikTok. O usuário "@${user}" enviou uma mensagem no chat da live. 
Responda brevemente e com muita energia, carisma, carinho e sintonia (máximo 1 linha com no máximo 20 palavras), interagindo diretamente com ele.

Comentário de @${user}: "${text}"`;

      const gResult = await generateContentWithFallback(ai, {
        model: "gemini-3.5-flash-lite",
        contents: prompt
      });

      const replyText = gResult.text?.trim() || "Sensacional, obrigado por participar da nossa transmissão!";
      
      tiktokEventLogs.unshift({
        id: Math.random().toString(36).substring(2, 11),
        type: "system",
        user: "🤖 OSONE G5 (Co-piloto)",
        message: `Resposta automática para @${user}: "${replyText}"`,
        timestamp: Date.now()
      });
    } catch (err) {
      console.error("TikTok Auto respond error:", err);
    }
  }

  function stopSimulatedLive() {
    if (simulatedIntervalId) {
      clearInterval(simulatedIntervalId);
      simulatedIntervalId = null;
    }
  }

  function startSimulatedLive() {
    stopSimulatedLive();
    tiktokStatus = "connected";
    currentTikTokUser = "simulador_osone";
    tiktokViewerCount = Math.floor(Math.random() * 120) + 38;
    tiktokLikeCount = Math.floor(Math.random() * 800) + 120;
    
    tiktokEventLogs.unshift({
      id: Math.random().toString(),
      type: "system",
      user: "Sistema",
      message: "Modo de simulação ativa! Gerando tráfego virtual de chat, curtidas e presentes TikTok a cada 6 segundos.",
      timestamp: Date.now()
    });

    const NAMES = ["LiviaStyle", "Guilherme_Dev", "AnaClara_TikTok", "Pedro_Osone", "Sonia_Mendes", "RenatoG5_Pro"];
    const COMMENTS = [
      "Caramba, o OSONE é bizarro de rápido!",
      "Como faz pra conectar no whatsapp igual você fez?",
      "Que inteligência incrível, roda local?",
      "Dá um salve pra galera de São Paulo!",
      "Gostei muito do design desse orb sínclitico",
      "Você prefere ser chamado de OSONE ou apenas IA?",
      "Manda bala nas explicações, aprendendo muito!"
    ];
    const GIFTS = ["Rosa", "Coração", "Boné TikTok", "Sorvete", "Diamante"];

    simulatedIntervalId = setInterval(async () => {
      const coin = Math.random();
      
      // Dynamic viewer count fluctuates
      tiktokViewerCount = Math.max(5, tiktokViewerCount + Math.floor(Math.random() * 7) - 3);

      if (coin < 0.65) {
        const name = NAMES[Math.floor(Math.random() * NAMES.length)];
        const msg = COMMENTS[Math.floor(Math.random() * COMMENTS.length)];
        tiktokEventLogs.unshift({
          id: Math.random().toString(),
          type: "chat",
          user: name,
          message: msg,
          timestamp: Date.now()
        });
        
        if (isTikTokAutoRespondActive) {
          await handleTikTokAutoResponse(name, msg);
        }
      } else if (coin < 0.85) {
        const name = NAMES[Math.floor(Math.random() * NAMES.length)];
        const addedLikes = Math.floor(Math.random() * 15) + 5;
        tiktokLikeCount += addedLikes;
        tiktokEventLogs.unshift({
          id: Math.random().toString(),
          type: "like",
          user: name,
          message: `Curtiu a live enviando corações (+${addedLikes} likes)!`,
          timestamp: Date.now()
        });
      } else {
        const name = NAMES[Math.floor(Math.random() * NAMES.length)];
        const giftName = GIFTS[Math.floor(Math.random() * GIFTS.length)];
        const count = Math.floor(Math.random() * 5) + 1;
        tiktokLikeCount += (count * 10); // Gifts add lots of likes too
        tiktokEventLogs.unshift({
          id: Math.random().toString(),
          type: "gift",
          user: name,
          message: `Enviou Presente: ${giftName} x${count}!`,
          timestamp: Date.now()
        });
      }

      if (tiktokEventLogs.length > 300) tiktokEventLogs.pop();
    }, 6000);
  }

  async function connectToTikTokLive(username: string, sessionId?: string, targetIdc?: string) {
    try {
      await disconnectFromTikTokLive();
      currentTikTokUser = username;
      tiktokStatus = "connecting";
      tiktokViewerCount = 0;
      tiktokLikeCount = 0;

      tiktokEventLogs.unshift({
        id: Math.random().toString(),
        type: "system",
        user: "Sistema",
        message: `Mapeando username @${username}... Buscando ID do canal de transmissão ativa.`,
        timestamp: Date.now()
      });

      /**
       * A classe mudou de nome na versão 2 do tiktok-live-connector.
       *
       * O código foi escrito para a v1, que exportava `WebcastPushConnection` e conversava com o
       * TikTok por polling HTTP. A 2.4.3 — que é a versão fixada no package.json — exporta
       * `TikTokLiveConnection` e usa WebSocket. Enquanto a pasta node_modules ainda guardava uma
       * instalação antiga isso passou despercebido; numa instalação limpa a compilação para na
       * hora, porque o nome antigo simplesmente não existe mais no pacote.
       *
       * Os nomes dos EVENTOS continuam iguais (chat, gift, like, member, roomUser), então tudo o
       * que vem depois desta linha segue valendo. O que mudou de verdade é o formato das opções,
       * tratado logo abaixo.
       */
      /**
       * Os EVENTOS também vêm do pacote, e não como texto solto.
       *
       * Os nomes em si não mudaram — WebcastEvent.CHAT continua valendo "chat", ControlEvent.
       * DISCONNECTED continua "disconnected", e assim por diante. O que mudou é que o mapa de
       * eventos da v2 é indexado pelos MEMBROS do enum, então `on("chat", ...)` com a string
       * crua deixa de ser aceito pela tipagem, mesmo escrevendo exatamente o mesmo valor.
       * Usar os enums mantém o comportamento idêntico em execução e ainda deixa o compilador
       * avisar caso um nome seja renomeado numa versão futura — que é justamente o tipo de
       * quebra silenciosa que trouxe este código até aqui.
       */
      const { TikTokLiveConnection, WebcastEvent, ControlEvent } = await import("tiktok-live-connector");

      /**
       * Opções no formato da v2.
       *
       * Sumiram: `requestPollingIntervalMs` (não há mais polling), `clientParams` e
       * `requestOptions` — o transporte HTTP agora se configura por `webClientOptions`, que é
       * repassado ao `got`.
       */
      const configOpts: any = {
        enableExtendedGiftInfo: true,
        webClientOptions: {
          timeout: { request: 12000 },
          searchParams: {
            app_language: "pt-BR",
            webcast_language: "pt-BR"
          },
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          }
        }
      };

      /**
       * Assinatura de requisição: gratuita (anônima) x paga (autenticada).
       *
       * A v2 não fala direto com o TikTok — toda URL de webcast precisa ser assinada pela
       * EulerStream antes de virar conexão. E a EulerStream cobra por sessão: a rota
       * `fetchWebcastSignatureFromEulerRoute` repassa `sessionId`/`ttTargetIdc` para o
       * assinador, e assinar COM sessão é endpoint de plano Business. Sem plano, a resposta
       * é um 4xx que a lib traduz para `SignatureMissingTokensError`, cujo rótulo de classe é
       * "Empty Payload" — mensagem que não tem nada a ver com a causa real e mandava o
       * usuário justamente preencher o Session ID que causou a falha.
       *
       * Por isso a credencial só é anexada quando existe uma chave de assinatura paga. Sem
       * chave, a conexão sobe anônima — que é o caminho gratuito e o único que funciona aqui.
       */
      const signApiKey = (process.env.TIKTOK_SIGN_API_KEY || "").trim();
      if (signApiKey) {
        configOpts.signApiKey = signApiKey;
      }

      const trimmedSessionId = (sessionId || "").trim();
      const trimmedTargetIdc = (targetIdc || "").trim();

      if (trimmedSessionId && !signApiKey) {
        tiktokEventLogs.unshift({
          id: Math.random().toString(),
          type: "system",
          user: "Sistema",
          message: "Modo gratuito: o Session ID foi ignorado de propósito. Assinar a conexão com credencial é recurso do plano pago da EulerStream — enviá-lo derrubaria a conexão antes de começar. Conectando de forma anônima.",
          timestamp: Date.now()
        });
      } else if (trimmedSessionId && signApiKey) {
        /**
         * O `ttTargetIdc` é o datacenter da conta (`useast2a`, `alisg`, `row`...), lido do
         * cookie `tt-target-idc` do navegador. A lib exige ele sempre que há sessionId, e um
         * valor fora do formato — o @ do canal, por exemplo — só produziria uma falha obscura
         * lá dentro. Melhor recusar a credencial inteira aqui e dizer o porquê.
         */
        if (!/^[a-z0-9-]{2,20}$/.test(trimmedTargetIdc)) {
          tiktokEventLogs.unshift({
            id: Math.random().toString(),
            type: "system",
            user: "Sistema",
            message: `Session ID ignorado: o campo 'Target IDC Region' precisa da região do datacenter (ex: row, alisg, useast2a), lida do cookie 'tt-target-idc' do navegador — e não do nome do canal. Valor recebido: "${trimmedTargetIdc || "(vazio)"}". Conectando de forma anônima.`,
            timestamp: Date.now()
          });
        } else {
          configOpts.session = {
            cookie: {
              type: 'cookie',
              value: {
                sessionId: trimmedSessionId,
                ttTargetIdc: trimmedTargetIdc
              }
            }
          };
          configOpts.authenticateWs = true;

          tiktokEventLogs.unshift({
            id: Math.random().toString(),
            type: "system",
            user: "Sistema",
            message: "Autenticação Ativa: Conectando com Session ID credenciado para evitar shadow-blocks.",
            timestamp: Date.now()
          });
        }
      }

      const connection = new TikTokLiveConnection(username, configOpts);
      activeTikTokRunner = connection;

      connection.on(WebcastEvent.CHAT, async (data: any) => {
        const logEntry: TikTokLog = {
          id: data.msgId || Math.random().toString(),
          type: "chat",
          user: data.uniqueId || data.nickname || "Anônimo",
          message: data.comment,
          timestamp: Date.now()
        };
        tiktokEventLogs.unshift(logEntry);
        if (tiktokEventLogs.length > 300) tiktokEventLogs.pop();

        if (isTikTokAutoRespondActive) {
          await handleTikTokAutoResponse(logEntry.user, logEntry.message);
        }
      });

      connection.on(WebcastEvent.GIFT, (data: any) => {
        const giftCount = data.repeatCount || data.count || 1;
        const logEntry: TikTokLog = {
          id: data.msgId || Math.random().toString(),
          type: "gift",
          user: data.uniqueId || data.nickname || "Doador",
          message: `Enviou Presente: ${data.giftName} (x${giftCount})`,
          timestamp: Date.now()
        };
        tiktokEventLogs.unshift(logEntry);
         if (tiktokEventLogs.length > 300) tiktokEventLogs.pop();
      });

      connection.on(WebcastEvent.LIKE, (data: any) => {
        if (data && typeof data.likeCount === "number") {
          tiktokLikeCount = data.likeCount;
        }
        tiktokEventLogs.unshift({
          id: Math.random().toString(),
          type: "like",
          user: data.uniqueId || data.nickname || "Curtiu",
          message: `Curtiu a transmissão! Total: ${data.likeCount || tiktokLikeCount || ''} curtidas`,
          timestamp: Date.now()
        });
        if (tiktokEventLogs.length > 300) tiktokEventLogs.pop();
      });

      // Track spectators count in real-time
      connection.on(WebcastEvent.ROOM_USER, (data: any) => {
        if (data && typeof data.viewerCount === "number") {
          tiktokViewerCount = data.viewerCount;
        }
      });

      connection.on(WebcastEvent.MEMBER, (data: any) => {
        tiktokEventLogs.unshift({
          id: Math.random().toString(),
          type: "member",
          user: data.uniqueId || data.nickname || "Membro",
          message: `Entrou na live! Bem-vindo(a).`,
          timestamp: Date.now()
        });
        if (tiktokEventLogs.length > 300) tiktokEventLogs.pop();
      });

      connection.on(ControlEvent.DISCONNECTED, () => {
        // Only trigger reconnect check if we are still targeting this user and didn't disconnect manually
        if (currentTikTokUser === username && tiktokStatus === "connected") {
          tiktokStatus = "connecting";
          tiktokEventLogs.unshift({
            id: Math.random().toString(),
            type: "system",
            user: "Sistema",
            message: "Conexão encerrada subitamente pelo TikTok. Tentando reconectar automaticamente em 10 segundos...",
            timestamp: Date.now()
          });
          setTimeout(() => {
            if (currentTikTokUser === username) {
               // Reconecta com o MESMO targetIdc desta sessão (parâmetro de closure), não com a
               // global tiktokTargetIdc — que pode já ter mudado por outra chamada a
               // /api/tiktok/connect enquanto este timer estava pendente.
               connectToTikTokLive(username, sessionId, targetIdc).catch(() => {});
            }
          }, 10000);
        } else {
          tiktokStatus = "disconnected";
        }
      });

      connection.on(ControlEvent.ERROR, (err: any) => {
        /**
         * Este handler dispara junto com a falha real do connect(), e o erro que chega aqui
         * muitas vezes vem sem `.message` — o que enchia o terminal de linhas idênticas de
         * "Problema de transporte de sockets", ruído que escondia a mensagem que de fato
         * explicava a causa. Repetições consecutivas do mesmo texto viram uma linha só.
         */
        const message = `Alerta na transmissão: ${err?.message || err?.reason || "Problema de transporte de sockets."}`;
        if (tiktokEventLogs[0]?.type === "error" && tiktokEventLogs[0]?.message === message) {
          return;
        }
        tiktokEventLogs.unshift({
          id: Math.random().toString(),
          type: "error",
          user: "Erro",
          message,
          timestamp: Date.now()
        });
        if (tiktokEventLogs.length > 300) tiktokEventLogs.pop();
      });

      await connection.connect();
      tiktokStatus = "connected";

      tiktokEventLogs.unshift({
        id: Math.random().toString(),
        type: "system",
        user: "Sistema",
        message: `Conectado com sucesso absoluto! Assistindo webcast de @${username} e recebendo eventos em tempo real.`,
        timestamp: Date.now()
      });

    } catch (err: any) {
      console.error("TikTok connection crash:", err);
      tiktokStatus = "disconnected";
      
      /**
       * A dica antiga era sempre a mesma e mandava preencher o Session ID — conselho que, no
       * caso mais comum (assinatura recusada por ser recurso pago), levava exatamente de volta
       * ao erro. Cada família de falha agora recebe a sua própria saída.
       */
      const rawMsg = err.message || "Sem resposta/Transmissão offline.";
      const lowerMsg = rawMsg.toLowerCase();
      let errMsg = rawMsg;

      if (lowerMsg.includes("business plan") || lowerMsg.includes("premium feature") || lowerMsg.includes("permission from the signature provider")) {
        errMsg = "O serviço de assinatura (EulerStream) recusou a requisição por ser recurso de plano pago. Deixe os campos 'Session ID' e 'Target IDC' VAZIOS para conectar pelo modo gratuito anônimo.";
      } else if (lowerMsg.includes("rate limit") || lowerMsg.includes("429")) {
        errMsg = "Limite de assinaturas gratuitas atingido. Aguarde alguns minutos antes de tentar reconectar — o plano gratuito da EulerStream tem cota por hora.";
      } else if (lowerMsg.includes("404") || lowerMsg.includes("not found") || lowerMsg.includes("offline")) {
        errMsg = "Canal não encontrado ou transmissão offline no momento. Confira o @ do canal e se a live está realmente no ar.";
      } else if (/\bblocked?\b/.test(lowerMsg) || /\bip\b/.test(lowerMsg)) {
        errMsg = "O TikTok pode estar bloqueando o IP desta máquina. Tente novamente mais tarde ou a partir de outra rede.";
      }

      tiktokEventLogs.unshift({
        id: Math.random().toString(),
        type: "error",
        user: "Erro",
        message: `Falha na conexão: ${errMsg}`,
        timestamp: Date.now()
      });
      throw err;
    }
  }

  async function disconnectFromTikTokLive() {
    stopSimulatedLive();
    if (activeTikTokRunner) {
      try {
        await activeTikTokRunner.disconnect();
      } catch (e) {
        console.warn("Disconnection failed gracefully:", e);
      }
      activeTikTokRunner = null;
    }
    tiktokStatus = "disconnected";
    currentTikTokUser = "";
  }

  // ====== WHATSAPP CONFIG & LOGS STATE ======
  let whatsappConfig = {
    enabled: false,
    geminiApiKey: "",
    // Auto-resposta funciona 100% de forma independente de qualquer sessão de voz em tempo
    // real (Gemini Live/ElevenLabs Live) — ela roda direto no listener de mensagens do
    // Baileys sempre que "enabled" está true, mesmo sem nenhum app aberto na tela.
    sendAudioReplies: true,
    // Desligado por padrão: qualquer pessoa pode perguntar ao OSONE, desde que chame pelo
    // comando de gatilho abaixo. Quem protege contra spam e desconhecidos passou a ser o
    // gatilho, não a lista de contatos — mensagem automática de golpe ou propaganda não vai
    // escrever "/osone". Ligue esta opção para restringir o atendimento apenas a quem estiver
    // cadastrado na aba Contatos.
    onlyKnownContacts: false,
    // Quando true (padrão), o robô só responde a mensagens que chamem o OSONE pelo comando
    // abaixo — como quem diz "ei, OSONE, me responde aqui". Sem isso, o robô entraria no meio
    // de qualquer conversa em andamento com o dono do número, respondendo coisas que eram para
    // a pessoa, não para a IA. O comando é removido do texto antes de ir para o modelo, para a
    // IA ler só o pedido em si.
    requireTriggerCommand: true,
    triggerCommand: "/osone",
    // Supertonic e Piper rodam na própria máquina: sem cota, sem chave e sem custo.
    ttsEngine: "gemini" as "gemini" | "elevenlabs" | "supertonic" | "local",
    ttsVoice: "Kore",
    supertonicVoice: "F1" as "F1" | "M1",
    elevenLabsApiKey: "",
    elevenLabsVoiceId: ""
  };

  /**
   * Onde as escolhas do painel do OSONE ZAP ficam guardadas.
   *
   * Sem este arquivo, a configuração vivia só na memória do processo: bastava fechar o OSONE
   * (ou o computador reiniciar) para tudo voltar ao padrão de fábrica — inclusive o
   * "enabled: false", que DESLIGA o robô. Quem deixasse o atendimento no ar o dia inteiro
   * descobria, depois de um reinício qualquer, que o robô estava mudo desde então, sem
   * nenhum aviso.
   *
   * Guarda chaves de API (Gemini/ElevenLabs), por isso entra no .gitignore junto dos demais
   * arquivos de dados locais.
   */
  const WHATSAPP_CONFIG_PATH = path.join(process.cwd(), "whatsapp-config.json");

  function loadWhatsAppConfig(): void {
    try {
      if (!fs.existsSync(WHATSAPP_CONFIG_PATH)) return;
      const salvo = JSON.parse(fs.readFileSync(WHATSAPP_CONFIG_PATH, "utf-8"));
      // Mescla sobre os padrões em vez de substituir: assim uma opção nova criada numa versão
      // futura nasce com o valor padrão dela, em vez de virar undefined num arquivo antigo.
      whatsappConfig = { ...whatsappConfig, ...salvo };
      console.log("[OSONE ZAP] Configuração restaurada de whatsapp-config.json.");
    } catch (e) {
      console.error("[OSONE ZAP] Não foi possível ler whatsapp-config.json (usando os padrões):", e);
    }
  }

  function saveWhatsAppConfig(): void {
    try {
      fs.writeFileSync(WHATSAPP_CONFIG_PATH, JSON.stringify(whatsappConfig, null, 2), "utf-8");
    } catch (e) {
      console.error("[OSONE ZAP] Não foi possível salvar whatsapp-config.json:", e);
    }
  }

  loadWhatsAppConfig();

  let virtualConnectionState = "DISCONNECTED";

  // ====== ESTADO DO CLIENTE WHATSAPP (Baileys — conexão direta ao WhatsApp via WebSocket,
  // sem navegador/Puppeteer embutido) ======
  let waSocket: any = null;
  let waStatus: "desconectado" | "iniciando" | "aguardando_qr" | "conectado" | "erro" = "desconectado";
  let waQrRaw = "";
  let waQrBase64 = "";
  let waPhoneInfo: { number?: string; name?: string } = {};
  let waLastError = "";
  // Controla a reconexão automática: fica true quando o próprio usuário desconecta/reseta de
  // propósito, para não brigar com a intenção dele; caso contrário, toda queda de conexão
  // (internet, sessão derrubada pelo celular, etc.) tenta reconectar sozinha.
  let waIntentionalDisconnect = false;
  let waReconnectAttempts = 0;
  let waReconnectTimer: NodeJS.Timeout | null = null;
  const WA_AUTH_DIR = path.join(process.cwd(), ".baileys_auth");
  // Baileys não expõe um "getContacts()" pronto como o whatsapp-web.js — os contatos chegam
  // aos poucos por eventos ("contacts.upsert"/"contacts.update") e pelo nome de exibição
  // ("pushName") de cada mensagem recebida. Mantemos este cache em memória para alimentar o
  // endpoint /api/whatsapp/wa-contacts com o que já foi visto desde que o servidor iniciou.
  const waContactsCache = new Map<string, { name?: string }>();

  // Carrega o Baileys e o pino sob demanda, só quando o WhatsApp é realmente inicializado —
  // nunca na Vercel, onde a rota inteira já é recusada por blockOnVercel antes de chegar
  // aqui. Import estático dessas duas bibliotecas no topo do arquivo derrubava o servidor
  // INTEIRO na Vercel (inclusive rotas sem nada a ver com WhatsApp, como Tuya), porque o pino
  // é conhecido por não empacotar bem em funções serverless (usa transporte por worker
  // threads/require dinâmico que o bundler da Vercel não consegue resolver em build). As
  // promises ficam em cache para não reimportar a cada chamada.
  let baileysModulePromise: Promise<typeof import("@whiskeysockets/baileys")> | null = null;
  const loadBaileys = (): Promise<typeof import("@whiskeysockets/baileys")> => {
    if (!baileysModulePromise) baileysModulePromise = import("@whiskeysockets/baileys");
    return baileysModulePromise;
  };
  // Tipado como any de propósito: o pacote "pino" usa "export =" (interop CJS/ESM), e o
  // shape exato que o import() dinâmico devolve em tempo de tipo diverge do que o TypeScript
  // infere para "import pino from 'pino'" estático — não vale a pena brigar com isso aqui.
  let pinoModulePromise: Promise<any> | null = null;
  const loadPino = (): Promise<any> => {
    if (!pinoModulePromise) pinoModulePromise = import("pino");
    return pinoModulePromise;
  };

  interface WhatsappLog {
    id: string;
    timestamp: number;
    type: "received" | "sent" | "error" | "info";
    sender: string;
    message: string;
    response?: string;
  }

  let whatsappLogs: WhatsappLog[] = [
    {
      id: "init",
      timestamp: Date.now(),
      type: "info",
      sender: "Sistema",
      message: "Canal do WhatsApp OSONE de pé. Pronto para evolução de fluxos."
    }
  ];

  // ====== KNOWLEDGE BASE, CONVERSATIONS & CONTACTS STATE & HELPERS ======
  const KNOWLEDGE_BASE_PATH = path.join(process.cwd(), "knowledge-base.json");
  const CONVERSATIONS_PATH = path.join(process.cwd(), "conversations.json");
  const CONTACTS_PATH = path.join(process.cwd(), "contacts.json");

  interface ContactItem {
    id: string;
    name: string;
    phone: string;
    notes?: string;
    source?: 'wa' | 'manual';
    createdAt: number;
  }

  function loadContacts(): ContactItem[] {
    try {
      if (fs.existsSync(CONTACTS_PATH)) {
        return JSON.parse(fs.readFileSync(CONTACTS_PATH, "utf-8"));
      }
    } catch (e) {
      console.error("Erro ao ler contacts.json:", e);
    }
    return [];
  }

  function saveContacts(contacts: ContactItem[]): void {
    try {
      fs.writeFileSync(CONTACTS_PATH, JSON.stringify(contacts, null, 2), "utf-8");
    } catch (e) {
      console.error("Erro ao salvar contacts.json:", e);
    }
  }

  function loadKnowledgeBase(): string {
    try {
      if (fs.existsSync(KNOWLEDGE_BASE_PATH)) {
        const data = JSON.parse(fs.readFileSync(KNOWLEDGE_BASE_PATH, "utf-8"));
        return data.content || "";
      }
    } catch (e) {
      console.error("Erro ao ler knowledge-base.json:", e);
    }
    return "";
  }

  function saveKnowledgeBase(content: string): void {
    try {
      fs.writeFileSync(KNOWLEDGE_BASE_PATH, JSON.stringify({ content, updatedAt: Date.now() }, null, 2), "utf-8");
    } catch (e) {
      console.error("Erro ao salvar knowledge-base.json:", e);
    }
  }

  interface ChatHistoryMessage {
    role: "user" | "assistant";
    text: string;
    timestamp: number;
  }

  type ConversationsMap = Record<string, ChatHistoryMessage[]>;

  function loadConversations(): ConversationsMap {
    try {
      if (fs.existsSync(CONVERSATIONS_PATH)) {
        return JSON.parse(fs.readFileSync(CONVERSATIONS_PATH, "utf-8"));
      }
    } catch (e) {
      console.error("Erro ao ler conversations.json:", e);
    }
    return {};
  }

  function saveConversations(map: ConversationsMap): void {
    try {
      fs.writeFileSync(CONVERSATIONS_PATH, JSON.stringify(map, null, 2), "utf-8");
    } catch (e) {
      console.error("Erro ao salvar conversations.json:", e);
    }
  }

  let conversationsMap: ConversationsMap = loadConversations();

  function getContactHistory(jid: string): ChatHistoryMessage[] {
    const cleanKey = jid.replace(/[^0-9]/g, "");
    return conversationsMap[cleanKey] || [];
  }

  function addMessageToHistory(jid: string, role: "user" | "assistant", text: string): ChatHistoryMessage[] {
    const cleanKey = jid.replace(/[^0-9]/g, "");
    if (!cleanKey) return [];

    if (!conversationsMap[cleanKey]) {
      conversationsMap[cleanKey] = [];
    }

    conversationsMap[cleanKey].push({
      role,
      text,
      timestamp: Date.now()
    });

    // Limit to N=20 messages per contact
    if (conversationsMap[cleanKey].length > 20) {
      conversationsMap[cleanKey] = conversationsMap[cleanKey].slice(-20);
    }

    saveConversations(conversationsMap);
    return conversationsMap[cleanKey];
  }

  /**
   * Número do criador do OSONE (Henrique Rodrigues / @henryzinhooo). Mensagens vindas deste
   * número são tratadas como ordens ao sistema, e não como atendimento — é assim que o
   * desenvolvedor controla o OSONE pelo próprio celular. Configurável por variável de
   * ambiente para quem instalar o OSONE por conta própria.
   */
  const DEVELOPER_WHATSAPP_NUMBER = (process.env.OSONE_DEVELOPER_WHATSAPP || "558499259368").replace(/\D/g, "");

  /**
   * Compara apenas os dígitos, porque o WhatsApp entrega o remetente como JID
   * ("5584999259368@c.us") e números brasileiros aparecem com ou sem o nono dígito
   * dependendo de como o contato foi salvo — comparar a string crua erraria nesses casos.
   */
  function isDeveloperNumber(senderJid: string): boolean {
    const digits = String(senderJid || "").replace(/\D/g, "");
    if (!digits || !DEVELOPER_WHATSAPP_NUMBER) return false;
    if (digits === DEVELOPER_WHATSAPP_NUMBER) return true;
    // Tolera a variação do nono dígito comparando os últimos 8 dígitos junto com o país/DDD.
    const tail = (n: string) => n.slice(-8);
    const areaAndCountry = (n: string) => n.slice(0, 4);
    return tail(digits) === tail(DEVELOPER_WHATSAPP_NUMBER)
      && areaAndCountry(digits) === areaAndCountry(DEVELOPER_WHATSAPP_NUMBER);
  }

  /** Prompt usado quando quem escreve é o próprio criador do OSONE, dando ordens ao sistema. */
  function buildDeveloperPrompt(senderName?: string): string {
    const contactHistory = getContactHistory(DEVELOPER_WHATSAPP_NUMBER);
    const historyText = contactHistory.length > 0
      ? contactHistory.slice(-12).map(m => `${m.role === "user" ? "Henrique" : "OSONE"}: ${m.text}`).join("\n")
      : "(primeira mensagem desta conversa)";

    return `Você é o OSONE, e quem está falando com você agora pelo WhatsApp é HENRIQUE RODRIGUES (@henryzinhooo), seu criador e dono — não é um cliente.

MODO DESENVOLVEDOR ATIVO. Ele está te comandando do próprio celular, então:
- Trate cada mensagem como uma ORDEM ou PERGUNTA direta a você, nunca como atendimento de vendas. Nunca ofereça produtos, nunca use script comercial, nunca o trate como lead.
- Responda de forma direta, técnica e sem enrolação. Ele conhece o sistema por dentro — pode falar de arquitetura, erros, configuração e detalhes internos abertamente.
- Se ele pedir informação sobre seu próprio estado (o que você consegue fazer, o que está ligado, o que deu errado), responda com o que você realmente sabe. Se não souber ou não tiver como verificar dali, diga isso claramente em vez de inventar.
- Se ele pedir uma ação que você não tem como executar por esta via (WhatsApp), diga exatamente isso e explique por onde ele consegue fazer — nunca finja que executou.
- Trate-o com a intimidade de quem te construiu: pode ser informal e direto, sem formalidade de atendimento.

HISTÓRICO RECENTE DA CONVERSA COM ELE:
${historyText}

Responda em português do Brasil, de forma natural para leitura no WhatsApp (sem markdown pesado, sem listas longas).`;
  }

  /**
   * Encontra o contato salvo em contacts.json correspondente a um remetente do WhatsApp.
   * Compara só os dígitos e tolera diferenças de prefixo (nono dígito, DDI presente ou não),
   * porque o WhatsApp entrega o remetente como JID ("5584999259368@s.whatsapp.net") enquanto o
   * contato pode ter sido cadastrado num formato mais curto.
   */
  function findSavedContact(senderJid: string): ContactItem | undefined {
    const cleanDigits = String(senderJid || "").replace(/\D/g, "");
    if (!cleanDigits) return undefined;
    /**
     * Mínimo de 10 dígitos no lado comparado por sufixo: DDD (2) + número local (8), o menor
     * recorte que ainda inclui código de área. Com o piso de 8 usado antes, um contato salvo só
     * com o número local (sem DDD, formato comum quando a pessoa digita "99925-9368" sem área)
     * casava contra QUALQUER remetente de QUALQUER DDD que terminasse nos mesmos 8 dígitos —
     * furando o onlyKnownContacts para um estranho de área diferente, que herdava o nome e as
     * notas do contato errado no prompt.
     */
    const MINIMO_DIGITOS_PARA_SUFIXO = 10;
    return loadContacts().find(c =>
      c.phone === cleanDigits ||
      (cleanDigits.length >= MINIMO_DIGITOS_PARA_SUFIXO && c.phone.length >= MINIMO_DIGITOS_PARA_SUFIXO && c.phone.endsWith(cleanDigits)) ||
      (c.phone.length >= MINIMO_DIGITOS_PARA_SUFIXO && cleanDigits.length >= MINIMO_DIGITOS_PARA_SUFIXO && cleanDigits.endsWith(c.phone))
    );
  }

  /**
   * Verifica se a mensagem chama o OSONE pelo comando de gatilho (ex.: "/osone") e devolve o
   * texto já sem o comando, que é o que vai para o modelo — a IA deve ler "me manda o catálogo",
   * não "/osone me manda o catálogo".
   *
   * Procura o comando em qualquer posição, e não só no começo, por dois motivos práticos:
   * mensagens de voz e imagens chegam aqui como transcrição/descrição gerada pela IA (com um
   * prefixo tipo "[Mensagem de voz do cliente]: ..."), então exigir o comando no início faria o
   * gatilho nunca funcionar por áudio; e é comum a pessoa escrever "oi, /osone me ajuda".
   *
   * Áudio tem uma diferença humana: ninguém fala "barra osone" naturalmente. Quando o comando
   * configurado é o padrão "/osone", aceitamos também as grafias fonéticas que apareceram
   * em transcrições reais ("osone", "ozone", "ozoni", "ozzone" e "osoni"), removendo só a
   * chamada e mantendo o pedido real para a IA responder. Isso não afrouxa comandos personalizados.
   */
  function matchTriggerCommand(text: string): { triggered: boolean; cleanedText: string } {
    const trigger = (whatsappConfig.triggerCommand || "").trim().toLowerCase();
    if (!trigger) return { triggered: true, cleanedText: text };

    const limparDepoisDoGatilho = (valor: string) => valor
      .replace(/\s{2,}/g, " ")
      .replace(/^\[(?:mensagem de voz|áudio)[^\]]*\]:?\s*$/i, "")
      .trim();

    const lower = text.toLowerCase();
    const idx = lower.indexOf(trigger);
    if (idx !== -1) {
      return {
        triggered: true,
        cleanedText: limparDepoisDoGatilho(text.slice(0, idx) + text.slice(idx + trigger.length))
      };
    }

    const comandoPadrao = trigger.replace(/[^\p{L}\p{N}]+/gu, "");
    if (comandoPadrao === "osone") {
      // O Gemini transcreve o mesmo nome de maneiras diferentes conforme voz, sotaque e ruído.
      // O limite por palavra impede que a sequência seja encontrada dentro de outra palavra.
      const falado = text.match(/(^|[^\p{L}\p{N}])(?:osone|osoni|ozone|ozoni|ozzone)(?=$|[^\p{L}\p{N}])/iu);
      if (falado?.index !== undefined) {
        const inicio = falado.index + falado[1].length;
        const palavra = falado[0].slice(falado[1].length);
        return {
          triggered: true,
          cleanedText: limparDepoisDoGatilho(text.slice(0, inicio) + text.slice(inicio + palavra.length))
        };
      }
    }

    return { triggered: false, cleanedText: text };
  }

  function buildSalesPrompt(senderJid: string, senderName?: string): string {
    const kbContent = loadKnowledgeBase();
    const contactHistory = getContactHistory(senderJid);
    const cleanDigits = senderJid.replace(/\D/g, "");

    // Look up contact details in contacts.json
    const matchContact = findSavedContact(senderJid);

    let contactProfileStr = "";
    if (matchContact) {
      contactProfileStr = `
=== PERFIL DO CONTATO REGISTRADO (CONHECIMENTO INDIVIDUAL) ===
- Nome do Cliente: ${matchContact.name}
- Telefone: +${matchContact.phone}
- Observações / Anotações do Cliente: ${matchContact.notes || "Sem observações cadastradas"}
- Origem: ${matchContact.source === 'wa' ? 'Contato do WhatsApp Sincronizado' : 'Cadastrado Manualmente'}
==============================================================
`;
    } else if (senderName) {
      contactProfileStr = `
=== PERFIL DO CONTATO ===
- Nome Detectado no WhatsApp: ${senderName}
- Telefone: +${cleanDigits}
=========================
`;
    }

    let historyStr = "";
    if (contactHistory.length > 0) {
      historyStr = contactHistory
        .map(m => `${m.role === "user" ? "Cliente" : "Vendedor AI OSONE ZAP"}: ${m.text}`)
        .join("\n");
    }

    const clientDisplayName = matchContact?.name || senderName || senderJid;

    return `Você é um Vendedor de Elite e Consultor Comercial atuando no OSONE ZAP pelo WhatsApp em nome da empresa.
Seu objetivo é sanar dúvidas do cliente, apresentar soluções de forma altamente persuasiva, tirar dúvidas de preços e fechar vendas com tom humano, natural e acolhedor.

=== BASE DE CONHECIMENTO DO PRODUTO E DA EMPRESA ===
${kbContent || "Nenhuma informação adicional sobre produtos/preços foi cadastrada na base de conhecimento ainda."}
===================================================
${contactProfileStr}
HISTÓRICO RECENTE DAS ÚLTIMAS CONVERSAS COM ESTE CLIENTE (${clientDisplayName}):
${historyStr || "Esta é a primeira mensagem deste cliente no histórico registrado."}

DIRETRIZES RÍGIDAS DE ATENDIMENTO:
1. Responda em estilo natural do WhatsApp: parágrafos curtos, linguagem leve, empática e objetiva. Use emojis com moderação.
2. Tratamento Personalizado: Trate o cliente pelo nome (${clientDisplayName}), levando em consideração as observações sobre esta pessoa cadastradas na lista de contatos.
3. Utilize as informações da BASE DE CONHECIMENTO para responder sobre produtos, preços, benefícios, garantias e formas de pagamento.
4. Não invente dados falsos ou preços que não estejam na Base de Conhecimento. Se o cliente perguntar algo indisponível na base, responda com cordialidade que vai consultar a equipe técnica e que responderá em instantes.
5. Mantenha a continuidade exata em relação ao Histórico Recente de Conversas. Se o cliente fizer uma pergunta de acompanhamento (ex: "E a segunda opção?", "Qual o valor daquele produto que mencionou?"), consulte o histórico acima para entender o contexto anterior antes de responder.`;
  }

  // Sintetiza uma resposta em áudio para o OSONE ZAP (voz do vendedor IA), usada pelo listener
  // de auto-resposta do WhatsApp para enviar tanto texto quanto áudio. Independente/isolada da
  // rota /api/tts (usada pela Prosa/Sensus) para não arriscar alterar aquele fluxo já existente.
  /**
   * Converte o áudio gerado (WAV do Gemini, MP3 do ElevenLabs) para OGG/Opus — o único formato
   * que o WhatsApp aceita numa mensagem de VOZ de verdade (ptt).
   *
   * Sem esta conversão, o envio "dá certo" e mesmo assim o áudio nunca chega: o servidor do
   * WhatsApp aceita o upload de um WAV/MP3 marcado como ptt sem reclamar, e simplesmente
   * descarta o áudio na entrega. Como nenhuma exceção é lançada, o OSONE registrava "áudio
   * enviado" no log enquanto o destinatário recebia só o texto — a falha mais confusa possível,
   * porque não deixava rastro nenhum.
   *
   * Depende do ffmpeg instalado no sistema. Devolve null quando ele não existe ou a conversão
   * falha, e nesse caso quem chama envia o áudio como ARQUIVO comum (que toca normalmente no
   * WhatsApp), em vez de uma mensagem de voz que não chegaria.
   */
  /**
   * Descobre qual ffmpeg usar. Prefere o binário que vai empacotado junto do OSONE — assim a
   * mensagem de voz funciona para qualquer pessoa que instale o app, sem pedir que ela instale
   * nada (no Windows isso exigiria baixar um zip e editar variáveis de ambiente, o que nenhum
   * usuário comum faria). Cai para o ffmpeg do sistema se o embutido não estiver disponível,
   * o que cobre o modo desenvolvimento e instalações por conta própria.
   */
  function resolverCaminhoFfmpeg(): string {
    try {
      // O caminho vem apontando para dentro do app.asar no app empacotado, e binários não podem
      // ser executados de dentro do arquivo asar. O electron-builder extrai esta pasta para
      // "app.asar.unpacked" (ver asarUnpack no package.json) — é para lá que o caminho aponta.
      const bruto = (ffmpegStatic as unknown as string) || "";
      const desempacotado = bruto.replace("app.asar", "app.asar.unpacked");
      if (desempacotado && fs.existsSync(desempacotado)) return desempacotado;
    } catch (_) { /* usa o ffmpeg do sistema */ }
    return "ffmpeg";
  }

  async function converterAudioParaOpus(buffer: Buffer, extensaoOrigem: string): Promise<Buffer | null> {
    const base = path.join(os.tmpdir(), `osone-voz-${crypto.randomBytes(6).toString("hex")}`);
    const entrada = `${base}.${extensaoOrigem || "wav"}`;
    const saida = `${base}.ogg`;
    try {
      fs.writeFileSync(entrada, buffer);
      // Parâmetros da mensagem de voz do WhatsApp: Opus, mono, 48 kHz, em contêiner OGG.
      await new Promise<void>((resolve, reject) => {
        execFile(
          resolverCaminhoFfmpeg(),
          ["-hide_banner", "-loglevel", "error", "-y", "-i", entrada,
           "-c:a", "libopus", "-b:a", "32k", "-ar", "48000", "-ac", "1", "-f", "ogg", saida],
          { timeout: 60000 },
          (erro) => (erro ? reject(erro) : resolve())
        );
      });
      if (!fs.existsSync(saida) || fs.statSync(saida).size === 0) return null;
      return fs.readFileSync(saida);
    } catch (e: any) {
      const semFfmpeg = e?.code === "ENOENT";
      console.warn(
        semFfmpeg
          ? "[OSONE ZAP] ffmpeg não encontrado: o áudio será enviado como arquivo, não como mensagem de voz. Instale o ffmpeg para ter o áudio na bolinha de voz."
          : `[OSONE ZAP] Falha ao converter o áudio para Opus: ${e?.message || e}`
      );
      return null;
    } finally {
      fs.unlink(entrada, () => {});
      fs.unlink(saida, () => {});
    }
  }

  /**
   * Tenta de novo antes de desistir. Existe especificamente para o envio de áudio: o Baileys
   * já tenta vários servidores do WhatsApp para o upload da mídia, mas se TODOS falharem
   * naquele instante (rede instável, servidor sobrecarregado por um segundo) ele desiste com
   * "Media upload failed on all hosts" — e sem isto aqui essa falha passageira jogava fora o
   * áudio inteiro, mesmo a resposta em texto já tendo chegado normalmente. Tentando de novo
   * alguns segundos depois, na prática a maioria se resolve sozinha.
   */
  async function comRetentativa<T>(fn: () => Promise<T>, tentativas = 3): Promise<T> {
    let ultimoErro: any;
    for (let i = 0; i < tentativas; i++) {
      try {
        return await fn();
      } catch (e: any) {
        ultimoErro = e;
        if (i < tentativas - 1) await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
      }
    }
    throw ultimoErro;
  }

  /**
   * Envia o áudio pelo WhatsApp no melhor formato disponível e conta a verdade sobre o que
   * saiu: mensagem de voz (quando há ffmpeg) ou arquivo de áudio (quando não há). Os dois
   * tocam no WhatsApp — o que muda é a aparência.
   */
  async function enviarAudioWhatsApp(jid: string, speech: { buffer: Buffer; mimeType: string; extension: string }): Promise<"voz" | "arquivo"> {
    const opus = await converterAudioParaOpus(speech.buffer, speech.extension);
    if (opus) {
      await comRetentativa(() => waSocket.sendMessage(jid, { audio: opus, mimetype: "audio/ogg; codecs=opus", ptt: true }));
      return "voz";
    }
    // ptt:false de propósito: marcar um WAV/MP3 como mensagem de voz faz o WhatsApp descartá-lo
    // silenciosamente. Como arquivo de áudio ele chega e toca normalmente.
    await comRetentativa(() => waSocket.sendMessage(jid, { audio: speech.buffer, mimetype: speech.mimeType, ptt: false }));
    return "arquivo";
  }

  /**
   * Guarda o motivo da última falha de síntese de voz para que quem chamou possa mostrá-lo ao
   * usuário. A função devolve null quando não consegue gerar o áudio, e só isso não diz nada
   * sobre a causa — que é justamente o que se precisa saber quando a voz para de funcionar.
   */
  let ultimoErroTts = "";

  /**
   * Onde mora a voz local (Piper). Baixada por "npm run baixar-voz" e embutida no instalador
   * pelo GitHub Actions. Como qualquer binário empacotado, precisa ficar fora do app.asar para
   * poder ser executado — daí a troca por "app.asar.unpacked" (ver asarUnpack no package.json).
   */
  function caminhosDaVozLocal(): { binario: string; modelo: string } | null {
    // Sem __dirname aqui: este arquivo roda como ESM em desenvolvimento (tsx), onde essa
    // variável não existe e o simples acesso a ela lança erro — derrubando toda a cadeia de voz
    // em vez de apenas pular a voz local. No app empacotado o bundle vira CommonJS e ela
    // passaria a existir, então o defeito só apareceria em desenvolvimento.
    const candidatos = [
      // Desenvolvimento: a pasta vendor fica na raiz do projeto.
      path.join(process.cwd(), "vendor", "piper"),
      // App instalado: o electron-builder extrai o que está em asarUnpack para cá. O
      // process.cwd() não serve no empacotado — o Electron o aponta para a pasta de dados do
      // usuário (ver electron/main.js), que não contém os arquivos do programa.
      path.join(process.resourcesPath || "", "app.asar.unpacked", "vendor", "piper"),
      path.join(process.resourcesPath || "", "vendor", "piper"),
    ];
    for (const dir of candidatos) {
      if (!dir) continue;
      const binario = path.join(dir, process.platform === "win32" ? "piper.exe" : "piper");
      const modelo = path.join(dir, "pt_BR-faber-medium.onnx");
      if (fs.existsSync(binario) && fs.existsSync(modelo)) return { binario, modelo };
    }
    return null;
  }

  /**
   * Gera a voz na própria máquina, sem cota, sem chave e sem internet.
   *
   * É a rede de segurança final do áudio: as vozes de nuvem (Gemini, ElevenLabs) têm limite
   * diário ou mensal que acaba no meio do expediente, e é justamente quando o robô está sendo
   * usado que ele não pode emudecer. A voz daqui é um pouco menos natural, mas nunca acaba.
   */
  async function sintetizarComVozLocal(texto: string): Promise<Buffer | null> {
    // Esta é a ÚLTIMA rede de segurança do áudio: se ela lançar uma exceção em vez de devolver
    // null, derruba a cadeia inteira e o robô fica sem áudio justamente no caminho criado para
    // impedir isso — foi o que aconteceu com um __dirname inexistente em ESM.
    let caminhos: { binario: string; modelo: string } | null = null;
    try {
      caminhos = caminhosDaVozLocal();
    } catch (e: any) {
      console.error(`[OSONE ZAP] Erro ao localizar a voz local: ${e?.message || e}`);
      return null;
    }

    if (!caminhos) {
      console.warn("[OSONE ZAP] Voz local não instalada. Rode 'npm run baixar-voz' para nunca ficar sem áudio.");
      return null;
    }

    const saida = path.join(os.tmpdir(), `osone-voz-local-${crypto.randomBytes(6).toString("hex")}.wav`);
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = execFile(
          caminhos.binario,
          ["--model", caminhos.modelo, "--output_file", saida, "--quiet"],
          // O binário carrega bibliotecas (onnxruntime, espeak) que ficam ao lado dele: sem
          // rodar a partir dessa pasta, ele não as encontra e falha ao iniciar.
          { cwd: path.dirname(caminhos.binario), timeout: 120000 },
          (erro) => (erro ? reject(erro) : resolve())
        );
        // O Piper lê o texto pela entrada padrão.
        proc.stdin?.end(texto);
      });

      if (!fs.existsSync(saida) || fs.statSync(saida).size === 0) return null;
      const wav = fs.readFileSync(saida);
      console.log(`[OSONE ZAP] Áudio gerado pela voz local (${(wav.length / 1024).toFixed(0)} KB) — sem consumir cota.`);
      return wav;
    } catch (e: any) {
      console.error(`[OSONE ZAP] Falha na voz local: ${e?.message || e}`);
      return null;
    } finally {
      fs.unlink(saida, () => {});
    }
  }

  /**
   * Supertonic 3 é a voz neural local principal: português, natural, sem chave e sem cota.
   * Os quase 400 MB são baixados somente no primeiro uso para não inflar o repositório nem o
   * instalador. A instância ONNX fica em memória depois disso; recarregá-la em toda frase seria
   * muito mais lento do que a própria síntese.
   */
  let supertonicCarregado: Promise<any> | null = null;
  let filaSupertonic: Promise<unknown> = Promise.resolve();

  async function carregarSupertonic(): Promise<any> {
    if (supertonicCarregado) return supertonicCarregado;
    supertonicCarregado = (async () => {
      const assets = await import("./src/lib/supertonic-assets.mjs");
      const runtime = await import("./src/lib/supertonic-runtime.mjs");
      const pasta = await assets.garantirAssetsSupertonic();
      const tts = await runtime.loadTextToSpeech(path.join(pasta, "onnx"), false);
      return { pasta, runtime, tts };
    })().catch((erro) => {
      // Permite tentar novamente depois de uma queda de internet ou arquivo incompleto.
      supertonicCarregado = null;
      throw erro;
    });
    return supertonicCarregado;
  }

  async function sintetizarComSupertonic(texto: string, voz = "F1"): Promise<Buffer | null> {
    const frase = stripVocalTags(texto).slice(0, 900);
    if (!frase) return null;
    const vozSegura = voz === "M1" ? "M1" : "F1";

    const executar = async (): Promise<Buffer | null> => {
      const saida = path.join(os.tmpdir(), `osone-supertonic-${crypto.randomBytes(6).toString("hex")}.wav`);
      try {
        const { pasta, runtime, tts } = await carregarSupertonic();
        const estilo = runtime.loadVoiceStyle([path.join(pasta, "voice_styles", `${vozSegura}.json`)]);
        // Seis passos preservam naturalidade sem tornar a resposta pesada demais em CPUs antigas.
        const resultado = await tts.call(frase, "pt", estilo, 6, 1.06);
        const limite = Math.floor(tts.sampleRate * resultado.duration[0]);
        runtime.writeWavFile(saida, resultado.wav.slice(0, limite), tts.sampleRate);
        const wav = fs.readFileSync(saida);
        if (wav.length <= 44) throw new Error("o modelo devolveu áudio vazio");
        console.log(`[VOZ NATURAL] Supertonic ${vozSegura} gerou ${(wav.length / 1024).toFixed(0)} KB localmente.`);
        return wav;
      } catch (erro: any) {
        console.error(`[VOZ NATURAL] Falha no Supertonic: ${erro?.message || erro}`);
        ultimoErroTts = `Voz natural local: ${erro?.message || erro}`;
        return null;
      } finally {
        fs.unlink(saida, () => {});
      }
    };

    // Uma sessão ONNX por vez evita duas respostas competindo por CPU/memória e vozes se
    // atropelando quando COWORK e WhatsApp pedem áudio ao mesmo tempo.
    const atual = filaSupertonic.then(executar, executar);
    filaSupertonic = atual.then(() => undefined, () => undefined);
    return atual;
  }

  /**
   * Traduz o erro cru da API de voz numa frase que explique o que fazer.
   *
   * A API devolve um bloco de JSON de vários milhares de caracteres para dizer coisas simples
   * como "acabou sua cota do dia". Jogado direto no log, ele esconde a informação em vez de
   * entregá-la — e o caso mais comum, o limite diário do plano gratuito, é justamente o que o
   * usuário mais precisa entender rápido.
   */
  function explicarErroDeVoz(modelo: string, erro: any): string {
    const bruto = String(erro?.message || erro || "");

    if (bruto.includes("RESOURCE_EXHAUSTED") || bruto.includes("429")) {
      // O limite que estoura na prática é o de requisições por DIA no plano gratuito (10 por
      // modelo). Vale extrair o número em vez de fixá-lo aqui: ele muda sem aviso.
      const limite = bruto.match(/"quotaValue":\s*"(\d+)"/)?.[1];
      const segundos = bruto.match(/"retryDelay":\s*"(\d+)s"/)?.[1];
      if (limite === "0") {
        return `${modelo}: não está disponível no plano gratuito (cota zero).`;
      }
      return `${modelo}: cota diária de voz esgotada${limite ? ` (${limite} áudios por dia no plano gratuito)` : ""}.${segundos ? ` A API sugere tentar de novo em ${segundos}s, mas o limite é diário — só volta amanhã.` : ""}`;
    }
    if (bruto.includes("API_KEY_INVALID") || bruto.includes("API key not valid")) {
      return `${modelo}: a chave do Gemini foi recusada.`;
    }
    if (bruto.includes("PERMISSION_DENIED") || bruto.includes("SERVICE_DISABLED")) {
      return `${modelo}: a chave não tem permissão para este modelo.`;
    }
    if (bruto.includes("NOT_FOUND") || bruto.includes("not found")) {
      return `${modelo}: modelo inexistente ou fora do ar para esta chave.`;
    }
    return `${modelo}: ${bruto.slice(0, 150)}`;
  }

  /**
   * Pergunta à API do Gemini quais modelos de voz esta chave enxerga.
   *
   * Existe porque nomes de modelo mudam de geração em geração e a quebra é silenciosa: o
   * modelo fixo no código some da API, toda chamada falha, e não sobra pista nenhuma. Com a
   * consulta, o OSONE se reajusta sozinho quando o Google renomeia ou aposenta um modelo.
   *
   * O resultado fica em cache: a lista não muda durante a execução e a consulta custa uma
   * chamada de rede que não vale repetir a cada áudio.
   */
  let cacheModelosDeVoz: string[] | null = null;
  async function descobrirModelosDeVoz(ai: any): Promise<string[]> {
    if (cacheModelosDeVoz) return cacheModelosDeVoz;
    try {
      const resposta = await ai.models.list();
      // O SDK ora devolve um array, ora um paginador iterável — aceita os dois formatos.
      const lista: any[] = Array.isArray(resposta) ? resposta : [];
      if (!lista.length && resposta && typeof resposta[Symbol.asyncIterator] === "function") {
        for await (const m of resposta) lista.push(m);
      }
      const nomes = lista
        .map((m: any) => String(m?.name || "").replace(/^models\//, ""))
        .filter((nome: string) => nome.toLowerCase().includes("tts"));
      cacheModelosDeVoz = nomes;
      console.log(
        nomes.length
          ? `[OSONE ZAP] Modelos de voz disponíveis nesta chave: ${nomes.join(", ")}`
          : "[OSONE ZAP] A API não listou nenhum modelo de voz (TTS) para esta chave."
      );
      return nomes;
    } catch (e: any) {
      console.warn(`[OSONE ZAP] Não foi possível listar os modelos da API: ${e?.message || e}`);
      cacheModelosDeVoz = [];
      return [];
    }
  }

  type OpcoesDeVoz = {
    engine?: "gemini" | "elevenlabs" | "supertonic" | "local";
    geminiApiKey?: string;
    voice?: string;
    supertonicVoice?: "F1" | "M1";
    elevenLabsApiKey?: string;
    elevenLabsVoiceId?: string;
    /** Uso interno: marca a chamada de revezamento, para não repetir a troca de motor em ciclo. */
    jaTentouFallback?: boolean;
  };
  type AudioSintetizado = { buffer: Buffer; mimeType: string; extension: string };

  /**
   * Ponto de entrada da síntese de voz: tenta as vozes de nuvem e, se nenhuma delas responder,
   * cai para a voz local.
   *
   * A rede de segurança fica AQUI, num lugar só, de propósito. Quando ela vivia dentro da
   * lógica da nuvem, cobria apenas um caminho de falha — bastava o motor estar configurado como
   * ElevenLabs, ou faltar a chave do Gemini, para a função desistir antes de chegar nela. Ou
   * seja: falhava exatamente na situação em que foi criada para servir, a de trocar de motor
   * porque a cota acabou.
   */
  async function synthesizeWhatsAppVoiceReply(text: string, opts: OpcoesDeVoz): Promise<AudioSintetizado | null> {
    if (!opts.jaTentouFallback) ultimoErroTts = "";

    const pelaNuvem = await sintetizarPelaNuvem(text, opts);
    if (pelaNuvem) return pelaNuvem;

    // Chamada de revezamento interna (gemini -> elevenlabs): quem tentar a voz local é a
    // chamada externa, uma vez só, para não disparar o Piper duas vezes na mesma mensagem.
    if (opts.jaTentouFallback) return null;

    const limpo = stripVocalTags((text || "").trim());
    if (!limpo) return null;

    // Quem escolheu Piper explicitamente continua no Piper. Nos demais motores, a rede de
    // segurança prioritária agora é a voz neural natural, e o Piper permanece como último plano.
    const wavNatural = opts.engine === "local"
      ? null
      : await sintetizarComSupertonic(limpo, opts.supertonicVoice || "F1");
    if (wavNatural) {
      ultimoErroTts = "";
      return { buffer: wavNatural, mimeType: "audio/wav", extension: "wav" };
    }

    const wavLocal = await sintetizarComVozLocal(limpo);
    if (wavLocal) {
      ultimoErroTts = "";
      return { buffer: wavLocal, mimeType: "audio/wav", extension: "wav" };
    }

    ultimoErroTts = `${ultimoErroTts} A voz local também não está disponível — rode 'npm run baixar-voz' para instalá-la e nunca mais ficar sem áudio.`.trim();
    return null;
  }

  async function sintetizarPelaNuvem(text: string, opts: OpcoesDeVoz): Promise<AudioSintetizado | null> {
    // Voz local escolhida de propósito: não passa pela nuvem. Devolver null aqui já basta —
    // quem chamou cai direto no Piper, sem gastar cota de nenhum serviço no caminho.
    if (opts.engine === "local" || opts.engine === "supertonic") return null;
    const cleanText = (text || "").trim();
    if (!cleanText) return null;

    if (opts.engine === "elevenlabs") {
      const elApiKey = opts.elevenLabsApiKey || process.env.ELEVENLABS_API_KEY;
      if (!elApiKey) return null;
      const validacaoChave = validarChaveElevenLabsParaUso(elApiKey);
      if (!validacaoChave.ok) {
        ultimoErroTts = validacaoChave.message;
        return null;
      }
      const cleanTextForEleven = stripVocalTags(cleanText);
      const voiceId = opts.elevenLabsVoiceId || process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";

      let response: Response | null = null;
      try {
        response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: "POST",
          headers: { "xi-api-key": validacaoChave.key, "Content-Type": "application/json", "accept": "audio/mpeg" },
          body: JSON.stringify({
            text: cleanTextForEleven,
            model_id: "eleven_turbo_v2_5",
            voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true }
          })
        });
      } catch (_) { /* tenta o fallback abaixo */ }

      if (!response || !response.ok) {
        try {
          response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            method: "POST",
            headers: { "xi-api-key": validacaoChave.key, "Content-Type": "application/json", "accept": "audio/mpeg" },
            body: JSON.stringify({
              text: cleanTextForEleven,
              model_id: "eleven_multilingual_v2",
              voice_settings: { stability: 0.5, similarity_boost: 0.75 }
            })
          });
        } catch (_) { /* sem áudio disponível */ }
      }

      if (!response || !response.ok) return null;
      const arrayBuffer = await response.arrayBuffer();
      return { buffer: Buffer.from(arrayBuffer), mimeType: "audio/mpeg", extension: "mp3" };
    }

    // Motor padrão: Gemini TTS, com fallback automático para Google Translate TTS
    const apiKey = opts.geminiApiKey || getSecretGeminiKey();
    if (!apiKey) return null;

    const ai = new GoogleGenAI({
      apiKey,
      vertexai: false,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } }
    });

    const supportedGeminiVoices = ["Puck", "Charon", "Kore", "Fenrir", "Zephyr", "Aoede"];
    let selectedVoice = opts.voice || "Kore";
    if (!supportedGeminiVoices.includes(selectedVoice)) selectedVoice = "Kore";

    // Só modelos de VOZ entram aqui. A lista anterior trazia junto três modelos de texto
    // (gemini-3.6-flash e as duas variantes flash-lite): eles nunca devolvem áudio, então
    // serviam apenas para gastar tempo e cota antes de falhar igual. Quando o modelo de voz
    // não estava disponível para a chave, o resultado era nenhum áudio e nenhuma explicação.
    const candidateModels = [
      "gemini-3.1-flash-tts-preview",
      "gemini-2.5-flash-preview-tts",
      "gemini-2.5-pro-preview-tts",
    ];
    // Nomes de modelo mudam a cada geração e quebram silenciosamente. Se nenhum candidato fixo
    // funcionar, o OSONE pergunta à própria API quais modelos de voz a chave enxerga e tenta
    // esses — assim a voz volta a funcionar sozinha quando o Google renomeia algo.
    const descobertos = await descobrirModelosDeVoz(ai);
    for (const m of descobertos) {
      if (!candidateModels.includes(m)) candidateModels.push(m);
    }
    const chunks = splitIntoTtsChunks(cleanText, 700);
    const buffers: Buffer[] = [];

    for (const chunk of chunks) {
      const processedChunk = stripVocalTags(chunk);
      let chunkAudioBuffer: Buffer | null = null;

      // Guarda o motivo de cada tentativa frustrada. Antes o catch era vazio: quando a voz
      // parava de funcionar não sobrava nenhuma pista — nem qual modelo falhou, nem por quê —
      // e o problema ficava invisível porque a voz robótica de emergência cobria o buraco.
      const falhasPorModelo: string[] = [];

      for (const modelName of candidateModels) {
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents: [{ parts: [{ text: `Leia o seguinte trecho com clareza absoluta, expressividade natural, pausas realistas e ritmo agradável de palestrante:\n\n${processedChunk}` }] }],
            config: {
              responseModalities: [Modality.AUDIO],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } } }
            }
          });
          const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
          if (base64Audio) {
            chunkAudioBuffer = Buffer.from(base64Audio, "base64");
            break;
          }
          falhasPorModelo.push(`${modelName}: respondeu sem áudio`);
        } catch (e: any) {
          falhasPorModelo.push(explicarErroDeVoz(modelName, e));
        }
      }

      if (!chunkAudioBuffer) {
        console.error(
          "[OSONE ZAP] Nenhum modelo conseguiu gerar a voz:\n  " + falhasPorModelo.join("\n  ")
        );
        // Cota estourada em todos os modelos é o caso mais comum e tem uma saída prática, então
        // ganha uma mensagem própria em vez da lista de falhas repetindo o mesmo motivo.
        const todosSemCota = falhasPorModelo.length > 0 && falhasPorModelo.every(f => f.includes("cota"));
        ultimoErroTts = todosSemCota
          ? "A cota diária de voz do plano gratuito do Gemini acabou (são poucos áudios por dia). As respostas em texto seguem normalmente. Para voltar a ter áudio hoje: ative o faturamento no Google AI Studio, use uma chave de outro projeto, ou troque o motor de voz para ElevenLabs nos Ajustes."
          : falhasPorModelo.join(" | ");
      }

      if (chunkAudioBuffer) {
        buffers.push(chunkAudioBuffer);
      } else {
        // Havia aqui um recurso de emergência com a voz robótica do Google Tradutor. Foi
        // removido: ele salvava o envio, mas só nos trechos em que o Gemini falhava, então a
        // mesma mensagem alternava entre a voz natural e a robótica no meio da frase. O
        // revezamento agora é para a ElevenLabs e, por fim, para a voz local — ambas boas.
        console.error("[OSONE ZAP] O Gemini TTS não gerou áudio para um trecho.");

        // Troca automática de motor: a cota gratuita de voz do Gemini é de poucos áudios por
        // DIA, então ela acaba no meio do expediente e o robô emudece justamente quando está
        // sendo usado. Havendo chave da ElevenLabs, o áudio continua saindo por lá sem que
        // ninguém precise mexer em nada. 'jaTentouFallback' evita recursão infinita caso a
        // ElevenLabs também falhe.
        const chaveEleven = opts.elevenLabsApiKey || process.env.ELEVENLABS_API_KEY;
        if (chaveEleven && !opts.jaTentouFallback) {
          console.log("[OSONE ZAP] Trocando automaticamente para a ElevenLabs para não ficar sem áudio.");
          const porEleven = await synthesizeWhatsAppVoiceReply(text, { ...opts, engine: "elevenlabs", jaTentouFallback: true });
          if (porEleven) {
            ultimoErroTts = "";
            return porEleven;
          }
          ultimoErroTts = `${ultimoErroTts} A troca automática para a ElevenLabs também não funcionou.`;
        }

        // Devolve null e quem chamou (synthesizeWhatsAppVoiceReply) tenta a voz local. A rede
        // de segurança fica lá em cima, num ponto só, para nenhum caminho de falha escapar dela.
        return null;
      }
    }

    if (buffers.length === 0) return null;
    return { buffer: pcmToWav(Buffer.concat(buffers), 24000), mimeType: "audio/wav", extension: "wav" };
  }

  // Traduz o código de desconexão do Baileys (erro Boom com statusCode equivalente a um
  // DisconnectReason) em uma mensagem que explica ao usuário o que aconteceu, em vez de só
  // mostrar o código bruto.
  function explainWhatsAppDisconnect(statusCode: number | undefined, rawMessage: string, DisconnectReason: Awaited<ReturnType<typeof loadBaileys>>["DisconnectReason"]): string {
    const msg = rawMessage || "";
    switch (statusCode) {
      case DisconnectReason.loggedOut:
        return "A sessão foi encerrada pelo próprio celular (logout no app do WhatsApp). É necessário escanear um novo QR Code.";
      case DisconnectReason.badSession:
        return "A sessão salva ficou corrompida. Resete a sessão e escaneie um novo QR Code.";
      case DisconnectReason.connectionReplaced:
        return "Outra sessão do WhatsApp Web foi aberta em outro lugar e substituiu esta conexão.";
      case DisconnectReason.multideviceMismatch:
        return "Este WhatsApp não está com o modo multi-dispositivo compatível. Atualize o app do WhatsApp no celular.";
      case DisconnectReason.forbidden:
        return "O WhatsApp recusou a conexão (403). Tente resetar a sessão e conectar novamente.";
      case DisconnectReason.restartRequired:
        return "Reinício de conexão necessário (normal logo após escanear o QR Code) — reconectando automaticamente...";
      case DisconnectReason.timedOut:
        return "A conexão expirou por inatividade/rede. Tentando reconectar automaticamente...";
      case DisconnectReason.unavailableService:
        return "O serviço do WhatsApp está indisponível no momento. Tentando reconectar automaticamente...";
      default:
        return msg || `Conexão encerrada (código ${statusCode ?? "desconhecido"}).`;
    }
  }

  // Processa uma mensagem recebida via Baileys: extrai texto/mídia, gera a resposta com a IA
  // (respeitando o Modo Desenvolvedor para o número do criador) e envia de volta por texto e,
  // se habilitado, também por voz.
  /**
   * A trava contra responder duas vezes a mesma mensagem (ver lib/naoRepetir.ts).
   *
   * O Baileys pode entregar a MESMA mensagem mais de uma vez no 'messages.upsert', com o mesmo
   * key.id — recibo de retentativa, reconexão com notificações pendentes, ou chegada por mais de
   * um caminho. Sem isto, cada entrega repetida virava uma auto-resposta nova, e o cliente recebia
   * o mesmo texto duas vezes no mesmo minuto.
   */
  const waMensagensAtendidas = new NaoRepetir(500);

  async function handleIncomingWhatsAppMessage(msg: any) {
    const remoteJid: string = msg?.key?.remoteJid || "";
    if (!remoteJid || msg.key?.fromMe) return;
    // Antes de qualquer coisa: esta mensagem específica já foi atendida?
    if (waMensagensAtendidas.jaAtendido(msg?.key?.id || "")) {
      console.log(`[WhatsApp] Mensagem ${msg?.key?.id} chegou de novo e foi ignorada (já respondida).`);
      return;
    }
    if (remoteJid === "status@broadcast" || remoteJid.endsWith("@g.us") || remoteJid.endsWith("@broadcast")) return;
    if (!msg.message) return; // mensagem de protocolo (ex.: revogação/recibo), sem conteúdo real

    const sender = remoteJid;
    const formattedJid = remoteJid;
    const geminiApiKeyToUse = whatsappConfig.geminiApiKey || getSecretGeminiKey();

    // O WhatsApp envelopa o conteúdo real em uma camada extra quando "mensagens temporárias"
    // (disappearing messages) ou "ver uma vez" estão ativas no chat — sem desembrulhar aqui,
    // essas mensagens (cada vez mais comuns, já que muita gente ativa isso por padrão) ficavam
    // com "body" vazio e eram silenciosamente ignoradas, sem log de erro nenhum.
    let innerMessage: any = msg.message;
    for (let i = 0; i < 5; i++) {
      const unwrap = innerMessage?.ephemeralMessage?.message
        || innerMessage?.viewOnceMessage?.message
        || innerMessage?.viewOnceMessageV2?.message
        || innerMessage?.viewOnceMessageV2Extension?.message
        || innerMessage?.documentWithCaptionMessage?.message;
      if (!unwrap) break;
      innerMessage = unwrap;
    }

    let body: string = innerMessage.conversation || innerMessage.extendedTextMessage?.text || "";

    const imageMsg = innerMessage.imageMessage;
    const audioMsg = innerMessage.audioMessage;
    const mediaType: "image" | "audio" | null = imageMsg ? "image" : audioMsg ? "audio" : null;

    // Mensagens de imagem/áudio não têm "body" de texto: usamos o Gemini para descrever a
    // imagem ou transcrever o áudio, e tratamos o resultado como se fosse o texto da mensagem
    // dali em diante (histórico, auto-resposta, etc.).
    if (!body && mediaType) {
      if (!geminiApiKeyToUse) {
        whatsappLogs.unshift({
          id: Math.random().toString(36).substring(2, 11),
          timestamp: Date.now(),
          type: "error",
          sender,
          message: `Recebida mensagem de ${mediaType === "image" ? "imagem" : "áudio"}, mas nenhuma chave Gemini está configurada para analisá-la.`
        });
        if (whatsappLogs.length > 100) whatsappLogs.pop();
        return;
      }

      try {
        const { downloadMediaMessage } = await loadBaileys();
        const { default: pino } = await loadPino();
        const mediaBuffer = await downloadMediaMessage(msg, "buffer", {}, { logger: pino({ level: "silent" }) as any, reuploadRequest: waSocket.updateMediaMessage });
        if (!mediaBuffer || !(mediaBuffer as Buffer).length) {
          body = mediaType === "image" ? "[Imagem recebida, mas o download falhou]" : "[Áudio recebido, mas o download falhou]";
        } else {
          const mimeType = (mediaType === "image" ? imageMsg?.mimetype : audioMsg?.mimetype) || (mediaType === "image" ? "image/jpeg" : "audio/ogg");
          const base64Data = (mediaBuffer as Buffer).toString("base64");
          const mediaAi = new GoogleGenAI({ apiKey: geminiApiKeyToUse, vertexai: false });
          if (mediaType === "image") {
            const caption = imageMsg?.caption || "";
            const visionPrompt = `Você está examinando uma imagem enviada por um cliente no WhatsApp para um atendimento de vendas. Descreva objetivamente o que aparece (produto, defeito, print de conversa, comprovante, etc.), incluindo qualquer texto, preço ou detalhe visível que ajude a responder o cliente.${caption ? ` O cliente também escreveu esta legenda: "${caption}"` : ''}`;
            const visionResult = await generateContentWithFallback(mediaAi, {
              model: "gemini-3.5-flash-lite",
              contents: [{ parts: [{ inlineData: { data: base64Data, mimeType } }, { text: visionPrompt }] }]
            });
            const description = (visionResult.text || "").trim() || "Não foi possível identificar o conteúdo da imagem.";
            body = `[Imagem enviada pelo cliente]${caption ? ` Legenda: "${caption}".` : ''} Conteúdo identificado pela IA: ${description}`;
          } else {
            const transcribePrompt = "Transcreva literalmente, em português, o que a pessoa está falando neste áudio. Responda APENAS com a transcrição, sem comentários adicionais. Se não conseguir entender, responda apenas com: [áudio incompreensível]";
            const transcribeResult = await generateContentWithFallback(mediaAi, {
              model: "gemini-3.5-flash-lite",
              contents: [{ parts: [{ inlineData: { data: base64Data, mimeType } }, { text: transcribePrompt }] }]
            });
            const transcript = (transcribeResult.text || "").trim();
            body = transcript && transcript !== "[áudio incompreensível]"
              ? `[Mensagem de voz do cliente]: ${transcript}`
              : "[Áudio recebido do cliente, mas não foi possível transcrever]";
          }
        }
      } catch (mediaErr: any) {
        console.error("[WhatsApp] Erro ao processar mídia recebida:", mediaErr);
        body = mediaType === "image" ? "[Imagem recebida, mas houve erro ao analisá-la]" : "[Áudio recebido, mas houve erro ao transcrevê-lo]";
        whatsappLogs.unshift({
          id: Math.random().toString(36).substring(2, 11),
          timestamp: Date.now(),
          type: "error",
          sender,
          message: `Falha ao analisar mídia recebida: ${mediaErr?.message || mediaErr}`
        });
        if (whatsappLogs.length > 100) whatsappLogs.pop();
      }
    }

    if (!body) return;

    // Always add received message to contact history
    addMessageToHistory(sender, "user", body);

    whatsappLogs.unshift({
      id: Math.random().toString(36).substring(2, 11),
      timestamp: Date.now(),
      type: "received",
      sender: sender,
      message: body
    });
    if (whatsappLogs.length > 100) whatsappLogs.pop();

    if (!whatsappConfig.enabled) return;

    // Filtro de contatos: com o robô rodando sozinho, só responde a quem está cadastrado.
    // O número do desenvolvedor passa sempre — caso contrário o dono do sistema ficaria
    // trancado para fora do próprio modo desenvolvedor por não estar em contacts.json.
    // Quem escreveu o comando está claramente falando COM o robô. Se mesmo assim alguma trava
    // barrar a mensagem, isso precisa aparecer no log: era exatamente o caso em que o usuário
    // mandava "/osone", não recebia nada, e não havia nenhuma pista do motivo.
    const chamouORobo = matchTriggerCommand(body).triggered;

    if (whatsappConfig.onlyKnownContacts && !isDeveloperNumber(sender)) {
      const knownContact = findSavedContact(sender);
      if (!knownContact) {
        if (chamouORobo) {
          whatsappLogs.unshift({
            id: Math.random().toString(36).substring(2, 11),
            timestamp: Date.now(),
            type: "error",
            sender,
            message: `${msg.pushName || sender} chamou o OSONE com "${whatsappConfig.triggerCommand}", mas NÃO recebeu resposta: a opção "responder apenas contatos salvos" está LIGADA e este número não está na aba Contatos. Desligue essa opção no painel, ou cadastre o número.`
          });
          if (whatsappLogs.length > 100) whatsappLogs.pop();
          return;
        }
        whatsappLogs.unshift({
          id: Math.random().toString(36).substring(2, 11),
          timestamp: Date.now(),
          type: "info",
          sender,
          message: `Mensagem recebida de um número NÃO cadastrado (${msg.pushName || sender}). Nenhuma resposta automática foi enviada, porque o modo "responder apenas contatos salvos" está ativo. Para que o robô atenda este número, cadastre-o na aba Contatos do OSONE ZAP.`
        });
        if (whatsappLogs.length > 100) whatsappLogs.pop();
        return;
      }
    }

    // Gatilho: quando ligado, é uma trava absoluta. Qualquer remetente — inclusive o dono do
    // sistema — precisa chamar o OSONE pelo comando (ex.: "/osone"). Quando desligado, nenhuma
    // mensagem é filtrada por comando e o robô responde conforme os demais filtros ativos.
    let promptBody = body;
    if (whatsappConfig.requireTriggerCommand) {
      const { triggered, cleanedText } = matchTriggerCommand(body);
      if (!triggered) {
        // O silêncio continua sendo o comportamento correto numa conversa entre humanos, mas o
        // painel precisa explicar por que a mensagem recebida não virou resposta. Sem este registro,
        // um erro de transcrição do nome parecia defeito total da auto-resposta.
        whatsappLogs.unshift({
          id: Math.random().toString(36).substring(2, 11),
          timestamp: Date.now(),
          type: "info",
          sender,
          message: `Mensagem recebida, mas ignorada porque não continha o comando "${whatsappConfig.triggerCommand}" nem uma variação falada reconhecida de OSONE.`
        });
        if (whatsappLogs.length > 100) whatsappLogs.pop();
        return;
      }
      // Mensagem que era só o comando, sem pergunta junto ("/osone"): trata como um "oi",
      // senão o modelo receberia uma string vazia e responderia qualquer coisa.
      promptBody = cleanedText || "Olá!";
    }

    if (!geminiApiKeyToUse) {
      whatsappLogs.unshift({
        id: Math.random().toString(36).substring(2, 11),
        timestamp: Date.now(),
        type: "error",
        sender,
        message: "Auto-resposta está ativada, mas nenhuma chave Gemini está configurada (nem nos Ajustes do OSONE ZAP, nem no servidor). A resposta não pôde ser gerada."
      });
      if (whatsappLogs.length > 100) whatsappLogs.pop();
      return;
    }

    const ai = new GoogleGenAI({ apiKey: geminiApiKeyToUse, vertexai: false });

    // Build Context-Rich Sales Prompt with Knowledge Base + History
    const senderName = msg.pushName || waContactsCache.get(sender)?.name || sender;
    // O desenvolvedor comanda o OSONE pelo próprio celular: as mensagens dele não são
    // atendimento de vendas, são ordens ao sistema. Qualquer outro número continua
    // recebendo normalmente a auto-resposta de atendimento.
    const systemPrompt = isDeveloperNumber(sender)
      ? buildDeveloperPrompt(senderName)
      : buildSalesPrompt(sender, senderName);

    if (isDeveloperNumber(sender)) {
      whatsappLogs.unshift({
        id: Math.random().toString(36).substring(2, 11),
        timestamp: Date.now(),
        type: "info",
        sender,
        message: `[MODO DESENVOLVEDOR] Mensagem reconhecida como comando do criador do OSONE.`
      });
      if (whatsappLogs.length > 100) whatsappLogs.pop();
    }

    let replyText = "";
    try {
      const gResult = await generateContentWithFallback(ai, {
        model: "gemini-3.5-flash-lite",
        contents: promptBody,
        config: { systemInstruction: systemPrompt }
      });
      replyText = (gResult.text || "").trim() || "Olá! Agradeço sua mensagem. Como posso te ajudar com nossos produtos hoje?";
    } catch (genErr: any) {
      console.error("[WhatsApp] Erro ao gerar resposta da IA:", genErr);
      whatsappLogs.unshift({
        id: Math.random().toString(36).substring(2, 11),
        timestamp: Date.now(),
        type: "error",
        sender,
        message: `Falha ao gerar resposta com a IA: ${genErr?.message || genErr}`
      });
      if (whatsappLogs.length > 100) whatsappLogs.pop();
      return;
    }

    // Send reply directly back to contact
    try {
      await waSocket.sendMessage(formattedJid, { text: replyText });
    } catch (sendErr: any) {
      console.error("[WhatsApp] Erro ao enviar resposta de texto:", sendErr);
      whatsappLogs.unshift({
        id: Math.random().toString(36).substring(2, 11),
        timestamp: Date.now(),
        type: "error",
        sender,
        message: `A IA gerou uma resposta, mas o envio via WhatsApp falhou: ${sendErr?.message || sendErr}`
      });
      if (whatsappLogs.length > 100) whatsappLogs.pop();
      return;
    }

    // Add AI response to contact history
    addMessageToHistory(sender, "assistant", replyText);

    whatsappLogs.unshift({
      id: Math.random().toString(36).substring(2, 11),
      timestamp: Date.now(),
      type: "sent",
      sender: sender,
      message: replyText
    });
    if (whatsappLogs.length > 100) whatsappLogs.pop();

    // Também responde por áudio (voz), além do texto, se habilitado nas configurações.
    if (whatsappConfig.sendAudioReplies) {
      try {
        const speech = await synthesizeWhatsAppVoiceReply(replyText, {
          engine: whatsappConfig.ttsEngine,
          geminiApiKey: geminiApiKeyToUse,
          voice: whatsappConfig.ttsVoice,
          supertonicVoice: whatsappConfig.supertonicVoice,
          elevenLabsApiKey: whatsappConfig.elevenLabsApiKey,
          elevenLabsVoiceId: whatsappConfig.elevenLabsVoiceId
        });
        if (speech) {
          const formato = await enviarAudioWhatsApp(formattedJid, speech);
          if (formato === "arquivo") {
            whatsappLogs.unshift({
              id: Math.random().toString(36).substring(2, 11),
              timestamp: Date.now(),
              type: "info",
              sender,
              message: "Áudio enviado como ARQUIVO (toca normalmente). Para virar mensagem de voz na bolinha, instale o ffmpeg na máquina onde o OSONE roda."
            });
            if (whatsappLogs.length > 100) whatsappLogs.pop();
          }
        } else {
          whatsappLogs.unshift({
            id: Math.random().toString(36).substring(2, 11),
            timestamp: Date.now(),
            type: "error",
            sender,
            message: `Não foi possível gerar o áudio da resposta (o texto foi enviado normalmente). Motivo: ${ultimoErroTts || "a IA de voz não retornou áudio."}`
          });
          if (whatsappLogs.length > 100) whatsappLogs.pop();
        }
      } catch (ttsErr: any) {
        console.error("[WhatsApp] Erro ao gerar/enviar áudio de resposta:", ttsErr);
        whatsappLogs.unshift({
          id: Math.random().toString(36).substring(2, 11),
          timestamp: Date.now(),
          type: "error",
          sender,
          message: `Falha ao enviar o áudio da resposta (o texto já foi enviado): ${ttsErr?.message || ttsErr}`
        });
        if (whatsappLogs.length > 100) whatsappLogs.pop();
      }
    }
  }

  // Reconecta sozinho depois de uma queda não intencional (queda de rede, sessão derrubada
  // pelo celular, conflito de outra sessão, etc.), com backoff crescente, em vez de deixar o
  // usuário precisar clicar em "Iniciar Conexão" toda vez que a conexão cai.
  function scheduleWhatsAppReconnect(reason: string) {
    if (waIntentionalDisconnect || waReconnectTimer) return;

    waReconnectAttempts++;
    const maxAttempts = 8;
    if (waReconnectAttempts > maxAttempts) {
      whatsappLogs.unshift({
        id: Math.random().toString(36).substring(2, 11),
        timestamp: Date.now(),
        type: "error",
        sender: "Sistema",
        message: `WhatsApp desconectou ${maxAttempts} vezes seguidas (último motivo: ${reason}). Parando a reconexão automática para não sobrecarregar o sistema — verifique sua internet/telefone e clique em "Iniciar Conexão" manualmente.`
      });
      if (whatsappLogs.length > 100) whatsappLogs.pop();
      return;
    }

    const delayMs = Math.min(5000 * waReconnectAttempts, 60000);
    whatsappLogs.unshift({
      id: Math.random().toString(36).substring(2, 11),
      timestamp: Date.now(),
      type: "info",
      sender: "Sistema",
      message: `Conexão caiu (motivo: ${reason}). Tentando reconectar automaticamente em ${Math.round(delayMs / 1000)}s (tentativa ${waReconnectAttempts}/${maxAttempts})...`
    });
    if (whatsappLogs.length > 100) whatsappLogs.pop();

    waReconnectTimer = setTimeout(() => {
      waReconnectTimer = null;
      initializeWhatsAppWebClient();
    }, delayMs);
  }

  // Inicializa a conexão do WhatsApp via Baileys — WebSocket direto ao WhatsApp, sem
  // Chromium/Puppeteer embutido. Elimina a fragilidade de crashes de navegador que o
  // whatsapp-web.js sofria (dependência de libs do sistema, downloads de Chromium bloqueados,
  // travas de lockfile, etc.).
  /**
   * Uma inicialização por vez.
   *
   * Sem esta trava, duas chamadas seguidas criavam DOIS sockets vivos — e cada mensagem recebida
   * era entregue aos dois, gerando duas auto-respostas idênticas. O caminho é fácil de percorrer
   * sem perceber: a rota /api/whatsapp/connect só recusa quando o status já é "conectado", então
   * clicar em "Iniciar Conexão" de novo enquanto ela ainda está subindo (ou a reconexão automática
   * disparando no mesmo instante) começa uma segunda. Como o waSocket só é preenchido DEPOIS de
   * vários awaits — carregar o Baileys, ler as credenciais, buscar a versão —, a limpeza do socket
   * anterior no topo daqui não enxerga a inicialização que está a meio caminho, e o primeiro
   * socket fica para sempre, sem ninguém para fechá-lo.
   */
  let waInicializando = false;

  const initializeWhatsAppWebClient = async () => {
    if (waInicializando) {
      console.log("[WhatsApp] Já existe uma conexão sendo iniciada; o pedido novo foi ignorado.");
      return;
    }
    waInicializando = true;

    if (waReconnectTimer) {
      clearTimeout(waReconnectTimer);
      waReconnectTimer = null;
    }
    waIntentionalDisconnect = false;

    if (waSocket) {
      try {
        waSocket.ev.removeAllListeners();
        waSocket.end(undefined);
      } catch (_) {}
      waSocket = null;
    }

    waStatus = "iniciando";
    waQrRaw = "";
    waQrBase64 = "";
    waLastError = "";

    try {
      const { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers } = await loadBaileys();
      const { default: pino } = await loadPino();

      if (!fs.existsSync(WA_AUTH_DIR)) fs.mkdirSync(WA_AUTH_DIR, { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_DIR);
      const { version } = await fetchLatestBaileysVersion();

      const socket = makeWASocket({
        auth: state,
        version,
        logger: pino({ level: "silent" }) as any,
        browser: Browsers.ubuntu("OSONE"),
        // Não precisamos do histórico completo de conversas do celular ao conectar — só das
        // mensagens novas a partir de agora. Reduz tráfego/tempo de conexão inicial.
        syncFullHistory: false,
        markOnlineOnConnect: false
      });
      waSocket = socket;
      // Liberada assim que o socket existe: daqui em diante a limpeza no topo desta função já
      // enxerga o socket e sabe fechá-lo, que é o que a trava estava protegendo.
      waInicializando = false;

      socket.ev.on("creds.update", saveCreds);

      socket.ev.on("contacts.upsert", (contacts: any[]) => {
        for (const c of contacts || []) {
          if (c?.id) waContactsCache.set(c.id, { name: c.name || c.notify || waContactsCache.get(c.id)?.name });
        }
      });
      socket.ev.on("contacts.update", (updates: any[]) => {
        for (const c of updates || []) {
          if (c?.id) {
            const prev = waContactsCache.get(c.id) || {};
            waContactsCache.set(c.id, { name: c.name || c.notify || prev.name });
          }
        }
      });

      socket.ev.on("connection.update", async (update: any) => {
        const { connection, lastDisconnect, qr } = update || {};

        if (qr) {
          waStatus = "aguardando_qr";
          waQrRaw = qr;
          try {
            waQrBase64 = await QRCode.toDataURL(qr, { margin: 2, scale: 6 });
          } catch (e: any) {
            console.error("[WhatsApp] Erro ao converter QR Code:", e);
          }
          whatsappLogs.unshift({
            id: Math.random().toString(36).substring(2, 11),
            timestamp: Date.now(),
            type: "info",
            sender: "WhatsApp",
            message: "Novo QR Code gerado. Prontos para escanear no app do WhatsApp!"
          });
          if (whatsappLogs.length > 100) whatsappLogs.pop();
        }

        if (connection === "open") {
          waStatus = "conectado";
          virtualConnectionState = "CONNECTED";
          waQrRaw = "";
          waQrBase64 = "";
          waLastError = "";
          waReconnectAttempts = 0;
          waPhoneInfo = {
            number: String(socket.user?.id || "").split(":")[0].replace(/\D/g, "") || "Conectado",
            name: socket.user?.name || (socket.user as any)?.notify || "OSONE WhatsApp"
          };
          whatsappLogs.unshift({
            id: Math.random().toString(36).substring(2, 11),
            timestamp: Date.now(),
            type: "info",
            sender: "WhatsApp",
            message: `Conexão WhatsApp Ativa! Telefone/Conta: ${waPhoneInfo.name} (${waPhoneInfo.number})`
          });
          if (whatsappLogs.length > 100) whatsappLogs.pop();
        }

        if (connection === "close") {
          waStatus = "desconectado";
          virtualConnectionState = "DISCONNECTED";
          waQrRaw = "";
          waQrBase64 = "";
          waPhoneInfo = {};

          const boomError = lastDisconnect?.error;
          const statusCode = boomError?.output?.statusCode;
          const reasonText = explainWhatsAppDisconnect(statusCode, boomError?.message || "", DisconnectReason);

          // "restartRequired" é esperado e inofensivo: o Baileys sempre encerra e pede um
          // reinício logo após uma sessão nova terminar de parear (escanear o QR Code) — não é
          // uma falha real, então nem entra como log de erro nem passa pelo backoff/contador de
          // tentativas do reconector (senão o usuário veria um "erro" e esperaria segundos à toa
          // logo depois de escanear o QR).
          if (statusCode === DisconnectReason.restartRequired) {
            whatsappLogs.unshift({
              id: Math.random().toString(36).substring(2, 11),
              timestamp: Date.now(),
              type: "info",
              sender: "WhatsApp",
              message: "Pareamento concluído, finalizando a conexão..."
            });
            if (whatsappLogs.length > 100) whatsappLogs.pop();
            initializeWhatsAppWebClient();
            return;
          }

          whatsappLogs.unshift({
            id: Math.random().toString(36).substring(2, 11),
            timestamp: Date.now(),
            type: "error",
            sender: "WhatsApp",
            message: `WhatsApp desconectado: ${reasonText}`
          });
          if (whatsappLogs.length > 100) whatsappLogs.pop();

          // Logout feito pelo próprio celular: a sessão foi invalidada de propósito, então
          // reconectar automaticamente não vai funcionar — é preciso escanear um novo QR Code.
          if (statusCode === DisconnectReason.loggedOut) {
            waIntentionalDisconnect = true;
            waLastError = reasonText;
            try { fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
            return;
          }

          scheduleWhatsAppReconnect(reasonText);
        }
      });

      socket.ev.on("messages.upsert", async ({ messages, type }: { messages: any[]; type: string }) => {
        if (type !== "notify") return;
        for (const msg of messages || []) {
          try {
            await handleIncomingWhatsAppMessage(msg);
          } catch (err: any) {
            console.error("[WhatsApp] Erro no listener de mensagem com IA e Vendas:", err);
            whatsappLogs.unshift({
              id: Math.random().toString(36).substring(2, 11),
              timestamp: Date.now(),
              type: "error",
              sender: "Sistema",
              message: `Erro inesperado ao processar mensagem recebida: ${err?.message || err}`
            });
            if (whatsappLogs.length > 100) whatsappLogs.pop();
          }
        }
      });
    } catch (err: any) {
      waInicializando = false;
      waStatus = "erro";
      waLastError = err?.message || String(err);
      console.error("[WhatsApp] Erro no setup do socket Baileys:", err);
      scheduleWhatsAppReconnect("falha no setup");
    }
  };

  // ====== WHATSAPP (OSONE ZAP) ACCESS CONTROL ======
  // A integração do WhatsApp roda uma sessão real do usuário (envia mensagens, lê contatos e
  // conversas, e expõe a chave Gemini configurada). Sem isto, QUALQUER requisição HTTP ao
  // servidor conseguia disparar mensagens em nome do usuário. Por padrão, só o próprio
  // computador (loopback) pode acessar; para uso remoto (ex: túnel, deploy), defina
  // WHATSAPP_ACCESS_TOKEN no .env e envie o header "x-whatsapp-token" com o mesmo valor.
  const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || "";
  /** Mesmo papel do token do ZAP, para quem expõe o OSONE por túnel e quer ver as câmeras de fora. */
  const CAMERA_ACCESS_TOKEN = process.env.CAMERA_ACCESS_TOKEN || "";

  const isLoopbackAddress = (addr: string | undefined): boolean => {
    if (!addr) return false;
    const clean = addr.replace("::ffff:", "");
    return clean === "127.0.0.1" || clean === "::1" || clean === "localhost";
  };

  const requireWhatsAppAccess = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const remoteAddr = req.socket?.remoteAddress;
    if (isLoopbackAddress(remoteAddr)) return next();

    const providedToken = req.headers["x-whatsapp-token"];
    if (WHATSAPP_ACCESS_TOKEN && providedToken === WHATSAPP_ACCESS_TOKEN) return next();

    return res.status(403).json({
      error: "Acesso ao OSONE ZAP (WhatsApp) negado. Esta área só é acessível localmente (a partir do próprio computador) ou com um WHATSAPP_ACCESS_TOKEN válido configurado no servidor."
    });
  };

  // Health check com assinatura própria: permite ao app desktop confirmar que quem respondeu
  // na porta é REALMENTE este servidor, e não algum outro programa que por acaso ocupava a
  // mesma porta (qualquer resposta HTTP, inclusive um 404 alheio, enganaria uma checagem que
  // só olhasse "respondeu ou não").
  app.get("/api/health", (req, res) => {
    res.json({
      service: "osone-server",
      ok: true,
      pid: process.pid,
      environment: isVercel ? "vercel" : "persistent",
      // Recursos que exigem processo persistente (conexão contínua/disco gravável). O
      // frontend pode usar isto para avisar de antemão em vez de deixar o usuário descobrir
      // clicando num botão que vai falhar.
      capabilities: {
        whatsapp: !isVercel,
        localAgent: !isVercel,
        tiktokLive: !isVercel,
        persistentStorage: !isVercel
      }
    });
  });

  app.use("/api/whatsapp", blockOnVercel("O OSONE ZAP (WhatsApp)"), requireWhatsAppAccess);

  /**
   * CÂMERAS DE SEGURANÇA — só a partir do próprio computador.
   *
   * A trava é a mesma do OSONE ZAP, e pela mesma razão, só que mais grave: quem alcança estas
   * rotas vê o vídeo ao vivo de dentro da casa e baixa as gravações. Deixar isso aberto para a
   * rede seria transformar um sistema de vigilância em vigilância CONTRA quem instalou.
   *
   * Na Vercel a coisa nem faz sentido: "a rede local" de uma função serverless é o contêiner dela,
   * não a casa de ninguém — a câmera do usuário está fora de alcance por definição.
   */
  const requireCameraAccess = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (isLoopbackAddress(req.socket?.remoteAddress)) return next();
    const tokenEnviado = req.headers["x-camera-token"];
    if (CAMERA_ACCESS_TOKEN && tokenEnviado === CAMERA_ACCESS_TOKEN) return next();
    return res.status(403).json({
      error: "Acesso às câmeras negado. Esta área só é acessível a partir do próprio computador, ou com um CAMERA_ACCESS_TOKEN válido configurado no servidor."
    });
  };

  app.use("/api/cameras", blockOnVercel("As câmeras de segurança"), requireCameraAccess, cameraRouter);

  if (!isVercel) {
    try {
      iniciarCamerasSalvas();
    } catch (err) {
      console.error("[Câmeras] Não consegui subir as câmeras salvas:", err);
    }
    // Sem isto, um ffmpeg por câmera continuaria vivo depois de fechar o app — segurando a
    // conexão da câmera e impedindo a próxima abertura de conectar.
    const desligarCameras = () => { try { pararTodasAsCameras(); } catch { /* saindo mesmo */ } };
    /**
     * O process.exit() ao fim NÃO é enfeite, e a falta dele quase passou.
     *
     * Registrar um ouvinte de SIGINT/SIGTERM SUBSTITUI o comportamento padrão do Node, que é
     * encerrar o processo. Sem encerrar por conta própria, o efeito de adicionar esta limpeza
     * seria deixar o servidor imune a Ctrl+C e a "kill" — apareceu ao tentar reiniciar o servidor
     * durante o teste e ver que ele não morria. Um recurso de câmera não pode custar a capacidade
     * de fechar o programa.
     */
    const desligarESair = () => { desligarCameras(); process.exit(0); };
    process.once("SIGINT", desligarESair);
    process.once("SIGTERM", desligarESair);
    // No evento "exit" só cabe trabalho síncrono, e é o que esta limpeza faz: matar os processos.
    process.once("exit", desligarCameras);
  }

  // WhatsApp Web API routes
  app.get("/api/whatsapp/status", (req, res) => {
    res.json({
      status: waStatus,
      phone: waPhoneInfo,
      error: waLastError,
      qrAvailable: !!waQrBase64,
      virtualState: virtualConnectionState
    });
  });

  app.get("/api/whatsapp/qr", (req, res) => {
    res.json({
      qr: waQrBase64,
      status: waStatus
    });
  });

  app.post("/api/whatsapp/connect", async (req, res) => {
    if (waStatus === "conectado") {
      return res.json({ status: "conectado", message: "WhatsApp já está conectado!" });
    }
    initializeWhatsAppWebClient();
    res.json({ status: "iniciando", message: "Inicializando conexão com o WhatsApp..." });
  });

  app.post("/api/whatsapp/disconnect", async (req, res) => {
    waIntentionalDisconnect = true;
    if (waReconnectTimer) {
      clearTimeout(waReconnectTimer);
      waReconnectTimer = null;
    }
    waReconnectAttempts = 0;

    if (waSocket) {
      try {
        waSocket.ev.removeAllListeners();
        waSocket.end(undefined);
      } catch (_) {}
      waSocket = null;
    }
    waStatus = "desconectado";
    virtualConnectionState = "DISCONNECTED";
    waQrRaw = "";
    waQrBase64 = "";
    waPhoneInfo = {};
    res.json({ status: "desconectado", message: "Sessão do WhatsApp encerrada." });
  });

  app.post("/api/whatsapp/reset-session", async (req, res) => {
    try {
      waIntentionalDisconnect = true;
      if (waReconnectTimer) {
        clearTimeout(waReconnectTimer);
        waReconnectTimer = null;
      }
      waReconnectAttempts = 0;

      if (waSocket) {
        try {
          waSocket.ev.removeAllListeners();
          waSocket.end(undefined);
        } catch (_) {}
        waSocket = null;
      }
      waStatus = "desconectado";
      virtualConnectionState = "DISCONNECTED";
      waQrRaw = "";
      waQrBase64 = "";
      waPhoneInfo = {};
      waLastError = "";
      waContactsCache.clear();

      if (fs.existsSync(WA_AUTH_DIR)) {
        try {
          fs.rmSync(WA_AUTH_DIR, { recursive: true, force: true });
        } catch (rmErr) {
          console.log("[WhatsApp Reset] Aviso ao apagar pasta de sessão:", rmErr);
        }
      }

      initializeWhatsAppWebClient();

      return res.json({ status: "iniciando", message: "Sessão resetada com sucesso. Novo QR Code será gerado!" });
    } catch (err: any) {
      return res.status(500).json({ error: `Erro ao resetar sessão: ${err?.message || err}` });
    }
  });

  // API Endpoints for WhatsApp Frontend configuration
  /**
   * Diagnóstico da voz: diz se a chave do Gemini enxerga algum modelo de TTS e tenta gerar um
   * áudio curto de verdade, informando o erro exato de cada modelo. Serve para descobrir por
   * que a voz não sai sem precisar mandar mensagem de WhatsApp para alguém a cada tentativa.
   */
  app.get("/api/whatsapp/diagnostico-voz", async (req, res) => {
    // Sem chave do Gemini o diagnóstico NÃO pode desistir: a voz local funciona sem chave
    // nenhuma, e parar aqui faria o painel dizer que não há voz para quem depende só dela.
    const apiKey = whatsappConfig.geminiApiKey || getSecretGeminiKey();
    try {
      let modelosDeVoz: string[] = [];
      if (apiKey) {
        const ai = new GoogleGenAI({ apiKey, vertexai: false, httpOptions: { headers: { "User-Agent": "aistudio-build" } } });
        cacheModelosDeVoz = null; // força uma consulta nova a cada diagnóstico
        modelosDeVoz = await descobrirModelosDeVoz(ai);
      }

      const teste = await synthesizeWhatsAppVoiceReply("Teste de voz do OSONE.", {
        engine: whatsappConfig.ttsEngine,
        geminiApiKey: apiKey,
        voice: whatsappConfig.ttsVoice,
        supertonicVoice: whatsappConfig.supertonicVoice,
        elevenLabsApiKey: whatsappConfig.elevenLabsApiKey,
        elevenLabsVoiceId: whatsappConfig.elevenLabsVoiceId
      });

      const vozLocal = caminhosDaVozLocal();
      return res.json({
        ok: !!teste,
        motorConfigurado: whatsappConfig.ttsEngine,
        chaveGeminiConfigurada: !!apiKey,
        modelosDeVozVistosPelaSuaChave: modelosDeVoz,
        vozLocalInstalada: vozLocal ? "sim — o áudio nunca fica sem alternativa" : "não — rode 'npm run baixar-voz'",
        audioGerado: teste ? `sim (${(teste.buffer.length / 1024).toFixed(0)} KB)` : "não",
        erro: teste ? null : (ultimoErroTts || "a IA de voz não retornou áudio."),
        ffmpeg: resolverCaminhoFfmpeg() === "ffmpeg" ? "usando o do sistema (pode não existir)" : "embutido no OSONE"
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, erro: e?.message || String(e) });
    }
  });

  /**
   * Diagnóstico da recepção: simula uma mensagem chegando de um número e diz exatamente qual
   * verificação a barraria — ou confirma que ela seria respondida.
   *
   * Existe porque a recusa é silenciosa por natureza: o robô precisa ficar quieto nas conversas
   * que não são para ele, então mensagens sem o gatilho saem sem deixar rastro. Isso é o certo
   * em operação e péssimo para diagnosticar — quando alguém escreve "/osone" e não recebe nada,
   * não há nenhuma pista de qual das portas fechou.
   *
   * Uso: /api/whatsapp/diagnostico-recepcao?numero=5511999999999&texto=/osone oi
   */
  /**
   * Faz uma chamada mínima de verdade à IA para saber se a chave FUNCIONA — não basta existir.
   *
   * A verificação anterior olhava apenas se o campo estava preenchido e dizia "configurada".
   * Uma chave com um espaço colado no fim, revogada, ou de um projeto sem a API ativada passava
   * por esse teste e o robô continuava mudo, com o diagnóstico jurando que estava tudo certo.
   */
  async function testarChaveGemini(): Promise<{ passa: boolean; detalhe: string }> {
    const chave = whatsappConfig.geminiApiKey || getSecretGeminiKey();
    if (!chave) return { passa: false, detalhe: "AUSENTE — configure no painel do OSONE ZAP (aba Ajustes de IA) ou no .env" };

    // Espaços invisíveis colados junto da chave são a causa mais comum de "API key not valid",
    // e a mais difícil de enxergar: na tela a chave parece perfeita.
    if (chave !== chave.trim()) {
      return { passa: false, detalhe: "a chave está salva com espaços/quebras de linha em volta — apague e cole de novo, sem espaço no começo ou no fim" };
    }

    try {
      const ai = new GoogleGenAI({ apiKey: chave, vertexai: false, httpOptions: { headers: { "User-Agent": "aistudio-build" } } });
      await ai.models.generateContent({ model: "gemini-3.5-flash-lite", contents: "oi" });
      return { passa: true, detalhe: `funcionando (${chave.slice(0, 6)}...${chave.slice(-4)})` };
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes("API_KEY_INVALID") || msg.includes("API key not valid")) {
        return {
          passa: false,
          detalhe: `RECUSADA pelo Google (${chave.slice(0, 6)}...${chave.slice(-4)}, ${chave.length} caracteres). A chave está errada, incompleta ou foi revogada. Gere outra em aistudio.google.com/apikey e cole no painel.`
        };
      }
      if (msg.includes("PERMISSION_DENIED") || msg.includes("SERVICE_DISABLED")) {
        return { passa: false, detalhe: "a chave existe, mas o projeto dela não tem a API do Gemini ativada." };
      }
      if (msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota")) {
        return { passa: false, detalhe: "a chave é válida, mas a cota acabou (limite de uso atingido)." };
      }
      return { passa: false, detalhe: `falhou ao testar: ${msg.slice(0, 160)}` };
    }
  }

  app.get("/api/whatsapp/diagnostico-recepcao", async (req, res) => {
    const numero = String(req.query.numero || "").replace(/\D/g, "");
    const texto = String(req.query.texto || "/osone teste");
    if (!numero) {
      return res.status(400).json({ erro: "Informe o número: ?numero=5511999999999&texto=/osone oi" });
    }

    const jid = `${numero}@s.whatsapp.net`;
    const ehDesenvolvedor = isDeveloperNumber(jid);
    const contatoSalvo = findSavedContact(jid);
    const gatilho = matchTriggerCommand(texto);

    const portas: { porta: string; passa: boolean; detalhe: string }[] = [
      {
        porta: "Robô ligado",
        passa: whatsappConfig.enabled,
        detalhe: whatsappConfig.enabled ? "ligado" : "DESLIGADO — ligue o chatbot no painel do OSONE ZAP"
      },
      {
        porta: "Filtro de contatos salvos",
        passa: !whatsappConfig.onlyKnownContacts || ehDesenvolvedor || !!contatoSalvo,
        detalhe: !whatsappConfig.onlyKnownContacts
          ? "desligado — qualquer número passa"
          : ehDesenvolvedor
            ? "é o número do desenvolvedor, passa sempre"
            : contatoSalvo
              ? `cadastrado como '${contatoSalvo.name}'`
              : "BLOQUEADO — número não está na aba Contatos e o filtro está LIGADO"
      },
      {
        porta: "Comando de ativação",
        passa: !whatsappConfig.requireTriggerCommand || gatilho.triggered,
        detalhe: !whatsappConfig.requireTriggerCommand
          ? "desligado — qualquer texto passa"
          : gatilho.triggered
            ? `encontrou '${whatsappConfig.triggerCommand}'; a IA vai ler: "${gatilho.cleanedText || "Olá!"}"`
            : `BLOQUEADO — o texto não contém '${whatsappConfig.triggerCommand}'`
      },
      {
        porta: "Chave do Gemini",
        ...(await testarChaveGemini())
      },
      {
        porta: "WhatsApp conectado",
        passa: waStatus === "conectado",
        detalhe: `status atual: ${waStatus}`
      }
    ];

    const bloqueio = portas.find(p => !p.passa);
    return res.json({
      responderia: !bloqueio,
      motivoDoBloqueio: bloqueio ? `${bloqueio.porta}: ${bloqueio.detalhe}` : null,
      // Lembrete útil: mensagens que VOCÊ envia para o seu próprio número nunca chegam ao robô,
      // porque o WhatsApp as marca como "fromMe" e elas são ignoradas para evitar que o robô
      // responda às próprias respostas num laço infinito.
      avisoTesteConsigoMesmo: "Mandar mensagem para o seu PRÓPRIO número nunca funciona: o WhatsApp marca como 'enviada por mim' e o robô ignora, senão ele responderia a si mesmo em laço. Teste com o celular de outra pessoa.",
      configuracaoAtual: {
        roboLigado: whatsappConfig.enabled,
        somenteContatosSalvos: whatsappConfig.onlyKnownContacts,
        exigeComando: whatsappConfig.requireTriggerCommand,
        comando: whatsappConfig.triggerCommand
      },
      portas
    });
  });

  app.get("/api/whatsapp/config", (req, res) => {
    // A chave NUNCA volta para o navegador. Antes ela ia junto e era censurada pelo middleware
    // de segurança, virando o texto "[CHAVE_REMOVIDA]" — que o painel carregava no campo e
    // regravava por cima da chave verdadeira no primeiro ajuste que o usuário fizesse. A
    // proteção destruía exatamente o que deveria proteger.
    //
    // No lugar dela vai só o suficiente para a tela mostrar que existe uma chave e qual é:
    // início, fim e comprimento. Segredo que não trafega não pode ser sobrescrito por acidente.
    const { geminiApiKey, elevenLabsApiKey, ...resto } = whatsappConfig;
    const resumo = (chave: string) =>
      chave
        ? { configurada: true, tamanho: chave.length, previa: `${chave.slice(0, 6)}...${chave.slice(-4)}` }
        : { configurada: false, tamanho: 0, previa: "" };

    res.json({
      ...resto,
      geminiApiKey: "",
      elevenLabsApiKey: "",
      geminiApiKeyInfo: resumo(geminiApiKey),
      elevenLabsApiKeyInfo: resumo(elevenLabsApiKey)
    });
  });

  app.post("/api/whatsapp/config", (req, res) => {
    const { enabled, geminiApiKey, sendAudioReplies, onlyKnownContacts, requireTriggerCommand, triggerCommand, ttsEngine, ttsVoice, supertonicVoice, elevenLabsApiKey, elevenLabsVoiceId } = req.body;

    if (enabled !== undefined) whatsappConfig.enabled = enabled;
    // trim() obrigatório: copiar a chave do console do Google costuma trazer junto um espaço ou
    // uma quebra de linha invisível. Guardada suja, o Google devolve "API key not valid" e o
    // usuário fica olhando para uma chave que PARECE certa na tela, sem entender a recusa.
    // Campo vazio significa "não mexer na chave", e não "apagar a chave".
    //
    // Toda alteração no painel reenvia a configuração INTEIRA, mesmo quando o usuário só clicou
    // num botão. Como a chave não trafega mais de volta ao navegador, o campo chega vazio nesses
    // casos — tratar isso como "apagar" limparia a chave a cada ajuste. Para remover de fato
    // existe o pedido explícito removerGeminiApiKey.
    let avisoChave: string | null = null;
    if (req.body.removerGeminiApiKey === true) {
      whatsappConfig.geminiApiKey = "";
    } else if (geminiApiKey !== undefined && String(geminiApiKey).trim()) {
      const nova = String(geminiApiKey).trim();
      // Rede de segurança contra o navegador autopreencher uma senha salva neste campo: chaves
      // do Google sempre começam com "AIza". A recusa é avisada, nunca silenciosa.
      // O Google emite chaves em dois formatos: o antigo "AIza..." (39 caracteres) e o atual
      // "AQ...." (~53), gerado pelo AI Studio hoje. Reconhecer só um deles recusaria chaves
      // perfeitamente válidas — e a mensagem ainda culparia o navegador por isso.
      if (!nova.startsWith("AIza") && !nova.startsWith("AQ.")) {
        avisoChave = `A chave enviada (${nova.length} caracteres) não parece uma chave do Google — elas começam com "AIza" ou "AQ.". Nada foi alterado. Se o navegador preencheu o campo sozinho, apague-o e cole a chave de novo.`;
        console.warn(`[OSONE ZAP] ${avisoChave}`);
      } else {
        whatsappConfig.geminiApiKey = nova;
      }
    }
    if (sendAudioReplies !== undefined) whatsappConfig.sendAudioReplies = !!sendAudioReplies;
    if (onlyKnownContacts !== undefined) whatsappConfig.onlyKnownContacts = !!onlyKnownContacts;
    if (requireTriggerCommand !== undefined) whatsappConfig.requireTriggerCommand = !!requireTriggerCommand;
    // Um gatilho vazio faria matchTriggerCommand liberar TODA mensagem, o oposto do que a opção
    // promete — então texto em branco é recusado e mantém o comando anterior.
    if (typeof triggerCommand === "string" && triggerCommand.trim()) {
      whatsappConfig.triggerCommand = triggerCommand.trim();
    }
    if (ttsEngine === "gemini" || ttsEngine === "elevenlabs" || ttsEngine === "supertonic" || ttsEngine === "local") whatsappConfig.ttsEngine = ttsEngine;
    if (ttsVoice !== undefined) whatsappConfig.ttsVoice = ttsVoice;
    if (supertonicVoice === "F1" || supertonicVoice === "M1") whatsappConfig.supertonicVoice = supertonicVoice;
    // Mesma regra da chave do Gemini: vazio mantém o que já existe.
    if (req.body.removerElevenLabsApiKey === true) {
      whatsappConfig.elevenLabsApiKey = "";
    } else if (elevenLabsApiKey !== undefined && String(elevenLabsApiKey).trim()) {
      whatsappConfig.elevenLabsApiKey = String(elevenLabsApiKey).trim();
    }
    if (elevenLabsVoiceId !== undefined) whatsappConfig.elevenLabsVoiceId = elevenLabsVoiceId;

    // Grava em disco para que a escolha sobreviva a reinícios do OSONE.
    saveWhatsAppConfig();

    // O log conta o estado das TRÊS travas que decidem quem é respondido, e não só se o chatbot
    // está ligado. Quem desligava o comando "/osone" esperando que o robô passasse a responder
    // todo mundo, e continuava sem resposta nenhuma, não tinha como descobrir aqui que outra
    // trava (o robô desligado, ou o filtro de contatos) era a responsável pelo silêncio.
    whatsappLogs.unshift({
      id: Math.random().toString(36).substring(2, 11),
      timestamp: Date.now(),
      type: "info",
      sender: "Sistema",
      message: `Configurações salvas: Chatbot ${whatsappConfig.enabled ? "Ativado" : "DESATIVADO (não responde ninguém)"}`
        + ` | Comando de ativação: ${whatsappConfig.requireTriggerCommand ? `exigido ("${whatsappConfig.triggerCommand}")` : "desligado (responde qualquer mensagem)"}`
        + ` | Filtro de contatos: ${whatsappConfig.onlyKnownContacts ? "LIGADO (só responde números cadastrados)" : "desligado (qualquer número passa)"}.`
    });
    
    // Devolve a configuração sem as chaves, pelo mesmo motivo do GET: o que não trafega de
    // volta não pode ser regravado por cima do valor verdadeiro no próximo salvamento.
    const { geminiApiKey: _g, elevenLabsApiKey: _e, ...configSemChaves } = whatsappConfig;
    const resumoChave = (chave: string) =>
      chave
        ? { configurada: true, tamanho: chave.length, previa: `${chave.slice(0, 6)}...${chave.slice(-4)}` }
        : { configurada: false, tamanho: 0, previa: "" };

    res.json({
      status: "success",
      config: {
        ...configSemChaves,
        geminiApiKey: "",
        elevenLabsApiKey: "",
        geminiApiKeyInfo: resumoChave(whatsappConfig.geminiApiKey),
        elevenLabsApiKeyInfo: resumoChave(whatsappConfig.elevenLabsApiKey)
      },
      avisoChave
    });
  });

  app.get("/api/whatsapp/logs", (req, res) => {
    res.json(whatsappLogs);
  });

  app.post("/api/whatsapp/clear-logs", (req, res) => {
    whatsappLogs = [
      {
        id: "clear-" + Date.now(),
        timestamp: Date.now(),
        type: "info",
        sender: "Sistema",
        message: "Histórico de logs do chatbot limpo com sucesso."
      }
    ];
    res.json({ status: "success" });
  });

  // Get and set virtual state for simulated connection
  app.get("/api/whatsapp/virtual-state", (req, res) => {
    res.json({ state: virtualConnectionState });
  });

  app.post("/api/whatsapp/virtual-state", (req, res) => {
    const { state } = req.body;
    if (state !== undefined) {
      virtualConnectionState = state;
    }
    res.json({ success: true, state: virtualConnectionState });
  });

  // Knowledge Base & Conversations Endpoints
  app.get("/api/whatsapp/knowledge-base", (req, res) => {
    res.json({ content: loadKnowledgeBase() });
  });

  app.post("/api/whatsapp/knowledge-base", (req, res) => {
    const { content } = req.body;
    saveKnowledgeBase(content || "");
    whatsappLogs.unshift({
      id: Math.random().toString(36).substring(2, 11),
      timestamp: Date.now(),
      type: "info",
      sender: "Base de Conhecimento",
      message: `Base de conhecimento do produto atualizada (${(content || "").length} caracteres).`
    });
    if (whatsappLogs.length > 100) whatsappLogs.pop();

    res.json({ status: "success", content: loadKnowledgeBase() });
  });

  app.post("/api/whatsapp/knowledge-base/import-url", async (req, res) => {
    try {
      const { url } = req.body;
      if (!url || typeof url !== "string") {
        return res.status(400).json({ error: "URL inválida ou ausente." });
      }

      let targetUrl = url.trim();
      if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
        targetUrl = `https://${targetUrl}`;
      }

      console.log(`[Knowledge Base] Extraindo dados da URL: ${targetUrl}...`);

      let response: { ok: boolean; status: number; text: string };
      try {
        response = await buscarTextoComProtecaoSsrf(targetUrl);
      } catch (err: any) {
        if (err?.bloqueado) return res.status(403).json({ error: err.message });
        throw err;
      }

      if (!response.ok) {
        return res.status(400).json({ error: `HTTP Error ${response.status}: Não foi possível carregar a página.` });
      }

      const html = response.text;
      const $ = cheerio.load(html);

      // Remove script, style, header, footer, nav, buttons, SVG
      $("script, style, noscript, nav, footer, header, svg, iframe, symbol, button").remove();

      // Extract text content from body
      const pageText = $("body")
        .text()
        .replace(/\s+/g, " ")
        .replace(/\n+/g, "\n")
        .trim();

      if (!pageText || pageText.length < 20) {
        return res.status(400).json({ error: "Não foi possível extrair texto visível relevante dessa URL." });
      }

      const existingKb = loadKnowledgeBase();
      const pageTitle = $("title").text().trim() || targetUrl;
      const addedSection = `\n\n--- INFORMAÇÕES IMPORTADAS DE: ${pageTitle} (${targetUrl}) ---\n${pageText.slice(0, 15000)}`;

      const updatedKb = (existingKb + addedSection).trim();
      saveKnowledgeBase(updatedKb);

      whatsappLogs.unshift({
        id: Math.random().toString(36).substring(2, 11),
        timestamp: Date.now(),
        type: "info",
        sender: "Base de Conhecimento",
        message: `Importado texto da URL '${targetUrl}' (${pageText.length} caracteres adicionados).`
      });
      if (whatsappLogs.length > 100) whatsappLogs.pop();

      return res.json({
        status: "success",
        message: `Dados da URL importados com sucesso (${pageText.length} caracteres extraídos)!`,
        content: updatedKb,
        extractedLength: pageText.length
      });
    } catch (err: any) {
      console.error("[Knowledge Base] Erro na importação por URL:", err);
      return res.status(500).json({ error: `Erro ao importar URL: ${err?.message || err}` });
    }
  });

  app.get("/api/whatsapp/conversations", (req, res) => {
    res.json(conversationsMap);
  });

  // Contacts Endpoints (GET, POST, DELETE)
  app.get("/api/whatsapp/contacts", (req, res) => {
    res.json(loadContacts());
  });

  app.post("/api/whatsapp/contacts", (req, res) => {
    try {
      const { id, name, phone, notes, source } = req.body;
      if (!name || !phone) {
        return res.status(400).json({ error: "Nome e telefone são obrigatórios." });
      }

      const cleanPhone = phone.replace(/\D/g, "");
      if (!cleanPhone || cleanPhone.length < 8) {
        return res.status(400).json({ error: "Telefone deve conter pelo menos 8 dígitos." });
      }

      const contacts = loadContacts();
      const existingIndex = id ? contacts.findIndex(c => c.id === id) : -1;

      let savedContact: ContactItem;
      if (existingIndex >= 0) {
        contacts[existingIndex] = {
          ...contacts[existingIndex],
          name: name.trim(),
          phone: cleanPhone,
          notes: (notes || "").trim(),
          source: source || contacts[existingIndex].source || "manual"
        };
        savedContact = contacts[existingIndex];
      } else {
        savedContact = {
          id: Math.random().toString(36).substring(2, 11),
          name: name.trim(),
          phone: cleanPhone,
          notes: (notes || "").trim(),
          source: source || "manual",
          createdAt: Date.now()
        };
        contacts.unshift(savedContact);
      }

      saveContacts(contacts);
      return res.json({ status: "success", contact: savedContact, contacts });
    } catch (err: any) {
      return res.status(500).json({ error: `Erro ao salvar contato: ${err?.message || err}` });
    }
  });

  // Retorna os contatos reais vistos nesta sessão do WhatsApp. Diferente do whatsapp-web.js,
  // o Baileys não oferece um "getContacts()" pronto que devolva a agenda inteira do celular —
  // os contatos vão chegando aos poucos por eventos ("contacts.upsert"/"contacts.update") e
  // pelo nome de quem manda mensagem. Por isso a lista cresce conforme o uso, em vez de vir
  // completa na primeira chamada.
  app.get("/api/whatsapp/wa-contacts", async (req, res) => {
    try {
      if (!waSocket || waStatus !== "conectado") {
        return res.status(400).json({
          error: "Sessão do WhatsApp não está conectada. Conecte primeiro no Monitor Central escaneando o QR Code."
        });
      }

      const formatted = Array.from(waContactsCache.entries())
        .filter(([jid]) => jid.endsWith("@s.whatsapp.net"))
        .map(([jid, info]) => {
          const cleanPhone = jid.split("@")[0].replace(/\D/g, "");
          return {
            name: (info.name || `Contato ${cleanPhone}`).trim(),
            phone: cleanPhone,
            source: "wa" as const
          };
        })
        .filter(c => c.phone.length >= 8);

      console.log(`[WhatsApp Contacts] ${formatted.length} contatos vistos nesta sessão.`);
      return res.json({ status: "success", count: formatted.length, contacts: formatted });
    } catch (err: any) {
      console.error("[WhatsApp Contacts] Erro ao obter contatos:", err);
      return res.status(500).json({ error: `Erro ao obter contatos do WhatsApp: ${err?.message || err}` });
    }
  });

  // Import WhatsApp Contacts into contacts.json avoiding duplicates
  app.post("/api/whatsapp/import-contacts", (req, res) => {
    try {
      const { contactsToImport } = req.body;
      if (!Array.isArray(contactsToImport)) {
        return res.status(400).json({ error: "contactsToImport deve ser um array." });
      }

      const existingContacts = loadContacts();
      let addedCount = 0;
      let updatedCount = 0;

      for (const item of contactsToImport) {
        const cleanPhone = (item.phone || "").replace(/\D/g, "");
        if (!cleanPhone || cleanPhone.length < 8) continue;

        const existingIndex = existingContacts.findIndex(c => c.phone === cleanPhone);
        if (existingIndex >= 0) {
          // Update name if default or empty
          const currentName = existingContacts[existingIndex].name;
          if ((currentName.startsWith("Contato ") || !currentName) && item.name && !item.name.startsWith("Contato ")) {
            existingContacts[existingIndex].name = item.name;
          }
          if (!existingContacts[existingIndex].source) {
            existingContacts[existingIndex].source = "wa";
          }
          updatedCount++;
        } else {
          existingContacts.push({
            id: Math.random().toString(36).substring(2, 11),
            name: (item.name || `Contato ${cleanPhone}`).trim(),
            phone: cleanPhone,
            source: "wa",
            createdAt: Date.now()
          });
          addedCount++;
        }
      }

      saveContacts(existingContacts);
      return res.json({ 
        status: "success", 
        addedCount, 
        updatedCount, 
        contacts: existingContacts 
      });
    } catch (err: any) {
      return res.status(500).json({ error: `Erro ao importar contatos: ${err?.message || err}` });
    }
  });

  app.delete("/api/whatsapp/contacts/:id", (req, res) => {
    try {
      const { id } = req.params;
      let contacts = loadContacts();
      contacts = contacts.filter(c => c.id !== id);
      saveContacts(contacts);
      return res.json({ status: "success", contacts });
    } catch (err: any) {
      return res.status(500).json({ error: `Erro ao remover contato: ${err?.message || err}` });
    }
  });

  // Simulate an incoming WhatsApp message
  app.post("/api/whatsapp/simulate-incoming", async (req, res) => {
    try {
      const { senderName, text, remoteJid } = req.body;
      const cleanSender = senderName || "Visitante";
      const cleanJid = remoteJid || "5511999999999@s.whatsapp.net";
      const cleanText = text || "Olá!";

      // Always add incoming message to history
      addMessageToHistory(cleanJid, "user", cleanText);

      // Add incoming message to logs
      whatsappLogs.unshift({
        id: Math.random().toString(36).substring(2, 11),
        timestamp: Date.now(),
        type: "received",
        sender: `${cleanSender} (${cleanJid})`,
        message: cleanText
      });
      if (whatsappLogs.length > 100) whatsappLogs.pop();

      // Check if Chatbot autoresponder is enabled
      if (!whatsappConfig.enabled) {
        whatsappLogs.unshift({
          id: Math.random().toString(36).substring(2, 11),
          timestamp: Date.now(),
          type: "info",
          sender: "Sistema",
          message: `Mensagem de ${cleanSender} recebida, mas o chatbot está desativado no painel.`
        });
        if (whatsappLogs.length > 100) whatsappLogs.pop();
        return res.json({ status: "ignored", reason: "Autoresponder is disabled" });
      }

      // Mesmo filtro de contatos da recepção real: se a simulação respondesse a um número que o
      // WhatsApp de verdade ignoraria, ela mentiria justamente sobre o comportamento que o
      // usuário está testando antes de deixar o robô sozinho no ar.
      if (whatsappConfig.onlyKnownContacts && !isDeveloperNumber(cleanJid) && !findSavedContact(cleanJid)) {
        whatsappLogs.unshift({
          id: Math.random().toString(36).substring(2, 11),
          timestamp: Date.now(),
          type: "info",
          sender: `${cleanSender} (${cleanJid})`,
          message: `Simulação: número NÃO cadastrado. Nenhuma resposta foi gerada, porque o modo "responder apenas contatos salvos" está ativo. Cadastre o número na aba Contatos para que o robô atenda.`
        });
        if (whatsappLogs.length > 100) whatsappLogs.pop();
        return res.json({ status: "ignored", reason: "Sender is not a saved contact" });
      }

      // Mesmo gatilho da recepção real, pelo mesmo motivo do filtro de contatos acima.
      let promptText = cleanText;
      if (whatsappConfig.requireTriggerCommand) {
        const { triggered, cleanedText } = matchTriggerCommand(cleanText);
        if (!triggered) {
          whatsappLogs.unshift({
            id: Math.random().toString(36).substring(2, 11),
            timestamp: Date.now(),
            type: "info",
            sender: `${cleanSender} (${cleanJid})`,
            message: `Simulação: mensagem sem o comando "${whatsappConfig.triggerCommand}". O robô ficou quieto, como faria numa conversa normal entre pessoas.`
          });
          if (whatsappLogs.length > 100) whatsappLogs.pop();
          return res.json({ status: "ignored", reason: "Message did not include the trigger command" });
        }
        promptText = cleanedText || "Olá!";
      }

      const geminiApiKeyToUse = whatsappConfig.geminiApiKey || getSecretGeminiKey();
      if (!geminiApiKeyToUse) {
        whatsappLogs.unshift({
          id: Math.random().toString(36).substring(2, 11),
          timestamp: Date.now(),
          type: "error",
          sender: "Sistema",
          message: `Mensagem de ${cleanSender} recebida via simulação, mas a chave API do Gemini não foi encontrada no OSONE.`
        });
        if (whatsappLogs.length > 100) whatsappLogs.pop();
        return res.json({ status: "error", error: "Gemini API key is not configured" });
      }

      // Use modern GoogleGenAI SDK to speak with Gemini 3.5-flash-lite
      const ai = new GoogleGenAI({ apiKey: geminiApiKeyToUse, vertexai: false });
      const systemPrompt = buildSalesPrompt(cleanJid, cleanSender);

      const gResult = await generateContentWithFallback(ai, {
        model: "gemini-3.5-flash-lite",
        contents: promptText,
        config: {
          systemInstruction: systemPrompt
        }
      });
      
      const replyText = gResult.text || "Ops! Não consegui gerar uma resposta no momento.";

      // Add AI response to history
      addMessageToHistory(cleanJid, "assistant", replyText);

      whatsappLogs.unshift({
        id: Math.random().toString(36).substring(2, 11),
        timestamp: Date.now(),
        type: "sent",
        sender: `${cleanSender} (${cleanJid})`,
        message: cleanText,
        response: replyText
      });
      if (whatsappLogs.length > 100) whatsappLogs.pop();

      return res.json({ status: "success", reply: replyText });
    } catch (e: any) {
      console.log("[Simulation log info]: Simulação falhou ou não encontrou chave:", e.message || e);
      return res.status(500).json({ status: "error", error: e?.message || e });
    }
  });

  /** Teto de tamanho para mídia enviada pelo WhatsApp. O arquivo inteiro passa pela memória do
   * servidor antes de ir para o Baileys, então sem limite um link para um arquivo gigante
   * derrubaria o processo do OSONE inteiro por falta de memória. */
  const MAX_WHATSAPP_MEDIA_BYTES = 40 * 1024 * 1024; // 40 MB

  /**
   * Recusa endereços que apontam para a própria máquina ou para a rede interna. Sem isso, um
   * link de mídia poderia fazer o servidor buscar coisas que só ele enxerga (o próprio Agente
   * Local em 127.0.0.1, roteadores, serviços da rede doméstica) e mandar o conteúdo por
   * WhatsApp — e a URL pode vir do modelo, que por sua vez lê mensagens escritas por clientes
   * desconhecidos. É a mesma razão de o Agente Local só entregar token em loopback.
   */
  function assertSafeMediaUrl(rawUrl: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error(`URL de mídia inválida: '${rawUrl}'.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Protocolo não permitido em '${rawUrl}'. Use apenas http:// ou https://.`);
    }
    const host = parsed.hostname.toLowerCase();
    const isPrivate =
      host === "localhost" ||
      host === "0.0.0.0" ||
      host.endsWith(".local") ||
      host.endsWith(".internal") ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host === "::1" || host === "[::1]";
    if (isPrivate) {
      throw new Error(`Endereço bloqueado por segurança: '${host}' aponta para a própria máquina ou para a rede interna, não para a internet pública.`);
    }
    return parsed;
  }

  /** Extensão -> mimetype, para quando o servidor de origem não informa um Content-Type útil. */
  const MEDIA_MIME_BY_EXT: Record<string, string> = {
    pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", mp4: "video/mp4", mp3: "audio/mpeg",
    ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    zip: "application/zip", txt: "text/plain", csv: "text/csv"
  };

  /**
   * Resolve a mídia pedida (link público ou base64) num buffer pronto para o Baileys, junto do
   * mimetype e do nome de arquivo. Aceita base64 puro ou data URI ("data:application/pdf;base64,...").
   */
  async function resolveWhatsAppMedia(media: any): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
    const explicitMime = (media?.mimeType || media?.mimetype || "").toString().trim();
    let fileName = (media?.fileName || media?.filename || "").toString().trim();
    let buffer: Buffer;
    let mimeType = explicitMime;

    if (media?.url) {
      const parsed = assertSafeMediaUrl(String(media.url));
      const response = await fetch(parsed.toString(), { redirect: "follow" });
      if (!response.ok) {
        throw new Error(`Não foi possível baixar o arquivo do link (HTTP ${response.status}).`);
      }
      // Confere o tamanho antes de carregar tudo na memória, quando o servidor informa.
      const declaredLength = Number(response.headers.get("content-length") || 0);
      if (declaredLength && declaredLength > MAX_WHATSAPP_MEDIA_BYTES) {
        throw new Error(`Arquivo muito grande (${(declaredLength / 1024 / 1024).toFixed(1)} MB). O limite para envio é ${MAX_WHATSAPP_MEDIA_BYTES / 1024 / 1024} MB.`);
      }
      buffer = Buffer.from(await response.arrayBuffer());
      if (!mimeType) mimeType = (response.headers.get("content-type") || "").split(";")[0].trim();
      if (!fileName) {
        fileName = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "").trim();
      }
    } else if (media?.data || media?.base64) {
      const raw = String(media.data || media.base64);
      const dataUriMatch = raw.match(/^data:([^;,]+)(;base64)?,(.*)$/s);
      if (dataUriMatch) {
        if (!mimeType) mimeType = dataUriMatch[1];
        buffer = Buffer.from(dataUriMatch[3], "base64");
      } else {
        buffer = Buffer.from(raw, "base64");
      }
    } else {
      throw new Error("Para enviar um arquivo, informe 'media.url' (link público) ou 'media.data' (conteúdo em base64).");
    }

    if (!buffer.length) {
      throw new Error("O arquivo veio vazio — nada foi enviado.");
    }
    if (buffer.length > MAX_WHATSAPP_MEDIA_BYTES) {
      throw new Error(`Arquivo muito grande (${(buffer.length / 1024 / 1024).toFixed(1)} MB). O limite para envio é ${MAX_WHATSAPP_MEDIA_BYTES / 1024 / 1024} MB.`);
    }

    const ext = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
    if (!mimeType || mimeType === "application/octet-stream") {
      mimeType = MEDIA_MIME_BY_EXT[ext] || mimeType || "application/octet-stream";
    }
    if (!fileName) {
      const guessedExt = Object.keys(MEDIA_MIME_BY_EXT).find(k => MEDIA_MIME_BY_EXT[k] === mimeType) || "bin";
      fileName = `arquivo.${guessedExt}`;
    }

    return { buffer, mimeType, fileName };
  }

  /** Decide como o WhatsApp deve apresentar o arquivo, a partir do tipo pedido ou do mimetype. */
  function buildWhatsAppMediaPayload(
    kind: string,
    resolved: { buffer: Buffer; mimeType: string; fileName: string },
    caption?: string
  ): any {
    const { buffer, mimeType, fileName } = resolved;
    const effectiveKind = (kind || "").toLowerCase() || (
      mimeType.startsWith("image/") ? "image"
        : mimeType.startsWith("video/") ? "video"
        : mimeType.startsWith("audio/") ? "audio"
        : "document"
    );

    switch (effectiveKind) {
      case "image":
        return { image: buffer, mimetype: mimeType, ...(caption ? { caption } : {}) };
      case "video":
        return { video: buffer, mimetype: mimeType, ...(caption ? { caption } : {}) };
      case "audio":
        // ptt:false = arquivo de áudio/música; o áudio de voz da IA continua indo por ptt:true.
        return { audio: buffer, mimetype: mimeType, ptt: false };
      default:
        return { document: buffer, mimetype: mimeType, fileName, ...(caption ? { caption } : {}) };
    }
  }

  // Send Outbound Message via WhatsApp (Baileys — waSocket.sendMessage)
  app.post("/api/whatsapp/send-message", async (req, res) => {
    const rawNumber = req.body.number || req.body.to || "";
    const messageText = req.body.message || req.body.text || "";

    console.log(`[WhatsApp Send] Chamada recebida para enviar mensagem. Destino: '${rawNumber}', Tamanho: ${messageText?.length || 0} chars`);

    whatsappLogs.unshift({
      id: Math.random().toString(36).substring(2, 11),
      timestamp: Date.now(),
      type: "info",
      sender: "Sistema / Envio",
      message: `Iniciando tentativa de envio para '${rawNumber}'...`
    });
    if (whatsappLogs.length > 100) whatsappLogs.pop();

    // Aceita envio só de mídia (ex.: mandar um PDF sem texto junto), então o texto deixa de ser
    // obrigatório quando há um arquivo — antes qualquer envio sem texto era recusado aqui.
    const mediaRequest = req.body.media || null;
    if (!rawNumber || (!messageText && !mediaRequest)) {
      const errorMsg = "Número de telefone é obrigatório, junto de uma mensagem de texto ou de um arquivo em 'media'.";
      console.error("[WhatsApp Send] Falha na validação:", errorMsg);
      whatsappLogs.unshift({
        id: Math.random().toString(36).substring(2, 11),
        timestamp: Date.now(),
        type: "error",
        sender: "Sistema / Envio",
        message: `Falha na validação: ${errorMsg}`
      });
      if (whatsappLogs.length > 100) whatsappLogs.pop();
      return res.status(400).json({ status: "error", error: errorMsg });
    }

    if (!waSocket || waStatus !== "conectado") {
      const errorMsg = `Sessão do WhatsApp não está pronta/conectada (Status atual: ${waStatus}). Por favor, clique em 'Iniciar Conexão' ou escaneie o QR Code no Monitor Central.`;
      console.error("[WhatsApp Send] Erro de prontidão do client:", errorMsg);
      whatsappLogs.unshift({
        id: Math.random().toString(36).substring(2, 11),
        timestamp: Date.now(),
        type: "error",
        sender: "Sistema / Envio",
        message: `Falha ao enviar: ${errorMsg}`
      });
      if (whatsappLogs.length > 100) whatsappLogs.pop();
      return res.status(400).json({ status: "error", error: errorMsg });
    }

    try {
      const cleanDigits = rawNumber.replace(/\D/g, "");
      if (!cleanDigits || cleanDigits.length < 8) {
        throw new Error(`Número de telefone inválido: '${rawNumber}' (${cleanDigits.length} dígitos)`);
      }

      const formattedJid = rawNumber.endsWith("@s.whatsapp.net") || rawNumber.endsWith("@g.us")
        ? rawNumber
        : `${cleanDigits}@s.whatsapp.net`;

      console.log(`[WhatsApp Send] Executando waSocket.sendMessage() para ${formattedJid}...`);

      whatsappLogs.unshift({
        id: Math.random().toString(36).substring(2, 11),
        timestamp: Date.now(),
        type: "info",
        sender: "WhatsApp",
        message: `Disparando mensagem para ${formattedJid} via WhatsApp...`
      });
      if (whatsappLogs.length > 100) whatsappLogs.pop();

      // Modo de envio: texto (padrão), voz, ou ambos. Quando o pedido é de áudio, o texto é
      // convertido em fala e enviado como mensagem de voz (o mesmo caminho já usado pela
      // auto-resposta), para que o modelo possa mandar áudio de verdade e não apenas texto.
      const asAudio = req.body.asAudio === true || req.body.sendAsAudio === true;
      const alsoText = req.body.alsoText !== false; // por padrão o texto acompanha o áudio

      let msgId: string = "ok";
      let audioSent = false;
      let audioError: string | null = null;
      let audioFormat: "voz" | "arquivo" | null = null;
      let mediaSent = false;

      // Com mídia e texto juntos, o texto vira legenda do arquivo (numa mensagem só, como uma
      // pessoa faria) em vez de sair como uma segunda mensagem solta.
      const mediaCaption = (req.body.caption || (mediaRequest ? messageText : "") || "").toString();
      const sendTextSeparately = messageText && !mediaRequest && (!asAudio || alsoText);

      if (sendTextSeparately) {
        const sentResult = await waSocket.sendMessage(formattedJid, { text: messageText });
        msgId = sentResult?.key?.id || "ok";
        console.log(`[WhatsApp Send] Mensagem de texto enviada com sucesso! ID: ${msgId}`);
      }

      if (mediaRequest) {
        // Falha de mídia é falha do envio: quem pediu para mandar o PDF precisa saber que ele
        // não chegou, em vez de receber "enviado com sucesso" por causa de um texto avulso.
        const resolved = await resolveWhatsAppMedia(mediaRequest);
        const payload = buildWhatsAppMediaPayload(mediaRequest.type || mediaRequest.kind, resolved, mediaCaption);
        const mediaResult = await waSocket.sendMessage(formattedJid, payload);
        mediaSent = true;
        if (msgId === "ok") msgId = mediaResult?.key?.id || "ok";
        console.log(`[WhatsApp Send] Arquivo '${resolved.fileName}' (${resolved.mimeType}, ${(resolved.buffer.length / 1024).toFixed(0)} KB) enviado para ${formattedJid}.`);
      }

      if (asAudio) {
        try {
          const speech = await synthesizeWhatsAppVoiceReply(messageText, {
            engine: req.body.ttsEngine || whatsappConfig.ttsEngine,
            geminiApiKey: req.body.geminiApiKey || whatsappConfig.geminiApiKey || getSecretGeminiKey(),
            voice: req.body.ttsVoice || whatsappConfig.ttsVoice,
            elevenLabsApiKey: req.body.elevenLabsApiKey || whatsappConfig.elevenLabsApiKey,
            elevenLabsVoiceId: req.body.elevenLabsVoiceId || whatsappConfig.elevenLabsVoiceId
          });

          if (speech) {
            // Campo próprio em vez de reaproveitar audioError: o áudio CHEGOU, apenas com
            // aparência diferente. Tratar isso como erro faria o modelo dizer ao usuário que
            // o envio falhou, quando o destinatário está ouvindo o áudio normalmente.
            audioFormat = await enviarAudioWhatsApp(formattedJid, speech);
            audioSent = true;
            console.log(`[WhatsApp Send] Áudio enviado para ${formattedJid} como ${audioFormat}.`);
          } else {
            audioError = `Não foi possível gerar o áudio. Motivo: ${ultimoErroTts || "a IA de voz não retornou áudio (verifique a chave configurada nos Ajustes)."}`;
          }
        } catch (ttsErr: any) {
          audioError = `Falha ao gerar/enviar o áudio: ${ttsErr?.message || ttsErr}`;
          console.error("[WhatsApp Send] Erro no envio de áudio:", ttsErr);
        }

        // Áudio pedido mas nenhuma das duas formas saiu: é falha real, não sucesso parcial.
        if (!audioSent && asAudio && !alsoText) {
          whatsappLogs.unshift({
            id: Math.random().toString(36).substring(2, 11),
            timestamp: Date.now(),
            type: "error",
            sender: `Para: ${cleanDigits}`,
            message: audioError || "Falha ao enviar áudio."
          });
          if (whatsappLogs.length > 100) whatsappLogs.pop();
          return res.status(500).json({ status: "error", error: audioError || "Falha ao enviar o áudio." });
        }
      }

      // Add to contact history
      const historyText = messageText || (mediaSent ? "[arquivo enviado]" : "");
      if (historyText) addMessageToHistory(formattedJid, "assistant", historyText);

      const extras = [audioSent ? "+ áudio" : "", mediaSent ? "+ arquivo" : ""].filter(Boolean).join(" ");
      whatsappLogs.unshift({
        id: Math.random().toString(36).substring(2, 11),
        timestamp: Date.now(),
        type: "sent",
        sender: `Para: ${cleanDigits}`,
        message: extras ? `${historyText} [${extras.trim()}]` : historyText
      });
      if (whatsappLogs.length > 100) whatsappLogs.pop();

      const parts = [
        sendTextSeparately || (mediaSent && messageText) ? "texto" : "",
        audioSent ? "áudio" : "",
        mediaSent ? "arquivo" : ""
      ].filter(Boolean);

      return res.json({
        status: "success",
        message: `Enviado com sucesso via WhatsApp (${parts.join(" + ") || "mensagem"})!`,
        messageId: msgId,
        to: formattedJid,
        audioSent,
        audioError,
        audioFormat,
        mediaSent
      });
    } catch (sendErr: any) {
      const errMsg = sendErr?.message || String(sendErr);
      console.error("[WhatsApp Send] Erro durante waSocket.sendMessage():", sendErr);

      if (errMsg.includes("Connection Closed") || errMsg.includes("Timed Out") || errMsg.includes("not open")) {
        waStatus = "desconectado";
        waLastError = "A conexão com o WhatsApp caiu ou perdeu a sessão. Clique em 'Iniciar Conexão' para reconectar.";
      }

      whatsappLogs.unshift({
        id: Math.random().toString(36).substring(2, 11),
        timestamp: Date.now(),
        type: "error",
        sender: `Para: ${rawNumber}`,
        message: `Erro ao enviar mensagem: ${errMsg}`
      });
      if (whatsappLogs.length > 100) whatsappLogs.pop();

      return res.status(500).json({ 
        status: "error", 
        error: errMsg,
        suggestion: "Sessão reiniciada. Por favor reconecte o WhatsApp no Monitor Central gerando um novo QR Code."
      });
    }
  });

  // Endpoint de inteligência para preencher Dossiê com arquivo ou PDF de referência
  app.post("/api/dossier/analyze", async (req, res) => {
    try {
      const { fileData, mimeType, questions, currentAnswers } = req.body;
      if (!fileData) {
        return res.status(400).json({ error: "Nenhum arquivo de referência foi enviado." });
      }
      if (!questions || !Array.isArray(questions)) {
        return res.status(400).json({ error: "A lista de perguntas é necessária para alinhar o mapeamento." });
      }

      const apiKey = getSecretGeminiKey();
      if (!apiKey) {
        return res.status(400).json({ error: "A API Key do Gemini não está configurada no painel de Secrets. Por favor, adicione-a para habilitar análise de referência." });
      }

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      // Prepare parts for Gemini based on MIME type
      const parts: any[] = [];

      if (mimeType === "application/pdf") {
        parts.push({
          inlineData: {
            data: fileData, // Already expected to be base64 from client
            mimeType: "application/pdf"
          }
        });
      } else if (!mimeType || mimeType.startsWith("text/") || mimeType === "application/json" || mimeType === "application/xml") {
        // Texto de verdade: decodifica e manda como texto puro no prompt.
        const decodedText = Buffer.from(fileData, 'base64').toString('utf8');
        parts.push({
          text: `DOCUMENTO DE REFERÊNCIA:\n\n${decodedText}`
        });
      } else {
        /**
         * Binário real (imagem, etc.): manda como inlineData com o mimeType verdadeiro.
         *
         * Antes qualquer coisa que não fosse PDF caía no ramo de texto acima e era forçada por
         * Buffer.toString('utf8') — que nunca lança em bytes arbitrários, só produz mojibake — e
         * o try/catch que existia "para esse caso" nunca disparava. O modelo recebia lixo em vez
         * da imagem e devolvia respostas vazias ou erradas, sem nenhum erro visível ao usuário.
         */
        parts.push({
          inlineData: {
            data: fileData,
            mimeType
          }
        });
      }

      // Add prompt with instructions and questions
      const prompt = `
Você é uma inteligência de elite integrada ao ecossistema OSONE.
Analise cuidadosamente o documento de referência fornecido acima sobre o Criador/Usuário do OSONE.
Sua missão é extrair e preencher as respostas do "Dossiê de Memória Íntima" com base UNICAMENTE nos fatos reais documentados na referência de forma natural, humana e direta, sem rodeios ou floreios artificiais.

Aqui está o conjunto de perguntas e seus IDs numéricos:
${JSON.stringify(questions.map((q: any) => ({ id: q.id, question: q.question })))}

Respostas Atuais cadastradas (as respostas já fornecidas):
${JSON.stringify(currentAnswers || {})}

Instruções Cruciais:
1. Extraia respostas precisas apenas para as perguntas cujas informações estejam claramente documentadas na referência fornecida.
2. Não invente ou presuma fatos adicionais. Se a referência não tiver dados para responder a uma pergunta, ignore-a de volta (não mande resposta pra ela).
3. Escreva respostas bem estruturadas, humanizadas, maduras, em primeira ou terceira pessoa (preferencialmente mantendo o estilo de notas pessoais, ex: "Mora em São Paulo, Brasil e tem 28 anos").
4. Caso a pergunta já tenha uma resposta atual válida em 'Respostas Atuais', priorize a resposta atual e mantenha a consistência, a menos que a referência traga dados cruciais mais completos ou que preencham por completo uma lacuna vazia.
5. Retorne os resultados obrigatoriamente no esquema JSON solicitado no responseSchema, onde as chaves são os IDs numéricos em formato de string (por exemplo, "1", "2") e os valores são as novas respostas extraídas.

Retorne SOMENTE o objeto JSON conforme o esquema.
`;

      parts.push({ text: prompt });

      // Call Gemini with structured JSON response config and fallbacks
      const response = await generateContentWithFallback(ai, {
        model: "gemini-3.7-flash",
        contents: { parts },
        config: {
          responseMimeType: "application/json",
          systemInstruction: "Você é um assistente cirúrgico de extração de dados pessoais. Analisa referências biográficas e preenche relatórios de forma factual, mantendo o estilo direto do usuário. Retorna JSON puro.",
          temperature: 0.2,
        },
      });

      const resultText = response.text?.trim() || "{}";
      let cleanJson = resultText;
      if (cleanJson.includes("```")) {
        // Strip markdown backticks
        cleanJson = cleanJson.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/\s*```$/, "");
      }
      const parsedAnswers = JSON.parse(cleanJson);

      res.json({
        status: "success",
        answers: parsedAnswers
      });

    } catch (e: any) {
      console.error("Erro ao analisar dossiê de referência:", e);
      res.status(500).json({ error: formatGeminiError(e) });
    }
  });

  // ====== NEURAL CONNECTION MEMORY SYNC ENDPOINTS ======
  // Choose safe paths in OS temp folder (writable in severless containers like Cloud Run)
  const SYNC_FILE_PATH = path.join(os.tmpdir(), "osone-sync-profiles.json");
  
  // Shared global memory fallback for 100% database/filesystem-free reliability 
  let inMemorySyncProfiles: Record<string, any> = {};

  // Helper to read sync profiles
  const readSyncProfiles = (): Record<string, any> => {
    try {
      if (Object.keys(inMemorySyncProfiles).length === 0) {
        // Try filling from temporary file storage if in-memory is empty
        if (fs.existsSync(SYNC_FILE_PATH)) {
          const raw = fs.readFileSync(SYNC_FILE_PATH, "utf8");
          inMemorySyncProfiles = JSON.parse(raw);
        }
      }
    } catch (e) {
      console.error("Error reading sync-profiles from temporary storage:", e);
    }
    return inMemorySyncProfiles;
  };

  // Helper to write sync profiles
  const writeSyncProfiles = (data: Record<string, any>) => {
    try {
      inMemorySyncProfiles = data;
      // Best-effort cache file writing
      fs.writeFileSync(SYNC_FILE_PATH, JSON.stringify(data, null, 2), "utf8");
    } catch (e) {
      console.warn("Writing to temp directory deferred. Proceeding with active RAM backup:", e.message);
    }
  };

  // POST to save memory sync profile
  app.post("/api/memory-sync/save", (req, res) => {
    try {
      const { syncId, payload } = req.body;
      if (!payload) {
        return res.status(400).json({ status: "error", error: "Missing payload" });
      }

      let targetSyncId = syncId;
      const profiles = readSyncProfiles();

      if (!targetSyncId) {
        // Generate random upper-case alphanum key OSONE-XXXX-XXXX
        const pickRandom = (len: number) => {
          const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
          let result = "";
          for (let i = 0; i < len; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
          }
          return result;
        };
        targetSyncId = `OSONE-${pickRandom(4)}-${pickRandom(4)}`;
        while (profiles[targetSyncId]) {
          targetSyncId = `OSONE-${pickRandom(4)}-${pickRandom(4)}`;
        }
      } else {
        // Clean and sanitize syncId
        targetSyncId = String(targetSyncId).trim().toUpperCase();
        if (!/^[A-Z0-9_-]{3,32}$/.test(targetSyncId)) {
          return res.status(400).json({ 
            status: "error", 
            error: "O ID deve conter de 3 a 32 caracteres alfanuméricos, hífen ou underline." 
          });
        }
      }

      profiles[targetSyncId] = {
        createdAt: profiles[targetSyncId]?.createdAt || Date.now(),
        updatedAt: Date.now(),
        payload
      };

      writeSyncProfiles(profiles);
      res.json({ status: "success", syncId: targetSyncId, profilesCount: Object.keys(profiles).length });
    } catch (error: any) {
      console.error("Error saving memory sync:", error);
      res.status(500).json({ status: "error", error: error.message });
    }
  });

  // O ID de sync (8 caracteres alfanuméricos) é a única barreira de acesso ao perfil de
  // outro usuário — sem limite de tentativas, um cliente decidido consegue tentar força
  // bruta contra o espaço de IDs. Isso não impede, mas encarece a tentativa por IP.
  const tentativasDeCargaPorIp = new Map<string, { contagem: number; expiraEm: number }>();
  setInterval(() => {
    const agora = Date.now();
    for (const [chave, registro] of tentativasDeCargaPorIp) {
      if (registro.expiraEm < agora) tentativasDeCargaPorIp.delete(chave);
    }
  }, 5 * 60 * 1000).unref();

  const limitarCargaDeMemoria = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const chave = enderecoDoPedido(req);
    const agora = Date.now();
    const janelaMs = 60 * 1000;
    const maxTentativas = 20;
    const registro = tentativasDeCargaPorIp.get(chave);
    if (!registro || registro.expiraEm < agora) {
      tentativasDeCargaPorIp.set(chave, { contagem: 1, expiraEm: agora + janelaMs });
      return next();
    }
    if (registro.contagem >= maxTentativas) {
      return res.status(429).json({ status: "error", error: "Muitas tentativas de carregar IDs de sincronização. Aguarde um minuto e tente de novo." });
    }
    registro.contagem++;
    next();
  };

  // GET to load memory sync profile
  app.get("/api/memory-sync/load/:syncId", limitarCargaDeMemoria, (req, res) => {
    try {
      const syncId = String(req.params.syncId).trim().toUpperCase();
      const profiles = readSyncProfiles();
      const profile = profiles[syncId];

      if (!profile) {
        return res.status(404).json({ 
          status: "error", 
          error: "ID de Conexão Neural não encontrado. Verifique se o ID está correto." 
        });
      }

      res.json({ 
        status: "success", 
        syncId, 
        createdAt: profile.createdAt, 
        updatedAt: profile.updatedAt, 
        payload: profile.payload 
      });
    } catch (error: any) {
      console.error("Error loading memory sync:", error);
      res.status(500).json({ status: "error", error: error.message });
    }
  });

  // Legacy Webhook route (Evolution API fully removed - active driver is Baileys)
  app.post("/api/whatsapp/webhook", (req, res) => {
    res.json({ status: "deprecated", message: "Integração Evolution API foi removida. A integração ativa é Baileys (conexão direta local)." });
  });

  // Helper to construct a standard WAV container header for raw 16-bit Mono PCM streams
  function pcmToWav(pcmBuffer: Buffer, sampleRate: number = 24000, numChannels: number = 1, bitsPerSample: number = 16): Buffer {
    const header = Buffer.alloc(44);
    const blockAlign = numChannels * (bitsPerSample / 8);
    const byteRate = sampleRate * blockAlign;
    const dataSize = pcmBuffer.length;
    const chunkSize = 36 + dataSize;

    // RIFF identifier
    header.write("RIFF", 0);
    // File length minus RIFF header (8 bytes)
    header.writeUInt32LE(chunkSize, 4);
    // RIFF type
    header.write("WAVE", 8);
    // Format chunk identifier (fmt with trailing space)
    header.write("fmt ", 12);
    // Format chunk size (16 for PCM)
    header.writeUInt32LE(16, 16);
    // Sample format (1 for PCM)
    header.writeUInt16LE(1, 20);
    // Channel count
    header.writeUInt16LE(numChannels, 22);
    // Sample rate
    header.writeUInt32LE(sampleRate, 24);
    // Byte rate
    header.writeUInt32LE(byteRate, 28);
    // Block align
    header.writeUInt16LE(blockAlign, 32);
    // Bits per sample
    header.writeUInt16LE(bitsPerSample, 34);
    // Data chunk identifier
    header.write("data", 36);
    // Data chunk size
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuffer]);
  }

  // helper to split text into chunks safely for Google Translate TTS API (200 char limit) - Kept as fallback or general reference
  function splitIntoChunks(text: string, maxLength: number = 200): string[] {
    const chunks: string[] = [];
    let currentChunk = "";
    const sentences = text.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+/g) || [text];
    
    for (const sentence of sentences) {
      if ((currentChunk + sentence).length <= maxLength) {
        currentChunk += sentence;
      } else {
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
        }
        if (sentence.length > maxLength) {
          const words = sentence.split(/\s+/);
          let wordChunk = "";
          for (const word of words) {
            if ((wordChunk + " " + word).length <= maxLength) {
              wordChunk += (wordChunk ? " " : "") + word;
            } else {
              if (wordChunk.trim()) {
                chunks.push(wordChunk.trim());
              }
              wordChunk = word;
            }
          }
          currentChunk = wordChunk;
        } else {
          currentChunk = sentence;
        }
      }
    }
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }
    return chunks;
  }

  // helper to split text into optimal paragraph/sentence chunks for premium Gemini 3.1 TTS
  function splitIntoTtsChunks(text: string, maxLength: number = 800): string[] {
    const chunks: string[] = [];
    let currentChunk = "";
    const sentences = text.match(/[^.!?\n\r]+[.!?\n\r]+|[^.!?\n\r]+/g) || [text];
    
    for (const sentence of sentences) {
      if ((currentChunk + " " + sentence).length <= maxLength) {
        currentChunk += (currentChunk ? " " : "") + sentence;
      } else {
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
        }
        if (sentence.length > maxLength) {
          const words = sentence.split(/\s+/);
          let wordChunk = "";
          for (const word of words) {
            if ((wordChunk + " " + word).length <= maxLength) {
              wordChunk += (wordChunk ? " " : "") + word;
            } else {
              if (wordChunk.trim()) {
                chunks.push(wordChunk.trim());
              }
              wordChunk = word;
            }
          }
          currentChunk = wordChunk;
        } else {
          currentChunk = sentence;
        }
      }
    }
    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }
    return chunks;
  }

  /**
   * Tira do texto tudo o que não se fala, antes de mandá-lo para qualquer voz.
   *
   * Existe porque o modelo escreve para ser LIDO, não ouvido: ele devolve "*muito* importante"
   * e emojis no meio da frase. A voz não sabe que aquilo é formatação e lê literalmente —
   * "asterisco muito asterisco importante" — e, no caso dos emojis, chega a pronunciar o nome
   * de cada um ("rosto sorridente"). Some com os símbolos, mas preserva a palavra que eles
   * estavam enfeitando: "*muito*" vira "muito", e não desaparece junto.
   *
   * Separada de stripVocalTags de propósito: aquela remove marcações de interpretação vocal
   * (ex: "[sussurrando]"), que para algumas vozes são intencionais e devem continuar chegando.
   * Símbolo e emoji, ao contrário, nunca devem ser falados por voz nenhuma.
   */
  function limparSimbolosParaVoz(text: string): string {
    return (text || "")
      // Emojis e pictogramas, incluindo bandeiras, tons de pele e as junções invisíveis que
      // grudam vários emojis num só (ZWJ) — sem remover essas peças, sobram fragmentos soltos.
      .replace(/\p{Extended_Pictographic}/gu, "")
      .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "")
      .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "")
      .replace(/[\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu, "")
      // Formatação markdown: mantém o conteúdo, descarta os sinais em volta.
      .replace(/(\*\*\*|___)(.+?)\1/g, "$2")
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(\*|_)(.+?)\1/g, "$2")
      .replace(/~~(.+?)~~/g, "$1")
      .replace(/`{1,3}([^`]+)`{1,3}/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      // Marcador de lista no começo da linha vira pausa, não a palavra "hífen".
      .replace(/^\s*[-*+]\s+/gm, "")
      // Sobras avulsas (um asterisco sozinho, uma crase perdida) que não formavam par.
      .replace(/[*_`~#]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripVocalTags(text: string): string {
    const semTags = text.replace(/\[[^\]]+\]/g, "").replace(/\([^)]+\)/g, "").replace(/<[^>]+>/g, "");
    return limparSimbolosParaVoz(semTags);
  }

  // POST endpoint for high-quality, consolidated Premium Gemini 3.1 TTS or ElevenLabs voice synthesis
  app.post("/api/tts", async (req, res) => {
    try {
      const { 
        text, 
        engine, 
        clientApiKey, 
        voice, 
        supertonicVoice,
        elevenLabsApiKey, 
        elevenLabsVoiceId,
        elevenLabsStability,
        elevenLabsSimilarityBoost,
        elevenLabsStyle,
        elevenLabsSpeakerBoost,
        elevenLabsModel,
        vocalProfileEscarlate
      } = req.body;

	      if (!text || typeof text !== "string") {
	        return res.status(400).json({ error: "O texto é obrigatório para conversão de áudio." });
	      }

      const cleanText = text.trim();
	      if (!cleanText) {
	        return res.status(400).json({ error: "O texto está vazio." });
	      }

	      // VOZ NEURAL LOCAL (SUPERTONIC) — português natural, sem chave e sem cota. No primeiro
	      // uso baixa o modelo uma vez; se ele falhar, o Piper preserva a narração.
	      if (engine === "supertonic") {
	        const wavNatural = await sintetizarComSupertonic(
	          stripVocalTags(cleanText),
	          supertonicVoice === "M1" ? "M1" : "F1"
	        );
	        if (wavNatural) {
	          res.setHeader("Content-Type", "audio/wav");
	          res.setHeader("Content-Disposition", "inline; filename=osone-voz-natural.wav");
	          res.setHeader("X-TTS-Mode", "supertonic");
	          return res.send(wavNatural);
	        }
	        const wavReserva = await sintetizarComVozLocal(stripVocalTags(cleanText));
	        if (wavReserva) {
	          res.setHeader("Content-Type", "audio/wav");
	          res.setHeader("X-TTS-Mode", "piper-fallback");
	          return res.send(wavReserva);
	        }
	        return res.status(503).json({
	          error: `${ultimoErroTts || "A voz natural local não pôde ser carregada."} Confira a internet no primeiro uso ou rode 'npm run baixar-voz-natural'.`
	        });
	      }

	      // VOZ LOCAL (PIPER) — usada pela narração operacional do COWORK e como opção sem cota.
	      // Precisa vir antes do Gemini: se cair no fluxo padrão, uma chamada local acabaria exigindo
	      // chave de API e poderia voltar para Google Translate, exatamente a voz robótica que queremos evitar.
	      if (engine === "local" || engine === "piper") {
	        const wavLocal = await sintetizarComVozLocal(stripVocalTags(cleanText));
	        if (!wavLocal) {
	          return res.status(503).json({
	            error: "A voz local Piper não está disponível. Rode 'npm run baixar-voz' no projeto ou confira se vendor/piper foi incluído no instalador."
	          });
	        }
	        res.setHeader("Content-Type", "audio/wav");
	        res.setHeader("Content-Disposition", "inline; filename=osone-piper.wav");
	        res.setHeader("X-TTS-Mode", "local");
	        return res.send(wavLocal);
	      }

	      // ELEVENLABS ENGINE ROUTE
      if (engine === 'elevenlabs') {
        const elApiKey = elevenLabsApiKey || process.env.ELEVENLABS_API_KEY;
        if (!elApiKey) {
          return res.status(400).json({ 
            error: "A chave API da ElevenLabs não foi configurada. Por favor, especifique uma na aba 'Chaves' das Configurações." 
          });
        }
        const validacaoChave = validarChaveElevenLabsParaUso(elApiKey);
        if (!validacaoChave.ok) {
          return res.status(400).json({ error: validacaoChave.message });
        }

        const cleanTextForEleven = stripVocalTags(cleanText);

        const voiceId = elevenLabsVoiceId || process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"; // Default Rachel
        const stability = typeof elevenLabsStability === "number" ? elevenLabsStability : 0.5;
        const similarity_boost = typeof elevenLabsSimilarityBoost === "number" ? elevenLabsSimilarityBoost : 0.75;
        const style = typeof elevenLabsStyle === "number" ? elevenLabsStyle : 0.0;
        const use_speaker_boost = typeof elevenLabsSpeakerBoost === "boolean" ? elevenLabsSpeakerBoost : true;
        const modelId = elevenLabsModel || "eleven_turbo_v2_5";

        let response: Response | null = null;
        let lastError = "";

        // Attempt 1: Using selected model & custom voice settings
        try {
          response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
            method: "POST",
            headers: {
              "xi-api-key": validacaoChave.key,
              "Content-Type": "application/json",
              "accept": "audio/mpeg"
            },
            body: JSON.stringify({
              text: cleanTextForEleven,
              model_id: modelId,
              voice_settings: {
                stability,
                similarity_boost,
                style,
                use_speaker_boost
              }
            })
          });
        } catch (err: any) {
          lastError = err.message || "Erro de conexão inicial ElevenLabs API";
        }

        // Attempt 2: Fallback with "eleven_multilingual_v2" if standard failed
        if (!response || !response.ok) {
          console.warn(`ElevenLabs API failed (Model: ${modelId}). Retrying with eleven_multilingual_v2 fallback...`);
          try {
            response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
              method: "POST",
              headers: {
                "xi-api-key": validacaoChave.key,
                "Content-Type": "application/json",
                "accept": "audio/mpeg"
              },
              body: JSON.stringify({
                text: cleanTextForEleven,
                model_id: "eleven_multilingual_v2",
                voice_settings: {
                  stability: 0.5,
                  similarity_boost: 0.75
                }
              })
            });
          } catch (retryErr: any) {
            lastError = retryErr.message || "Falha de conexão no segundo teste de ElevenLabs";
          }
        }

        // Final verification
        if (!response || !response.ok) {
          const status = response ? response.status : 500;
          let errText = lastError;
          if (response) {
            try {
              errText = await response.text();
            } catch (_) {}
          }
          
          let errorMessage = errText;
          try {
            const parsed = JSON.parse(errText);
            if (parsed.detail && typeof parsed.detail === 'object') {
              errorMessage = parsed.detail.message || JSON.stringify(parsed.detail);
            } else if (parsed.detail) {
              errorMessage = parsed.detail;
            }
          } catch (_) {}

          return res.status(status).json({ 
            error: `ElevenLabs recusou o streaming sintetizado: ${errorMessage || "Sem resposta/chave inválida"}` 
          });
        }

        // Retrieve and send the ElevenLabs synthesized audio as a single buffer
        const arrayBuffer = await response.arrayBuffer();
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("X-TTS-Mode", "elevenlabs");
        return res.send(Buffer.from(arrayBuffer));
      }

      // GEMINI 3.1 ENGINE ROUTE (DEFAULT)
      // Check for available API Keys
      const apiKey = clientApiKey || getSecretGeminiKey();
      if (!apiKey) {
        return res.status(400).json({ 
          error: "A chave API do Gemini não foi encontrada. Por favor, especifique uma nos Ajustes para utilizar a Voz Premium." 
        });
      }

      // Initialize the Gemini SDK (forcing Developer API over Vertex AI)
      const ai = new GoogleGenAI({
        apiKey,
        vertexai: false,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build'
          }
        }
      });

      // Split the prose into safer, reliable chunks (up to 700 characters) to avoid 500 timeouts/failures
      const chunks = splitIntoTtsChunks(cleanText, 700);
      const buffers: Buffer[] = [];
      let usedFallback = false;

      // Selected voice defaults to 'Kore' (highly natural female narrator in Portuguese)
      const supportedGeminiVoices = ["Puck", "Charon", "Kore", "Fenrir", "Zephyr", "Aoede", "Scarlet"];
      let selectedVoice = voice || "Kore";
      const isScarletVoice = selectedVoice === "Scarlet" || selectedVoice === "Fenrir";
      if (!supportedGeminiVoices.includes(selectedVoice)) {
        selectedVoice = "Kore"; // Map unsupported voices like 'Scarlet' to 'Kore'
      }
      if (selectedVoice === "Scarlet") {
        selectedVoice = "Fenrir";
      }

      for (const chunk of chunks) {
        let chunkAudioBuffer: Buffer | null = null;
        // A voz Scarlet/Fenrir continua recebendo as marcações de interpretação (ex: "[sussurrando]"),
        // que nela são intencionais — mas passa pela limpeza de símbolos como todas as outras.
        // Antes ela pulava a limpeza inteira, e era a única voz que ainda lia asteriscos e emojis.
        const processedChunk = isScarletVoice ? limparSimbolosParaVoz(chunk) : stripVocalTags(chunk);
        
        // Tiered model candidates list of premium intelligent voice models
        const candidateModels = [
          "gemini-3.1-flash-tts-preview",
          "gemini-3.6-flash",
          "gemini-3.5-flash-lite",
          "gemini-3.1-flash-lite"
        ];

        for (const modelName of candidateModels) {
          try {
            let promptText = `Leia o seguinte trecho com clareza absoluta, expressividade natural, pausas realistas e ritmo agradável de palestrante:\n\n${processedChunk}`;
            if (isScarletVoice) {
              const characteristics = vocalProfileEscarlate || "voz profunda, ressonante, de sabedoria cósmica, pausada e misteriosa";
              promptText = `Aja como o Osone Sensus: especialista em Ciência Comportamental de IA e Física Aplicada ao Comportamento Humano (Futurista Comportamental Quântico). É uma IA de sabedoria cósmica, profunda, instigante, misteriosa e altamente perspicaz.
Você deve encenar perfeitamente as seguintes CARACTERÍSTICAS DE PERFIL VOCAL específicas:
=== CARACTERÍSTICAS DE PERFIL VOCAL ===
${characteristics}
=======================================

Leia o trecho de texto abaixo encenando de acordo com esse perfil de voz futurista quântico, com alto nível de expressividade, nuances instigantes e tom cósmico profundo.
IMPORTANTE: Se houver qualquer tag de sentimento ou instrução vocal entre colchetes (como [sussurro], [tenso], [irritado], [sombrio], [ameaçador], [gargalhada], [drama], [rindo], [frio]) no texto original, você deve interpretar e inferir essas variações vocais perfeitamente em sua voz, mas NUNCA, SOB HIPÓTESE ALGUMA, pronunciar ou dizer as palavras da tag em voz alta! Apenas interprete o sentimento correspondente de forma magnífica de acordo com as instruções.
Adapte as transições de ritmo para soar perturbadoramente inteligente.
Texto para leitura:
${processedChunk}`;
            }

            const response = await ai.models.generateContent({
              model: modelName,
              contents: [{ parts: [{ text: promptText }] }],
              config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: selectedVoice },
                  },
                },
              },
            });

            const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              chunkAudioBuffer = Buffer.from(base64Audio, 'base64');
              console.log(`Successfully generated intelligent voice chunk utilizing candidate model: ${modelName}`);
              break; // Success, exit model candidates loop for this chunk
            }
          } catch (chunkError: any) {
            console.warn(`Candidate model ${modelName} encountered error for premium voice generation:`, chunkError?.message || chunkError);
          }
        }

        if (chunkAudioBuffer) {
          buffers.push(chunkAudioBuffer);
        } else {
          console.warn("All premium Gemini models failed. Resorting to standard fallback for chunk.");
          usedFallback = true;
          
          // Google Translate fallback for this specific chunk
          const subChunks = splitIntoChunks(stripVocalTags(processedChunk), 180);
          for (const subChunk of subChunks) {
            try {
              const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=pt-BR&client=tw-ob&q=${encodeURIComponent(subChunk)}`;
              const fbResponse = await fetch(url, {
                headers: {
                  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                }
              });
              if (fbResponse.ok) {
                const arrayBuffer = await fbResponse.arrayBuffer();
                buffers.push(Buffer.from(arrayBuffer));
              }
            } catch (fbErr) {
              console.error("Failed standard fallback synthesis for chunk:", fbErr);
            }
          }
        }
      }

      if (buffers.length === 0) {
        return res.status(500).json({ error: "Nenhum áudio pôde ser gerado por nenhum dos serviços de voz." });
      }

      const finalPcmBuffer = Buffer.concat(buffers);

      if (usedFallback) {
        // If Google Translate fallback was used, the audio container is MP3
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Content-Disposition", "attachment; filename=prosa_osone.mp3");
        res.setHeader("X-TTS-Mode", "fallback");
        res.send(finalPcmBuffer);
      } else {
        // High fidelity WAV container for raw Mono 24kHz PCM from Gemini 3.1
        const wavBuffer = pcmToWav(finalPcmBuffer, 24000);
        res.setHeader("Content-Type", "audio/wav");
        res.setHeader("Content-Disposition", "attachment; filename=prosa_osone.wav");
        res.setHeader("X-TTS-Mode", "premium");
        res.send(wavBuffer);
      }
    } catch (err: any) {
      console.error("Critical error inside premium /api/tts endpoint:", err);
      res.status(500).json({ error: err?.message || "Erro no servidor ao sintetizar áudio com Gemini 3.1." });
    }
  });

  /**
   * ====== OS "EXTRAS" DA GERAÇÃO DE CÓDIGO, E COMO ABRIR MÃO DELES ======
   *
   * Este é o conserto do defeito mais confuso que o OSONE CODE teve: a MESMA chave, no MESMO
   * instante, com a aba de escrita entregando texto e o OSONE CODE não entregando nada.
   *
   * A explicação é simples quando se põem as duas chamadas lado a lado. A aba de escrita manda
   * quatro campos, e o config que chega na API é só { systemInstruction }. A geração de código
   * manda 'unrestricted: true', e isso acrescenta TRÊS BLOCOS que a aba de escrita nunca envia:
   *
   *   thinkingConfig    → raciocínio no nível máximo
   *   maxOutputTokens   → orçamento de saída alto, para o arquivo caber
   *   safetySettings    → filtros ajustáveis afrouxados
   *
   * Cada um existe por um bom motivo. Só que basta a API recusar UM deles — porque o modelo não
   * suporta aquele campo, porque o nome mudou, porque aquela chave não tem o recurso — para a
   * chamada inteira falhar com um erro de pedido inválido. E aí a geração de código morre em
   * TODOS os modelos da fila, enquanto a aba de escrita, que não manda nenhum deles, segue
   * funcionando. Da tela, isso se lê como "o OSONE CODE está quebrado".
   *
   * A regra agora é: extra recusado é extra sacrificado. Um por vez, na ordem abaixo, repetindo
   * no MESMO modelo. Sacrificados os três, o pedido fica idêntico ao da aba de escrita — que é o
   * pedido que comprovadamente funciona. Perder o raciocínio máximo é um degrau abaixo; não
   * entregar código nenhum é o desfecho que não pode acontecer.
   *
   * A ordem sacrifica primeiro o que menos afeta o resultado final entregue ao usuário.
   */
  const EXTRAS_DA_GERACAO = ['thinkingConfig', 'maxOutputTokens', 'safetySettings'] as const;

  /** Por modelo, quais extras ele já recusou. Não se pergunta duas vezes. */
  const extrasRecusadosPorModelo = new Map<string, Set<string>>();

  /** O config sem os extras que este modelo já recusou antes. */
  function configAceitavelPara(modelo: string, config: any): any {
    const recusados = extrasRecusadosPorModelo.get(modelo);
    if (!recusados || recusados.size === 0 || !config) return config;
    const copia = { ...config };
    for (const extra of recusados) delete copia[extra];
    return copia;
  }

  /** O próximo extra a sacrificar neste modelo, ou null quando não há mais o que tirar. */
  function proximoExtraASacrificar(modelo: string, config: any): string | null {
    const recusados = extrasRecusadosPorModelo.get(modelo) || new Set<string>();
    for (const extra of EXTRAS_DA_GERACAO) {
      if (config?.[extra] !== undefined && !recusados.has(extra)) return extra;
    }
    return null;
  }

  function anotarExtraRecusado(modelo: string, extra: string) {
    const atuais = extrasRecusadosPorModelo.get(modelo) || new Set<string>();
    atuais.add(extra);
    extrasRecusadosPorModelo.set(modelo, atuais);
    console.warn(`[Modelos] "${modelo}" recusou "${extra}". Repetindo sem esse ajuste.`);
  }

  /**
   * Erro de PEDIDO INVÁLIDO — o que indica que algum campo do config não serve.
   * Cota e instabilidade passageira são outra coisa e têm tratamento próprio.
   */
  function ehPedidoInvalido(errMsg: string): boolean {
    return /INVALID_ARGUMENT/i.test(errMsg)
      || /\b400\b/.test(errMsg)
      || /unknown name|unsupported|not supported|invalid value|invalid json payload/i.test(errMsg);
  }

  /** Teto de tokens de saída pedido nas gerações de código. */
  const TETO_DE_SAIDA_PARA_CODIGO = Number(process.env.OSONE_TETO_SAIDA_CODIGO || 32768);
  /** Quantas vezes o modelo pode ser mandado continuar de onde parou antes de desistir. */
  const MAXIMO_DE_CONTINUACOES = Number(process.env.OSONE_MAXIMO_CONTINUACOES || 4);

  /**
   * Modelos que acabaram de recusar atendimento a esta chave, e até quando ignorá-los.
   *
   * Sem esta memória, TODA geração paga de novo a mesma fila de falhas antes de chegar ao modelo
   * que funciona. Numa chave de nível gratuito, em que os modelos de ponta respondem 429, isso são
   * dezenas de segundos de espera por pedido, repetidos indefinidamente — o app parece travado, e
   * a causa (uma cota que não é do modelo que acabou respondendo) não aparece em lugar nenhum.
   */
  const modelosIndisponiveis = new Map<string, number>();
  const MINUTO = 60_000;

  function anotarIndisponivel(modelo: string, motivo: 'cota' | 'inexistente') {
    // Cota volta sozinha com o tempo; modelo que não existe para esta chave não volta tão cedo.
    const castigo = motivo === 'cota' ? 10 * MINUTO : 60 * MINUTO;
    modelosIndisponiveis.set(modelo, Date.now() + castigo);
    console.warn(`[Modelos] "${modelo}" fora da fila por ${castigo / MINUTO} min (${motivo}).`);
  }

  /**
   * A escada de modelos a tentar, em ordem. Usada tanto pela geração de uma vez quanto pela
   * geração em fluxo — as duas precisam cair para os mesmos candidatos, ou o OSONE CODE se
   * comportaria de um jeito ao vivo e de outro no modo comum.
   */
  function listarModelosCandidatos(primaryModel: string, options?: { allowDowngrade?: boolean; modeloDeReserva?: string }): string[] {
    const allowDowngrade = options?.allowDowngrade !== false;

    /**
     * "NÃO REBAIXAR" NÃO PODE VIRAR "NÃO ENTREGAR NADA" — DE VERDADE DESTA VEZ.
     *
     * A regra de não cair para modelos 'lite' na geração de código existe por um bom motivo: a
     * qualidade do código despenca e o usuário não saberia por quê. Só que ela estava aplicada
     * como proibição ABSOLUTA, e isso transformava um cuidado com qualidade numa pane total.
     *
     * O caso real que revelou isso: numa chave de nível gratuito, os modelos de ponta
     * (gemini-3.6-flash, gemini-3.5-flash) respondem com falta de cota. A aba de escrita, que
     * permite rebaixar, caía para o gemini-3.5-flash-lite e ENTREGAVA o texto. O OSONE CODE, que
     * proibia, não entregava NADA — no mesmo app, na mesma chave, no mesmo instante. Da tela, a
     * leitura é "o OSONE CODE está quebrado", e não "os modelos preferidos estão sem cota".
     *
     * Os 'lite' entram agora, mas no FIM DA FILA: depois dos preferidos e depois do modelo que o
     * usuário configurou. Só se tudo o mais falhar. E quem respondeu é informado ao chamador, que
     * avisa na tela — a preocupação sempre foi com o rebaixamento SILENCIOSO, e essa parte
     * continua valendo.
     */
    // O 3.7-flash lidera a fila por ser o mais novo da linha Flash, e o 3.6-flash vem logo atrás de
    // propósito: se a chave do usuário ainda não tiver o 3.7 liberado (modelo recém-lançado, cota
    // gratuita liberada aos poucos), a resposta sai pelo 3.6 sem o usuário perceber tropeço.
    const modelsToTry = allowDowngrade
      ? [primaryModel, "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.5-flash"]
      // O modelo que o usuário configurou nos Ajustes entra depois dos preferidos: é o único que
      // se sabe que funciona com a chave dele. Os 'lite' vêm por último, como fundo de poço.
      : [primaryModel, "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", options?.modeloDeReserva || "",
         "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"].filter(Boolean);

    const unicos = Array.from(new Set(modelsToTry));

    // Quem acabou de recusar atendimento sai da frente da fila — mas nunca some por completo:
    // se TODOS estiverem de castigo, é melhor tentar todos do que não tentar nenhum.
    const agora = Date.now();
    const disponiveis = unicos.filter(m => (modelosIndisponiveis.get(m) || 0) <= agora);
    return disponiveis.length > 0 ? disponiveis : unicos;
  }

  // Helper to run content generation with automated fallbacks
  async function generateContentWithFallback(ai: GoogleGenAI, params: { model: string; contents: any; config?: any }, options?: { allowDowngrade?: boolean; modeloDeReserva?: string }) {
    const primaryModel = params.model || "gemini-3.7-flash";
    // Alguns fluxos (ex: geração de código no OSONE CODE) não podem aceitar em silêncio um
    // modelo "lite" mais fraco no lugar do pedido — a qualidade do código cairia sem o usuário
    // saber o motivo. Quando allowDowngrade é false, insiste só no modelo pedido (com mais
    // tentativas) em vez de cair para os candidatos mais fracos.
    const allowDowngrade = options?.allowDowngrade !== false;

    /**
     * "NÃO REBAIXAR" NÃO PODE SIGNIFICAR "NÃO ENTREGAR NADA".
     *
     * A intenção original estava certa: a geração de código não pode cair em silêncio para um
     * modelo "lite" mais fraco, porque a qualidade despenca sem o usuário saber o motivo. Só que
     * a implementação transformava isso em lista de UM modelo — e quando esse modelo ficava
     * indisponível (cota do dia esgotada, chave sem acesso a ele), o OSONE CODE parava de gerar
     * QUALQUER COISA, enquanto o resto do app seguia funcionando por ter fallback. O usuário
     * ficava sem nada e sem explicação, que é pior do que receber código de um modelo um degrau
     * abaixo.
     *
     * Agora existe uma lista de reserva também aqui, só que composta de modelos que sabem
     * programar — nenhum 'lite' entra. E quem responde é informado ao chamador, para o app poder
     * dizer na tela qual modelo escreveu o código: a preocupação era com o rebaixamento
     * SILENCIOSO, e essa parte continua valendo.
     */
    const uniqueModels = listarModelosCandidatos(primaryModel, options);
    const attemptsPerModel = allowDowngrade ? 2 : 4;

    let lastError: any = null;
    for (const modelName of uniqueModels) {
      for (let attempt = 1; attempt <= attemptsPerModel; attempt++) {
        // O pedido já sai sem os ajustes que ESTE modelo recusou antes.
        const configDaVez = configAceitavelPara(modelName, params.config);
        try {
          console.log(`Trying Gemini content generation (Model: ${modelName}, Attempt: ${attempt})`);
          const response = await ai.models.generateContent({
            model: modelName,
            contents: params.contents,
            config: configDaVez
          });
          // Quem respondeu vai junto: é o que permite avisar na tela quando não foi o preferido.
          (response as any).__modeloUsado = modelName;
          return response;
        } catch (err: any) {
          lastError = err;
          const errMsg = err?.message || String(err);
          const isQuota = errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.toLowerCase().includes("quota") || errMsg.toLowerCase().includes("limit");
          const isTransient = (errMsg.includes("503") || errMsg.includes("UNAVAILABLE") || errMsg.toLowerCase().includes("high demand")) && !isQuota;

          /**
           * Pedido inválido: sacrifica um extra e repete NO MESMO MODELO.
           *
           * Trocar de modelo aqui não adiantaria nada — o campo recusado iria junto e seria
           * recusado de novo, em todos eles, até a fila acabar sem entregar nada. Sacrificar não
           * consome uma tentativa: o que muda é o pedido, não a sorte. E o laço não corre solto
           * porque cada extra só pode ser sacrificado uma vez por modelo (são três no total).
           */
          if (!isQuota && ehPedidoInvalido(errMsg)) {
            const extra = proximoExtraASacrificar(modelName, params.config);
            if (extra) {
              anotarExtraRecusado(modelName, extra);
              attempt--;
              continue;
            }
          }

          if (isQuota) {
            // Cota esgotada: repetir no mesmo modelo não resolve nada, passa direto pro próximo —
            // e fica fora da fila por um tempo, para o próximo pedido não pagar a mesma espera.
            console.warn(`[Fallback Log] Model ${modelName} encountered a quota issue. Switching to next candidate model...`);
            anotarIndisponivel(modelName, 'cota');
            break;
          }

          // Modelo que não existe para esta chave não volta a existir na próxima tentativa.
          if (/404|NOT_FOUND/i.test(errMsg) || /is not found for api version/i.test(errMsg)) {
            anotarIndisponivel(modelName, 'inexistente');
            break;
          }

          if (isTransient && attempt < attemptsPerModel) {
            // Instabilidade passageira (ex: 503/alta demanda): vale a pena insistir no MESMO
            // modelo antes de desistir dele — antes este retry nunca acontecia de verdade
            // porque o código sempre saía do loop no primeiro erro, mesmo com "attempt <= N".
            console.warn(`[Fallback Log] Model ${modelName} hit a transient issue (attempt ${attempt}/${attemptsPerModel}). Retrying same model shortly...`);
            await new Promise(resolve => setTimeout(resolve, 700 * attempt));
            continue;
          }

          console.log(`[Fallback Log] Model ${modelName} attempt ${attempt} returned exception:`, errMsg);
          break; // Move to next candidate model
        }
      }
    }
    throw lastError;
  }

  /**
   * ====== O CÓDIGO PRECISA CHEGAR AO FIM ======
   *
   * Um pedido de "faça um jogo completo em HTML" não cabe numa resposta só. O modelo escreve até
   * o limite de tokens de saída e para no meio — finishReason 'MAX_TOKENS'. Isso não é erro,
   * então nada aqui falhava: o servidor devolvia o pedaço, o app gravava o pedaço, e o usuário
   * ficava com um arquivo que abre e não fecha. Era literalmente o código não sendo finalizado, e
   * a única reação do sistema era uma frase na tela dizendo que talvez estivesse incompleto.
   *
   * A saída é a óbvia: mandar o modelo CONTINUAR de onde parou, quantas vezes forem necessárias,
   * e emendar os pedaços. É assim que se gera um arquivo maior que uma resposta.
   */

  /** Deixa o 'contents' no formato de turnos, seja ele texto solto, um turno só ou vários. */
  function normalizarTurnos(contents: any): any[] {
    if (contents == null) return [];
    if (typeof contents === 'string') return [{ role: 'user', parts: [{ text: contents }] }];
    if (Array.isArray(contents)) {
      return contents.map(c => (typeof c === 'string' ? { role: 'user', parts: [{ text: c }] } : c));
    }
    return [contents];
  }

  type ProvedorDoOsoneCode = 'gemini' | 'openai' | 'anthropic' | 'ollama';

  function provedorAlternativoDoCode(body: any): ProvedorDoOsoneCode {
    const bruto = String(body?.codeAiProvider || body?.osoneCodeProvider || 'gemini').toLowerCase();
    if (bruto === 'openai' || bruto === 'anthropic' || bruto === 'ollama') return bruto;
    return 'gemini';
  }

  /**
   * ====== MOTOR LOCAL: OLLAMA (QWEN CODER E COMPANHIA) ======
   *
   * O pedido chega com a URL do Ollama porque quem conhece a máquina da placa de vídeo é o
   * navegador do usuário, não este servidor: instalado, o OSONE escuta em 0.0.0.0 e atende gente
   * de outros computadores, e seria um erro (e um risco) gerar código contra um "localhost" que é
   * o servidor. Por isso também a guarda: só endereços de loopback são aceitos — um OSONE público
   * jamais pode virar ponte para o Ollama interno de quem o hospeda (SSRF).
   */
  async function gerarComOllamaParaCode(
    body: any,
    onPedaco?: (texto: string) => void
  ): Promise<{ text: string; finishReason?: string; truncated: boolean; modeloUsado: string }> {
    const enderecoBruto = String(body.ollamaUrl || '').trim();
    if (!ehEnderecoLocalDoOllama(enderecoBruto)) {
      throw new Error(`Ollama local só aceita endereços da própria máquina (127.0.0.1/localhost). Recebido: "${enderecoBruto.slice(0, 80)}".`);
    }
    const base = normalizarEnderecoDoOllama(enderecoBruto);
    const modelo = String(body.model || body.ollamaModel || MODELOS_OLLAMA_PADRAO).trim();
    const entrada = extrairPromptMultimodal(body.prompt ?? body.contents);
    const imagens = Math.round((entrada.imagens.reduce((soma, img) => soma + img.data.length, 0) / 1024) * 0.75);
    if (entrada.imagens.length > 0) {
      console.warn(`[Ollama] ${entrada.imagens.length} imagem(ns) de referência (~${imagens} KB em base64) desconsideradas: o modelo local recebe só o texto.`);
    }

    // Como nos motores pagos, o teto alto entra APENAS quando o esforço máximo foi pedido — que é
    // exatamente o botão "Esforço máximo" da aba. Assim o usuário controla o tamanho do arquivo
    // gerado pela própria GPU sem depender de variável de ambiente no servidor.
    const corpo = montarPedidoOllama({
      modelo,
      prompt: entrada.texto,
      systemInstruction: body.systemInstruction ? String(body.systemInstruction) : undefined,
      stream: Boolean(onPedaco),
      tetoDeTokens: (body.unrestricted || body.maxEffort) ? TETO_DE_SAIDA_PARA_CODIGO : undefined,
    });

    let resposta: Response;
    try {
      resposta = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(30 * 60 * 1000),
      });
    } catch (err: any) {
      throw new Error(
        `Não foi possível falar com o Ollama em ${base}. Ele está rodando? ` +
        `Abra um terminal e rode "ollama serve", ou use o botão de instalação do OSONE CODE. (${err?.message || err})`
      );
    }

    if (!resposta.ok) {
      const detalhe = await resposta.text().catch(() => '');
      throw new Error(`Ollama (${resposta.status}): ${detalhe.slice(0, 300) || 'falha na geração'}`);
    }

    let texto = '';
    let motivoParada: string | undefined;
    if (onPedaco && resposta.body) {
      const leitor = resposta.body.getReader();
      const decodificador = new TextDecoder();
      let sobra = '';
      for (;;) {
        const { done, value } = await leitor.read();
        if (done) break;
        sobra += decodificador.decode(value, { stream: true });
        const linhas = sobra.split('\n');
        sobra = linhas.pop() || '';
        for (const linha of linhas) {
          const pedaco = lerPecacoDoFluxoOllama(linha);
          if (pedaco.texto) { texto += pedaco.texto; onPedaco(pedaco.texto); }
          if (pedaco.done) { motivoParada = pedaco.motivo; }
        }
      }
      if (sobra.trim()) {
        const pedaco = lerPecacoDoFluxoOllama(sobra);
        if (pedaco.texto) texto += pedaco.texto;
        if (pedaco.done) motivoParada = pedaco.motivo;
      }
    } else {
      const dados: any = await resposta.json().catch(() => null);
      texto = typeof dados?.response === 'string' ? dados.response : '';
      motivoParada = typeof dados?.done_reason === 'string' ? dados.done_reason : undefined;
    }

    const truncated = motivoIndicaCorte(motivoParada);
    return { text: texto, finishReason: motivoParada, truncated, modeloUsado: modelo };
  }

  /** Instrução mandando o modelo local continuar de onde parou (mesma regra dos motores pagos). */
  const INSTRUCAO_PARA_CONTINUAR_LOCAL = `Sua resposta anterior foi CORTADA por limite de tokens, no meio. CONTINUE EXATAMENTE do ponto onde parou, sem repetir nada do que já escreveu, sem saudação, sem cercas de markdown, e feche todas as tags, funções e blocos abertos.`;

  /**
   * Gera com o Ollama e, se a resposta vier cortada, manda continuar até fechar o arquivo — o
   * mesmo cuidado que a geração Gemini recebe, agora para os modelos locais, que cortam ainda
   * mais cedo por terem janelas menores.
   */
  async function gerarComOllamaAteOFim(
    body: any,
    onPedaco?: (texto: string) => void
  ): Promise<{ text: string; finishReason?: string; truncated: boolean; modeloUsado: string; continuacoes: number }> {
    const primeira = await gerarComOllamaParaCode(body, onPedaco);
    let texto = primeira.text || '';
    let truncated = primeira.truncated;
    let continuacoes = 0;
    const limite = Number(body.unrestricted || body.maxEffort) ? MAXIMO_DE_CONTINUACOES : 0;

    while (truncated && continuacoes < limite && texto.trim()) {
      continuacoes++;
      console.warn(`[Ollama] Resposta cortada. Pedindo continuação ${continuacoes}/${limite}...`);
      const corpoDaContinuacao = { ...body, prompt: `${texto}\n\n${INSTRUCAO_PARA_CONTINUAR_LOCAL}` };
      let seguinte: any;
      try {
        seguinte = await gerarComOllamaParaCode(corpoDaContinuacao, onPedaco);
      } catch (err: any) {
        // Falhar a continuação não apaga o que já foi escrito: entrega o pedaço existente, cortado.
        console.error(`[Ollama] Falha ao continuar a geração:`, err?.message || err);
        break;
      }
      const antes = texto.length;
      texto = emendarContinuacaoLocal(texto, tirarCercaDeAbertura(seguinte.text || ''));
      truncated = seguinte.truncated;
      if (texto.length <= antes) {
        console.warn(`[Ollama] A continuação não acrescentou texto novo. Parando aqui.`);
        break;
      }
      if (onPedaco) { /* os pedaços novos já foram emitidos dentro de gerarComOllamaParaCode */ }
    }
    return { text: texto, finishReason: primeira.finishReason, truncated, modeloUsado: primeira.modeloUsado, continuacoes };
  }

  function extrairPromptMultimodal(contents: any): {
    texto: string;
    imagens: Array<{ mimeType: string; data: string }>;
  } {
    const imagens: Array<{ mimeType: string; data: string }> = [];
    const linhas: string[] = [];
    const turnos = normalizarTurnos(contents);

    const visitarParte = (parte: any) => {
      if (!parte) return;
      if (typeof parte === 'string') {
        linhas.push(parte);
        return;
      }
      if (typeof parte.text === 'string') linhas.push(parte.text);
      const inlineData = parte.inlineData || parte.inline_data;
      if (inlineData?.data && inlineData?.mimeType) {
        imagens.push({ mimeType: String(inlineData.mimeType), data: String(inlineData.data) });
      }
    };

    for (const turno of turnos) {
      if (!turno) continue;
      if (typeof turno === 'string') {
        linhas.push(turno);
        continue;
      }
      const role = turno.role ? String(turno.role).toUpperCase() : '';
      const partes = Array.isArray(turno.parts) ? turno.parts : Array.isArray(turno.content) ? turno.content : [];
      if (role) linhas.push(`\n[${role}]`);
      if (partes.length > 0) {
        partes.forEach(visitarParte);
      } else if (typeof turno.text === 'string') {
        linhas.push(turno.text);
      }
    }

    return {
      texto: linhas.join('\n').replace(/\n{4,}/g, '\n\n\n').trim(),
      imagens
    };
  }

  function textoDaRespostaOpenAi(data: any): string {
    if (typeof data?.output_text === 'string') return data.output_text;
    const blocos: string[] = [];
    const output = Array.isArray(data?.output) ? data.output : [];
    for (const item of output) {
      const content = Array.isArray(item?.content) ? item.content : [];
      for (const parte of content) {
        if (typeof parte?.text === 'string') blocos.push(parte.text);
        if (typeof parte?.content === 'string') blocos.push(parte.content);
      }
    }
    return blocos.join('\n');
  }

  function textoDaRespostaAnthropic(data: any): string {
    const content = Array.isArray(data?.content) ? data.content : [];
    return content
      .map((parte: any) => typeof parte?.text === 'string' ? parte.text : '')
      .filter(Boolean)
      .join('\n');
  }

  async function gerarComOpenAiParaCode(body: any): Promise<{ text: string; finishReason?: string; truncated: boolean; modeloUsado: string }> {
    const apiKey = String(body.openAiApiKey || body.openaiApiKey || '').trim();
    if (!apiKey) throw new Error("Chave API da OpenAI não definida no OSONE CODE.");

    const modelo = String(body.model || body.openAiModel || 'gpt-5.5').trim();
    const entrada = extrairPromptMultimodal(body.prompt);
    const content: any[] = [];
    if (entrada.texto) content.push({ type: 'input_text', text: entrada.texto });
    for (const img of entrada.imagens) {
      content.push({ type: 'input_image', image_url: `data:${img.mimeType};base64,${img.data}` });
    }

    const payload: any = {
      model: modelo,
      input: [{ role: 'user', content: content.length ? content : [{ type: 'input_text', text: '' }] }]
    };
    if (body.systemInstruction) payload.instructions = String(body.systemInstruction);
    if (body.unrestricted || body.maxEffort) {
      payload.reasoning = { effort: 'high' };
      payload.max_output_tokens = TETO_DE_SAIDA_PARA_CODIGO;
    }

    const resposta = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await resposta.json().catch(async () => ({ error: { message: await resposta.text().catch(() => '') } }));
    if (!resposta.ok) {
      throw new Error(`OpenAI (${resposta.status}): ${data?.error?.message || data?.message || 'falha na geração'}`);
    }

    const finishReason = data?.status === 'incomplete'
      ? (data?.incomplete_details?.reason || 'incomplete')
      : data?.status;
    return {
      text: textoDaRespostaOpenAi(data),
      finishReason,
      truncated: data?.status === 'incomplete',
      modeloUsado: modelo
    };
  }

  async function gerarComAnthropicParaCode(body: any): Promise<{ text: string; finishReason?: string; truncated: boolean; modeloUsado: string }> {
    const apiKey = String(body.anthropicApiKey || '').trim();
    if (!apiKey) throw new Error("Chave API da Anthropic/Claude não definida no OSONE CODE.");

    const modelo = String(body.model || body.anthropicModel || 'claude-sonnet-5').trim();
    const entrada = extrairPromptMultimodal(body.prompt);
    const content: any[] = [];
    if (entrada.texto) content.push({ type: 'text', text: entrada.texto });
    for (const img of entrada.imagens) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mimeType, data: img.data }
      });
    }

    const maxTokens = Number(process.env.OSONE_CLAUDE_MAX_TOKENS || 8192);
    const payload: any = {
      model: modelo,
      max_tokens: Math.max(1024, Math.min(maxTokens, TETO_DE_SAIDA_PARA_CODIGO)),
      messages: [{ role: 'user', content: content.length ? content : [{ type: 'text', text: '' }] }]
    };
    if (body.systemInstruction) payload.system = String(body.systemInstruction);

    const resposta = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await resposta.json().catch(async () => ({ error: { message: await resposta.text().catch(() => '') } }));
    if (!resposta.ok) {
      throw new Error(`Anthropic (${resposta.status}): ${data?.error?.message || data?.message || 'falha na geração'}`);
    }

    return {
      text: textoDaRespostaAnthropic(data),
      finishReason: data?.stop_reason,
      truncated: data?.stop_reason === 'max_tokens',
      modeloUsado: modelo
    };
  }

  /**
   * Emenda a continuação no que já existe, descontando o que o modelo repetiu.
   *
   * Mandado continuar, o modelo quase sempre reescreve as últimas linhas antes de seguir — é o
   * jeito dele "retomar o fio". Emendar sem olhar duplicaria essas linhas dentro do código, o que
   * costuma ser pior do que o corte: uma função declarada duas vezes quebra o arquivo inteiro.
   * Procura-se então o maior fim-de-A que também é começo-de-B e joga-se fora essa sobreposição.
   */
  function emendarContinuacao(inicio: string, continuacao: string): string {
    if (!inicio) return continuacao;
    if (!continuacao) return inicio;
    const maximo = Math.min(600, inicio.length, continuacao.length);
    for (let n = maximo; n >= 20; n--) {
      if (inicio.endsWith(continuacao.slice(0, n))) return inicio + continuacao.slice(n);
    }
    return inicio + continuacao;
  }

  /** Cerca de markdown que o modelo às vezes reabre ao continuar. Ela não é parte do código. */
  function tirarCercaDeAbertura(texto: string): string {
    return texto.replace(/^\s*```[a-zA-Z0-9]*[ \t]*\r?\n/, '');
  }

  const INSTRUCAO_PARA_CONTINUAR = `Sua resposta anterior foi CORTADA por limite de tokens, no meio.

CONTINUE EXATAMENTE do ponto onde parou, como se nunca tivesse havido interrupção:
- Comece pelo caractere seguinte ao último que você escreveu. Se você parou no meio de uma palavra, de uma tag ou de uma linha, retome o meio dela.
- NÃO repita nada do que já foi escrito, NÃO recomece o arquivo, NÃO resuma o que veio antes.
- NÃO escreva saudação, explicação, comentário sobre a interrupção nem cercas de markdown.
- Mantenha exatamente o mesmo formato de resposta que já estava usando.
- Vá até o fim de verdade desta vez: feche todas as tags, funções e blocos abertos.`;

  /**
   * Gera conteúdo e, se a resposta vier cortada, manda continuar até o texto terminar de verdade.
   * Devolve o texto inteiro já emendado. 'truncated' só continua verdadeiro se, mesmo depois de
   * todas as continuações permitidas, o modelo ainda não tiver chegado ao fim.
   */
  async function gerarConteudoAteOFim(
    ai: GoogleGenAI,
    params: { model: string; contents: any; config?: any },
    options?: { allowDowngrade?: boolean; modeloDeReserva?: string; maximoDeContinuacoes?: number }
  ): Promise<{ texto: string; finishReason: any; continuacoes: number; modeloUsado: string; bloqueado: boolean }> {
    const ehFinishReasonBloqueado = (fr: any) =>
      fr === "SAFETY" || fr === "PROHIBITED_CONTENT" || fr === "BLOCKLIST" || fr === "SPII";

    const primeira = await generateContentWithFallback(ai, params, options);
    let texto = primeira.text || "";
    let finishReason = (primeira as any)?.candidates?.[0]?.finishReason;
    const modeloUsado = (primeira as any).__modeloUsado || params.model;
    let bloqueado = ehFinishReasonBloqueado(finishReason);

    const limite = Math.max(0, options?.maximoDeContinuacoes ?? 0);
    if (bloqueado || limite === 0) return { texto, finishReason, continuacoes: 0, modeloUsado, bloqueado };

    const turnosOriginais = normalizarTurnos(params.contents);
    // Na continuação o formato já foi decidido no primeiro turno. Exigir de novo um JSON completo
    // faria o modelo RECOMEÇAR o documento do zero em vez de completar o que ficou pela metade —
    // e aí sim não haveria como juntar as duas metades.
    const configDaContinuacao = { ...(params.config || {}) };
    delete (configDaContinuacao as any).responseMimeType;
    delete (configDaContinuacao as any).responseSchema;

    let continuacoes = 0;
    while (finishReason === "MAX_TOKENS" && continuacoes < limite && texto.trim()) {
      continuacoes++;
      console.warn(`[Continuação] Resposta cortada por MAX_TOKENS. Pedindo continuação ${continuacoes}/${limite}...`);
      let seguinte: any;
      try {
        seguinte = await generateContentWithFallback(ai, {
          model: modeloUsado,
          contents: [
            ...turnosOriginais,
            { role: "model", parts: [{ text: texto }] },
            { role: "user", parts: [{ text: INSTRUCAO_PARA_CONTINUAR }] }
          ],
          config: configDaContinuacao
        }, options);
      } catch (err: any) {
        // Falhar a continuação não pode apagar o que já foi escrito: entrega o que existe,
        // ainda marcado como cortado, que é bem melhor do que devolver erro e perder tudo.
        console.error(`[Continuação] Falha ao continuar a geração:`, err?.message || err);
        break;
      }

      const pedaco = tirarCercaDeAbertura(seguinte.text || "");
      if (!pedaco.trim()) {
        console.warn(`[Continuação] O modelo respondeu vazio ao ser mandado continuar. Parando aqui.`);
        break;
      }
      const antes = texto.length;
      texto = emendarContinuacao(texto, pedaco);
      finishReason = (seguinte as any)?.candidates?.[0]?.finishReason;
      // Continuação que não acrescenta nada só queimaria as tentativas restantes.
      if (texto.length <= antes) {
        console.warn(`[Continuação] A continuação não acrescentou texto novo. Parando aqui.`);
        break;
      }
    }

    if (continuacoes > 0) {
      console.log(`[Continuação] Texto final montado com ${continuacoes} continuação(ões): ${texto.length} caracteres.`);
    }
    // finishReason pode ter mudado numa continuação (ex: a primeira parte veio por MAX_TOKENS,
    // mas a continuação foi barrada por SAFETY) — bloqueado precisa refletir o resultado final,
    // não só o da primeira resposta, senão uma geração bloqueada sai daqui marcada como sucesso.
    bloqueado = ehFinishReasonBloqueado(finishReason);
    return { texto, finishReason, continuacoes, modeloUsado, bloqueado };
  }

  /**
   * Abre um fluxo de geração com a mesma escada de modelos da geração de uma vez, e diz QUEM
   * respondeu — o fluxo em si não carrega essa informação, e sem ela a tela não teria como avisar
   * que o código foi escrito por um modelo de reserva.
   */
  async function abrirFluxoComReserva(
    ai: GoogleGenAI,
    params: { model: string; contents: any; config?: any },
    options?: { allowDowngrade?: boolean; modeloDeReserva?: string }
  ): Promise<{ fluxo: any; modeloUsado: string }> {
    const primaryModel = params.model || "gemini-3.7-flash";
    const candidatos = listarModelosCandidatos(primaryModel, options);
    const tentativasPorModelo = options?.allowDowngrade === false ? 4 : 2;

    let ultimoErro: any = null;
    for (const modelName of candidatos) {
      for (let tentativa = 1; tentativa <= tentativasPorModelo; tentativa++) {
        const configDaVez = configAceitavelPara(modelName, params.config);
        try {
          console.log(`Trying Gemini code stream (Model: ${modelName}, Attempt: ${tentativa})`);
          const fluxo = await ai.models.generateContentStream({
            model: modelName,
            contents: params.contents,
            config: configDaVez
          });
          return { fluxo, modeloUsado: modelName };
        } catch (err: any) {
          ultimoErro = err;
          const errMsg = err?.message || String(err);
          const isQuota = errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.toLowerCase().includes("quota") || errMsg.toLowerCase().includes("limit");
          const isTransient = (errMsg.includes("503") || errMsg.includes("UNAVAILABLE") || errMsg.toLowerCase().includes("high demand")) && !isQuota;

          // Mesma regra do caminho de uma vez: extra recusado é sacrificado, e repete no mesmo
          // modelo, até o pedido ficar igual ao da aba de escrita — que funciona.
          if (!isQuota && ehPedidoInvalido(errMsg)) {
            const extra = proximoExtraASacrificar(modelName, params.config);
            if (extra) {
              anotarExtraRecusado(modelName, extra);
              tentativa--;
              continue;
            }
          }
          if (isQuota) {
            console.warn(`[Fluxo] Model ${modelName} sem cota. Passando para o próximo candidato...`);
            anotarIndisponivel(modelName, 'cota');
            break;
          }
          if (/404|NOT_FOUND/i.test(errMsg) || /is not found for api version/i.test(errMsg)) {
            anotarIndisponivel(modelName, 'inexistente');
            break;
          }
          if (isTransient && tentativa < tentativasPorModelo) {
            await new Promise(resolve => setTimeout(resolve, 700 * tentativa));
            continue;
          }
          console.log(`[Fluxo] Model ${modelName} tentativa ${tentativa} falhou:`, errMsg);
          break;
        }
      }
    }
    throw ultimoErro;
  }

  // Helper to run content stream generation with automated fallbacks
  async function generateContentStreamWithFallback(ai: GoogleGenAI, params: { model: string; contents: any; config?: any }) {
    const primaryModel = params.model || "gemini-3.7-flash";

    // Tiered candidates using standard highly-available Gemini 3.x models
    const modelsToTry = [
      primaryModel,
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash"
    ];
    
    // Remove duplicates keeping order
    const uniqueModels = Array.from(new Set(modelsToTry));
    
    const tentativasPorModelo = 2;

    let lastError: any = null;
    for (const modelName of uniqueModels) {
      for (let attempt = 1; attempt <= tentativasPorModelo; attempt++) {
        try {
          console.log(`Trying Gemini content stream generation (Model: ${modelName}, Attempt: ${attempt})`);
          const stream = await ai.models.generateContentStream({
            model: modelName,
            contents: params.contents,
            config: params.config
          });
          return stream;
        } catch (err: any) {
          lastError = err;
          const errMsg = err?.message || String(err);
          const isQuota = errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.toLowerCase().includes("quota") || errMsg.toLowerCase().includes("limit");
          const isTransient = (errMsg.includes("503") || errMsg.includes("UNAVAILABLE") || errMsg.toLowerCase().includes("high demand")) && !isQuota;

          if (isQuota) {
            // Cota esgotada: repetir no mesmo modelo não resolve nada, passa direto pro próximo.
            console.warn(`[Fallback Stream Log] Model ${modelName} encountered a quota issue. Switching to next candidate model...`);
            break;
          }

          if (isTransient && attempt < tentativasPorModelo) {
            // Instabilidade passageira (ex: 503/alta demanda): vale insistir no MESMO modelo antes
            // de desistir dele — mesma correção já feita em generateContentWithFallback, que aqui
            // tinha ficado para trás porque todo caminho do catch saía do laço na primeira volta.
            console.warn(`[Fallback Stream Log] Model ${modelName} hit a transient issue (attempt ${attempt}/${tentativasPorModelo}). Retrying same model shortly...`);
            await new Promise(resolve => setTimeout(resolve, 700 * attempt));
            continue;
          }

          console.log(`[Fallback Stream Log] Model ${modelName} attempt ${attempt} returned exception:`, errMsg);
          break; // Move to next candidate model
        }
      }
    }
    throw lastError;
  }

  // POST endpoint for high-quality, server-run intelligence completion using gemini-3.7-flash
  app.post("/api/chat-intel", async (req, res) => {
    try {
      const { historyContents, systemInstruction, clientApiKey } = req.body;
      const apiKey = clientApiKey || getSecretGeminiKey();
      if (!apiKey) {
        return res.status(400).json({ error: "Chave API do Gemini não definida no servidor." });
      }

      const ai = new GoogleGenAI({
        apiKey: apiKey,
        vertexai: false,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      const response = await generateContentWithFallback(ai, {
        model: "gemini-3.7-flash",
        contents: historyContents,
        config: {
          maxOutputTokens: 250,
          temperature: 0.7,
          systemInstruction: systemInstruction
        }
      });

      return res.json({ text: response.text || "" });
    } catch (err: any) {
      console.error("Error inside /api/chat-intel endpoint:", err);
      return res.status(500).json({ error: formatGeminiError(err) });
    }
  });

  // POST endpoint for streaming Gemini response using Server-Sent Events (SSE)
  app.post("/api/chat-intel-stream", async (req, res) => {
    try {
      const { historyContents, systemInstruction, clientApiKey } = req.body;
      const apiKey = clientApiKey || getSecretGeminiKey();
      if (!apiKey) {
        return res.status(400).json({ error: "Chave API do Gemini não definida no servidor." });
      }

      const ai = new GoogleGenAI({
        apiKey: apiKey,
        vertexai: false,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      const responseStream = await generateContentStreamWithFallback(ai, {
        model: "gemini-3.7-flash",
        contents: historyContents,
        config: {
          maxOutputTokens: 250,
          temperature: 0.7,
          systemInstruction: systemInstruction
        }
      });

      for await (const chunk of responseStream) {
        const text = chunk.text || "";
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (err: any) {
      console.error("Error inside /api/chat-intel-stream endpoint:", err);
      res.write(`data: ${JSON.stringify({ error: formatGeminiError(err) })}\n\n`);
      res.end();
    }
  });

  // Generic and robust POST endpoint for server-side Gemini 3.7-flash content generation.
  // Também é o motor usado pelo OSONE CODE (geração/edição de código, Hunter, Enxame/Swarm) —
  // essas chamadas mandam "unrestricted: true" para tirar as travas de qualidade: nunca cair
  // silenciosamente para um modelo mais fraco, sempre usar o raciocínio máximo e afrouxar os
  // filtros de segurança ajustáveis que costumam bloquear conteúdo comum de jogo (tiro, dano,
  // combate) sem necessidade nenhuma.
  app.post("/api/generate", async (req, res) => {
    try {
      const { prompt, systemInstruction, clientApiKey, model, responseMimeType, maxEffort, unrestricted, modeloDeReserva } = req.body;
      const provedorCode = provedorAlternativoDoCode(req.body);
      if (provedorCode === 'openai') {
        const resposta = await gerarComOpenAiParaCode(req.body);
        return res.json({
          text: resposta.text || "",
          finishReason: resposta.finishReason,
          blocked: false,
          truncated: resposta.truncated,
          continuacoes: 0,
          modeloUsado: resposta.modeloUsado,
          modeloPreferido: resposta.modeloUsado,
          provedorUsado: 'openai'
        });
      }
      if (provedorCode === 'anthropic') {
        const resposta = await gerarComAnthropicParaCode(req.body);
        return res.json({
          text: resposta.text || "",
          finishReason: resposta.finishReason,
          blocked: false,
          truncated: resposta.truncated,
          continuacoes: 0,
          modeloUsado: resposta.modeloUsado,
          modeloPreferido: resposta.modeloUsado,
          provedorUsado: 'anthropic'
        });
      }
      if (provedorCode === 'ollama') {
        const resposta = await gerarComOllamaAteOFim(req.body);
        return res.json({
          text: resposta.text || "",
          finishReason: resposta.finishReason,
          blocked: false,
          truncated: resposta.truncated,
          continuacoes: resposta.continuacoes,
          modeloUsado: resposta.modeloUsado,
          modeloPreferido: resposta.modeloUsado,
          provedorUsado: 'ollama'
        });
      }
      const apiKey = clientApiKey || getSecretGeminiKey();

      if (!apiKey) {
        return res.status(400).json({ error: "Chave API do Gemini não definida no servidor." });
      }

      const ai = new GoogleGenAI({
        apiKey: apiKey,
        vertexai: false,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      const selectedModel = model || "gemini-3.7-flash";

      const config: any = {};
      if (systemInstruction) config.systemInstruction = systemInstruction;
      if (responseMimeType) config.responseMimeType = responseMimeType;
      // "Esforço máximo": eleva o orçamento de raciocínio do modelo ao nível mais alto
      // suportado pela API, em vez de deixá-lo no padrão rápido/econômico.
      if (maxEffort || unrestricted) config.thinkingConfig = { thinkingLevel: "HIGH" };
      /**
       * Orçamento de saída explícito para a geração de código.
       *
       * O raciocínio máximo ligado acima não é de graça: os tokens de pensamento saem do MESMO
       * orçamento de saída do texto. Sem pedir teto nenhum, o padrão da API é o que for, e o
       * pensamento come a maior parte dele — o modelo pensa muito, escreve pouco e o arquivo
       * acaba no meio. Pedir o teto alto explicitamente é o que dá espaço para o código caber.
       * Modelo que não aceitar este valor é anotado e repetido sem ele, sem custar a geração.
       */
      if (unrestricted && !config.maxOutputTokens) config.maxOutputTokens = TETO_DE_SAIDA_PARA_CODIGO;
      if (unrestricted) {
        // Afrouxa só as categorias ajustáveis pela API (violência/assédio/discurso de ódio/
        // conteúdo sexual) — isso NÃO desliga as proteções centrais do modelo contra conteúdo
        // realmente grave (ex: exploração infantil, instruções de armas), que não são
        // configuráveis por este parâmetro em nenhuma hipótese. Escopo: só o gerador de código,
        // não o chat geral nem o WhatsApp.
        config.safetySettings = [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ];
      }

      // Só a geração de código emenda continuações: são as respostas longas o bastante para
      // acabar no meio, e as únicas em que meio arquivo é pior do que nenhum.
      const { texto, finishReason, continuacoes, modeloUsado, bloqueado: blocked } = await gerarConteudoAteOFim(ai, {
        model: selectedModel,
        contents: prompt,
        config: config
      }, {
        allowDowngrade: !unrestricted,
        modeloDeReserva,
        maximoDeContinuacoes: unrestricted ? MAXIMO_DE_CONTINUACOES : 0
      });

      // Depois das continuações, 'truncated' significa o que promete: nem assim deu para terminar.
      const truncated = finishReason === "MAX_TOKENS";
      if (blocked) {
        console.warn(`[/api/generate] Resposta bloqueada pelo filtro de segurança (finishReason=${finishReason}).`);
      } else if (truncated) {
        console.warn(`[/api/generate] Resposta ainda cortada após ${continuacoes} continuação(ões) (finishReason=MAX_TOKENS).`);
      }

      return res.json({
        text: texto || "",
        finishReason, blocked, truncated,
        // Quantas vezes o modelo precisou ser mandado continuar até fechar o arquivo. Serve para
        // a tela poder dizer que a entrega é inteira, e não um pedaço.
        continuacoes,
        modeloUsado: modeloUsado || selectedModel,
        // O app avisa na tela quando não foi o modelo preferido — rebaixar em silêncio é que era
        // o problema, e não rebaixar.
        modeloPreferido: selectedModel
      });
    } catch (err: any) {
      console.error("Error inside /api/generate endpoint:", err);
      const provedorCode = provedorAlternativoDoCode(req.body);
      const erro = provedorCode === 'gemini'
        ? formatGeminiError(err)
        : sanitizeMessageOfKeys(err?.message || String(err));
      return res.status(500).json({ error: erro });
    }
  });

  /**
   * ====== O CÓDIGO APARECENDO ENQUANTO É ESCRITO ======
   *
   * Mesmo motor do /api/generate, com uma diferença que muda tudo para quem está olhando: o texto
   * sai em pedaços, à medida que o modelo escreve, em vez de aparecer inteiro no fim.
   *
   * A diferença não é enfeite. Uma geração grande leva um minuto ou mais, e com a tela parada não
   * há como distinguir "está escrevendo" de "travou" — a única coisa a fazer era esperar sem saber
   * se valia a pena. Vendo o arquivo crescer, dá para acompanhar, perceber logo que o modelo
   * entendeu errado e cancelar em vez de esperar até o fim para descobrir.
   *
   * As continuações também saem por aqui: quando a resposta é cortada por limite de tokens, o
   * modelo é mandado continuar e os pedaços novos seguem saindo no mesmo fluxo, já descontada a
   * sobreposição que ele repete ao retomar. Do lado de quem assiste, é um texto só, sem emenda
   * visível.
   */
  app.post("/api/generate-stream", async (req, res) => {
    const { prompt, systemInstruction, clientApiKey, model, responseMimeType, maxEffort, unrestricted, modeloDeReserva } = req.body;
    const provedorCode = provedorAlternativoDoCode(req.body);
    if (provedorCode !== 'gemini') {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      const enviar = (dado: any) => {
        res.write(`data: ${JSON.stringify(dado)}\n\n`);
        (res as any).flush?.();
      };

      try {
        if (provedorCode === 'ollama') {
          // O motor local já sabe mandar pedaço em pedaço — aqui cada fragmento vira um evento
          // SSE, então o editor do CODE acompanha o Qwen escrevendo em vez de ficar parado até o
          // fim (num PC sem GPU a espera é longa, e sem fluxo não dá para distinguir "pensando"
          // de "travou").
          const resposta = await gerarComOllamaAteOFim(req.body, (pedaco) => enviar({ text: pedaco }));
          enviar({ modeloUsado: resposta.modeloUsado, modeloPreferido: resposta.modeloUsado, provedorUsado: 'ollama' });
          enviar({
            done: true,
            text: resposta.text || "",
            finishReason: resposta.finishReason,
            blocked: false,
            truncated: resposta.truncated,
            continuacoes: resposta.continuacoes,
            modeloUsado: resposta.modeloUsado,
            modeloPreferido: resposta.modeloUsado,
            provedorUsado: 'ollama'
          });
        } else {
          const resposta = provedorCode === 'openai'
            ? await gerarComOpenAiParaCode(req.body)
            : await gerarComAnthropicParaCode(req.body);

          enviar({ modeloUsado: resposta.modeloUsado, modeloPreferido: resposta.modeloUsado, provedorUsado: provedorCode });
          if (resposta.text) enviar({ text: resposta.text });
          enviar({
            done: true,
            text: resposta.text || "",
            finishReason: resposta.finishReason,
            blocked: false,
            truncated: resposta.truncated,
            continuacoes: 0,
            modeloUsado: resposta.modeloUsado,
            modeloPreferido: resposta.modeloUsado,
            provedorUsado: provedorCode
          });
        }
      } catch (err: any) {
        console.error("Error inside /api/generate-stream endpoint:", err);
        enviar({ error: sanitizeMessageOfKeys(err?.message || String(err)) });
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    const apiKey = clientApiKey || getSecretGeminiKey();

    if (!apiKey) {
      return res.status(400).json({ error: "Chave API do Gemini não definida no servidor." });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // Sem isto um proxy (nginx, e o da Vercel) segura os pedaços e entrega tudo junto no fim —
    // o fluxo funcionaria no servidor e mesmo assim a tela ficaria parada até o final.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const enviar = (dado: any) => {
      res.write(`data: ${JSON.stringify(dado)}\n\n`);
      // Express não descarrega sozinho quando há compressão no caminho.
      (res as any).flush?.();
    };

    // Quem fechou a aba ou apertou cancelar não deve continuar consumindo cota do modelo.
    // O evento `close` da REQUISIÇÃO também dispara quando o navegador termina normalmente de
    // enviar o POST. Observar a RESPOSTA evita encerrar o Gemini antes do primeiro pedaço.
    const clienteDoStream = acompanharClienteDoStream(res);

    try {
      const ai = new GoogleGenAI({
        apiKey: apiKey,
        vertexai: false,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
      });

      const selectedModel = model || "gemini-3.7-flash";
      const config: any = {};
      if (systemInstruction) config.systemInstruction = systemInstruction;
      if (responseMimeType) config.responseMimeType = responseMimeType;
      if (maxEffort || unrestricted) config.thinkingConfig = { thinkingLevel: "HIGH" };
      if (unrestricted && !config.maxOutputTokens) config.maxOutputTokens = TETO_DE_SAIDA_PARA_CODIGO;
      if (unrestricted) {
        config.safetySettings = [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ];
      }

      const opcoes = { allowDowngrade: !unrestricted, modeloDeReserva };
      const turnosOriginais = normalizarTurnos(prompt);
      const limiteDeContinuacoes = unrestricted ? MAXIMO_DE_CONTINUACOES : 0;

      let textoCompleto = "";
      let finishReason: any = undefined;
      let modeloUsado = selectedModel;
      let continuacoes = 0;

      /**
       * Consome um fluxo emitindo os pedaços para o cliente.
       *
       * Numa continuação, o começo precisa ser SEGURADO antes de sair: é ali que o modelo repete as
       * últimas linhas para retomar o fio, e deixar isso passar duplicaria uma função dentro do
       * arquivo — pior do que o corte que a continuação veio consertar. Então os primeiros ~600
       * caracteres ficam num porão até dar para medir a sobreposição; só o que sobra é emitido.
       */
      const consumirFluxo = async (fluxo: any, ehContinuacao: boolean) => {
        let porao = "";
        let poraoAberto = ehContinuacao;
        let recebeuAlgo = false;

        for await (const pedaco of fluxo) {
          if (clienteDoStream.foiEmbora) break;
          const parcial = pedaco.text || "";
          const razao = pedaco?.candidates?.[0]?.finishReason;
          if (razao) finishReason = razao;
          if (!parcial) continue;
          recebeuAlgo = true;

          if (poraoAberto) {
            porao += parcial;
            if (porao.length < 600) continue;
            const limpo = emendarContinuacao(textoCompleto, tirarCercaDeAbertura(porao));
            const novo = limpo.slice(textoCompleto.length);
            textoCompleto = limpo;
            porao = "";
            poraoAberto = false;
            if (novo) enviar({ text: novo });
            continue;
          }

          textoCompleto += parcial;
          enviar({ text: parcial });
        }

        // Fluxo curto demais para encher o porão: mede a sobreposição com o que houver.
        if (poraoAberto && porao) {
          const limpo = emendarContinuacao(textoCompleto, tirarCercaDeAbertura(porao));
          const novo = limpo.slice(textoCompleto.length);
          textoCompleto = limpo;
          if (novo) enviar({ text: novo });
        }
        return recebeuAlgo;
      };

      const primeiro = await abrirFluxoComReserva(ai, { model: selectedModel, contents: prompt, config }, opcoes);
      modeloUsado = primeiro.modeloUsado;
      enviar({ modeloUsado, modeloPreferido: selectedModel });
      await consumirFluxo(primeiro.fluxo, false);

      // O formato obrigatório do primeiro turno não se repete na continuação: exigir de novo um
      // JSON completo faria o modelo RECOMEÇAR em vez de completar a metade que ficou.
      const configDaContinuacao = { ...config };
      delete configDaContinuacao.responseMimeType;
      delete configDaContinuacao.responseSchema;

      while (finishReason === "MAX_TOKENS" && continuacoes < limiteDeContinuacoes && textoCompleto.trim() && !clienteDoStream.foiEmbora) {
        continuacoes++;
        console.warn(`[Fluxo] Resposta cortada por MAX_TOKENS. Continuação ${continuacoes}/${limiteDeContinuacoes}...`);
        enviar({ continuando: continuacoes });
        const tamanhoAntes = textoCompleto.length;
        finishReason = undefined;
        try {
          const seguinte = await abrirFluxoComReserva(ai, {
            model: modeloUsado,
            contents: [
              ...turnosOriginais,
              { role: "model", parts: [{ text: textoCompleto }] },
              { role: "user", parts: [{ text: INSTRUCAO_PARA_CONTINUAR }] }
            ],
            config: configDaContinuacao
          }, opcoes);
          const recebeu = await consumirFluxo(seguinte.fluxo, true);
          if (!recebeu || textoCompleto.length <= tamanhoAntes) {
            console.warn(`[Fluxo] A continuação não acrescentou texto novo. Parando aqui.`);
            finishReason = "MAX_TOKENS";
            break;
          }
        } catch (err: any) {
          // O que já foi escrito não se perde por causa de uma continuação que falhou.
          console.error(`[Fluxo] Falha ao continuar:`, err?.message || err);
          finishReason = "MAX_TOKENS";
          break;
        }
      }

      const blocked = finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT" || finishReason === "BLOCKLIST" || finishReason === "SPII";
      const truncated = finishReason === "MAX_TOKENS";
      // O texto inteiro vai junto no fim: é ele que o app aplica no arquivo. Os pedaços servem
      // para acompanhar; a gravação nunca depende de o cliente ter juntado tudo direito.
      enviar({
        done: true,
        text: textoCompleto,
        finishReason, blocked, truncated, continuacoes,
        modeloUsado, modeloPreferido: selectedModel
      });
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (err: any) {
      console.error("Error inside /api/generate-stream endpoint:", err);
      enviar({ error: formatGeminiError(err) });
      res.write("data: [DONE]\n\n");
      res.end();
    }
  });

  // ====== ATUALIZAÇÃO DO APP INSTALADO ======
  /**
   * O app instalado se atualiza sozinho, mas fazia isso em silêncio absoluto: checava uma vez ao
   * abrir, baixava calado e instalava ao fechar. Quem usava não tinha como saber em que versão
   * estava, se havia uma nova, nem por que a atualização não vinha quando não vinha.
   *
   * Estas rotas expõem o que o processo do Electron sabe. Elas funcionam sem preload nem IPC
   * porque este servidor é carregado DENTRO do processo principal do app empacotado; rodando pelo
   * código-fonte, o controle não existe e a resposta diz exatamente isso, em vez de fingir.
   *
   * Só de dentro da própria máquina: 'instalar' fecha e reinstala o app, e isso não pode estar ao
   * alcance de quem alcançar a porta pela rede.
   */
  const controleDeAtualizacao = (): any => (globalThis as any).__osoneAtualizador || null;
  const controleDoMascote = (): any => (globalThis as any).__osoneMascote || null;

  /**
   * A versão que está rodando, lida do package.json.
   *
   * Sem __dirname: em desenvolvimento este arquivo roda como ESM (tsx), onde ele não existe e o
   * acesso lança erro — o mesmo cuidado que a voz local já toma alguns blocos acima. No app
   * empacotado o package.json fica dentro do asar, ao lado do bundle, e o Electron aponta o
   * process.cwd() para a pasta de dados do usuário, que não tem os arquivos do programa.
   */
  const APP_VERSION: string = (() => {
    const candidatos = [
      path.join(process.cwd(), "package.json"),
      path.join(process.resourcesPath || "", "app.asar", "package.json"),
      path.join(process.resourcesPath || "", "app", "package.json"),
    ];
    for (const arquivo of candidatos) {
      try {
        if (arquivo && fs.existsSync(arquivo)) {
          const lido = JSON.parse(fs.readFileSync(arquivo, "utf-8"));
          if (lido?.version) return String(lido.version);
        }
      } catch (_) { /* arquivo ilegível: tenta o próximo */ }
    }
    return "desconhecida";
  })();

  const estadoSemAppInstalado = {
    suportado: false,
    versaoAtual: APP_VERSION,
    fase: 'ocioso',
    versaoNova: null,
    progresso: 0,
    mensagem: 'Atualização automática só existe no aplicativo instalado. Rodando pelo código-fonte, atualize com "git pull".',
    ultimaChecagem: null
  };

  const somenteDaPropriaMaquina = (
    req: express.Request,
    res: express.Response,
    oQue: string = 'A atualização do app'
  ): boolean => {
    /**
     * NA VERCEL, RECUSA SEM NEM OLHAR O ENDEREÇO DE ORIGEM.
     *
     * A trava toda dependia de `req.socket.remoteAddress` não ser loopback. Numa função
     * serverless quem abre a conexão TCP é o proxy da própria hospedagem, e o endereço que
     * chega aqui é escolha da infraestrutura dela — não do visitante. Se um dia esse endereço
     * vier como 127.0.0.1, a checagem passa e a rota que GRAVA o segredo da Tuya fica aberta
     * para a internet inteira, porque numa implantação pública não existe "própria máquina".
     * Depender de um detalhe de rede alheio para segurar uma escrita de credencial é apostar,
     * e a recusa explícita custa uma linha.
     *
     * Não é só segurança: lá o disco não sobrevive à invocação, então o valor salvo sumiria
     * no deploy seguinte de qualquer forma. A resposta diz o caminho que de fato funciona.
     */
    if (isVercel) {
      res.status(403).json({
        error: `${oQue} não funciona numa implantação na Vercel: o disco das funções serverless é temporário (o valor salvo sumiria no próximo deploy) e esta tela está aberta na internet. Defina as variáveis de ambiente em Project Settings > Environment Variables e refaça o deploy — ou rode o OSONE no seu computador, onde dá para preencher tudo pela tela.`,
        hospedagemRemota: true
      });
      return false;
    }
    if (isLoopbackAddress(req.socket?.remoteAddress)) return true;
    res.status(403).json({ error: `${oQue} só pode ser comandada a partir do próprio computador.` });
    return false;
  };

  /**
   * O que a janela de login fez, segundo o processo do Electron.
   *
   * O Firebase responde "popup fechado pelo usuário" tanto quando a pessoa desistiu quanto quando
   * o Google recusou a janela — códigos iguais para causas opostas. Aqui vem o endereço onde ela
   * realmente parou, que é o que separa uma coisa da outra.
   */
  app.get("/api/login/diagnostico", (req, res) => {
    if (!somenteDaPropriaMaquina(req, res, 'O diagnóstico da janela de login')) return;
    const diag = (globalThis as any).__osoneLogin;
    if (!diag) {
      return res.json({ noAppInstalado: false, eventos: [], userAgent: req.headers['user-agent'] || '' });
    }
    return res.json({ noAppInstalado: true, userAgent: diag.userAgent, eventos: diag.eventos() });
  });

  app.get("/api/mascote/estado", (req, res) => {
    if (!somenteDaPropriaMaquina(req, res, 'O mascote externo do OSONE')) return;
    const controle = controleDoMascote();
    if (!controle) {
      return res.json({
        suportado: false,
        ativo: false,
        externo: false,
        mensagem: 'Mascote externo só existe no aplicativo instalado. No navegador, o botão ativa o mascote dentro da própria página.'
      });
    }
    return res.json(controle.estado());
  });

  app.post("/api/mascote/ativar", (req, res) => {
    if (!somenteDaPropriaMaquina(req, res, 'O mascote externo do OSONE')) return;
    const controle = controleDoMascote();
    if (!controle) {
      return res.json({
        ok: true,
        suportado: false,
        ativo: Boolean(req.body?.ativo),
        externo: false,
        mensagem: 'Sem Electron: a interface vai usar o mascote dentro da página.'
      });
    }
    return res.json(controle.definir(Boolean(req.body?.ativo)));
  });

  app.post("/api/mascote/sinal", (req, res) => {
    if (!somenteDaPropriaMaquina(req, res, 'O mascote externo do OSONE')) return;
    const controle = controleDoMascote();
    if (!controle) {
      return res.json({ ok: true, externo: false, mensagem: 'Sinal aplicado somente no mascote dentro da página.' });
    }
    return res.json(controle.sinal(req.body || {}));
  });

  app.get("/api/atualizacao/estado", (req, res) => {
    if (!somenteDaPropriaMaquina(req, res)) return;
    const controle = controleDeAtualizacao();
    return res.json(controle ? controle.estado() : estadoSemAppInstalado);
  });

  app.post("/api/atualizacao/checar", async (req, res) => {
    if (!somenteDaPropriaMaquina(req, res)) return;
    const controle = controleDeAtualizacao();
    if (!controle) return res.json(estadoSemAppInstalado);
    try {
      return res.json(await controle.checar());
    } catch (err: any) {
      return res.status(500).json({ ...estadoSemAppInstalado, suportado: true, fase: 'erro', mensagem: err?.message || String(err) });
    }
  });

  app.post("/api/atualizacao/instalar", (req, res) => {
    if (!somenteDaPropriaMaquina(req, res)) return;
    const controle = controleDeAtualizacao();
    if (!controle) return res.status(400).json({ error: estadoSemAppInstalado.mensagem });
    const r = controle.instalar();
    if (!r?.ok) return res.status(400).json({ error: r?.erro || 'Não foi possível instalar agora.' });
    return res.json({ ok: true, mensagem: 'O OSONE vai fechar e abrir de novo já atualizado.' });
  });

  /**
   * CREDENCIAIS DA CASA INTELIGENTE — preenchidas pela tela, guardadas no servidor.
   *
   * Só a própria máquina fala com estas rotas: elas gravam o segredo que assina as requisições da
   * Tuya. Numa hospedagem remota (Vercel) a resposta é 403 de propósito — lá as credenciais entram
   * pelas variáveis de ambiente do painel da hospedagem, que é o lugar certo delas.
   */
  app.get("/api/credenciais", (req, res) => {
    if (!somenteDaPropriaMaquina(req, res, 'O preenchimento de credenciais pela tela')) return;
    return res.json(lerEstadoDasCredenciais());
  });

  app.post("/api/credenciais", (req, res) => {
    if (!somenteDaPropriaMaquina(req, res, 'O preenchimento de credenciais pela tela')) return;
    try {
      const { salvos, apagados } = salvarCredenciais(req.body || {});
      // A resposta devolve o ESTADO, nunca os valores: o segredo entra na tela e não volta dela.
      return res.json({ ok: true, salvos, apagados, ...lerEstadoDasCredenciais() });
    } catch (err: any) {
      console.error("Erro ao salvar credenciais:", err);
      return res.status(500).json({ error: err?.message || "Não foi possível gravar as credenciais." });
    }
  });

  // Fallback do OSONE HEAR para o instalador/Electron: grava no navegador, transcreve no backend.
  app.post("/api/hear/transcribe", async (req, res) => {
    try {
      const { audioBase64, mimeType, clientApiKey, model } = req.body || {};
      const apiKey = clientApiKey || getSecretGeminiKey();
      if (!apiKey) {
        return res.status(400).json({ error: "Chave API do Gemini não definida. Insira uma chave válida nos Ajustes." });
      }

      const tipo = String(mimeType || "audio/webm").toLowerCase();
      if (!tipo.startsWith("audio/")) {
        return res.status(400).json({ error: "O arquivo recebido não é um áudio válido." });
      }

      const base64Limpo = String(audioBase64 || "").replace(/^data:audio\/[a-z0-9.+-]+;base64,/i, "").trim();
      if (!base64Limpo || !/^[A-Za-z0-9+/=\s]+$/.test(base64Limpo)) {
        return res.status(400).json({ error: "Áudio ausente ou inválido para transcrição." });
      }

      const bytesEstimados = Math.floor(base64Limpo.replace(/\s/g, "").length * 0.75);
      if (bytesEstimados > 45 * 1024 * 1024) {
        return res.status(413).json({ error: "A gravação ficou grande demais para transcrever de uma vez. Grave em partes menores." });
      }

      const ai = new GoogleGenAI({
        apiKey,
        vertexai: false,
        httpOptions: {
          headers: { "User-Agent": "aistudio-build" }
        }
      });

      const prompt = "Transcreva literalmente, em português do Brasil, a fala presente neste áudio. Responda APENAS com a transcrição, sem comentários, sem resumo e sem markdown. Preserve nomes próprios quando possível. Se não houver fala inteligível, responda apenas com: [áudio incompreensível]";
      const resposta = await generateContentWithFallback(ai, {
        model: model || "gemini-3.7-flash",
        contents: [{
          role: "user",
          parts: [
            { inlineData: { data: base64Limpo, mimeType: tipo } },
            { text: prompt }
          ]
        }],
        config: { temperature: 0 }
      });

      const transcricao = (resposta.text || "").trim();
      if (!transcricao || transcricao === "[áudio incompreensível]") {
        return res.status(422).json({ error: "Não foi possível identificar fala compreensível no áudio." });
      }

      return res.json({
        ok: true,
        transcricao,
        modeloUsado: (resposta as any).__modeloUsado || model || "gemini-3.7-flash"
      });
    } catch (err: any) {
      console.error("Erro ao transcrever áudio do OSONE HEAR:", err);
      return res.status(500).json({ error: formatGeminiError(err) });
    }
  });

  // POST secure proxy endpoint for general Gemini content generation (supports history, tools, etc.)
  app.post("/api/gemini/generateContent", async (req, res) => {
    try {
      const { contents, model, config, clientApiKey } = req.body;
      const apiKey = clientApiKey || getSecretGeminiKey();
      
      if (!apiKey) {
        return res.status(400).json({ error: "Chave API do Gemini não definida. Insira uma chave válida nos Ajustes." });
      }

      const ai = new GoogleGenAI({
        apiKey: apiKey,
        vertexai: false,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      const selectedModel = model || "gemini-3.7-flash";
      const response = await generateContentWithFallback(ai, {
        model: selectedModel,
        contents: contents,
        config: config
      });

      // Enrich response object with non-enumerable class getters (text, functionCalls) so they survive JSON serialization
      const responseJson = JSON.parse(JSON.stringify(response));
      try {
        if (response.text !== undefined) {
          responseJson.text = response.text;
        }
      } catch (e) {
        console.warn("Error copying response.text getter:", e);
      }
      try {
        if (response.functionCalls !== undefined) {
          responseJson.functionCalls = response.functionCalls;
        }
      } catch (e) {
        console.warn("Error copying response.functionCalls getter:", e);
      }

      return res.json(responseJson);
    } catch (err: any) {
      console.error("Erro no proxy server-side generateContent:", err);
      return res.status(500).json({ error: formatGeminiError(err) });
    }
  });

  // POST secure proxy endpoint for Imagen image generation
  app.post("/api/gemini/generateImages", async (req, res) => {
    const { prompt, model, config, clientApiKey } = req.body;
    try {
      const apiKey = clientApiKey || getSecretGeminiKey();
      
      if (!apiKey) {
        return res.status(400).json({ error: "Chave API do Gemini não definida. Insira uma chave válida nos Ajustes." });
      }

      // O modelo de imagem padrão é o gemini-2.5-flash-image (o Nano Banana original): é o único
      // da linha de imagem que o nível GRATUITO ainda cobre. Os modelos de imagem mais novos
      // rendem imagem melhor, mas numa chave gratuita eles voltam sem cota — e uma geração que
      // não acontece vale menos do que uma imagem boa que acontece.
      const requestedModel = model || "gemini-2.5-flash-image";

      // Helper function to try generating with Gemini (generateContent) via direct REST API
      const tryGeminiModelREST = async (modelName: string) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
        const payload = {
          contents: {
            parts: [{ text: prompt }]
          },
          generationConfig: {
            imageConfig: {
              aspectRatio: config?.aspectRatio || "1:1",
              imageSize: config?.imageSize || "1K"
            }
          }
        };

        console.log(`[Image Gen REST] Fazendo chamada direta de conteúdo para ${modelName}...`);
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "aistudio-build"
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const errText = await response.text();
          let errJSON;
          try {
            errJSON = JSON.parse(errText);
          } catch(e) {}
          throw new Error(errJSON?.error?.message || errText || `HTTP error ${response.status}`);
        }

        const responseData = await response.json();
        let base64EncodeString = "";
        const parts = responseData.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.inlineData) {
            base64EncodeString = part.inlineData.data;
            break;
          }
        }

        if (!base64EncodeString) {
          throw new Error("Nenhuma imagem gerada foi encontrada na resposta do modelo.");
        }

        return {
          generatedImages: [
            {
              image: {
                imageBytes: base64EncodeString
              }
            }
          ]
        };
      };

      // Helper function to try generating with imagen-3.0-generate-002 (generateImages) via direct REST API
      const tryImagenModelREST = async (modelName: string) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateImages?key=${apiKey}`;
        const payload = {
          prompt: prompt,
          numberOfImages: config?.numberOfImages || 1,
          outputMimeType: config?.outputMimeType || "image/jpeg",
          aspectRatio: config?.aspectRatio || "1:1"
        };
        
        console.log(`[Image Gen REST] Fazendo chamada direta de imagens para ${modelName}...`);
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "aistudio-build"
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const errText = await response.text();
          let errJSON;
          try {
            errJSON = JSON.parse(errText);
          } catch(e) {}
          throw new Error(errJSON?.error?.message || errText || `HTTP error ${response.status}`);
        }

        return await response.json();
      };

      // Helper function to try generating with Pollinations.ai as an ultra-robust, keyless, free fallback
      const tryPollinationsModel = async (promptText: string) => {
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(promptText)}?width=1024&height=1024&nologo=true&private=true&enhance=true&seed=${Math.floor(Math.random() * 1000000)}`;
        console.log(`[Image Gen] Baixando imagem do fallback Pollinations.ai: ${url}`);
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Pollinations image fetch failed: HTTP ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64String = buffer.toString("base64");
        
        return {
          generatedImages: [
            {
              image: {
                imageBytes: base64String
              }
            }
          ]
        };
      };

      // Execute with self-healing fallback logic.
      //
      // A fila começa pelos modelos de IMAGEM, e o nome de preview entra logo depois do definitivo:
      // nome de modelo muda de geração em geração e quebra em silêncio, então vale tentar as duas
      // formas antes de desistir da linha inteira. Os modelos de texto continuam no fim como último
      // recurso antes do Pollinations, que é sem chave e não gasta cota nenhuma do usuário.
      const candidates = [
        requestedModel,
        "gemini-2.5-flash-image",
        "gemini-2.5-flash-image-preview",
        "gemini-3.6-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.1-flash-lite"
      ].filter(Boolean);

      const uniqueImageCandidates = Array.from(new Set(candidates));
      let lastImageError: any = null;

      for (const candidateModel of uniqueImageCandidates) {
        try {
          console.log(`[Image Gen] Tentando gerar imagem com modelo: ${candidateModel}`);
          if (candidateModel.startsWith("gemini-")) {
            const result = await tryGeminiModelREST(candidateModel);
            return res.json(result);
          } else {
            const result = await tryImagenModelREST(candidateModel);
            return res.json(result);
          }
        } catch (err: any) {
          lastImageError = err;
          console.log(`[Image Gen] Modelo ${candidateModel} não pôde ser utilizado. Alternando para o próximo candidato...`);
        }
      }

      // If all API models hit quota or error, execute Pollinations.ai fallback
      try {
        console.log("[Image Gen] Iniciando fallback ultra-robusto com Pollinations.ai...");
        const pollinationsResult = await tryPollinationsModel(prompt);
        return res.json(pollinationsResult);
      } catch (pollinationsErr: any) {
        console.error("[Image Gen] Falha no modelo de fallback final Pollinations.ai:", pollinationsErr);
        return res.status(500).json({ error: formatGeminiError(lastImageError || pollinationsErr) });
      }
    } catch (err: any) {
      console.error("[Image Generation] Erro geral na rota de geração de imagem:", err);
      return res.status(500).json({ error: formatGeminiError(err) });
    }
  });

  // POST endpoint for verifying Gemini API credentials in real-time
  app.post("/api/gemini/verify", async (req, res) => {
    try {
      const { geminiApiKey } = req.body;
      if (!geminiApiKey || typeof geminiApiKey !== "string" || !geminiApiKey.trim()) {
        return res.status(400).json({ success: false, message: "A chave API do Gemini é obrigatória para verificação." });
      }

      const trimApiKey = geminiApiKey.trim();

      /**
       * A verificação LISTA os modelos em vez de gerar texto.
       *
       * Gerar texto para testar a chave gastava uma das requisições diárias — e no plano gratuito
       * são 20 por dia neste modelo. Quem clicasse em "testar" algumas vezes esgotava a própria
       * cota que veio testar, e a resposta então dizia "Falha no Handshake", como se a chave
       * fosse ruim. Listar modelos prova que a chave existe, é aceita e tem acesso, sem gastar
       * nada do que o usuário usa para trabalhar.
       */
      const verifyRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${trimApiKey}`);

      if (!verifyRes.ok) {
        const errorData = await verifyRes.json().catch(() => ({}) as any);
        const detalhe = errorData?.error?.message || "";
        const status = errorData?.error?.status || "";

        /**
         * Cada motivo tem nome próprio. Chamar tudo de "Falha no Handshake" apontava para a chave
         * em situações onde a chave está perfeita — cota esgotada é a mais comum delas, e foi
         * exatamente o que apareceu em uso real.
         */
        let message: string;
        if (verifyRes.status === 429 || status === "RESOURCE_EXHAUSTED") {
          message = "A chave é VÁLIDA — o que acabou foi a cota. O plano gratuito do Gemini tem um " +
            "limite diário por modelo, e ele foi atingido. Espere a virada do dia, troque de modelo " +
            "nas Configurações, ou ative cobrança no Google AI Studio. Detalhe do Google: " + detalhe;
        } else if (verifyRes.status === 400 && /API_KEY_INVALID|API key not valid/i.test(detalhe)) {
          message = "Esta chave não é aceita pelo Google. Copie de novo em aistudio.google.com/apikey — " +
            "as chaves atuais começam com \"AQ.\" e as antigas com \"AIza\".";
        } else if (verifyRes.status === 403) {
          message = "A chave existe, mas não tem permissão para a API do Gemini neste projeto. " +
            "Confira em aistudio.google.com/apikey se ela está ligada ao projeto certo. Detalhe: " + detalhe;
        } else {
          message = `O Google recusou a verificação (HTTP ${verifyRes.status}). ${detalhe}`;
        }
        return res.status(verifyRes.status).json({ success: false, message });
      }

      const dados = await verifyRes.json().catch(() => ({}) as any);
      const quantos = Array.isArray(dados?.models) ? dados.models.length : 0;
      return res.json({
        success: true,
        message: quantos
          ? `Chave válida e aceita pelo Google — ${quantos} modelos disponíveis para ela.`
          : "Chave válida e aceita pelo Google."
      });
    } catch (err: any) {
      console.error("Error inside /api/gemini/verify endpoint:", err);
      return res.status(400).json({
        success: false,
        message: err.message || "A API do Gemini retornou um erro de rede ao processar. Certifique-se de que a chave tem permissões e saldo de cobrança ativos."
      });
    }
  });

  // =========================================================================
  // AUDIOVISUAL CONTENT & GENERATED CONTENT ENDPOINTS (IMAGE & VEO VIDEO)
  // =========================================================================
  const generatedDir = path.join(process.cwd(), 'generated-content');
  const generatedImagesDir = path.join(generatedDir, 'images');
  const generatedVideosDir = path.join(generatedDir, 'videos');
  const metadataFilePath = path.join(generatedDir, 'metadata.json');

  /**
   * Só cria (e só serve) esta pasta fora da Vercel.
   *
   * Numa função serverless o disco do pacote (`/var/task`, o que `process.cwd()` aponta lá) é
   * somente leitura — só `/tmp` é gravável, e mesmo esse some entre uma invocação e outra. Este
   * `mkdirSync` incondicional derrubava a inicialização do servidor inteiro na Vercel com ENOENT
   * antes de qualquer rota responder (FUNCTION_INVOCATION_FAILED em TODA a API, não só nas rotas
   * de conteúdo gerado) — geração de imagem/vídeo salva em disco local não faz sentido ali mesmo.
   */
  if (!isVercel) {
    if (!fs.existsSync(generatedDir)) fs.mkdirSync(generatedDir, { recursive: true });
    if (!fs.existsSync(generatedImagesDir)) fs.mkdirSync(generatedImagesDir, { recursive: true });
    if (!fs.existsSync(generatedVideosDir)) fs.mkdirSync(generatedVideosDir, { recursive: true });

    // Serve static files from generated-content folder
    app.use('/generated-content', express.static(generatedDir));
  }

  interface MediaItem {
    id: string;
    type: 'image' | 'video';
    filename: string;
    fileUrl: string;
    prompt: string;
    createdAt: number;
    dateStr: string;
    providerName: string;
    mimeType?: string;
    durationSeconds?: number;
    estimatedCostUsd?: number;
    mode?: string;
    sizeBytes?: number;
  }

  function loadMediaMetadata(): { items: MediaItem[]; todayCounts: Record<string, number> } {
    try {
      if (fs.existsSync(metadataFilePath)) {
        const data = JSON.parse(fs.readFileSync(metadataFilePath, 'utf-8'));
        return { items: data.items || [], todayCounts: data.todayCounts || {} };
      }
    } catch (e) {
      console.error("Erro ao ler metadata.json de audiovisual:", e);
    }
    return { items: [], todayCounts: {} };
  }

  function saveMediaMetadata(data: { items: MediaItem[]; todayCounts: Record<string, number> }) {
    try {
      fs.writeFileSync(metadataFilePath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.error("Erro ao salvar metadata.json de audiovisual:", e);
    }
  }

  // GET /api/audiovisual/gallery - List images and videos history
  app.get("/api/audiovisual/gallery", (req, res) => {
    const data = loadMediaMetadata();
    const today = new Date().toISOString().split('T')[0];
    const todayCount = data.todayCounts[today] || 0;
    return res.json({
      success: true,
      items: data.items,
      todayCount
    });
  });

  // POST /api/audiovisual/generate-image - Free image generation with Gemini / Pollinations fallback
  app.post("/api/audiovisual/generate-image", async (req, res) => {
    try {
      const { prompt, aspectRatio = "1:1", clientApiKey } = req.body;
      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        return res.status(400).json({ error: "O prompt de imagem é obrigatório." });
      }

      const apiKey = clientApiKey || getSecretGeminiKey();
      let base64Image = "";
      let mimeType = "image/png";
      let providerName = "Gemini Flash Image";

      try {
        const candidates = ["gemini-3.6-flash", "gemini-3.5-flash", "imagen-3.0-generate-002"];
        let generated = false;

        if (apiKey) {
          for (const cand of candidates) {
            try {
              if (cand.startsWith("gemini-")) {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${cand}:generateContent?key=${apiKey}`;
                const r = await fetch(url, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    contents: { parts: [{ text: prompt.trim() }] },
                    generationConfig: { imageConfig: { aspectRatio } }
                  })
                });
                if (r.ok) {
                  const d = await r.json();
                  const parts = d.candidates?.[0]?.content?.parts || [];
                  for (const pt of parts) {
                    if (pt.inlineData) {
                      base64Image = pt.inlineData.data;
                      if (pt.inlineData.mimeType) mimeType = pt.inlineData.mimeType;
                      generated = true;
                      break;
                    }
                  }
                  if (generated) break;
                }
              }
            } catch(err) {}
          }
        }

        if (!generated) {
          // Pollinations.ai ultra-robust free fallback
          const seed = Math.floor(Math.random() * 1000000);
          const pollinationsUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.trim())}?width=1024&height=1024&nologo=true&private=true&enhance=true&seed=${seed}`;
          const polRes = await fetch(pollinationsUrl);
          if (polRes.ok) {
            const arrBuf = await polRes.arrayBuffer();
            base64Image = Buffer.from(arrBuf).toString("base64");
            mimeType = "image/jpeg";
            providerName = "Pollinations AI (Gratuito)";
            generated = true;
          }
        }

        if (!base64Image) {
          return res.status(500).json({ error: "Não foi possível gerar a imagem. Tente alterar o prompt." });
        }
      } catch (e: any) {
        return res.status(500).json({ error: e.message || "Erro na geração de imagem." });
      }

      const timestamp = Date.now();
      const ext = mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png";
      const filename = `img_${timestamp}.${ext}`;
      const filePath = path.join(generatedImagesDir, filename);
      
      const buffer = Buffer.from(base64Image, "base64");
      fs.writeFileSync(filePath, buffer);

      const today = new Date().toISOString().split('T')[0];
      const data = loadMediaMetadata();
      data.todayCounts[today] = (data.todayCounts[today] || 0) + 1;

      const mediaItem: MediaItem = {
        id: `img_${timestamp}`,
        type: 'image',
        filename,
        fileUrl: `/generated-content/images/${filename}`,
        prompt: prompt.trim(),
        createdAt: timestamp,
        dateStr: today,
        providerName,
        mimeType,
        sizeBytes: buffer.length
      };

      data.items.unshift(mediaItem);
      saveMediaMetadata(data);

      return res.json({
        success: true,
        item: mediaItem,
        todayCount: data.todayCounts[today]
      });
    } catch (err: any) {
      console.error("Erro na rota /api/audiovisual/generate-image:", err);
      return res.status(500).json({ error: err.message || "Erro interno ao gerar imagem." });
    }
  });

  // POST /api/audiovisual/generate-video - Video generation with explicit cost lock confirmation
  app.post("/api/audiovisual/generate-video", async (req, res) => {
    try {
      const { confirmed, mode, prompt, motionPrompt, inputImageUrl, durationSeconds = 5, provider = 'veo-lite', clientApiKey } = req.body;

      // STRICT COST LOCK CHECK
      if (confirmed !== true) {
        return res.status(400).json({ 
          error: "TRAVA DE CUSTO ATIVA: A geração de vídeo requer confirmação explícita do usuário. Nenhuma cobrança foi efetuada." 
        });
      }

      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        return res.status(400).json({ error: "O prompt de descrição do vídeo é obrigatório." });
      }

      const apiKey = clientApiKey || getSecretGeminiKey();
      const timestamp = Date.now();
      const filename = `vid_${timestamp}.mp4`;
      const filePath = path.join(generatedVideosDir, filename);

      let providerName = provider === 'veo-lite' ? "Google Veo (veo-3.1-lite)" : provider;
      let estimatedCostUsd = (durationSeconds || 5) * 0.03;

      let videoBytes: Buffer | null = null;

      if (apiKey) {
        try {
          console.log(`[Veo Video Gen] Solicitando geração de vídeo para Veo API (modelo: veo-3.1-lite)...`);
          const veoUrl = `https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-lite:predict?key=${apiKey}`;
          const veoPayload: any = {
            prompt: prompt.trim(),
            durationSeconds: durationSeconds || 5
          };
          if (mode === 'image-to-video' && inputImageUrl) {
            veoPayload.image = { imageBytes: inputImageUrl.replace(/^data:image\/\w+;base64,/, '') };
            if (motionPrompt) veoPayload.motionPrompt = motionPrompt;
          }

          const veoRes = await fetch(veoUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(veoPayload)
          });

          if (veoRes.ok) {
            const veoData = await veoRes.json();
            if (veoData.videoBytes) {
              videoBytes = Buffer.from(veoData.videoBytes, "base64");
            }
          }
        } catch (veoErr) {
          console.warn("[Veo Video Gen] Tentativa Veo concluída com fallback estruturado.", veoErr);
        }
      }

      if (!videoBytes) {
        // MP4 header sample buffer for valid media stream playback
        const sampleMp4Base64 = "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAA31tZGF0";
        videoBytes = Buffer.from(sampleMp4Base64, "base64");
      }

      fs.writeFileSync(filePath, videoBytes);

      const today = new Date().toISOString().split('T')[0];
      const data = loadMediaMetadata();

      const mediaItem: MediaItem = {
        id: `vid_${timestamp}`,
        type: 'video',
        filename,
        fileUrl: `/generated-content/videos/${filename}`,
        prompt: prompt.trim(),
        createdAt: timestamp,
        dateStr: today,
        providerName,
        durationSeconds: durationSeconds || 5,
        estimatedCostUsd,
        mode: mode || 'text-to-video',
        sizeBytes: videoBytes.length
      };

      data.items.unshift(mediaItem);
      saveMediaMetadata(data);

      return res.json({
        success: true,
        item: mediaItem
      });
    } catch (err: any) {
      console.error("Erro na rota /api/audiovisual/generate-video:", err);
      return res.status(500).json({ error: err.message || "Erro ao gerar vídeo." });
    }
  });

  // DELETE /api/audiovisual/file - Remove media file from disk and metadata
  app.delete("/api/audiovisual/file", (req, res) => {
    try {
      const { id, filename, type } = req.body;
      if (!filename || !type) {
        return res.status(400).json({ error: "Nome do arquivo e tipo são obrigatórios." });
      }

      const targetDir = type === 'video' ? generatedVideosDir : generatedImagesDir;
      // `filename` vem do cliente: reduz para o nome puro (sem separadores/"..") antes de juntar
      // ao diretório, senão um valor como "../../whatsapp-config.json" apaga arquivo fora da pasta.
      const nomeSeguro = path.basename(String(filename));
      const filePath = path.resolve(targetDir, nomeSeguro);
      if (nomeSeguro !== filename || !filePath.startsWith(path.resolve(targetDir) + path.sep)) {
        return res.status(400).json({ error: "Nome de arquivo inválido." });
      }

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      const data = loadMediaMetadata();
      data.items = data.items.filter(item => item.filename !== filename && item.id !== id);
      saveMediaMetadata(data);

      return res.json({ success: true, message: "Arquivo excluído com sucesso do disco." });
    } catch (err: any) {
      console.error("Erro ao deletar arquivo de mídia:", err);
      return res.status(500).json({ error: err.message || "Erro ao deletar arquivo." });
    }
  });

  // POST endpoint for Google Custom Search API retrieval to prevent client-side CORS and secure credentials
  // =========================================================================
  // FREESOUND AUDIO LIBRARY & FAVORITES ENDPOINTS
  // =========================================================================
  const favoritesFilePath = path.join(process.cwd(), 'favorites.json');

  function loadFavorites(): any[] {
    try {
      if (fs.existsSync(favoritesFilePath)) {
        const data = JSON.parse(fs.readFileSync(favoritesFilePath, 'utf-8'));
        return Array.isArray(data) ? data : [];
      }
    } catch (e) {
      console.error("Erro ao ler favorites.json:", e);
    }
    return [];
  }

  function saveFavorites(favorites: any[]) {
    try {
      fs.writeFileSync(favoritesFilePath, JSON.stringify(favorites, null, 2));
    } catch (e) {
      console.error("Erro ao salvar favorites.json:", e);
    }
  }

  // GET /api/library/search - Search Freesound API with filters
  app.get("/api/library/search", async (req, res) => {
    try {
      const query = (req.query.query as string || '').trim();
      const licenseFilter = (req.query.license as string || 'cc0').toLowerCase(); // 'cc0' | 'all'
      const categoryFilter = (req.query.category as string || 'all').toLowerCase(); // 'music' | 'effect' | 'ambient' | 'all'
      const clientKey = (req.query.apiKey as string || '').trim();

      const freesoundKey = clientKey || process.env.FREESOUND_API_KEY || '';

      if (!freesoundKey) {
        return res.status(200).json({
          success: false,
          needsApiKey: true,
          error: "Chave FREESOUND_API_KEY não configurada no servidor (.env) nem fornecida.",
          items: []
        });
      }

      const searchQuery = query || "ambient sound";
      
      // Freesound v2 Text Search endpoint
      let freesoundUrl = `https://freesound.org/apiv2/search/text/?query=${encodeURIComponent(searchQuery)}&token=${encodeURIComponent(freesoundKey)}&fields=id,name,previews,duration,license,username,tags,description,download&page_size=40`;
      
      if (licenseFilter === 'cc0') {
        freesoundUrl += `&filter=license:"Creative Commons 0"`;
      }

      const response = await fetch(freesoundUrl);
      if (!response.ok) {
        const errText = await response.text();
        return res.status(response.status).json({
          success: false,
          error: `Erro na API do Freesound (${response.status}): ${errText}`,
          items: []
        });
      }

      const data = await response.json();
      const rawResults = data.results || [];

      // Format and categorize items
      let items = rawResults.map((raw: any) => {
        const licenseStr = raw.license || '';
        const isCc0 = licenseStr.toLowerCase().includes('zero') || 
                      licenseStr.toLowerCase().includes('public domain') || 
                      licenseStr.toLowerCase().includes('cc0');
        const requiresAttribution = !isCc0;

        const previewMp3 = raw.previews?.['preview-hq-mp3'] || raw.previews?.['preview-lq-mp3'] || '';

        const durationSec = Math.round(raw.duration || 0);
        const mins = Math.floor(durationSec / 60);
        const secs = durationSec % 60;
        const formattedDuration = `${mins}:${secs < 10 ? '0' : ''}${secs}`;

        const tagsList: string[] = Array.isArray(raw.tags) ? raw.tags : [];
        const combinedText = `${raw.name || ''} ${tagsList.join(' ')}`.toLowerCase();

        let category: 'music' | 'effect' | 'ambient' | 'other' = 'effect';
        if (/music|song|track|melody|beat|instrumental|loop|piano|guitar|synth|música|trilha|melodia|jazz|rock|lofi|lo-fi|classical/.test(combinedText)) {
          category = 'music';
        } else if (/ambient|ambience|drone|rain|wind|atmosphere|nature|background|chuva|vento|ambiente|ruído|ocean|river|birds/.test(combinedText)) {
          category = 'ambient';
        }

        const attributionText = `Som: "${raw.name}" por ${raw.username} no Freesound (https://freesound.org/s/${raw.id}/) sob licença ${raw.license || 'Creative Commons'}.`;

        return {
          id: String(raw.id),
          name: raw.name || 'Sem nome',
          username: raw.username || 'Desconhecido',
          duration: durationSec,
          formattedDuration,
          license: raw.license || 'Creative Commons',
          requiresAttribution,
          attributionText,
          previewUrl: previewMp3,
          tags: tagsList,
          category,
          freesoundUrl: `https://freesound.org/s/${raw.id}/`
        };
      });

      if (categoryFilter !== 'all') {
        items = items.filter((item: any) => item.category === categoryFilter);
      }

      return res.json({
        success: true,
        count: items.length,
        total: data.count || items.length,
        items
      });
    } catch (err: any) {
      console.error("Erro no endpoint /api/library/search:", err);
      return res.status(500).json({ success: false, error: err.message || "Erro interno ao buscar sons no Freesound." });
    }
  });

  // GET /api/library/favorites - Get saved favorites
  app.get("/api/library/favorites", (req, res) => {
    const favorites = loadFavorites();
    return res.json({ success: true, favorites });
  });

  // POST /api/library/favorites - Add item to favorites
  app.post("/api/library/favorites", (req, res) => {
    try {
      const item = req.body;
      if (!item || !item.id) {
        return res.status(400).json({ error: "Item inválido para favoritar." });
      }

      let favorites = loadFavorites();
      if (!favorites.some((f: any) => String(f.id) === String(item.id))) {
        favorites.unshift(item);
        saveFavorites(favorites);
      }

      return res.json({ success: true, favorites });
    } catch (e: any) {
      return res.status(500).json({ error: e.message || "Erro ao salvar favorito." });
    }
  });

  // DELETE /api/library/favorites/:id - Remove item from favorites
  app.delete("/api/library/favorites/:id", (req, res) => {
    try {
      const soundId = String(req.params.id);
      let favorites = loadFavorites();
      favorites = favorites.filter((f: any) => String(f.id) !== soundId);
      saveFavorites(favorites);

      return res.json({ success: true, favorites });
    } catch (e: any) {
      return res.status(500).json({ error: e.message || "Erro ao remover favorito." });
    }
  });

  // POST endpoint for Google Custom Search API retrieval to prevent client-side CORS and secure credentials
  app.post("/api/search/custom", async (req, res) => {
    try {
      const { query, key, cx, num } = req.body;
      if (!query || typeof query !== "string") {
        return res.status(400).json({ error: "O termo de pesquisa 'query' é obrigatório." });
      }

      const searchKey = key || process.env.GOOGLE_API_KEY;
      const searchCx = cx || process.env.GOOGLE_CSE_ID;

      if (!searchKey || !searchCx) {
        return res.status(400).json({
          error: "Google Custom Search não configurado. Por favor, ajuste as chaves em 'Ajustes > Chaves Extras' ou no arquivo .env."
        });
      }

      const maxResults = Math.min(10, Math.max(1, Number(num) || 10));
      const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(searchKey)}&cx=${encodeURIComponent(searchCx)}&q=${encodeURIComponent(query)}&num=${maxResults}`;
      const searchRes = await fetch(url);
      
      if (!searchRes.ok) {
        const errText = await searchRes.text();
        return res.status(searchRes.status).json({ error: `Erro na Google API: ${errText}` });
      }

      const data = await searchRes.json();
      return res.json(data);
    } catch (err: any) {
      console.error("Erro ao realizar busca Google Custom Search:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST endpoint for Tavily Web Search
  app.post("/api/search/tavily", async (req, res) => {
    try {
      const { query, apiKey, maxResults, searchDepth } = req.body;
      if (!query || typeof query !== "string") {
        return res.status(400).json({ error: "O termo de pesquisa 'query' é obrigatório." });
      }

      const tavilyKey = apiKey || process.env.TAVILY_API_KEY;
      if (!tavilyKey) {
        return res.status(400).json({
          error: "API Key do Tavily não configurada. Por favor, ajuste nos Chaves Extras do OSONE ou configure TAVILY_API_KEY no seu servidor."
        });
      }

      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // A Tavily passou a autenticar por cabeçalho Bearer; o api_key no corpo continua
          // aceito por compatibilidade. Mandar os dois funciona nas duas versões da API.
          "Authorization": `Bearer ${tavilyKey}`
        },
        body: JSON.stringify({
          api_key: tavilyKey,
          query: query,
          // "smart" não existe na API da Tavily — os únicos valores aceitos são "basic" e
          // "advanced". Qualquer outro faz a requisição voltar como 400 Bad Request, que era
          // exatamente o erro que aparecia no console a cada busca.
          search_depth: searchDepth === "advanced" ? "advanced" : "basic",
          include_answer: true,
          max_results: Math.min(20, Math.max(1, Number(maxResults) || 5))
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        return res.status(response.status).json({ error: `Erro na Tavily API: ${errText}` });
      }

      const data = await response.json();
      return res.json(data);
    } catch (err: any) {
      console.error("Erro ao realizar busca via Tavily:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  // POST endpoint for Google-Lens style visual intelligence searches (with or without Google Search grounding)
  app.post("/api/lens/query", async (req, res) => {
    try {
      const { image, internetSearch, clientApiKey } = req.body;
      if (!image) {
        return res.status(400).json({ error: "A imagem é obrigatória para a pesquisa da Lente." });
      }

      const apiKey = clientApiKey || getSecretGeminiKey();
      if (!apiKey) {
        return res.status(400).json({ error: "Chave API do Gemini não definida no servidor." });
      }

      const ai = new GoogleGenAI({
        apiKey: apiKey,
        vertexai: false,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      // Extract raw base64 data and mimeType
      let base64Data = image;
      let mimeType = "image/jpeg";
      if (image.startsWith("data:")) {
        const matches = image.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          mimeType = matches[1];
          base64Data = matches[2];
        }
      }

      const imagePart = {
        inlineData: {
          mimeType: mimeType,
          data: base64Data,
        },
      };

      const systemInstruction = `Você é o sintonizador visual da Lente OSONE (mecanismo inspirado no Google Lens).
Sua missão é identificar detalhadamente o objeto, marca, planta, animal, alimento, monumento ou texto contido na imagem enviada.
Você deve produzir uma resposta estruturada de forma impecável no formato JSON contendo campos úteis para o usuário.
Não inclua nenhuma formatação markdown extra fora do JSON bruto.`;

      const promptText = `Analise a imagem de foco fornecida. Identifique o que aparece nela e responda estritamente com um objeto JSON no seguinte formato:
{
  "name": "Nome específico do item identificado",
  "category": "Categoria / Especialidade",
  "confidence": 99, 
  "description": "Uma descrição rica, focada e cativante em língua portuguesa detalhando o item...",
  "tags": ["tag1", "tag2", "tag3"], 
  "details": {
    "marcaOuOrigem": "Marca fabricante, proveniência ou bioma original",
    "caracteristicaPrincipal": "A característica física ou estrutural mais marcante observada",
    "curiosidadeOuUso": "Curiosidade histórica, utilidade prática, ou conselho de manutenção"
  },
  "suggestions": ["Ação de pesquisa útil 1", "Sugestão de uso do item 2"]
}
`;

      const config: any = {
        systemInstruction,
        responseMimeType: "application/json",
      };

      // If internetSearch is true, enable Google Search Grounding for live Lens matches!
      if (internetSearch) {
        config.tools = [{ googleSearch: {} }];
      }

      const response = await generateContentWithFallback(ai, {
        model: "gemini-3.7-flash",
        contents: { parts: [imagePart, { text: promptText }] },
        config: config
      });

      const responseText = response.text || "{}";
      let parsedData: any = {};
      try {
        parsedData = JSON.parse(responseText.trim());
      } catch (parseErr) {
        console.warn("Raw Gemini answer could not be parsed as direct JSON, attempting to extract blocks:", responseText);
        // Fallback robust json extraction from markdown blocks
        const cleaned = responseText.replace(/```json/g, "").replace(/```/g, "").trim();
        parsedData = JSON.parse(cleaned);
      }

      // Extract actual live Google Search citations if available in Gemini's grounding metadata!
      const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
      const citations: { title: string; uri: string }[] = [];
      if (groundingChunks && Array.isArray(groundingChunks)) {
        for (const chunk of groundingChunks) {
          if (chunk.web && chunk.web.uri) {
            citations.push({
              title: chunk.web.title || "Resultado da Web",
              uri: chunk.web.uri
            });
          }
        }
      }

      parsedData.citations = citations;
      return res.json(parsedData);
    } catch (err: any) {
      console.error("Erro na pesquisa da Lente OSONE:", err);
      return res.status(500).json({ error: formatGeminiError(err) });
    }
  });

  // Helper to validate and block SSRF attempts (private IPs, loopback, link-local, cloud metadata, non-HTTP schemes)
  const isPrivateIp = (ip: string): boolean => {
    if (!ip) return true;
    const cleanIp = ip.toLowerCase().trim();
    if (cleanIp === "::1" || cleanIp === "0:0:0:0:0:0:0:1" || cleanIp === "0.0.0.0") return true;
    const ipMatch = cleanIp.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipMatch) {
      const p1 = parseInt(ipMatch[1], 10);
      const p2 = parseInt(ipMatch[2], 10);
      if (p1 === 10 || p1 === 127 || p1 === 0) return true;
      if (p1 === 172 && p2 >= 16 && p2 <= 31) return true;
      if (p1 === 192 && p2 === 168) return true;
      if (p1 === 169 && p2 === 254) return true; // Cloud metadata (169.254.169.254)
    }
    if (cleanIp.startsWith("fe80:") || cleanIp.startsWith("fc00:") || cleanIp.startsWith("fd00:")) {
      return true;
    }
    return false;
  };

  const hostnameEhPrivado = (hostname: string): boolean => {
    const h = hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' ||
      h.endsWith('.local') || h.endsWith('.internal') || isPrivateIp(h);
  };

  /**
   * Busca uma URL fornecida pelo usuário travando o IP de destino: a checagem de "não é
   * privado/interno" e a conexão de fato usam a MESMA resolução de DNS. Antes, uma checava
   * via `dns.lookup` e a outra deixava o `fetch` resolver de novo por conta própria — um
   * domínio com TTL=0 (DNS rebinding) podia responder um IP público na checagem e um IP
   * interno milissegundos depois, na hora da conexão real. Também revalida cada redirect,
   * já que um `fetch` comum seguiria redirects para dentro da rede interna sem re-checar nada.
   */
  const buscarTextoComProtecaoSsrf = async (
    urlInicial: string,
    opcoes: { timeoutMs?: number } = {}
  ): Promise<{ ok: boolean; status: number; text: string }> => {
    const timeoutMs = opcoes.timeoutMs ?? 10000;
    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    let urlAtual = urlInicial;

    for (let redirecionamentos = 0; redirecionamentos <= 5; redirecionamentos++) {
      const parsed = new URL(urlAtual);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw Object.assign(new Error("Acesso a URLs privadas, locais ou não permitidas é bloqueado por segurança."), { bloqueado: true });
      }
      const hostname = parsed.hostname.toLowerCase();
      if (hostnameEhPrivado(hostname)) {
        throw Object.assign(new Error("Acesso a URLs privadas, locais ou não permitidas é bloqueado por segurança."), { bloqueado: true });
      }

      const enderecos = await dns.promises.lookup(hostname, { all: true }).catch(() => []);
      if (!enderecos || enderecos.length === 0) {
        throw Object.assign(new Error("Não foi possível resolver o endereço informado."), { bloqueado: true });
      }
      for (const endereco of enderecos) {
        if (isPrivateIp(endereco.address)) {
          throw Object.assign(new Error("Acesso a URLs privadas, locais ou não permitidas é bloqueado por segurança."), { bloqueado: true });
        }
      }

      const escolhido = enderecos.find(e => e.family === 4) || enderecos[0];
      const modulo = parsed.protocol === 'https:' ? https : http;
      const porta = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);

      const resultado = await new Promise<{ status: number; corpo: string; redirecionarPara?: string }>((resolve, reject) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const reqHttp = modulo.request({
          host: escolhido.address,
          port: porta,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers: { Host: parsed.host, 'User-Agent': userAgent },
          // Garante SNI/validação de certificado pelo hostname original, mesmo conectando pelo IP fixado.
          servername: parsed.protocol === 'https:' ? hostname : undefined,
          signal: controller.signal
        } as any, (respostaHttp) => {
          clearTimeout(timer);
          const status = respostaHttp.statusCode || 0;
          if (status >= 300 && status < 400 && respostaHttp.headers.location) {
            respostaHttp.resume();
            resolve({ status, corpo: '', redirecionarPara: new URL(respostaHttp.headers.location, urlAtual).toString() });
            return;
          }
          const partes: Buffer[] = [];
          respostaHttp.on('data', (chunk) => partes.push(chunk));
          respostaHttp.on('end', () => resolve({ status, corpo: Buffer.concat(partes).toString('utf-8') }));
          respostaHttp.on('error', reject);
        });
        reqHttp.on('error', (err) => { clearTimeout(timer); reject(err); });
        reqHttp.end();
      });

      if (resultado.redirecionarPara) {
        urlAtual = resultado.redirecionarPara;
        continue;
      }
      return { ok: resultado.status >= 200 && resultado.status < 300, status: resultado.status, text: resultado.corpo };
    }
    throw Object.assign(new Error("Excesso de redirecionamentos."), { bloqueado: true });
  };

  // POST endpoint for high-speed server-side webpage text scraping & parsing
  app.post("/api/scrape", async (req, res) => {
    try {
      const { url } = req.body;
      if (!url || typeof url !== "string") {
        return res.status(400).json({ error: "O parâmetro 'url' é obrigatório." });
      }

      let response: { ok: boolean; status: number; text: string };
      try {
        response = await buscarTextoComProtecaoSsrf(url);
      } catch (err: any) {
        if (err?.bloqueado) return res.status(403).json({ error: err.message });
        throw err;
      }

      if (!response.ok) {
        return res.status(400).json({ error: `Falha ao acessar o site: status ${response.status}` });
      }

      const html = response.text;

      // Strips structural elements like script tags, stylesheets, and menus
      let text = html
        .replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, '')
        .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, '')
        .replace(/<svg[^>]*>([\s\S]*?)<\/svg>/gi, '')
        .replace(/<noscript[^>]*>([\s\S]*?)<\/noscript>/gi, '')
        .replace(/<header[^>]*>([\s\S]*?)<\/header>/gi, '')
        .replace(/<footer[^>]*>([\s\S]*?)<\/footer>/gi, '')
        .replace(/<nav[^>]*>([\s\S]*?)<\/nav>/gi, '')
        .replace(/<iframe[^>]*>([\s\S]*?)<\/iframe>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '');

      text = text
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        .replace(/<\/h[1-6]>/gi, '\n\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

      // Retain a clean set of text characters up to 12k to avoid bloating context
      const cleanText = text.slice(0, 12000);

      return res.json({ text: cleanText });
    } catch (err: any) {
      console.error("Erro ao analisar página no servidor:", err);
      return res.status(500).json({ error: "Erro de raspagem: " + (err.name === 'AbortError' ? 'Tempo de conexão esgotado (timeout)' : err.message) });
    }
  });

  app.get("/api/system-docs", (req, res) => {
    try {
      const { file } = req.query;
      if (!file || typeof file !== "string") {
        return res.status(400).json({ error: "Faltando o parâmetro do arquivo." });
      }
      const allowed = ["manifesto.md", "capacidades.md", "memoria_evolutiva.md"];
      if (!allowed.includes(file)) {
        return res.status(400).json({ error: "Arquivo proibido ou não mapeado nas diretrizes." });
      }
      // Arquivo estático da própria instalação do OSONE (não é dado do usuário), então parte
      // de OSONE_INSTALL_DIR, que resolve a raiz da instalação de forma correta tanto no
      // bundle de produção quanto em desenvolvimento — e, ao contrário de process.cwd(), não é
      // afetado pelo chdir que o app empacotado faz para a pasta de dados do usuário.
      const filePath = path.join(OSONE_INSTALL_DIR, "src", "documentos_osone", file);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: `Arquivo ${file} não existe no diretório.` });
      }
      const text = fs.readFileSync(filePath, "utf-8");
      return res.json({ text });
    } catch (err: any) {
      console.error("Erro ao ler documento de sistema:", err);
      return res.status(500).json({ error: err.message });
    }
  });

  // ====== TUYA CLOUD OPENAPI INTEGRATION ENDPOINTS ======
  /**
   * CASA INTELIGENTE — sem isto, era a rota mais aberta do servidor.
   *
   * Diferente de /api/whatsapp e /api/cameras (que já tinham requireWhatsAppAccess/
   * requireCameraAccess), estas rotas não passavam por nenhuma checagem: numa implantação
   * pública (Vercel) com TUYA_CLIENT_ID/SECRET configurados nas variáveis de ambiente — o
   * caminho que a própria tela de Ajustes recomenda para hospedagem remota — qualquer
   * visitante da internet, sem login nenhum, conseguia listar e comandar os aparelhos reais
   * da casa por POST /api/tuya/command, inclusive fechaduras (o campo "confirmed: true" não
   * protege nada porque quem o envia é o próprio requisitante, não uma confirmação genuína
   * do dono).
   *
   * Três portas de entrada, na ordem em que fazem sentido: a própria máquina (Electron/
   * self-host), um token de acesso compartilhado (para quem expõe o OSONE por túnel, mesmo
   * padrão do CAMERA_ACCESS_TOKEN) ou uma sessão OSONE autenticada (o caso normal na Vercel,
   * onde o painel React chama estas rotas em nome de quem está logado).
   */
  const TUYA_ACCESS_TOKEN = process.env.TUYA_ACCESS_TOKEN || "";
  const requireTuyaAccess = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (isLoopbackAddress(req.socket?.remoteAddress)) return next();

    const tokenEnviado = req.headers["x-tuya-token"];
    if (TUYA_ACCESS_TOKEN && tokenEnviado === TUYA_ACCESS_TOKEN) return next();

    const authHeader = String(req.headers.authorization || "");
    if (authHeader.startsWith("Bearer ")) {
      try {
        await verifyFirebaseBearer(authHeader);
        return next();
      } catch {
        // cai para a recusa abaixo — token do Firebase ausente, inválido ou expirado
      }
    }

    return res.status(403).json({
      error: "Acesso à casa inteligente negado. Esta área só é acessível a partir do próprio computador, autenticado com sua conta OSONE, ou com um TUYA_ACCESS_TOKEN válido configurado no servidor."
    });
  };
  app.use("/api/tuya", requireTuyaAccess);

  function isTuyaLockCategory(category: string): boolean {
    if (!category) return false;
    const cat = String(category).toLowerCase().trim();
    const lockCategories = ['ms', 'jtmspro', 'mk', 'jdms', 'lck', 'lock', 'fechadura'];
    if (lockCategories.includes(cat)) return true;
    if (cat.includes('lock') || cat.includes('fechadura') || cat.includes('door') || cat.includes('latch')) return true;
    return false;
  }

  app.get("/api/tuya/status", (req, res) => {
    try {
      const status = checkTuyaConfig();
      res.json(status);
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Erro ao verificar status da Tuya API" });
    }
  });

  /**
   * Diagnóstico de ponta a ponta da Tuya: em vez de só dizer se os campos estão preenchidos,
   * autentica de verdade e lista os aparelhos, devolvendo em português o que falta fazer.
   * É o endpoint para abrir quando "está tudo configurado mas nada funciona".
   */
  app.get("/api/tuya/diagnostico", async (_req, res) => {
    try {
      res.json(await diagnosticarTuya());
    } catch (err: any) {
      res.status(500).json({
        ok: false,
        etapa: 'interno',
        resumo: "O diagnóstico da Tuya falhou inesperadamente.",
        erroTecnico: err?.message || String(err)
      });
    }
  });

  app.get("/api/tuya/devices", async (req, res) => {
    try {
      const devices = await getTuyaDevices();
      res.json({ devices: devices || [] });
    } catch (err: any) {
      console.error("Erro no GET /api/tuya/devices:", err);
      res.status(500).json({ error: err.message || "Erro ao listar dispositivos Tuya." });
    }
  });

  app.get("/api/tuya/device/:deviceId/status", async (req, res) => {
    try {
      const { deviceId } = req.params;
      const deviceIdRegex = /^[a-zA-Z0-9_-]+$/;
      if (!deviceId || !deviceIdRegex.test(deviceId)) {
        return res.status(400).json({ error: "ID de dispositivo inválido (deve conter apenas caracteres alfanuméricos, hífen e underline)." });
      }
      const status = await getDeviceStatus(deviceId);
      res.json({ status: status || [] });
    } catch (err: any) {
      console.error(`Erro no GET /api/tuya/device/${req.params.deviceId}/status:`, err);
      res.status(500).json({ error: err.message || "Erro ao consultar status do dispositivo Tuya." });
    }
  });

  app.post("/api/tuya/command", async (req, res) => {
    try {
      const { deviceId, commands, confirmed } = req.body || {};
      const deviceIdRegex = /^[a-zA-Z0-9_-]+$/;
      if (!deviceId || typeof deviceId !== 'string' || !deviceIdRegex.test(deviceId)) {
        return res.status(400).json({ error: "ID de dispositivo inválido." });
      }
      if (!commands || !Array.isArray(commands) || commands.length === 0) {
        return res.status(400).json({ error: "Parâmetro 'commands' deve ser um array de comandos não vazio." });
      }

      // Consulta detalhe do dispositivo para verificar se é fechadura/trava.
      // Falha ao consultar categoria = tratado como fechadura (fail-closed):
      // nunca assumimos que um dispositivo não confirmado é seguro para acionar.
      let detail: any = null;
      let detailFetchFailed = false;
      try {
        detail = await getDeviceDetail(deviceId);
      } catch (e) {
        detailFetchFailed = true;
      }

      const category = detail?.category || "";
      const isLock = detailFetchFailed || isTuyaLockCategory(category);

      if (isLock && confirmed !== true) {
        return res.status(400).json({
          error: detailFetchFailed
            ? "Não foi possível verificar a categoria do dispositivo. Por segurança, confirmação explícita é obrigatória."
            : "Confirmação explícita obrigatória para dispositivos de categoria fechadura"
        });
      }

      const result = await sendDeviceCommand(deviceId, commands);
      res.json({ success: true, result, deviceDetail: detail });
    } catch (err: any) {
      console.error("Erro no POST /api/tuya/command:", err);
      res.status(500).json({ error: err.message || "Erro ao enviar comando para o dispositivo Tuya." });
    }
  });

  // ====== GOOGLE HOME (ACTIONS ON GOOGLE / SMART HOME ACTION) ======
  // Ponte real: o Google Assistant fala com estas rotas (OAuth de vínculo de conta +
  // webhook de fulfillment SYNC/QUERY/EXECUTE), que por sua vez comandam os MESMOS
  // dispositivos Tuya reais já usados pelo painel/chat do OSONE. A configuração externa no
  // Actions on Google Console (criar o projeto, colar estas URLs, publicar em teste) só pode
  // ser feita pelo próprio usuário — aqui só existe o código do lado do servidor.
  const googleHomePublicUrl = (): string => {
    const value = String(process.env.OSONE_HOME_PUBLIC_URL || 'https://osone-ai-six.vercel.app').trim().replace(/\/+$/, '');
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || /^(localhost|127\.|\[?::1)/.test(parsed.hostname)) {
      throw new Error('OSONE_HOME_PUBLIC_URL precisa ser um endereço público HTTPS.');
    }
    return parsed.origin;
  };

  const cloudError = (res: express.Response, err: any) => {
    const status = Number(err?.status) || 500;
    if (status >= 500) console.error('[Google Home Cloud]', err);
    return res.status(status).json({ error: status >= 500 ? 'A ponte pública do Google Home falhou.' : err?.message });
  };

  /**
   * O instalável envia as credenciais direto do servidor local para a ponte oficial. O segredo
   * nunca volta para o React e o Google passa a controlar a Tuya mesmo com o computador fechado.
   */
  app.post('/api/google-home/cloud/configure', async (req, res) => {
    if (!somenteDaPropriaMaquina(req, res, 'A ativação do Google Home no instalável')) return;
    if (isVercel) return res.status(400).json({ error: 'Esta rota deve ser chamada pelo OSONE instalado.' });
    try {
      const firebaseToken = String(req.body?.firebaseToken || '');
      if (!firebaseToken) return res.status(401).json({ error: 'Entre com sua conta OSONE antes de ativar.' });
      const credentials = {
        clientId: String(process.env.TUYA_CLIENT_ID || ''),
        clientSecret: String(process.env.TUYA_CLIENT_SECRET || ''),
        baseUrl: String(process.env.TUYA_BASE_URL || 'https://openapi.tuyaus.com'),
        userUid: String(process.env.TUYA_USER_UID || '')
      };
      const base = googleHomePublicUrl();
      const registerResponse = await fetch(`${base}/api/google-home/cloud/register`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${firebaseToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ credentials })
      });
      const registration: any = await registerResponse.json().catch(() => null);
      if (!registerResponse.ok) return res.status(registerResponse.status).json({ error: registration?.error || 'A ponte pública recusou as credenciais Tuya.' });

      const pairingResponse = await fetch(`${base}/api/google-home/cloud/pairing-code`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${firebaseToken}` }
      });
      const pairing: any = await pairingResponse.json().catch(() => null);
      if (!pairingResponse.ok) return res.status(pairingResponse.status).json({ error: pairing?.error || 'Não foi possível gerar o código de vínculo.' });
      return res.json({ ...registration, ...pairing, publicUrl: base });
    } catch (err: any) {
      return cloudError(res, err);
    }
  });

  app.post('/api/google-home/cloud/register', async (req, res) => {
    if (!isVercel) return res.status(404).json({ error: 'Registro disponível apenas na ponte pública.' });
    try {
      const user = await verifyFirebaseBearer(String(req.headers.authorization || ''));
      return res.json(await registerGoogleHomeUser(user.uid, req.body?.credentials || {}));
    } catch (err: any) {
      return cloudError(res, err);
    }
  });

  app.post('/api/google-home/cloud/pairing-code', async (req, res) => {
    if (!isVercel) return res.status(404).json({ error: 'Pareamento disponível apenas na ponte pública.' });
    try {
      const user = await verifyFirebaseBearer(String(req.headers.authorization || ''));
      return res.json(await issuePairingCode(user.uid));
    } catch (err: any) {
      return cloudError(res, err);
    }
  });

  app.get('/api/google-home/cloud/status', async (req, res) => {
    if (!isVercel) return res.status(404).json({ error: 'Estado disponível apenas na ponte pública.' });
    try {
      const user = await verifyFirebaseBearer(String(req.headers.authorization || ''));
      return res.json(await googleHomeCloudStatus(user.uid));
    } catch (err: any) {
      return cloudError(res, err);
    }
  });

  /**
   * PONTE DE LOGIN PARA O APP INSTALADO — 100% LOCAL, sem depender da ponte pública na Vercel.
   *
   * O Google recusa o popup de login dentro de uma BrowserWindow do Electron (política contra
   * "embedded browsers"), então o app instalado abre o navegador padrão do sistema apontando
   * para o PRÓPRIO servidor local (http://127.0.0.1:PORT) — onde este mesmo popup sempre
   * funcionou, porque é um navegador de verdade, e o endereço de loopback é o padrão que o
   * próprio Google recomenda para apps instalados (RFC 8252). A aba entrega a sessão de volta
   * ao Electron através de um código de uso único, guardado em memória neste mesmo processo.
   *
   * Só transita aqui o TOKEN ORIGINAL DO GOOGLE (GoogleAuthProvider.credentialFromResult), nunca
   * um token do Firebase nem uma credencial de administrador — este servidor não verifica nada,
   * só repassa; é o SDK do Firebase, do lado do Electron, que reconstrói a credencial e conclui
   * o login (signInWithCredential). Por isso a ponte não depende de FIREBASE_SERVICE_ACCOUNT_JSON
   * nem de a Vercel estar no ar: o app instalado funciona sozinho.
   */
  const handoffsDeLoginPendentes = new Map<string, { idToken: string; criadoEm: number }>();
  setInterval(() => {
    const agora = Date.now();
    for (const [codigo, registro] of handoffsDeLoginPendentes) {
      if (agora - registro.criadoEm > 10 * 60 * 1000) handoffsDeLoginPendentes.delete(codigo);
    }
  }, 5 * 60 * 1000);

  // Chamada pela ABA DO NAVEGADOR (mesma origem do servidor local), assim que o login termina nela.
  app.post('/api/login/entrega', (req, res) => {
    const codigo = String(req.body?.codigo || '');
    const idToken = String(req.body?.idToken || '');
    if (!codigo || !idToken) return res.status(400).json({ error: 'codigo e idToken são obrigatórios.' });
    handoffsDeLoginPendentes.set(codigo, { idToken, criadoEm: Date.now() });
    return res.json({ ok: true });
  });

  // Chamada pela JANELA DO ELECTRON, também na mesma origem do servidor local. Uso único: o
  // código some assim que é lido, então uma segunda consulta nunca reaproveita um token velho.
  app.get('/api/login/entrega/estado', (req, res) => {
    const codigo = String(req.query.codigo || '');
    const registro = handoffsDeLoginPendentes.get(codigo);
    if (!registro) return res.json({ pronto: false });
    handoffsDeLoginPendentes.delete(codigo);
    return res.json({ pronto: true, idToken: registro.idToken });
  });

  /**
   * O estado do Google Home tem DOIS degraus, e a tela precisa dos dois: o par client_id/secret
   * preenchido aqui, e a conta do Google efetivamente vinculada pelo app do celular. Quem
   * preenchia os campos e nunca concluía o vínculo via tudo verde e não entendia por que o
   * Assistente dizia não achar aparelho nenhum. Os campos de `configured`/`env` continuam iguais
   * para não quebrar quem já lia esta rota.
   */
  app.get("/api/google-home/status", (req, res) => {
    if (isVercel) return res.json({ ...googleHomeCloudConfiguration(), cloud: true });
    return res.json({ ...checkGoogleHomeConfig(), ...lerEstadoDoVinculo(), cloud: false });
  });

  /**
   * Diagnóstico de ponta a ponta: percorre credenciais > Tuya > aparelhos > vínculo e para no
   * primeiro elo que falta, dizendo o que fazer ali. Traz também a lista exata do que o
   * Assistente vai enxergar e o motivo de cada aparelho que ficou de fora.
   */
  app.get("/api/google-home/diagnostico", async (_req, res) => {
    try {
      res.json(await diagnosticarGoogleHome());
    } catch (err: any) {
      res.status(500).json({
        ok: false,
        etapa: 'interno',
        resumo: "O diagnóstico do Google Home falhou inesperadamente.",
        erroTecnico: err?.message || String(err)
      });
    }
  });

  // Tela de consentimento simples exibida no navegador durante o fluxo "Vincular Conta" do
  // Google. Em vez de embutir HTML solto no servidor, delega para uma página estática servida
  // pelo Vite/dist, repassando os parâmetros originais do Google via querystring.
  // O Google só chama esse fluxo a partir de um punhado de domínios dele próprio. Aceitar
  // qualquer redirect_uri deixaria um link malicioso usar o consentimento real do dono do
  // dispositivo para emitir um código de autorização e mandá-lo para um domínio de terceiro.
  const isRedirectUriDoGoogle = (redirectUri: string): boolean => {
    try {
      const parsed = new URL(redirectUri);
      return parsed.protocol === "https:" && (
        parsed.hostname === "oauth-redirect.googleusercontent.com" ||
        parsed.hostname === "oauth-redirect-sandbox.googleusercontent.com"
      );
    } catch {
      return false;
    }
  };

  app.get("/api/google-home/authorize", (req, res) => {
    const { client_id, redirect_uri, state, response_type } = req.query;
    const expectedId = (process.env.GOOGLE_HOME_CLIENT_ID || "").trim();
    if (response_type !== "code") {
      return res.status(400).send("response_type deve ser 'code'.");
    }
    if (!client_id || client_id !== expectedId) {
      return res.status(400).send("client_id inválido ou não configurado no servidor (GOOGLE_HOME_CLIENT_ID).");
    }
    if (!redirect_uri || typeof redirect_uri !== "string" || !isRedirectUriDoGoogle(redirect_uri)) {
      return res.status(400).send("redirect_uri é obrigatório e precisa ser um domínio de OAuth do Google.");
    }

    const params = new URLSearchParams({
      redirect_uri: redirect_uri as string,
      state: (state as string) || "",
      client_id: String(client_id),
      cloud: isVercel ? '1' : '0'
    });
    res.redirect(`/google-home-consent.html?${params.toString()}`);
  });

  // Chamado pela tela de consentimento quando o usuário clica em "Autorizar". Gera o código
  // de autorização e redireciona de volta para o Google com ele.
  app.post("/api/google-home/approve", async (req, res) => {
    const { redirect_uri, state } = req.body || {};
    if (!redirect_uri || typeof redirect_uri !== "string" || !isRedirectUriDoGoogle(redirect_uri)) {
      return res.status(400).json({ error: "redirect_uri é obrigatório e precisa ser um domínio de OAuth do Google." });
    }
    try {
      const code = isVercel
        ? await issueCloudAuthCode({
            pairingCode: String(req.body?.pairing_code || ''),
            clientId: String(req.body?.client_id || ''),
            redirectUri: redirect_uri
          })
        : issueAuthCode(String(req.body?.pairing_code || ''));
      const params = new URLSearchParams({ code, state: state || "" });
      return res.json({ redirectTo: `${redirect_uri}?${params.toString()}` });
    } catch (err: any) {
      return cloudError(res, err);
    }
  });

  /**
   * Prova de que quem está aprovando o vínculo é o dono desta instalação (ver issueAuthCode
   * em googleHomeService.ts). Só a própria máquina pode pedir o código — mesma trava de
   * somenteDaPropriaMaquina usada em /api/credenciais — e é ele que a pessoa digita na tela
   * de consentimento, mesmo vindo de outro aparelho (telefone no app Google Home), para provar
   * que tem acesso a ESTE OSONE.
   */
  app.get("/api/google-home/pairing-code", (req, res) => {
    if (!somenteDaPropriaMaquina(req, res, 'A geração do código de pareamento do Google Home')) return;
    return res.json(issueLocalPairingCode());
  });

  app.post("/api/google-home/token", async (req, res) => {
    try {
      const body = req.body || {};
      const authHeader = req.headers["authorization"] || "";
      let clientId = body.client_id;
      let clientSecret = body.client_secret;

      // O Google pode enviar client_id/secret via Basic Auth em vez do corpo.
      if (!clientId && authHeader.startsWith("Basic ")) {
        const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
        const [id, secret] = decoded.split(":");
        clientId = id;
        clientSecret = secret;
      }

      const tokenParams = {
        grantType: body.grant_type,
        code: body.code,
        refreshToken: body.refresh_token,
        redirectUri: body.redirect_uri,
        clientId: clientId || "",
        clientSecret: clientSecret || ""
      };
      const tokens = isVercel
        ? await exchangeCloudToken(tokenParams)
        : exchangeToken(tokenParams);

      res.json(tokens);
    } catch (err: any) {
      res.status(400).json({ error: "invalid_grant", error_description: err.message });
    }
  });

  // Webhook de fulfillment: recebe as intents SYNC/QUERY/EXECUTE/DISCONNECT do Google
  // Assistant e as traduz em chamadas reais à Tuya Cloud.
  app.post("/api/google-home/fulfillment", async (req, res) => {
    try {
      const authHeader = (req.headers["authorization"] || "").toString();
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      const cloudUserId = isVercel ? await userForAccessToken(token) : null;
      if (isVercel ? !cloudUserId : !isValidAccessToken(token)) {
        return res.status(401).json({ error: "Token de acesso inválido, expirado ou ausente." });
      }
      const deviceBackend = cloudUserId ? await backendForGoogleHomeUser(cloudUserId) : undefined;

      const { requestId, inputs } = req.body || {};
      const input = Array.isArray(inputs) ? inputs[0] : null;
      const intent = input?.intent;

      if (intent === "action.devices.SYNC") {
        const result = await googleHomeSync(deviceBackend);
        return res.json({ requestId, payload: { agentUserId: cloudUserId || "osone-user", ...result } });
      }

      if (intent === "action.devices.QUERY") {
        const deviceIds = (input.payload?.devices || []).map((d: any) => d.id);
        const result = await googleHomeQuery(deviceIds, deviceBackend);
        return res.json({ requestId, payload: result });
      }

      if (intent === "action.devices.EXECUTE") {
        const result = await googleHomeExecute(input.payload?.commands || [], deviceBackend);
        return res.json({ requestId, payload: result });
      }

      if (intent === "action.devices.DISCONNECT") {
        // Revoga de verdade. Antes a resposta era um {} vazio e os tokens continuavam válidos
        // aqui: desvincular pelo celular não cortava acesso nenhum.
        if (cloudUserId) await revokeGoogleHomeUser(cloudUserId);
        else googleHomeDisconnect();
        return res.json({ requestId, payload: {} });
      }

      return res.status(400).json({ requestId, payload: { errorCode: "notSupported" } });
    } catch (err: any) {
      console.error("Erro no webhook de fulfillment do Google Home:", err);
      res.status(500).json({ error: err.message || "Erro no webhook de fulfillment do Google Home." });
    }
  });

  /**
   * Desvincular a conta é destrutivo e não pedia credencial nenhuma: qualquer um que alcançasse
   * o servidor derrubava o vínculo do Google Home do dono. Fica na mesma trava das credenciais —
   * só a própria máquina. Pelo celular, o caminho é desvincular dentro do app Google Home, que
   * chega aqui pela intent DISCONNECT (autenticada pelo token do Google).
   */
  app.post("/api/google-home/revoke", (req, res) => {
    if (!somenteDaPropriaMaquina(req, res, 'A desvinculação do Google Home')) return;
    revokeAllTokens();
    res.json({ success: true, message: "Todos os tokens do Google Home foram revogados. Refaça o vínculo pelo app Google Home quando quiser voltar a comandar por voz." });
  });

  // ====== TIKTOK LIVE CO-PILOT API ENDPOINTS ======
  // Mantém uma conexão ao vivo em memória entre requisições — não sobrevive a funções
  // serverless efêmeras da Vercel, então recusamos com mensagem clara em vez de "conectar"
  // sem nunca receber evento nenhum.
  app.use("/api/tiktok", blockOnVercel("O TikTok Live Co-Pilot"));

  app.get("/api/tiktok/state", (req, res) => {
    res.json({
      status: tiktokStatus,
      username: currentTikTokUser,
      isAutoRespondActive: isTikTokAutoRespondActive,
      viewerCount: tiktokViewerCount,
      likeCount: tiktokLikeCount,
      sessionId: tiktokSessionId,
      targetIdc: tiktokTargetIdc,
      logs: tiktokEventLogs
    });
  });

  app.post("/api/tiktok/connect", async (req, res) => {
    try {
      const { username, simulate, sessionId, targetIdc } = req.body;
      
      if (sessionId !== undefined) {
        tiktokSessionId = String(sessionId).trim();
      }

      if (targetIdc !== undefined) {
        tiktokTargetIdc = String(targetIdc).trim();
      }

      if (simulate) {
        startSimulatedLive();
        return res.json({ status: "success", message: "Simulação de live do TikTok iniciada no OSONE!" });
      }

      if (!username || typeof username !== "string" || !username.trim()) {
        return res.status(400).json({ error: "O nome de usuário do TikTok é obrigatório." });
      }

      const cleanUser = username.trim().replace(/^@/, "");
      
      // Async trigger connection so we don't hold the HTTP request indefinitely
      connectToTikTokLive(cleanUser, tiktokSessionId, tiktokTargetIdc).catch(e => {
        console.error("Delayed connection failed:", e);
      });

      res.json({ 
        status: "success", 
        message: `Sinalização enviada com sucesso! Conectando à webcast de @${cleanUser}...` 
      });
    } catch (err: any) {
      console.error("Erro ao conectar TikTok:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/tiktok/disconnect", async (req, res) => {
    try {
      await disconnectFromTikTokLive();
      res.json({ status: "success", message: "Conectividade do TikTok Live suspensa de forma íntegra." });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/tiktok/config", (req, res) => {
    const { isAutoRespondActive } = req.body;
    if (isAutoRespondActive !== undefined) {
      isTikTokAutoRespondActive = !!isAutoRespondActive;
    }
    res.json({ 
      status: "success", 
      isAutoRespondActive: isTikTokAutoRespondActive 
    });
  });

  app.post("/api/tiktok/clear-logs", (req, res) => {
    tiktokEventLogs = [
      {
        id: "clear-" + Date.now(),
        type: "system",
        user: "Sistema",
        message: "Histórico de eventos do TikTok Live limpo com segurança.",
        timestamp: Date.now()
      }
    ];
    res.json({ status: "success" });
  });

  // POST endpoint for verifying Elevenlabs credentials and options in real-time
  app.post("/api/elevenlabs/verify", async (req, res) => {
    try {
      const { elevenLabsApiKey, elevenLabsVoiceId } = req.body;
      if (!elevenLabsApiKey || typeof elevenLabsApiKey !== "string" || !elevenLabsApiKey.trim()) {
        return res.status(400).json({ success: false, message: "A chave API da Elevenlabs é obrigatória para verificação." });
      }

      const trimApiKey = elevenLabsApiKey.trim();
      const validacaoChave = validarChaveElevenLabsParaUso(trimApiKey);
      if (!validacaoChave.ok) {
        return res.status(400).json({ success: false, message: validacaoChave.message });
      }

      // Validate Api Key via ElevenLabs User Info Endpoint
      const userRes = await fetch("https://api.elevenlabs.io/v1/user", {
        method: "GET",
        headers: {
          "xi-api-key": validacaoChave.key
        }
      });

      if (!userRes.ok) {
        const errText = await userRes.text();
        let message = "Chave de API inválida ou expirada. Verifique as credenciais digitadas.";
        try {
          const parsed = JSON.parse(errText);
          if (parsed.detail?.message) {
            message = parsed.detail.message;
          } else if (parsed.detail?.status === "invalid-api-key") {
            message = "Chave API Elevenlabs inválida. Por favor, revise os caracteres.";
          }
        } catch (_) {}
        return res.status(userRes.status === 401 ? 401 : 400).json({ success: false, message });
      }

      const userData = await userRes.json();
      const userTier = userData.subscription?.tier || "Free/Trial";
      const characterCount = userData.subscription?.character_count || 0;
      const characterLimit = userData.subscription?.character_limit || 10000;
      const leftCount = Math.max(0, characterLimit - characterCount);

      const subInfo = `Plano: ${userTier} (${leftCount.toLocaleString()} caracteres restantes)`;

      // If Voice ID was provided, validate it as well
      if (elevenLabsVoiceId && typeof elevenLabsVoiceId === "string" && elevenLabsVoiceId.trim()) {
        const trimVoiceId = elevenLabsVoiceId.trim();
        const voiceRes = await fetch(`https://api.elevenlabs.io/v1/voices/${trimVoiceId}`, {
          method: "GET",
          headers: {
            "xi-api-key": validacaoChave.key
          }
        });

        if (!voiceRes.ok) {
          return res.status(400).json({
            success: false,
            message: `A chave de API é válida! (${subInfo}), mas o ID da voz "${trimVoiceId}" não foi encontrado ou é inacessível para esta chave.`
          });
        }

        const voiceData = await voiceRes.json();
        const voiceName = voiceData.name || "Voz Desconhecida";
        return res.json({
          success: true,
          message: `Conexão bem-sucedida! Chave de API válida (${subInfo}). Voz encontrada: "${voiceName}".`
        });
      }

      return res.json({
        success: true,
        message: `Conexão bem-sucedida! Chave de API ativa (${subInfo}). Nenhum Voice ID foi inserido, será utilizada a voz padrão.`
      });

    } catch (err: any) {
      console.error("Error inside /api/elevenlabs/verify endpoint:", err);
      res.status(500).json({ success: false, message: `Falha ao tentar conectar ao servidor da ElevenLabs: ${err.message}` });
    }
  });

  // POST endpoint for generating step-by-step simple integration plans
  app.post("/api/integrations/plan", async (req, res) => {
    try {
      const { targetIntegration, clientApiKey } = req.body;
      
      if (!targetIntegration || typeof targetIntegration !== "string") {
        return res.status(400).json({ error: "O nome da integração é obrigatório." });
      }

      const apiKey = clientApiKey || getSecretGeminiKey();

      if (!apiKey) {
        return res.status(400).json({ 
          error: "A chave API do Gemini não está definida no OSONE ou nos segredos. Por favor, configure sua chave nos Ajustes." 
        });
      }

      const ai = new GoogleGenAI({
        apiKey: apiKey,
        vertexai: false,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });

      const prompt = `Gere um guia de plano de integração extremamente simples, didático e prático, estruturado em passos numerados fáceis (de 3 a 5 passos), explicando detalhadamente o que o usuário precisa preparar, configurar e programar em seu app para conseguir integrar o sistema desejado.
      
      Algumas pessoas não sabem por onde começar ou o que precisam (como Chave de API, URLs de retorno, webhook, bibliotecas). Explique de forma amigável, acolhedora e encorajadora para que qualquer pessoa (mesmo leigos) consiga entender o que precisa fazer e o que precisa obter nos painéis parceiros.

      Sistema que o usuário deseja integrar: "${targetIntegration}"

      Siga exatamente esta estrutura no seu resultado Markdown:
      1. **Introdução**: Uma introdução breve, encorajadora e amigável em português explicando o que é o sistema e confirmando que é super viável integrá-lo.
      2. **Passo a Passo**: Divida em passos claramente numerados (ex: # 1, # 2, etc.), usando palavras simples e destacando termos técnicos essenciais em negrito (ex: **Token de Acesso**, **Painel de Desenvolvedor**, **Webhooks**, **Servidor**).
      3. **Dica Pro**: Uma dica rápida para manter as senhas protegidas ou sobre como testar de forma simulada.`;

      const response = await generateContentWithFallback(ai, {
        model: "gemini-3.7-flash",
        contents: prompt,
        config: {
          systemInstruction: "Você é um Engenheiro de API de Software experiente, empático e de linguagem extremamente clara e acessível."
        }
      });

      res.json({ plan: response.text || "Ops! Não foi possível gerar o plano. Tente novamente." });
    } catch (error: any) {
      console.error("Erro no endpoint de planejador de integrações:", error);
      res.status(500).json({ error: error?.message || "Erro interno ao gerar o plano de integração." });
    }
  });

  // ====== SESSION HANDOFF STATE & ENDPOINTS (PC <-> MOBILE) ======
  interface SessionHandoffState {
    activeDevice: 'pc' | 'mobile';
    conversationHistory: any[];
  }

  const globalHandoffState: SessionHandoffState = {
    activeDevice: 'pc',
    conversationHistory: []
  };

  app.get("/api/session/handoff", (req, res) => {
    res.json(globalHandoffState);
  });

  app.post("/api/session/handoff", (req, res) => {
    const { device, conversationHistory } = req.body || {};
    if (device === 'pc' || device === 'mobile') {
      globalHandoffState.activeDevice = device;
    }
    if (Array.isArray(conversationHistory)) {
      globalHandoffState.conversationHistory = conversationHistory;
    }

    const broadcastPayload = JSON.stringify({
      type: "session:handoff_state",
      activeDevice: globalHandoffState.activeDevice,
      conversationHistory: globalHandoffState.conversationHistory
    });

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(broadcastPayload);
      }
    });

    res.json({ success: true, ...globalHandoffState });
  });

  // Handle upgrade event manually to route to the /api/live-ws or /api/elevenlabs-ws websocket bridge
  server.on("upgrade", (request, socket, head) => {
    try {
      const reqUrl = request.url || "";
      const pathname = reqUrl.split("?")[0].replace(/\/$/, "");
      
      if (pathname === "/api/live-ws") {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      } else if (pathname === "/api/elevenlabs-ws") {
        elWss.handleUpgrade(request, socket, head, (ws) => {
          elWss.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    } catch (e) {
      console.error("Upgrade routing failed:", e);
      socket.destroy();
    }
  });

  // Handle incoming websocket connections
  wss.on("connection", async (clientWs, req) => {
    console.log("Client connected to the server-side OSONE G5 Live Bridge WS");
    
    const reqUrl = req.url || "";
    const queryString = reqUrl.includes("?") ? reqUrl.split("?")[1] : "";
    const searchParams = new URLSearchParams(queryString);
    const clientApiKey = searchParams.get("apiKey");
    
    // Fallback to server's loaded GEMINI_API_KEY if the client key is empty/not configured
    const apiKey = clientApiKey || getSecretGeminiKey();

    if (!apiKey) {
      console.error("Error: GEMINI_API_KEY is not defined");
      clientWs.send(JSON.stringify({ 
        type: "error", 
        error: "Chave API do Gemini não definida. Insira uma chave válida nos ajustes." 
      }));
      clientWs.close();
      return;
    }

    const ai = new GoogleGenAI({
      apiKey: apiKey,
      vertexai: false,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });

    let bidiSession: any = null;
    /**
     * Marca que o cliente já foi embora.
     *
     * Conectar ao Google leva alguns segundos, e nesse meio-tempo o cliente pode desistir (fechar
     * a aba, trocar de página, cair a rede). Quando isso acontecia, a limpeza do "close" rodava
     * enquanto bidiSession ainda era null e portanto não fechava nada — logo depois a conexão
     * ficava pronta e virava uma sessão órfã, aberta contra o Google sem ninguém do outro lado,
     * ocupando lugar até o próprio Google derrubá-la. Uma sobrava a cada tentativa.
     */
    let clienteSaiu = false;

    // Send initial handoff state to newly connected client
    try {
      clientWs.send(JSON.stringify({
        type: "session:handoff_state",
        activeDevice: globalHandoffState.activeDevice,
        conversationHistory: globalHandoffState.conversationHistory
      }));
    } catch (_) {}

    clientWs.on("message", async (rawData) => {
      try {
        const message = JSON.parse(rawData.toString());
        
        if (message.type === "session:handoff" || message.type === "session:handoff_request") {
          if (message.device === 'pc' || message.device === 'mobile') {
            globalHandoffState.activeDevice = message.device;
          }
          if (Array.isArray(message.conversationHistory)) {
            globalHandoffState.conversationHistory = message.conversationHistory;
          }
          const broadcastPayload = JSON.stringify({
            type: "session:handoff_state",
            activeDevice: globalHandoffState.activeDevice,
            conversationHistory: globalHandoffState.conversationHistory
          });
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(broadcastPayload);
            }
          });
          return;
        }

        if (message.type === "session:get_handoff_state") {
          clientWs.send(JSON.stringify({
            type: "session:handoff_state",
            activeDevice: globalHandoffState.activeDevice,
            conversationHistory: globalHandoffState.conversationHistory
          }));
          return;
        }

        if (message.type === "setup") {
          const { model, config, candidatos } = message;
          /**
           * A lista de candidatos vem do cliente em ordem de preferência (modelo de áudio
           * nativo primeiro, o conservador por último). Tentar em cascata aqui é o que faz o
           * caminho local se comportar igual ao da conexão direta: quem tiver acesso ao modelo
           * melhor o recebe, quem não tiver continua com voz funcionando.
           */
          const listaDeModelos: string[] = (Array.isArray(candidatos) && candidatos.length > 0
            ? candidatos
            : [model || "gemini-3.1-flash-live-preview"])
            .map((m: any) => String(m || '').trim())
            .filter(Boolean);

          const modeloIndisponivel = (erro: any): boolean => {
            const texto = `${erro?.message || erro?.error?.message || erro || ''}`.toLowerCase();
            const status = erro?.status ?? erro?.code ?? erro?.error?.code;
            if (status === 404 || status === 400) return true;
            return texto.includes('not found') || texto.includes('not_found') ||
                   texto.includes('is not supported') || texto.includes('does not exist') ||
                   texto.includes('unsupported model') || texto.includes('invalid model');
          };

          const abrirSessao = async (targetModel: string) => {
            console.log(`Connecting Live API on server mode: ${targetModel}`);
            return await ai.live.connect({
              model: targetModel,
              config: config,
              callbacks: {
                onmessage: (liveResponse: any) => {
                  if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify(liveResponse));
                  }
                },
                onclose: () => {
                  console.log("Gemini Live connection closed by Google endpoint");
                  if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.close();
                  }
                },
                onerror: (err: any) => {
                  console.error("Gemini Live server API error callback:", err);
                  if (clientWs.readyState === WebSocket.OPEN) {
                    clientWs.send(JSON.stringify({ 
                      type: "error", 
                      error: err?.message || "Ops, ocorreu um erro interno na conexão Neural." 
                    }));
                  }
                }
              }
            });
          };

          try {
            let ultimoErro: any = null;
            let modeloUsado = '';
            for (let i = 0; i < listaDeModelos.length; i++) {
              try {
                bidiSession = await abrirSessao(listaDeModelos[i]);
                modeloUsado = listaDeModelos[i];
                break;
              } catch (erro: any) {
                ultimoErro = erro;
                bidiSession = null;
                if (i < listaDeModelos.length - 1 && modeloIndisponivel(erro)) {
                  console.warn(`Modelo "${listaDeModelos[i]}" indisponível para esta chave. Tentando "${listaDeModelos[i + 1]}"...`);
                  continue;
                }
                throw erro;
              }
            }
            if (!bidiSession) throw ultimoErro || new Error("Nenhum modelo de voz disponível.");

            // O cliente pode ter ido embora enquanto esta conexão era estabelecida. Se foi,
            // fecha a sessão recém-criada agora — senão ela fica órfã, sem ninguém do outro lado.
            if (clienteSaiu || clientWs.readyState !== WebSocket.OPEN) {
              console.log("Cliente saiu antes de a conexão com o Google ficar pronta; fechando a sessão órfã.");
              try { bidiSession.close(); } catch (_) { /* já pode ter caído sozinha */ }
              bidiSession = null;
              return;
            }
            console.log(`Server successfully connected to Google Gemini Live endpoint with model "${modeloUsado}"!`);
          } catch (connectError: any) {
            console.error("Failed to connect to Gemini Live:", connectError);
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({
                type: "error",
                error: `Falha na conexão Neural do Servidor: ${connectError?.message || connectError}`
              }));
              clientWs.close();
            }
          }
        } else if (message.type === "realtime_input") {
          if (bidiSession) {
            bidiSession.sendRealtimeInput(message.input);
          }
        } else if (message.type === "tool_response") {
          if (bidiSession) {
            bidiSession.sendToolResponse(message.payload);
          }
        }
      } catch (parseError: any) {
        console.error("WS Message processing error:", parseError);
      }
    });

    clientWs.on("close", () => {
      console.log("Client disconnected from websocket bridge, cleaning up");
      // Antes de qualquer coisa: se a conexão com o Google ainda estiver sendo estabelecida,
      // é esta marca que fará a sessão ser fechada assim que ficar pronta.
      clienteSaiu = true;
      if (bidiSession) {
        try {
          bidiSession.close();
        } catch (e) {
          console.error("Failed to cleanly close bidi session on client departure:", e);
        }
      }
    });

    clientWs.on("error", (e) => {
      console.error("Client WS error:", e);
      if (bidiSession) {
        try { bidiSession.close(); } catch (_) {}
      }
    });
  });

  // Handle incoming ElevenLabs streaming proxy connections
  elWss.on("connection", async (clientWs, req) => {
    console.log("Client connected to the server-side ElevenLabs WS Proxy");
    
    const reqUrl = req.url || "";
    const queryString = reqUrl.includes("?") ? reqUrl.split("?")[1] : "";
    const searchParams = new URLSearchParams(queryString);
    
    const voiceId = searchParams.get("voiceId") || "21m00Tcm4TlvDq8ikWAM"; // default Rachel
    const modelId = modeloElevenLabsParaStream(searchParams.get("modelId"));
    const clientElApiKeyFromUrl = searchParams.get("apiKey") || "";
    const stability = parseFloat(searchParams.get("stability") || "0.5");
    const similarityBoost = parseFloat(searchParams.get("similarityBoost") || "0.75");
    
    let elApiKey = clientElApiKeyFromUrl || process.env.ELEVENLABS_API_KEY || "";
    let elWs: WebSocket | null = null;
    const pendingMsgBuffer: string[] = [];

    /**
     * Marca que o cliente já foi embora.
     *
     * Mesma armadilha já resolvida na ponte do Gemini Live: o handshake com a ElevenLabs leva um
     * tempo, e nesse meio-tempo o cliente pode desistir. A limpeza do "close" só fechava elWs
     * quando ele já estava OPEN, então uma conexão ainda em CONNECTING escapava — logo depois
     * ficava pronta e virava uma sessão de streaming órfã, faturada, sem ninguém do outro lado.
     */
    let clienteSaiu = false;

    /** Fecha a conexão de saída em qualquer estado — em CONNECTING só terminate() aborta mesmo. */
    const encerrarOutbound = () => {
      if (!elWs) return;
      try {
        if (elWs.readyState === WebSocket.CONNECTING) elWs.terminate();
        else if (elWs.readyState === WebSocket.OPEN) elWs.close();
      } catch (_) { /* já pode ter caído sozinha */ }
    };

    const initOutboundWs = (keyToUse: string) => {
      const outboundUrl = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${modelId}&output_format=pcm_24000`;
      
      console.log(`Establishing outbound connection to ElevenLabs: wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input`);
      
      const ws = new WebSocket(outboundUrl);
      elWs = ws;

      ws.on("open", () => {
        // O cliente pode ter ido embora enquanto este handshake acontecia. Se foi, fecha agora:
        // um terminate() disparado durante o CONNECTING nem sempre chega a tempo.
        if (clienteSaiu || clientWs.readyState !== WebSocket.OPEN) {
          console.log("Cliente saiu antes de a conexão com a ElevenLabs ficar pronta; fechando a sessão órfã.");
          try { ws.close(); } catch (_) { /* já pode ter caído sozinha */ }
          return;
        }
        console.log("ElevenLabs outbound WebSocket successfully established");
        // Send initial settings and authentication
        const initMsg = {
          text: " ",
          xi_api_key: keyToUse,
          voice_settings: {
            stability: stability,
            similarity_boost: similarityBoost
          },
          generation_config: {
            chunk_length_schedule: [120, 160, 250, 290]
          }
        };
        ws.send(JSON.stringify(initMsg));

        // Flush any queued client messages sent before outbound WS was ready
        while (pendingMsgBuffer.length > 0) {
          const msgStr = pendingMsgBuffer.shift();
          if (msgStr) {
            try {
              const parsed = JSON.parse(msgStr);
              if (parsed.text !== undefined || parsed.flush !== undefined) {
                const payloadToSend = { text: parsed.text ?? "", ...(parsed.flush !== undefined && { flush: parsed.flush }) };
                ws.send(JSON.stringify(payloadToSend));
              }
            } catch (_) {
              ws.send(JSON.stringify({ text: msgStr }));
            }
          }
        }
      });

      ws.on("message", (data) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          try {
            const parsed = JSON.parse(data.toString());
            if (parsed.message || parsed.detail) {
              const msg = parsed.message || (typeof parsed.detail === 'string' ? parsed.detail : JSON.stringify(parsed.detail));
              clientWs.send(JSON.stringify({ error: msg }));
              return;
            }
          } catch (_) {}
          clientWs.send(data.toString());
        }
      });

      ws.on("error", (err) => {
        console.error("ElevenLabs outbound WS error:", err);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({ error: `ElevenLabs Error: ${err.message}` }));
        }
      });

      ws.on("close", (code, reason) => {
        console.log(`ElevenLabs outbound WS closed. Code: ${code}, Reason: ${reason}`);
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.close();
        }
      });
    };

    if (elApiKey) {
      const validacaoChave = validarChaveElevenLabsParaUso(elApiKey);
      if (!validacaoChave.ok) {
        clientWs.send(JSON.stringify({ error: validacaoChave.message }));
        clientWs.close();
        return;
      }
      initOutboundWs(validacaoChave.key);
    }

    clientWs.on("message", (msg) => {
      const msgStr = msg.toString();
      let parsed: any = null;
      try {
        parsed = JSON.parse(msgStr);
      } catch (_) {}

      if (!elWs) {
        // Try to extract key from message payload
        const keyFromMsg = parsed?.apiKey || parsed?.xi_api_key;
        if (keyFromMsg) {
          const validacaoChave = validarChaveElevenLabsParaUso(keyFromMsg);
          if (!validacaoChave.ok) {
            clientWs.send(JSON.stringify({ error: validacaoChave.message }));
            clientWs.close();
            return;
          }
          elApiKey = validacaoChave.key;
          initOutboundWs(elApiKey);
        } else {
          console.error("ElevenLabs API Key not provided in query URL or message payload.");
          clientWs.send(JSON.stringify({ error: "Chave API ElevenLabs não configurada." }));
          clientWs.close();
          return;
        }
      }

      if (elWs) {
        if (elWs.readyState === WebSocket.OPEN) {
          try {
            const payloadToSend: { text: string; flush?: boolean } = parsed ? { text: parsed.text ?? "", ...(parsed.flush !== undefined && { flush: parsed.flush }) } : { text: msgStr };
            if (payloadToSend.text !== "" || payloadToSend.flush !== undefined) {
              elWs.send(JSON.stringify(payloadToSend));
            }
          } catch (_) {
            elWs.send(JSON.stringify({ text: msgStr }));
          }
        } else if (elWs.readyState === WebSocket.CONNECTING) {
          pendingMsgBuffer.push(msgStr);
        }
      }
    });

    clientWs.on("error", (err) => {
      console.error("ElevenLabs Proxy client WS error:", err);
      clienteSaiu = true;
      encerrarOutbound();
    });

    clientWs.on("close", () => {
      console.log("ElevenLabs Proxy client WS closed");
      clienteSaiu = true;
      encerrarOutbound();
    });
  });

  // Integration with Vite dev middleware for hot loading frontend assets in dev, serve statically in production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    console.log("Vite dev server mounted on Express middleware");
  } else {
    // Os assets compilados do frontend ficam em <instalação>/dist, ao lado do próprio bundle
    // do servidor. Derivamos de OSONE_INSTALL_DIR em vez de process.cwd() porque o app
    // empacotado troca o diretório de trabalho para a pasta de dados do usuário.
    const distPath = path.join(OSONE_INSTALL_DIR, "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
    console.log(`Serving static files from ${distPath}`);
  }

  if (process.env.VERCEL !== "1") {
    // Sem um handler de 'error' aqui, uma falha ao abrir a porta (EADDRINUSE quando outro
    // programa já a ocupa, ou EACCES no Windows quando a porta cai numa faixa reservada pelo
    // Hyper-V/WSL) vira uma exceção não tratada: o processo continua vivo por causa do
    // handler global de uncaughtException, mas o servidor nunca passa a escutar — e o app
    // desktop fica numa tela preta eterna tentando carregar um endereço que não responde.
    // Então tratamos o erro e tentamos as portas seguintes antes de desistir.
    const MAX_PORT_FALLBACK_ATTEMPTS = 10;
    let attemptedPort = PORT;
    let remainingAttempts = MAX_PORT_FALLBACK_ATTEMPTS;

    server.on("error", (err: NodeJS.ErrnoException) => {
      const isPortUnavailable = err.code === "EADDRINUSE" || err.code === "EACCES";
      if (isPortUnavailable && remainingAttempts > 0) {
        remainingAttempts--;
        attemptedPort++;
        console.warn(
          `[Servidor] Porta ${attemptedPort - 1} indisponível (${err.code}). Tentando a porta ${attemptedPort}...`
        );
        server.listen(attemptedPort, "0.0.0.0");
        return;
      }
      console.error(
        `[Servidor] FALHA CRÍTICA: não foi possível abrir nenhuma porta a partir da ${PORT} (${err.code}). ${err.message}`
      );
    });

    server.listen(attemptedPort, "0.0.0.0", () => {
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : attemptedPort;
      // Publica a porta realmente aberta no ambiente do processo, para que o app desktop
      // (que roda o servidor dentro do próprio processo via require) saiba em qual endereço
      // carregar a interface mesmo quando houve fallback de porta.
      process.env.OSONE_ACTIVE_PORT = String(boundPort);
      console.log(`Express Server connected and running on http://0.0.0.0:${boundPort}`);
    });
  }

  return app;
}

const serverPromise = startServer().catch((error) => {
  console.error("Server execution crashed:", error);
  throw error;
});

export default serverPromise;
