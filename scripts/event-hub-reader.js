/*
 * Microsoft Sample Code - Copyright (c) 2020 - Licensed MIT
 * (Igual que en la práctica; solo se añade el 4º parámetro del callback con las
 *  propiedades del mensaje, para saber si es telemetría o una alerta.)
 */

const { EventHubConsumerClient } = require('@azure/event-hubs');
const { convertIotHubToEventHubsConnectionString } = require('./iot-hub-connection-string.js');

class EventHubReader {
  constructor(iotHubConnectionString, consumerGroup) {
    this.iotHubConnectionString = iotHubConnectionString;
    this.consumerGroup = consumerGroup;
  }

  async startReadMessage(startReadMessageCallback) {
    try {
      const eventHubConnectionString = await convertIotHubToEventHubsConnectionString(this.iotHubConnectionString);
      this.consumerClient = new EventHubConsumerClient(this.consumerGroup, eventHubConnectionString);
      console.log('Successfully created the EventHubConsumerClient from IoT Hub event hub-compatible connection string.');

      const partitionIds = await this.consumerClient.getPartitionIds();
      console.log('The partition ids are: ', partitionIds);

      this.subscription = this.consumerClient.subscribe({
        processEvents: (events /* , context */) => {
          for (let i = 0; i < events.length; ++i) {
            startReadMessageCallback(
              events[i].body,
              events[i].enqueuedTimeUtc,
              events[i].systemProperties['iothub-connection-device-id'],
              events[i].properties,
            );
          }
        },
        processError: (err /* , context */) => {
          console.error(err.message || err);
        },
      });
    } catch (ex) {
      console.error(ex.message || ex);
    }
  }

  // Close connection to Event Hub.
  async stopReadMessage() {
    if (this.subscription) await this.subscription.close();
    if (this.consumerClient) await this.consumerClient.close();
  }
}

module.exports = EventHubReader;
