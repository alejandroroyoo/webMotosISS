/* Moto Fleet · lógica de la página.
 * Recibe por WebSocket los mensajes que reenvía server.js:
 *   { type: 'snapshot',  motos: [...], alerts: [...] }   al conectarse
 *   { type: 'telemetry', motoId, deviceId, receivedAt, data }
 *   { type: 'alert',     motoId, deviceId, receivedAt, data }   caída detectada en el Edge
 * (Hace lo mismo que chart-device-data.js de la práctica, pero con mapa,
 *  tarjetas por moto y alertas.)
 */
(() => {
  // ------------------------------------------------------------ umbrales
  // Los mismos que el módulo Edge MotorcycleHealthMonitor. Se usan para las
  // motos que llegan directas al IoT Hub (sin "status" calculado en el Edge).
  const T = {
    tempCrit: 110, tempWarn: 100,
    batCrit: 11.8, batWarn: 12.2,
    tireCrit: 1.8, tireWarn: 2.0,
    rpmCrit: 10200, rpmWarn: 9500,
    speedWarn: 120, fuelWarn: 10,
    crashLean: 60, crashSpeed: 5,
  };
  const HISTORY = 60;          // puntos en las gráficas (2 minutos a 1 lectura cada 2 s)
  const TRAIL = 80;            // posiciones en el rastro del mapa
  const STALE_MS = 30000;      // sin datos durante 30 s => tarjeta apagada
  const MAX_ALERTS = 40;

  const COLORS = { NORMAL: '#2fd17c', WARNING: '#f5b031', CRITICAL: '#ff4040' };
  const STATUS_TEXT = { NORMAL: 'NORMAL', WARNING: 'AVISO', CRITICAL: 'CRÍTICO' };
  const REASON_TEXT = {
    'Crash detected': 'Caída detectada',
    'Engine overheating': 'Motor sobrecalentado',
    'High engine temperature': 'Temperatura del motor alta',
    'Low battery': 'Batería baja',
    'Battery dropping': 'La batería está bajando',
    'Low tire pressure (front)': 'Presión baja (delantera)',
    'Low tire pressure (rear)': 'Presión baja (trasera)',
    'Tire pressure dropping (front)': 'Pierde presión (delantera)',
    'Tire pressure dropping (rear)': 'Pierde presión (trasera)',
    'Excessive RPM': 'Revoluciones excesivas',
    'High RPM': 'Revoluciones altas',
    Speeding: 'Exceso de velocidad',
    'Low fuel': 'Poca gasolina',
  };

  const motos = new Map();      // motoId -> estado de la moto en la página
  const alerts = [];
  let selectedId = null;
  let map;
  let didFitMap = false;
  let chartSpeed;
  let chartEngine;

  const $ = (id) => document.getElementById(id);
  const translate = (r) => REASON_TEXT[r] || r;
  const fmt = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');
  const isValidTime = (t) => t !== undefined && t !== null && !Number.isNaN(new Date(t).getTime());
  const timeOf = (iso) => new Date(iso).toLocaleTimeString('es-ES', { hour12: false });

  // ------------------------------------------------------------ estado de una lectura

  /** Devuelve { status, reasons } y la gravedad de cada campo. */
  function evaluate(d) {
    const level = {};
    const crit = [];
    const warn = [];
    const check = (field, value, isCrit, isWarn, critReason, warnReason) => {
      if (typeof value !== 'number') return;
      if (isCrit(value)) { level[field] = 'CRITICAL'; if (critReason) crit.push(critReason); } else if (isWarn(value)) { level[field] = 'WARNING'; if (warnReason) warn.push(warnReason); }
    };
    check('temp', d.engineTemperature, (v) => v > T.tempCrit, (v) => v > T.tempWarn, 'Engine overheating', 'High engine temperature');
    check('battery', d.battery, (v) => v < T.batCrit, (v) => v < T.batWarn, 'Low battery', 'Battery dropping');
    check('front', d.tirePressureFront, (v) => v < T.tireCrit, (v) => v < T.tireWarn, 'Low tire pressure (front)', 'Tire pressure dropping (front)');
    check('rear', d.tirePressureRear, (v) => v < T.tireCrit, (v) => v < T.tireWarn, 'Low tire pressure (rear)', 'Tire pressure dropping (rear)');
    check('rpm', d.rpm, (v) => v > T.rpmCrit, (v) => v > T.rpmWarn, 'Excessive RPM', 'High RPM');
    check('speed', d.speed, () => false, (v) => v > T.speedWarn, null, 'Speeding');
    check('fuel', d.fuelLevel, () => false, (v) => v < T.fuelWarn, null, 'Low fuel');

    const lyingDown = Math.abs(d.leanAngle || 0) >= T.crashLean && (d.speed || 0) <= T.crashSpeed;
    if (lyingDown) { level.lean = 'CRITICAL'; crit.unshift('Crash detected'); }

    // Si el Edge ya ha calculado el estado, manda el suyo
    if (d.status) {
      return { status: d.status, reasons: d.reasons || [], level, fromEdge: true };
    }
    let status = 'NORMAL';
    if (crit.length) status = 'CRITICAL';
    else if (warn.length) status = 'WARNING';
    return { status, reasons: crit.concat(warn), level, fromEdge: false };
  }

  // ------------------------------------------------------------ mapa

  function initMap() {
    map = L.map('map', { zoomControl: true, attributionControl: true }).setView([40.4168, -3.7038], 12);
    // Mosaicos de OpenStreetMap (sin API key). Se oscurecen por CSS (.leaflet-tile-pane)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
  }

  function updateMarker(moto) {
    const d = moto.latest.data;
    if (typeof d.latitude !== 'number' || typeof d.longitude !== 'number') return;
    const pos = [d.latitude, d.longitude];
    const color = COLORS[moto.eval.status] || COLORS.NORMAL;

    if (!moto.marker) {
      moto.trail = L.polyline([], { color: '#ff6a1a', weight: 3, opacity: 0.7 }).addTo(map);
      moto.marker = L.circleMarker(pos, {
        radius: 9, weight: 3, color: '#0d0f13', fillColor: color, fillOpacity: 1,
      }).addTo(map);
      // Con un string, Leaflet lo mete como HTML; con un elemento, el id va como texto
      const label = document.createElement('span');
      label.textContent = moto.id;
      moto.marker.bindTooltip(label, {
        permanent: true, direction: 'right', offset: [10, 0], className: 'moto-label',
      });
      moto.marker.on('click', () => select(moto.id));
    }
    moto.marker.setLatLng(pos);
    moto.marker.setStyle({ fillColor: color, radius: moto.eval.status === 'CRITICAL' ? 11 : 9 });

    moto.positions.push(pos);
    if (moto.positions.length > TRAIL) moto.positions.shift();
    moto.trail.setLatLngs(moto.id === selectedId ? moto.positions : []);
  }

  function fitMapOnce() {
    if (didFitMap) return;
    const points = Array.from(motos.values()).filter((m) => m.positions.length).map((m) => m.positions.at(-1));
    if (!points.length) return;
    didFitMap = true;
    if (points.length === 1) map.setView(points[0], 14);
    else map.fitBounds(points, { padding: [40, 40], maxZoom: 15 });
  }

  // ------------------------------------------------------------ tarjetas

  function createCard(moto) {
    const node = $('cardTemplate').content.firstElementChild.cloneNode(true);
    node.querySelector('.card-id').textContent = moto.id;
    node.addEventListener('click', () => select(moto.id));
    $('cards').appendChild(node);
    $('noMotos').hidden = true;
    return node;
  }

  function setField(card, name, text, level) {
    const el = card.querySelector(`[data-f="${name}"]`);
    if (!el) return;
    el.textContent = text;
    el.classList.remove('WARNING', 'CRITICAL');
    if (level) el.classList.add(level);
  }

  function renderCard(moto) {
    const { card } = moto;
    const d = moto.latest.data;
    const { status, reasons, level } = moto.eval;

    card.classList.remove('NORMAL', 'WARNING', 'CRITICAL');
    card.classList.add(status);
    card.classList.toggle('selected', moto.id === selectedId);

    const pill = card.querySelector('.pill');
    pill.className = `pill ${status}`;
    pill.textContent = STATUS_TEXT[status] || status;

    setField(card, 'speed', fmt(d.speed), level.speed);
    setField(card, 'rpm', fmt(d.rpm), level.rpm);
    setField(card, 'temp', `${fmt(d.engineTemperature, 1)} °C`, level.temp);
    setField(card, 'battery', `${fmt(d.battery, 2)} V`, level.battery);
    setField(card, 'fuel', `${fmt(d.fuelLevel)} %`, level.fuel);
    setField(card, 'front', `${fmt(d.tirePressureFront, 2)} bar`, level.front);
    setField(card, 'rear', `${fmt(d.tirePressureRear, 2)} bar`, level.rear);
    setField(card, 'lean', `${fmt(d.leanAngle)}°`, level.lean);
    card.querySelector('.lean-bar').style.transform = `rotate(${Math.max(-90, Math.min(90, d.leanAngle || 0))}deg)`;
    setField(card, 'reasons', reasons.map(translate).join(' · '));
    setField(card, 'source', moto.eval.fromEdge ? 'vía Edge' : 'directo al IoT Hub');
  }

  function refreshAges() {
    const now = Date.now();
    motos.forEach((moto) => {
      const ms = now - moto.lastSeen;
      const s = Math.round(ms / 1000);
      setField(moto.card, 'ago', s < 60 ? `hace ${s} s` : `hace ${Math.round(s / 60)} min`);
      moto.card.classList.toggle('stale', ms > STALE_MS);
    });
  }

  // ------------------------------------------------------------ gráficas

  function makeChart(canvas, left, right) {
    const axisColor = '#8a93a6';
    const gridColor = 'rgba(138, 147, 166, 0.12)';
    return new Chart(canvas, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: left.label, data: [], yAxisID: 'y', borderColor: left.color, backgroundColor: left.color, borderWidth: 2, pointRadius: 0, tension: 0.3 },
          { label: right.label, data: [], yAxisID: 'y1', borderColor: right.color, backgroundColor: right.color, borderWidth: 2, pointRadius: 0, tension: 0.3 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#e8eaf0', boxWidth: 12, boxHeight: 2 } },
          tooltip: { backgroundColor: '#1b1f29', borderColor: '#262b37', borderWidth: 1 },
        },
        scales: {
          x: { ticks: { color: axisColor, maxTicksLimit: 6, maxRotation: 0 }, grid: { color: gridColor } },
          y: { position: 'left', title: { display: true, text: left.unit, color: left.color }, ticks: { color: axisColor }, grid: { color: gridColor } },
          y1: { position: 'right', title: { display: true, text: right.unit, color: right.color }, ticks: { color: axisColor }, grid: { drawOnChartArea: false } },
        },
      },
    });
  }

  function initCharts() {
    chartSpeed = makeChart($('chartSpeed'),
      { label: 'Velocidad', unit: 'km/h', color: '#ff6a1a' },
      { label: 'RPM', unit: 'rpm', color: '#6aa8ff' });
    chartEngine = makeChart($('chartEngine'),
      { label: 'Temperatura motor', unit: '°C', color: '#ff4040' },
      { label: 'Batería', unit: 'V', color: '#2fd17c' });
  }

  function renderCharts() {
    const moto = motos.get(selectedId);
    if (!moto) return;
    const h = moto.history;
    chartSpeed.data.labels = h.time;
    chartSpeed.data.datasets[0].data = h.speed;
    chartSpeed.data.datasets[1].data = h.rpm;
    chartEngine.data.labels = h.time;
    chartEngine.data.datasets[0].data = h.temp;
    chartEngine.data.datasets[1].data = h.battery;
    chartSpeed.update();
    chartEngine.update();
    $('selectedName').textContent = moto.id;
    $('selectedReasons').textContent = moto.eval.reasons.map(translate).join(' · ');
  }

  function select(motoId) {
    selectedId = motoId;
    motos.forEach((m) => {
      m.card.classList.toggle('selected', m.id === motoId);
      if (m.trail) m.trail.setLatLngs(m.id === motoId ? m.positions : []);
    });
    renderCharts();
  }

  // ------------------------------------------------------------ alertas

  function addAlert(alert) {
    alerts.unshift(alert);
    if (alerts.length > MAX_ALERTS) alerts.pop();

    const li = document.createElement('li');
    li.className = `alert ${alert.severity}${alert.crash ? ' crash' : ''}`;

    const top = document.createElement('div');
    top.className = 'alert-top';
    const who = document.createElement('span');
    who.className = 'alert-moto';
    who.textContent = alert.motoId;
    const when = document.createElement('span');
    when.textContent = timeOf(alert.time);
    top.append(who, when);

    const title = document.createElement('p');
    title.className = 'alert-title';
    title.textContent = alert.title;

    const msg = document.createElement('p');
    msg.className = 'alert-msg';
    msg.textContent = alert.message;

    li.append(top, title, msg);

    if (typeof alert.lat === 'number' && typeof alert.lon === 'number') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Ver en el mapa';
      btn.addEventListener('click', () => {
        map.flyTo([alert.lat, alert.lon], 16);
        if (motos.has(alert.motoId)) select(alert.motoId);
      });
      li.append(btn);
    }

    const list = $('alerts');
    list.prepend(li);
    while (list.children.length > MAX_ALERTS) list.lastElementChild.remove();
    $('noAlerts').hidden = true;
  }

  // Alertas que manda el servidor (messageType = alert). Las caídas tienen su
  // propio texto; cualquier otro tipo se muestra con lo que traiga el mensaje.
  function addServerAlert(msg) {
    const d = msg.data;
    const time = isValidTime(d.detectedAt) ? d.detectedAt : msg.receivedAt;
    const isCrash = d.alertType === undefined || String(d.alertType).toUpperCase() === 'CRASH';
    if (!isCrash) {
      addAlert({
        crash: false,
        severity: d.severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
        motoId: msg.motoId,
        time,
        title: translate(d.alertType),
        message: d.message || '',
        lat: d.latitude,
        lon: d.longitude,
      });
      return;
    }
    addAlert({
      crash: true,
      severity: 'CRITICAL',
      motoId: msg.motoId,
      time,
      title: 'Caída detectada',
      message: typeof d.impactG === 'number'
        ? `Impacto de ${fmt(Math.abs(d.impactG), 2)} g a ${fmt(d.speedBeforeCrash)} km/h · moto tumbada a ${fmt(d.leanAngle)}°`
        : `Moto tumbada (${fmt(d.leanAngle)}°) y parada`,
      lat: d.latitude,
      lon: d.longitude,
    });
  }

  // Avisa cuando una moto pasa a un estado peor (para las motos sin Edge
  // es la única forma de enterarse de una caída)
  function statusChangeAlert(moto, previous) {
    const order = { NORMAL: 0, WARNING: 1, CRITICAL: 2 };
    const now = moto.eval.status;
    // Una moto nueva cuenta como NORMAL: si su primera lectura ya es mala, también avisa
    if (!(order[now] > order[previous || 'NORMAL'])) return;
    const d = moto.latest.data;
    const crash = moto.eval.reasons.includes('Crash detected');
    if (crash && moto.eval.fromEdge) return; // el Edge ya manda su propia alerta de caída
    addAlert({
      crash,
      severity: now,
      motoId: moto.id,
      time: moto.latest.receivedAt,
      title: crash ? 'Caída detectada' : `${STATUS_TEXT[now]}: ${moto.eval.reasons.map(translate).join(', ')}`,
      message: crash
        ? `Moto tumbada (${fmt(d.leanAngle)}°) y parada`
        : `Velocidad ${fmt(d.speed)} km/h · motor ${fmt(d.engineTemperature, 1)} °C`,
      lat: d.latitude,
      lon: d.longitude,
    });
  }

  // ------------------------------------------------------------ mensajes

  function handleTelemetry(msg, quiet) {
    let moto = motos.get(msg.motoId);
    if (!moto) {
      moto = {
        id: msg.motoId,
        positions: [],
        history: { time: [], speed: [], rpm: [], temp: [], battery: [] },
      };
      moto.card = createCard(moto);
      motos.set(moto.id, moto);
      if (!selectedId) selectedId = moto.id;
    }

    // Al reconectar, la foto del servidor repite la última lectura que ya tenemos:
    // no se vuelve a meter en las gráficas ni en el rastro
    if (quiet && moto.latest && moto.latest.receivedAt === msg.receivedAt) return;

    const previous = moto.eval ? moto.eval.status : null;
    moto.latest = msg;
    // Hora real de la lectura (no la de llegada al navegador): así una moto que
    // dejó de enviar hace rato sale apagada aunque venga en la foto inicial
    const received = Date.parse(msg.receivedAt);
    moto.lastSeen = Number.isNaN(received) ? Date.now() : Math.min(received, Date.now());
    moto.eval = evaluate(msg.data);

    const d = msg.data;
    const h = moto.history;
    h.time.push(timeOf(isValidTime(d.timestamp) ? d.timestamp : msg.receivedAt));
    h.speed.push(d.speed);
    h.rpm.push(d.rpm);
    h.temp.push(d.engineTemperature);
    h.battery.push(d.battery);
    if (h.time.length > HISTORY) Object.values(h).forEach((arr) => arr.shift());

    renderCard(moto);
    updateMarker(moto);
    if (!quiet) statusChangeAlert(moto, previous);
    if (moto.id === selectedId) renderCharts();
    updateCounters();
  }

  function updateCounters() {
    $('motoCount').textContent = motos.size;
    const critical = Array.from(motos.values()).filter((m) => m.eval.status === 'CRITICAL').length;
    $('criticalCount').textContent = critical;
    $('criticalCount').classList.toggle('has-critical', critical > 0);
  }

  function handleMessage(msg) {
    if (msg.type === 'snapshot') {
      // Al (re)conectar, el servidor manda las alertas que guarda: se empieza de cero
      alerts.length = 0;
      $('alerts').replaceChildren();
      (msg.alerts || []).slice().reverse().forEach(addServerAlert);
      (msg.motos || []).forEach((m) => handleTelemetry(m, true));
      fitMapOnce();
      select(selectedId);
    } else if (msg.type === 'alert') {
      addServerAlert(msg);
    } else if (msg.type === 'telemetry') {
      handleTelemetry(msg, false);
      fitMapOnce();
    }
  }

  // ------------------------------------------------------------ WebSocket

  function setConnection(state, text) {
    const el = $('connection');
    el.dataset.state = state;
    el.querySelector('.conn-text').textContent = text;
  }

  function connect() {
    // if deployed to a site supporting SSL, use wss:// (igual que en la práctica)
    const protocol = document.location.protocol.startsWith('https') ? 'wss://' : 'ws://';
    const ws = new WebSocket(protocol + document.location.host);
    ws.onopen = () => setConnection('open', 'En directo');
    ws.onmessage = (event) => {
      try {
        handleMessage(JSON.parse(event.data));
      } catch (err) {
        console.error('Bad message', err, event.data);
      }
    };
    ws.onclose = () => {
      setConnection('closed', 'Sin conexión, reintentando…');
      setTimeout(connect, 3000);
    };
  }

  // ------------------------------------------------------------ arranque

  initMap();
  initCharts();
  connect();
  setInterval(refreshAges, 1000);
})();
