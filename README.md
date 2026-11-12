# Moto Fleet – Web en tiempo real

Dashboard web de las motos: mapa en directo, una tarjeta por moto, gráficas y panel de alertas de caídas.

Parte de [web-apps-node-iot-hub-data-visualization](https://github.com/ETSISI-ISS/web-apps-node-iot-hub-data-visualization) (práctica de ISS) y funciona igual: `server.js` lee los mensajes del IoT Hub y los reenvía al navegador por WebSocket.

| Archivo | Qué hace | Respecto a la práctica |
|---|---|---|
| `server.js` | Lee del IoT Hub y reenvía al navegador | Identifica la moto por `motoId`, distingue alertas, guarda el último estado, modo demo |
| `scripts/event-hub-reader.js` | Lector del IoT Hub | Igual, pero también pasa las propiedades del mensaje |
| `scripts/iot-hub-connection-string.js` | Convierte la connection string | Sin cambios |
| `scripts/demo-data.js` | Datos inventados para probar sin Azure | Nuevo |
| `public/index.html`, `css/style.css`, `js/dashboard.js` | La página | Nuevos (sustituyen a `chart-device-data.js`) |

## Qué muestra

- **Mapa** (Leaflet) con cada moto en verde, naranja o rojo según su estado, y el rastro de la moto seleccionada.
- **Tarjetas por moto**: velocidad, inclinación, rpm, temperatura del motor, batería, gasolina y presión de neumáticos. Los valores fuera de rango salen en naranja o rojo.
- **Gráficas** de la moto seleccionada: velocidad + rpm y temperatura del motor + batería (últimos 2 minutos).
- **Alertas**: caídas detectadas por el Edge y cambios a AVISO o CRÍTICO.

Acepta los dos tipos de mensaje del proyecto:

- **Vía Edge** (`MotorcycleHealthMonitor`): ya traen `status` y `reasons`, y las caídas llegan como mensajes con `messageType = alert`.
- **Directos al IoT Hub** (`simulated-device-moto`): no traen estado, así que la página lo calcula con los mismos umbrales que el Edge, caídas incluidas.

## Probar en local sin Azure (modo demo)

```powershell
npm install
npm run demo
```

Abre http://localhost:3000. Salen 3 motos inventadas; `moto-01` tiene una caída cada 2 minutos.

## Ejecutar en local con el IoT Hub

1. Crea un consumer group solo para la web (el de Stream Analytics tiene que ser otro):

   ```bash
   az iot hub consumer-group create --hub-name MotorcycleIoTHub --name webapp
   ```

2. Copia la connection string **service** del hub:

   ```bash
   az iot hub connection-string show --hub-name MotorcycleIoTHub --policy-name service --output tsv
   ```

3. En PowerShell:

   ```powershell
   $env:IotHubConnectionString = "HostName=MotorcycleIoTHub.azure-devices.net;SharedAccessKeyName=service;SharedAccessKey=..."
   $env:EventHubConsumerGroup = "webapp"
   npm install
   npm start
   ```

La connection string no se escribe en ningún archivo del repositorio.

## Desplegar en Azure App Service (como en la práctica)

Como este repositorio solo contiene la web, sirve el método de la práctica con Local Git:

```bash
az appservice plan create --name myserviceplan --resource-group MotorcycleIoTEdgeResources --sku FREE --is-linux --location westeurope
az webapp create --name <nombre-unico> --resource-group MotorcycleIoTEdgeResources --plan myserviceplan --runtime "NODE:20-lts" --deployment-local-git
az webapp config set --name <nombre-unico> --resource-group MotorcycleIoTEdgeResources --web-sockets-enabled true
az webapp config appsettings set --name <nombre-unico> --resource-group MotorcycleIoTEdgeResources \
  --settings IotHubConnectionString="<connection string service>" EventHubConsumerGroup=webapp
```

Después, como en la práctica, añade el remoto de Git que devuelve `az webapp create` y haz `git push webapp main:master`.

- Si el plan gratuito da error de cuota, prueba otra región (`--location`). Si al final usas un plan de Windows (sin `--is-linux`), el runtime se escribe distinto: búscalo con `az webapp list-runtimes --os windows`.
- Sin **WebSockets** activado la página se queda en "Sin conexión, reintentando…".

## Detalles

- Leaflet 1.9.4 y Chart.js 4.4.4 se cargan desde CDN, igual que el Chart.js de la práctica.
- El mapa usa los mosaicos de OpenStreetMap (no necesitan API key), oscurecidos con un filtro CSS en `style.css` (`.leaflet-tile-pane`). Los de CARTO ya piden API key.
- Los umbrales de los colores están al principio de `public/js/dashboard.js` (objeto `T`). Si cambiáis los del Edge, cambiadlos también aquí.
