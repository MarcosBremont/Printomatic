'use strict';

/* ============================================================
   CONFIGURACIÓN LOCAL
   Precios por defecto usados si el backend no expone /api/prices.
   ============================================================ */
const DEFAULT_PRICES = {
  bw: 1.0,     // precio por página en blanco/negro
  color: 3.0,  // precio por página a color
  currency: 'MXN'
};

const STATUS_POLL_INTERVAL_MS = 15000;
const STORAGE_KEY_SERVER = 'printomatic_server';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ============================================================
   ESTADO
   ============================================================ */
const state = {
  serverUrl: null,       // ej: "https://192.168.1.50:8080"
  serverOnline: null,
  file: null,
  totalPages: 0,
  copies: 1,
  color: false,
  rangeMode: 'all',      // 'all' | 'custom'
  rangeText: '',
  selectedPageCount: 0,
  prices: { ...DEFAULT_PRICES }
};

let statusPollTimer = null;

/* ============================================================
   REFERENCIAS AL DOM
   ============================================================ */
const el = (id) => document.getElementById(id);

const dom = {
  statusBtn: el('btn-status'),
  statusText: el('status-text'),
  settingsBtn: el('btn-settings'),

  dropzone: el('dropzone'),
  fileInput: el('file-input'),
  uploadError: el('upload-error'),
  readingIndicator: el('reading-indicator'),

  fileName: el('file-name'),
  filePages: el('file-pages'),
  btnChangeFile: el('btn-change-file'),

  inputCopies: el('input-copies'),
  btnCopiesMinus: el('btn-copies-minus'),
  btnCopiesPlus: el('btn-copies-plus'),

  inputRange: el('input-page-range'),
  rangeError: el('range-error'),

  quotePages: el('quote-pages'),
  quoteUnitPrice: el('quote-unit-price'),
  quoteCopies: el('quote-copies'),
  quoteTotal: el('quote-total'),
  btnToConfirm: el('btn-to-confirm'),

  cFile: el('c-file'),
  cTotalPages: el('c-total-pages'),
  cRange: el('c-range'),
  cColor: el('c-color'),
  cCopies: el('c-copies'),
  cTotal: el('c-total'),
  btnPay: el('btn-pay'),
  btnBackOptions: el('btn-back-options'),

  resultContent: el('result-content'),
  btnNewOrder: el('btn-new-order'),

  modalSettings: el('modal-settings'),
  inputServer: el('input-server'),
  settingsStatus: el('settings-status'),
  btnTestConnection: el('btn-test-connection'),
  btnSaveServer: el('btn-save-server')
};

/* ============================================================
   UTILIDADES
   ============================================================ */
function formatCurrency(amount) {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: state.prices.currency || 'MXN'
  }).format(amount);
}

function normalizeServerInput(raw) {
  let value = (raw || '').trim();
  if (!value) return null;
  if (!/^https?:\/\//i.test(value)) {
    // Sin protocolo explícito: se asume el mismo protocolo de la página.
    // Nota: si esta PWA corre sobre HTTPS (GitHub Pages) y el servidor local
    // solo habla HTTP, el navegador bloqueará la petición por "mixed content".
    // En ese caso el usuario debe escribir el protocolo explícitamente
    // (ej. "http://192.168.1.50:8080") y habilitar contenido inseguro para
    // este sitio, o exponer el servidor local por HTTPS.
    const protocol = window.location.protocol === 'https:' ? 'https://' : 'http://';
    value = protocol + value;
  }
  return value.replace(/\/+$/, '');
}

function goToScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  el(id).classList.add('active');
}

function setStepper(stepNumber) {
  document.querySelectorAll('.step-dot').forEach((dot) => {
    const n = Number(dot.dataset.step);
    dot.classList.remove('active', 'done');
    if (n < stepNumber) dot.classList.add('done');
    else if (n === stepNumber) dot.classList.add('active');
  });
}

/* ============================================================
   SERVIDOR: RESOLUCIÓN INICIAL Y ESTADO DE CONEXIÓN
   ============================================================ */
function resolveInitialServer() {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('server');
  if (fromUrl) {
    const normalized = normalizeServerInput(fromUrl);
    localStorage.setItem(STORAGE_KEY_SERVER, normalized);
    return normalized;
  }
  return localStorage.getItem(STORAGE_KEY_SERVER);
}

function setStatusUI(status, message) {
  dom.statusBtn.classList.remove('status-online', 'status-offline', 'status-unknown');
  dom.statusBtn.classList.add(`status-${status}`);
  dom.statusText.textContent = message;
}

async function checkServerStatus() {
  if (!state.serverUrl) {
    setStatusUI('offline', 'Sin configurar');
    state.serverOnline = false;
    return false;
  }
  setStatusUI('unknown', 'Verificando…');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${state.serverUrl}/api/status`, {
      method: 'GET',
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error('status not ok');

    state.serverOnline = true;
    setStatusUI('online', 'Conectado');
    await tryLoadPrices();
    return true;
  } catch (err) {
    state.serverOnline = false;
    setStatusUI('offline', 'Sin conexión');
    return false;
  }
}

async function tryLoadPrices() {
  try {
    const res = await fetch(`${state.serverUrl}/api/prices`);
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.bw === 'number' && typeof data.color === 'number') {
      state.prices.bw = data.bw;
      state.prices.color = data.color;
      state.prices.currency = data.currency || state.prices.currency;
      updateQuote();
    }
  } catch (err) {
    // El backend puede no exponer este endpoint: se conservan los
    // precios locales definidos en DEFAULT_PRICES.
  }
}

function startStatusPolling() {
  if (statusPollTimer) clearInterval(statusPollTimer);
  statusPollTimer = setInterval(checkServerStatus, STATUS_POLL_INTERVAL_MS);
}

/* ============================================================
   MODAL DE CONFIGURACIÓN DE SERVIDOR
   ============================================================ */
function openSettingsModal() {
  dom.inputServer.value = state.serverUrl ? state.serverUrl.replace(/^https?:\/\//, '') : '';
  dom.settingsStatus.classList.add('hidden');
  dom.modalSettings.classList.remove('hidden');
}

function closeSettingsModal() {
  dom.modalSettings.classList.add('hidden');
}

function showSettingsStatus(kind, message) {
  dom.settingsStatus.classList.remove('hidden', 'alert-error', 'alert-success');
  dom.settingsStatus.classList.add(kind === 'error' ? 'alert-error' : 'alert-success');
  dom.settingsStatus.textContent = message;
}

async function handleTestConnection() {
  const candidate = normalizeServerInput(dom.inputServer.value);
  if (!candidate) {
    showSettingsStatus('error', 'Ingresa una dirección de servidor válida.');
    return;
  }
  const previous = state.serverUrl;
  state.serverUrl = candidate;
  dom.btnTestConnection.disabled = true;
  dom.btnTestConnection.textContent = 'Probando…';
  const ok = await checkServerStatus();
  dom.btnTestConnection.disabled = false;
  dom.btnTestConnection.textContent = 'Probar conexión';
  if (ok) {
    showSettingsStatus('success', 'Conexión exitosa con el servidor.');
  } else {
    showSettingsStatus('error', 'No se pudo conectar con el servidor.');
    state.serverUrl = previous;
  }
}

function handleSaveServer() {
  const candidate = normalizeServerInput(dom.inputServer.value);
  if (!candidate) {
    showSettingsStatus('error', 'Ingresa una dirección de servidor válida.');
    return;
  }
  state.serverUrl = candidate;
  localStorage.setItem(STORAGE_KEY_SERVER, candidate);
  closeSettingsModal();
  checkServerStatus();
  startStatusPolling();
}

/* ============================================================
   PASO 1: SUBIDA Y LECTURA DEL PDF
   ============================================================ */
function showUploadError(message) {
  dom.uploadError.textContent = message;
  dom.uploadError.classList.remove('hidden');
}

function clearUploadError() {
  dom.uploadError.classList.add('hidden');
  dom.uploadError.textContent = '';
}

async function handleFileSelected(file) {
  clearUploadError();

  if (!file) return;
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    showUploadError('El archivo debe estar en formato PDF.');
    return;
  }

  dom.readingIndicator.classList.remove('hidden');
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const numPages = pdf.numPages;

    if (!numPages || numPages < 1) {
      throw new Error('El PDF no contiene páginas.');
    }

    state.file = file;
    state.totalPages = numPages;
    state.copies = 1;
    state.color = false;
    state.rangeMode = 'all';
    state.rangeText = '';

    dom.readingIndicator.classList.add('hidden');
    enterOptionsScreen();
  } catch (err) {
    dom.readingIndicator.classList.add('hidden');
    showUploadError('No se pudo leer el PDF. Verifica que el archivo no esté dañado o protegido.');
  }
}

/* ============================================================
   PASO 2: OPCIONES Y COTIZADOR
   ============================================================ */
function enterOptionsScreen() {
  dom.fileName.textContent = state.file.name;
  dom.filePages.textContent = `${state.totalPages} página${state.totalPages === 1 ? '' : 's'}`;

  dom.inputCopies.value = state.copies;
  setColorMode(false);
  setRangeMode('all');
  dom.inputRange.value = '';
  dom.rangeError.classList.add('hidden');

  updateQuote();
  goToScreen('screen-options');
  setStepper(2);
}

function setColorMode(isColor) {
  state.color = isColor;
  document.querySelectorAll('.segmented-btn[data-color]').forEach((btn) => {
    const active = (btn.dataset.color === 'true') === isColor;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', String(active));
  });
  updateQuote();
}

function setRangeMode(mode) {
  state.rangeMode = mode;
  document.querySelectorAll('.segmented-btn[data-range]').forEach((btn) => {
    const active = btn.dataset.range === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', String(active));
  });
  dom.inputRange.classList.toggle('hidden', mode !== 'custom');
  dom.rangeError.classList.add('hidden');
  updateQuote();
}

/**
 * Interpreta un string de rango de páginas (ej: "1-3", "2", "1,3,5", "2-4,7")
 * y devuelve la lista de páginas únicas y ordenadas dentro de los límites del documento.
 * Devuelve null si el formato es inválido.
 */
function parsePageRange(text, totalPages) {
  const cleaned = (text || '').trim();
  if (!cleaned) return null;

  const pages = new Set();
  const parts = cleaned.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  for (const part of parts) {
    const rangeMatch = part.match(/^(\d+)\s*-\s*(\d+)$/);
    const singleMatch = part.match(/^(\d+)$/);

    if (rangeMatch) {
      let start = parseInt(rangeMatch[1], 10);
      let end = parseInt(rangeMatch[2], 10);
      if (start > end) [start, end] = [end, start];
      if (start < 1 || end > totalPages) return null;
      for (let p = start; p <= end; p++) pages.add(p);
    } else if (singleMatch) {
      const p = parseInt(singleMatch[1], 10);
      if (p < 1 || p > totalPages) return null;
      pages.add(p);
    } else {
      return null;
    }
  }

  return Array.from(pages).sort((a, b) => a - b);
}

function getPagesString() {
  if (state.rangeMode === 'all') return 'all';
  return dom.inputRange.value.trim();
}

function updateQuote() {
  let pageCount;

  if (state.rangeMode === 'all') {
    pageCount = state.totalPages;
    dom.rangeError.classList.add('hidden');
  } else {
    const parsed = parsePageRange(dom.inputRange.value, state.totalPages);
    if (parsed === null && dom.inputRange.value.trim() !== '') {
      dom.rangeError.textContent = `Rango inválido. Usa el formato "1-3" o "2" (páginas entre 1 y ${state.totalPages}).`;
      dom.rangeError.classList.remove('hidden');
      pageCount = 0;
    } else if (parsed === null) {
      pageCount = 0;
      dom.rangeError.classList.add('hidden');
    } else {
      pageCount = parsed.length;
      dom.rangeError.classList.add('hidden');
    }
  }

  state.selectedPageCount = pageCount;
  state.copies = Math.max(1, parseInt(dom.inputCopies.value, 10) || 1);

  const unitPrice = state.color ? state.prices.color : state.prices.bw;
  const total = pageCount * state.copies * unitPrice;

  dom.quotePages.textContent = String(pageCount);
  dom.quoteUnitPrice.textContent = formatCurrency(unitPrice);
  dom.quoteCopies.textContent = String(state.copies);
  dom.quoteTotal.textContent = formatCurrency(total);

  dom.btnToConfirm.disabled = pageCount === 0;
}

/* ============================================================
   PASO 3: CONFIRMACIÓN
   ============================================================ */
function enterConfirmScreen() {
  const unitPrice = state.color ? state.prices.color : state.prices.bw;
  const total = state.selectedPageCount * state.copies * unitPrice;

  dom.cFile.textContent = state.file.name;
  dom.cTotalPages.textContent = `${state.totalPages}`;
  dom.cRange.textContent = state.rangeMode === 'all'
    ? `Todas (${state.selectedPageCount})`
    : `${dom.inputRange.value.trim()} (${state.selectedPageCount} pág.)`;
  dom.cColor.textContent = state.color ? 'Color' : 'Blanco / Negro';
  dom.cCopies.textContent = String(state.copies);
  dom.cTotal.textContent = formatCurrency(total);

  goToScreen('screen-confirm');
  setStepper(3);
}

/* ============================================================
   PASO 4 y 5: ENVÍO DE LA ORDEN
   ============================================================ */
async function submitPrintOrder() {
  goToScreen('screen-sending');

  const formData = new FormData();
  formData.append('file', state.file, state.file.name);
  formData.append('copies', String(state.copies));
  formData.append('color', String(state.color));
  formData.append('pages', getPagesString());

  try {
    const res = await fetch(`${state.serverUrl}/api/print`, {
      method: 'POST',
      body: formData
    });

    if (!res.ok) {
      throw new Error(`El servidor respondió con estado ${res.status}`);
    }

    showResult(true, 'Orden enviada con éxito. Recoge tus copias en la bandeja de salida.');
  } catch (err) {
    showResult(false, 'No se pudo comunicar con el servidor de impresión. Verifica la conexión e intenta de nuevo.');
  }
}

function showResult(success, message) {
  const iconSuccess = `
    <svg viewBox="0 0 24 24" fill="none"><path d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const iconError = `
    <svg viewBox="0 0 24 24" fill="none"><path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  dom.resultContent.innerHTML = `
    <div class="result-icon ${success ? 'success' : 'error'}">${success ? iconSuccess : iconError}</div>
    <h1>${success ? '¡Listo!' : 'Ocurrió un error'}</h1>
    <p class="subtitle">${message}</p>
  `;

  goToScreen('screen-result');
}

function resetOrder() {
  state.file = null;
  state.totalPages = 0;
  state.copies = 1;
  state.color = false;
  state.rangeMode = 'all';
  state.selectedPageCount = 0;
  dom.fileInput.value = '';
  clearUploadError();
  goToScreen('screen-upload');
  setStepper(1);
}

/* ============================================================
   EVENTOS
   ============================================================ */
dom.fileInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  handleFileSelected(file);
});

['dragover', 'dragenter'].forEach((evt) => {
  dom.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dom.dropzone.classList.add('dragover');
  });
});

['dragleave', 'drop'].forEach((evt) => {
  dom.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dom.dropzone.classList.remove('dragover');
  });
});

dom.dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  handleFileSelected(file);
});

dom.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    dom.fileInput.click();
  }
});

dom.btnChangeFile.addEventListener('click', resetOrder);

dom.btnCopiesMinus.addEventListener('click', () => {
  dom.inputCopies.value = Math.max(1, (parseInt(dom.inputCopies.value, 10) || 1) - 1);
  updateQuote();
});

dom.btnCopiesPlus.addEventListener('click', () => {
  dom.inputCopies.value = (parseInt(dom.inputCopies.value, 10) || 1) + 1;
  updateQuote();
});

dom.inputCopies.addEventListener('input', updateQuote);
dom.inputCopies.addEventListener('blur', () => {
  if (!dom.inputCopies.value || parseInt(dom.inputCopies.value, 10) < 1) {
    dom.inputCopies.value = 1;
    updateQuote();
  }
});

document.querySelectorAll('.segmented-btn[data-color]').forEach((btn) => {
  btn.addEventListener('click', () => setColorMode(btn.dataset.color === 'true'));
});

document.querySelectorAll('.segmented-btn[data-range]').forEach((btn) => {
  btn.addEventListener('click', () => setRangeMode(btn.dataset.range));
});

dom.inputRange.addEventListener('input', updateQuote);

dom.btnToConfirm.addEventListener('click', enterConfirmScreen);
dom.btnBackOptions.addEventListener('click', () => {
  goToScreen('screen-options');
  setStepper(2);
});

dom.btnPay.addEventListener('click', () => {
  if (!state.serverOnline) {
    showResult(false, 'El servidor de impresión no está disponible en este momento. Intenta más tarde o avisa a un encargado.');
    return;
  }
  submitPrintOrder();
});

dom.btnNewOrder.addEventListener('click', resetOrder);

dom.statusBtn.addEventListener('click', openSettingsModal);
dom.settingsBtn.addEventListener('click', openSettingsModal);
dom.btnTestConnection.addEventListener('click', handleTestConnection);
dom.btnSaveServer.addEventListener('click', handleSaveServer);
dom.modalSettings.addEventListener('click', (e) => {
  if (e.target === dom.modalSettings) closeSettingsModal();
});

/* ============================================================
   INICIALIZACIÓN
   ============================================================ */
function init() {
  state.serverUrl = resolveInitialServer();

  if (state.serverUrl) {
    checkServerStatus();
    startStatusPolling();
  } else {
    setStatusUI('offline', 'Sin configurar');
    openSettingsModal();
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {
        // El registro del service worker puede fallar en contextos no
        // seguros (http) o durante desarrollo local: no es crítico.
      });
    });
  }
}

init();
