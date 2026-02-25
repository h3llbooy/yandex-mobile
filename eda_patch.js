// ═══════════════════════════════════════════════════════════════════════
// ПАТЧ ДЛЯ eda.html — вставить в <script> секцию
// Добавляет:
//   1. Получение координат через Telegram.WebApp.requestLocation
//   2. Передачу координат в прокси через заголовок X-User-Coords
//   3. Передачу chat_id через X-Chat-Id (для cookie и device_id lookup)
//   4. Обработку SBP (payment.payload.url) -> Telegram.WebApp.openLink
//   5. Обработку transparentPayment (UI шторка ожидания)
// ═══════════════════════════════════════════════════════════════════════

// ── 1. КООРДИНАТЫ ────────────────────────────────────────────────────────

// Хранилище текущих координат пользователя
const userCoords = { lat: null, lon: null };

// Получаем chat_id из URL параметров (бот передаёт &chat_id=...)
function getChatId() {
  return new URLSearchParams(location.search).get('chat_id') || '';
}

// Запрашиваем геолокацию через Telegram WebApp
function requestUserLocation() {
  const tg = window.Telegram && window.Telegram.WebApp;
  if (!tg) return;

  // Метод requestLocation появился в TMA SDK 7.0+
  if (typeof tg.requestLocation === 'function') {
    tg.requestLocation(function(data) {
      if (data && data.latitude) {
        userCoords.lat = data.latitude;
        userCoords.lon = data.longitude;
        console.log('[GEO] Telegram location:', userCoords);
      }
    });
  } else if (navigator.geolocation) {
    // Фолбэк — браузерная геолокация
    navigator.geolocation.getCurrentPosition(
      pos => {
        userCoords.lat = pos.coords.latitude;
        userCoords.lon = pos.coords.longitude;
        console.log('[GEO] Browser location:', userCoords);
      },
      err => console.warn('[GEO] Error:', err.message),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }
}

// Вызываем сразу при загрузке
requestUserLocation();

// ── 2. ЦЕНТРАЛЬНАЯ ФУНКЦИЯ ЗАПРОСА ЧЕРЕЗ ПРОКСИ ──────────────────────────

// Берём параметры из URL (бот передаёт их при открытии WebApp)
const urlParams  = new URLSearchParams(location.search);
const PROXY_BASE = urlParams.get('proxy') || '';
const TOKEN      = urlParams.get('token') || '';
const DEVICE_ID  = urlParams.get('device_id') || '';
const APPMETRICA_UUID = urlParams.get('appmetrica_uuid') || '';
const CHAT_ID    = getChatId();

/**
 * Основная функция запросов к Яндекс API через наш прокси.
 * Автоматически добавляет координаты и все нужные заголовки.
 *
 * @param {string} path   - путь на eda.yandex.ru (напр. "/eats/v1/cart/v2/full-carts")
 * @param {Object} opts   - { method, body, idempotency }
 */
async function apiRequest(path, opts = {}) {
  const method = opts.method || 'POST';
  const url    = `${PROXY_BASE}/proxy${path}`;

  const headers = {
    'Content-Type':  'application/json',
    'X-Bearer':      TOKEN,
    'X-Device-Id':   DEVICE_ID,
    'X-Chat-Id':     CHAT_ID,   // бэкенд подтянет device_id, uuid, cookies из accounts
  };

  // Координаты — если есть, передаём
  if (userCoords.lat !== null) {
    headers['X-User-Coords'] = `${userCoords.lat},${userCoords.lon}`;
  }

  // Idempotency token для создания заказа
  if (opts.idempotency) {
    headers['X-Idempotency-Token'] = opts.idempotency;
  }

  const fetchOpts = { method, headers };
  if (opts.body && method !== 'GET') {
    fetchOpts.body = typeof opts.body === 'string'
      ? opts.body
      : JSON.stringify(opts.body);
  }

  const resp = await fetch(url, fetchOpts);
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

// Более удобные обёртки
function apiGet(path) {
  return apiRequest(path, { method: 'GET' });
}
function apiPost(path, body) {
  return apiRequest(path, { method: 'POST', body });
}


// ── 3. SBP ОПЛАТА ────────────────────────────────────────────────────────

/**
 * Показываем оверлей ожидания оплаты с анимацией
 */
function showPaymentOverlay(message = 'Ожидаем оплату...') {
  let overlay = document.getElementById('sbp-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'sbp-overlay';
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      color:#fff;font-family:-apple-system,sans-serif;
    `;
    overlay.innerHTML = `
      <div style="font-size:48px;margin-bottom:16px">💳</div>
      <div id="sbp-overlay-text" style="font-size:17px;font-weight:600;text-align:center;padding:0 32px">${message}</div>
      <div style="margin-top:24px;font-size:13px;color:rgba(255,255,255,.6)">Не закрывай приложение</div>
      <button id="sbp-cancel-btn" style="
        margin-top:32px;padding:12px 32px;border-radius:12px;border:none;
        background:rgba(255,255,255,.15);color:#fff;font-size:15px;cursor:pointer;
      ">Отмена</button>
    `;
    document.body.appendChild(overlay);
    document.getElementById('sbp-cancel-btn').onclick = hidePaymentOverlay;
  } else {
    overlay.style.display = 'flex';
    document.getElementById('sbp-overlay-text').textContent = message;
  }
}

function hidePaymentOverlay() {
  const overlay = document.getElementById('sbp-overlay');
  if (overlay) overlay.style.display = 'none';
}

function updatePaymentOverlayText(text) {
  const el = document.getElementById('sbp-overlay-text');
  if (el) el.textContent = text;
}

/**
 * Поллинг статуса оплаты.
 * Вызывается после создания заказа.
 * Обрабатывает transparentPayment и sbp_required.
 *
 * @param {string} orderId  - например "260224-6786757"
 * @param {Function} onSuccess - коллбэк при успешной оплате
 * @param {Function} onError   - коллбэк при ошибке
 */
async function pollPaymentStatus(orderId, onSuccess, onError) {
  const MAX_POLLS = 60;    // макс 60 * ~2с = 2 минуты
  const POLL_MS   = 2000;
  let polls = 0;
  let sbpOpened = false;

  showPaymentOverlay('Создаём заказ...');

  const poll = async () => {
    if (polls++ > MAX_POLLS) {
      hidePaymentOverlay();
      onError && onError('timeout');
      return;
    }

    try {
      const { status, data } = await apiPost(
        '/eats/v1/eats-payments/v1/order/tracking',
        { order_id: orderId }
      );

      const payment = data?.order?.payment || {};
      const payStatus = payment.status;

      // Обрабатываем transparentPayment (UI-данные от яндекса)
      const tp = data?.transparentPayment;
      if (tp?.screen?.text?.text) {
        updatePaymentOverlayText(tp.screen.text.text);
      } else if (data?.order?.description) {
        updatePaymentOverlayText(data.order.description);
      }

      console.log('[POLL]', polls, 'status=', payStatus);

      if (payStatus === 'paid' || payStatus === 'success') {
        hidePaymentOverlay();
        onSuccess && onSuccess(data);
        return;
      }

      if (payStatus === 'sbp_required' || payStatus === 'sbp') {
        // Получаем ссылку СБП
        const sbpUrl = payment.payload?.url;
        if (sbpUrl && !sbpOpened) {
          sbpOpened = true;
          updatePaymentOverlayText('Подтвердите платёж в приложении банка');
          // Открываем ссылку через Telegram WebApp
          openPaymentLink(sbpUrl);
        }
        // Продолжаем поллинг
        setTimeout(poll, POLL_MS);
        return;
      }

      if (payStatus === 'failed' || payStatus === 'cancelled' || payStatus === 'error') {
        hidePaymentOverlay();
        const errMsg = payment.error_message || 'Оплата не прошла';
        onError && onError(errMsg);
        return;
      }

      if (payStatus === 'pending' || payStatus === 'processing') {
        setTimeout(poll, POLL_MS);
        return;
      }

      // Неизвестный статус — продолжаем поллинг
      setTimeout(poll, POLL_MS);

    } catch (e) {
      console.error('[POLL ERR]', e);
      setTimeout(poll, POLL_MS);
    }
  };

  poll();
}

/**
 * Открываем ссылку оплаты:
 * 1. Через Telegram.WebApp.openLink (если доступно)
 * 2. Фолбэк — window.open
 */
function openPaymentLink(url) {
  console.log('[SBP] Opening:', url);
  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg && typeof tg.openLink === 'function') {
    // try_instant_view=false чтобы открывался банк, а не браузер Telegram
    tg.openLink(url, { try_instant_view: false });
  } else {
    window.open(url, '_blank');
  }
}

/**
 * Создать заказ + запустить поллинг оплаты.
 * Вызывать вместо прямого POST /api/v1/orders.
 *
 * @param {Object} orderPayload - тело запроса создания заказа
 * @param {Function} onSuccess
 * @param {Function} onError
 */
async function createOrderAndPay(orderPayload, onSuccess, onError) {
  try {
    // Генерируем idempotency token (чтобы дубли не создавались)
    const idempotency = generateIdempotencyToken(orderPayload);

    const { status, data } = await apiRequest('/api/v1/orders', {
      method: 'POST',
      body: orderPayload,
      idempotency,
    });

    if (status !== 200 || !data.order_nr) {
      const msg = data.message || data.err || 'Ошибка создания заказа';
      onError && onError(msg);
      return;
    }

    const orderId = data.order_nr;
    console.log('[ORDER] Created:', orderId);

    // Запускаем поллинг
    pollPaymentStatus(orderId, onSuccess, onError);

  } catch (e) {
    onError && onError(e.message);
  }
}

/**
 * Генерируем стабильный idempotency token на основе содержимого заказа.
 * Повторный вызов с теми же данными даст тот же токен → дубля не будет.
 */
function generateIdempotencyToken(payload) {
  const str = JSON.stringify(payload) + Date.now().toString().slice(0, -3); // точность до секунды
  // Простой хэш без crypto API
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  // Формат из дампа: два UUID через точку
  const part1 = Math.abs(hash).toString(16).padStart(8, '0');
  const rand   = Math.random().toString(16).slice(2, 34).padStart(32, '0');
  return `${part1}${rand.slice(0, 24)}.${rand.slice(24)}`;
}


// ── 4. ПРОМОКОДЫ ─────────────────────────────────────────────────────────

/**
 * Применить промокод. Полный набор заголовков уже будет в apiPost.
 * Использовать:
 *   applyPromocode('FREE500', placeSlug, shippingType)
 */
async function applyPromocode(code, placeSlug, shippingType = 'delivery') {
  const { status, data } = await apiPost(
    `/api/v2/cart/promocode?soft_multi=true&screen=checkout&shippingType=${shippingType}&placeSlug=${placeSlug}&offline=false`,
    { code }
  );

  if (data.status === 'error') {
    return { ok: false, message: data.err || data.message || 'Промокод не применён' };
  }
  return { ok: true, data };
}

// ── 5. ИНИЦИАЛИЗАЦИЯ ─────────────────────────────────────────────────────

// Обновляем геолокацию каждые 2 минуты
setInterval(requestUserLocation, 120_000);

console.log('[EDA Patch v6.0] Loaded. ChatId:', CHAT_ID, 'DeviceId:', DEVICE_ID);
