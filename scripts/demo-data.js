// Datos inventados para probar la web sin Azure (DEMO_MODE=true).
// Genera 3 motos alrededor de Madrid que envían una lectura cada 2 segundos:
//   - moto-01 simula llegar por el Edge: trae "status" y "reasons", y cada
//     ~2 minutos tiene una caída con su alerta (messageType = alert).
//   - moto-02 y moto-03 simulan llegar directas al IoT Hub (sin "status"):
//     la página calcula su estado. moto-02 se sobrecalienta de vez en cuando.

const CENTER = { lat: 40.4168, lon: -3.7038 };
const INTERVAL_MS = 2000;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function noise(a) { return (Math.random() * 2 - 1) * a; }
function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f; }

class DemoMoto {
  constructor(motoId, viaEdge, offsetLat, offsetLon) {
    this.motoId = motoId;
    this.viaEdge = viaEdge;
    this.lat = CENTER.lat + offsetLat;
    this.lon = CENTER.lon + offsetLon;
    this.heading = Math.random() * 2 * Math.PI;
    this.speed = 40;
    this.targetSpeed = 60;
    this.lean = 0;
    this.temp = 85;
    this.battery = 13.9;
    this.fuel = 60 + Math.random() * 30;
    this.overheatLeft = 0;
    this.crashLeft = 0;
    this.tick = 0;
  }

  next() {
    this.tick += 1;
    const dt = INTERVAL_MS / 1000;
    const prevSpeed = this.speed;

    if (this.crashLeft > 0) {
      this.crashLeft -= dt;
      this.speed = this.speed > 8 ? this.speed * 0.15 : 0;
      this.lean = 87;
    } else {
      if (this.tick % 12 === 0) this.targetSpeed = [30, 50, 80, 100, 125][Math.floor(Math.random() * 5)];
      const diff = this.targetSpeed - this.speed;
      this.speed = clamp(this.speed + clamp(diff, -15 * dt, 8 * dt) + noise(1), 0, 160);
      const leanTarget = this.speed > 20 && this.tick % 10 < 4 ? 30 * Math.sin(this.tick) : 0;
      this.lean += clamp(leanTarget - this.lean, -30, 30);
    }

    // Se mueve hacia donde mira, girando con la inclinación y volviendo al centro si se aleja
    const v = this.speed / 3.6;
    this.heading += clamp(this.lean / 200, -0.4, 0.4);
    const dLat = CENTER.lat - this.lat;
    const dLon = CENTER.lon - this.lon;
    if (Math.hypot(dLat, dLon) > 0.05) this.heading = Math.atan2(dLon, dLat);
    this.lat += (v * dt * Math.cos(this.heading)) / 111320;
    this.lon += (v * dt * Math.sin(this.heading)) / (111320 * Math.cos(this.lat * Math.PI / 180));

    const rpm = this.speed < 3 ? 1200 : clamp(this.speed * 75 + noise(200), 1500, 11000);
    if (this.overheatLeft > 0) this.overheatLeft -= dt;
    const tempTarget = this.overheatLeft > 0 ? 118 : 82 + rpm / 1000;
    this.temp += (tempTarget - this.temp) * 0.08;
    this.battery = rpm > 2000 ? 13.9 + noise(0.05) : 12.7 + noise(0.05);
    this.fuel = Math.max(5, this.fuel - this.speed * 0.00012 * dt * 10);

    return {
      motoId: this.motoId,
      timestamp: new Date().toISOString(),
      latitude: round(this.lat, 6),
      longitude: round(this.lon, 6),
      speed: round(this.speed, 1),
      rpm: Math.round(rpm),
      engineTemperature: round(this.temp, 1),
      battery: round(this.battery, 2),
      fuelLevel: round(this.fuel, 1),
      tirePressureFront: round(2.3 + noise(0.01), 2),
      tirePressureRear: round(2.5 + noise(0.01), 2),
      leanAngle: round(this.lean + noise(0.5), 1),
      acceleration: round((this.speed - prevSpeed) / 3.6 / dt / 9.81, 2),
    };
  }
}

// Mismas reglas que el módulo MotorcycleHealthMonitor (versión reducida)
function edgeStatus(t, crashActive) {
  const critical = [];
  const warning = [];
  if (crashActive) critical.push('Crash detected');
  if (t.engineTemperature > 110) critical.push('Engine overheating');
  else if (t.engineTemperature > 100) warning.push('High engine temperature');
  if (t.speed > 120) warning.push('Speeding');
  let status = 'NORMAL';
  if (critical.length) status = 'CRITICAL';
  else if (warning.length) status = 'WARNING';
  return { status, reasons: critical.concat(warning) };
}

class DemoData {
  constructor() {
    this.motos = [
      new DemoMoto('moto-01', true, 0.01, -0.01),
      new DemoMoto('moto-02', false, -0.012, 0.008),
      new DemoMoto('moto-03', false, 0.005, 0.015),
    ];
  }

  start(callback) {
    let tick = 0;
    setInterval(() => {
      tick += 1;
      const [m1, m2] = this.motos;
      if (tick % 60 === 20) m1.crashLeft = 30;        // caída de moto-01 cada 2 minutos
      if (tick % 75 === 40) m2.overheatLeft = 40;     // sobrecalentamiento de moto-02

      this.motos.forEach((moto) => {
        const t = moto.next();
        if (moto.viaEdge) {
          const crashActive = moto.crashLeft > 0 && t.speed <= 5;
          const { status, reasons } = edgeStatus(t, crashActive);
          Object.assign(t, { status, reasons, crashActive, processedAt: new Date().toISOString() });

          if (crashActive && !moto.alertSent) {
            moto.alertSent = true;
            callback({
              alertType: 'CRASH',
              severity: 'CRITICAL',
              motoId: moto.motoId,
              detectedAt: new Date().toISOString(),
              latitude: t.latitude,
              longitude: t.longitude,
              leanAngle: t.leanAngle,
              speedBeforeCrash: 72,
              impactG: -1.09,
              message: 'Crash detected: impact of -1.09 g at 72 km/h, motorcycle lying at 87 degrees',
            }, new Date(), 'edgedevicehealthmonitor', { messageType: 'alert', status: 'CRITICAL' });
          }
          if (!crashActive) moto.alertSent = false;
          callback(t, new Date(), 'edgedevicehealthmonitor', { messageType: 'telemetry', status });
        } else {
          callback(t, new Date(), moto.motoId, { messageType: 'telemetry' });
        }
      });
    }, INTERVAL_MS);
  }
}

module.exports = DemoData;
