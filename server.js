// Servidor de la web de motos.
// Basado en web-apps-node-iot-hub-data-visualization (práctica de ISS):
// lee los mensajes del IoT Hub con EventHubReader y los reenvía al navegador
// por WebSocket. Cambios respecto al original:
//   - Identifica cada moto por el campo "motoId" del mensaje (los mensajes del
//     Edge llegan todos con el deviceId del dispositivo Edge).
//   - Distingue telemetría y alertas de caída (propiedad "messageType").
//   - Guarda el último estado de cada moto y las últimas alertas, y se los
//     manda a cada navegador que se conecta (así la página no sale vacía).
//   - Modo demo (DEMO_MODE=true): datos inventados, sin necesidad de Azure.

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const EventHubReader = require('./scripts/event-hub-reader.js');
const DemoData = require('./scripts/demo-data.js');

const demoMode = (process.env.DEMO_MODE || '').toLowerCase() === 'true';
const iotHubConnectionString = process.env.IotHubConnectionString;
const eventHubConsumerGroup = process.env.EventHubConsumerGroup;

if (!demoMode) {
  if (!iotHubConnectionString) {
    console.error('Environment variable IotHubConnectionString must be specified (or DEMO_MODE=true).');
    process.exit(1);
  }
  if (!eventHubConsumerGroup) {
    console.error('Environment variable EventHubConsumerGroup must be specified (or DEMO_MODE=true).');
    process.exit(1);
  }
  // No se imprime la connection string entera: daría acceso al IoT Hub a quien vea los logs
  const hostName = (iotHubConnectionString.match(/HostName=([^;]+)/) || [])[1] || '?';
  console.log(`Using IoT Hub [${hostName}] with consumer group [${eventHubConsumerGroup}]`);
} else {
  console.log('DEMO_MODE: generating fake motorcycle data, IoT Hub is not used.');
}

// --------------------------------------------------------------- web y WebSocket

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res /* , next */) => {
  res.redirect('/');
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Último estado de cada moto y últimas alertas (en memoria)
const MAX_ALERTS = 30;
const latestByMoto = new Map();
const recentAlerts = [];

wss.broadcast = (data) => {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(data);
      } catch (e) {
        console.error(e);
      }
    }
  });
};

// Al conectarse un navegador, se le manda lo que ya sabemos
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'snapshot',
    motos: Array.from(latestByMoto.values()),
    alerts: recentAlerts,
  }));
});

server.listen(process.env.PORT || '3000', () => {
  console.log('Listening on %d.', server.address().port);
});

// --------------------------------------------------------------- mensajes

// El cuerpo puede llegar ya como objeto, como texto o como bytes
function parseBody(body) {
  if (body === null || body === undefined) return null;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) body = Buffer.from(body).toString('utf8');
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch (e) {
      return null;
    }
  }
  return typeof body === 'object' ? body : null;
}

function handleMessage(body, enqueuedTime, deviceId, properties) {
  const data = parseBody(body);
  if (!data) {
    console.warn('Ignoring message that is not JSON from [%s]', deviceId);
    return;
  }

  const props = properties || {};
  const isAlert = props.messageType === 'alert' || data.alertType !== undefined;

  const message = {
    type: isAlert ? 'alert' : 'telemetry',
    motoId: data.motoId || deviceId || 'unknown',
    deviceId,
    receivedAt: new Date(enqueuedTime || Date.now()).toISOString(),
    data,
  };

  if (isAlert) {
    recentAlerts.unshift(message);
    if (recentAlerts.length > MAX_ALERTS) recentAlerts.pop();
    console.log('ALERT from %s: %s', message.motoId, data.message || data.alertType);
  } else {
    latestByMoto.set(message.motoId, message);
  }

  wss.broadcast(JSON.stringify(message));
}

if (demoMode) {
  new DemoData().start(handleMessage);
} else {
  const eventHubReader = new EventHubReader(iotHubConnectionString, eventHubConsumerGroup);
  (async () => {
    await eventHubReader.startReadMessage(handleMessage);
  })().catch((err) => console.error(err));
}
