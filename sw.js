// sw.js — Service Worker de rastreamento GPS em background
// Deve ficar na RAIZ do site (mesmo nível do checkin.html)
// Versão: 1.0

const SW_VERSION = 'gps-tracker-v1';
const TRACK_INTERVAL_MS = 10000; // 10s entre coletas

// Estado interno do SW
let trackingActive = false;
let sessionId      = null;
let supabaseUrl    = null;
let supabaseKey    = null;
let trackTimer     = null;
let pendingPoints  = []; // pontos coletados em background aguardando envio

// ── Instalação e ativação ──
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// ── Comunicação com a página ──
self.addEventListener('message', async (e) => {
  const { type, payload } = e.data || {};

  if (type === 'START_TRACKING') {
    sessionId   = payload.sessionId;
    supabaseUrl = payload.supabaseUrl;
    supabaseKey = payload.supabaseKey;
    trackingActive = true;
    pendingPoints  = [];
    startTrackLoop();
    e.source?.postMessage({ type: 'SW_READY' });
  }

  if (type === 'STOP_TRACKING') {
    stopTrackLoop();
    e.source?.postMessage({ type: 'SW_STOPPED' });
  }

  // A página enviou sua posição atual em resposta ao pedido do SW
  if (type === 'POSITION_RESPONSE' && payload) {
    await handlePosition(payload);
  }

  // A página voltou ao foco — envia pontos pendentes acumulados em background
  if (type === 'PAGE_VISIBLE') {
    await flushPending();
  }
});

// ── Loop de rastreamento ──
function startTrackLoop() {
  if (trackTimer) clearInterval(trackTimer);
  trackTimer = setInterval(requestPosition, TRACK_INTERVAL_MS);
}

function stopTrackLoop() {
  if (trackTimer) { clearInterval(trackTimer); trackTimer = null; }
  trackingActive = false;
}

// Pede posição para a página (se visível) ou acumula pedido
async function requestPosition() {
  if (!trackingActive || !sessionId) return;

  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

  if (clients.length === 0) {
    // Nenhuma aba aberta — acumula marcador de tempo para flush posterior
    pendingPoints.push({ type: 'REQUEST', ts: Date.now() });
    return;
  }

  // Envia pedido de posição para todas as abas do checkin
  clients.forEach(client => {
    client.postMessage({ type: 'REQUEST_POSITION', ts: Date.now() });
  });
}

// Processa uma posição recebida da página
async function handlePosition(pos) {
  if (!trackingActive || !sessionId || !supabaseUrl) return;

  const point = {
    session_id: sessionId,
    latitude:   pos.latitude,
    longitude:  pos.longitude,
    speed:      pos.speed || 0,
    timestamp:  new Date(pos.timestamp).toISOString()
  };

  // Tenta enviar imediatamente
  const sent = await sendPoint(point);
  if (!sent) {
    // Falhou (offline ou aba em background sem rede) — acumula para flush
    pendingPoints.push(point);
  }
}

// Envia um ponto ao Supabase
async function sendPoint(point) {
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/locations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey':        supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      },
      body: JSON.stringify(point)
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Envia todos os pontos acumulados quando a página volta ao foco
async function flushPending() {
  if (!pendingPoints.length) return;

  const toSend = pendingPoints.filter(p => p.session_id); // só pontos reais
  pendingPoints = [];

  for (const point of toSend) {
    await sendPoint(point);
  }

  // Notifica a página sobre quantos pontos foram enviados
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(c => c.postMessage({ type: 'FLUSH_DONE', count: toSend.length }));
}
