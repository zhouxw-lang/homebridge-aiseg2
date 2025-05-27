/* eslint-disable max-len */
import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { request as HttpRequest } from 'urllib';

import { Aiseg2Platform, Aiseg2Node } from './platform';

export interface ShutterDevice extends Aiseg2Node { // TODO
    displayName: string;
    manufacturer: string;
    model: string;
    serialNumber: string;
    firmwareRevision: string;
    disable?: string;
    state?: string;
    position?: number;
    accessory?: ShutterAccessory;
}


export enum OpenState {
  Open = '0x41',
  Closed = '0x42',
  Opening = '0x43',
  Closing = '0x44',
  HalfOpen = '0x45',
}

export class ShutterAccessory {
  private service: Service;

  private currentPosition = 0; // 0 = closed, 100 = open
  private targetPosition = 0;
  private positionState = 2; // Stopped

  constructor(
    private readonly platform: Aiseg2Platform,
    private readonly accessory: PlatformAccessory,
  ) {

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, accessory.context.device.manufacturer)
      .setCharacteristic(this.platform.Characteristic.Model, accessory.context.device.model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, accessory.context.device.serialNumber);

    const serviceType = this.platform.Service.WindowCovering;

    // get the WindowCovering service if it exists, otherwise create a new one
    this.service = this.accessory.getService(serviceType) || this.accessory.addService(serviceType);

    // set the service name for display as the default name in the Home app
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);

    // register handlers for the required characteristics

    this.service.getCharacteristic(this.platform.Characteristic.CurrentPosition)
      .onGet(this.getCurrentPosition.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetPosition)
      .onSet(this.setTargetPosition.bind(this))
      .onGet(this.getTargetPosition.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.PositionState)
      .onGet(this.getPositionState.bind(this));

  }

  private getCurrentPosition(): CharacteristicValue {
    return this.currentPosition;
  }

  private getTargetPosition(): CharacteristicValue {
    return this.targetPosition;
  }

  private getPositionState(): CharacteristicValue {
    return this.positionState;
  }

  // Returns the ShutterDevice data from within the accessory context
  getDeviceContext(): ShutterDevice {
    return this.accessory.context.device;
  }

  private async setTargetPosition(value: CharacteristicValue) {
    const newPosition = value as number;
    this.targetPosition = newPosition;

    const deviceData = this.accessory.context.device;
    let openValue: number;

    // Determine if we're opening, closing, or stopping
    if (newPosition > this.currentPosition) {
      this.positionState = 1; // Opening
      openValue = 0; // Open command
      this.platform.log.debug(`Setting ${deviceData.displayName} to OPEN (target: ${newPosition}%)`);
    } else if (newPosition < this.currentPosition) {
      this.positionState = 0; // Closing
      openValue = 1; // Close command
      this.platform.log.debug(`Setting ${deviceData.displayName} to CLOSE (target: ${newPosition}%)`);
    } else {
      this.positionState = 2; // Stopped
      openValue = 2; // Stop command
      this.platform.log.debug(`Setting ${deviceData.displayName} to STOP (at: ${newPosition}%)`);
    }

    const url = `http://${this.platform.config.host}/action/devices/device/325/operation`;

    const objSendData = {
      nodeId: deviceData.nodeId,
      eoj: deviceData.eoj,
      type: deviceData.type,
      device: {
        open: String(openValue),
      },
    };
    const payload = `data={"objSendData":"${JSON.stringify(objSendData).replace(/"/g, '\\"')}","token":"${this.platform.Token}"}`;

    const responseHandler = (err, data, res) => {
      if (err) {
        this.platform.log.error(`Error setting shutter position: ${err}`);
        return;
      }

      if (res.status !== 200) {
        this.platform.log.error(`HTTP post failed with status ${res.status}: ${res.statusMessage}`);
        return;
      }

      this.platform.log.debug(`Response: '${data}'`);

      if (openValue === 2) { // The command was stop
        this.platform.log.info(`Homebridge -> ${deviceData.displayName} STOPPED at ${this.targetPosition}%`);
      } else {
        this.platform.log.info(`Homebridge -> ${deviceData.displayName} ${openValue === 0 ? 'OPENING' : 'CLOSING'} to ${newPosition}%`);
      }
      this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, this.targetPosition);
      this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);
    };

    this.platform.log.debug(`Sending command '${openValue}' to device '${deviceData.displayName}' with ${url}`);
    HttpRequest(url, {
      method: 'POST',
      rejectUnauthorized: false,
      digestAuth: `aiseg:${this.platform.config.password}`,
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: payload,
    }, responseHandler);
  }

  // Update the shutter state based on device data
  updateShutterState(deviceData: ShutterDevice) {
    if (!deviceData.state) {
      return;
    }

    // Convert state to position
    let newPosition = this.currentPosition;
    let newPositionState = this.positionState;

    switch (deviceData.state) {
      case OpenState.Open:
        newPosition = 100; // 100% = fully open
        newPositionState = 2; // Stopped
        break;
      case OpenState.Closed:
        newPosition = 0; // 0% = fully closed
        newPositionState = 2; // Stopped
        break;
      case OpenState.Opening:
        newPositionState = 1; // Opening
        break;
      case OpenState.Closing:
        newPositionState = 0; // Closing
        break;
      case OpenState.HalfOpen:
        newPosition = 50; // 50% = half open
        newPositionState = 2; // Stopped
        break;
    }

    // Update if position or position state has changed
    if (newPosition !== this.currentPosition || newPositionState !== this.positionState) {
      this.currentPosition = newPosition;
      this.targetPosition = newPosition;
      this.positionState = newPositionState;

      const stateText = newPositionState === 0 ? 'Closing' : newPositionState === 1 ? 'Opening' : 'Stopped';
      this.platform.log.info(`AiSEG2 -> ${deviceData.displayName} position: ${newPosition}%, state: ${stateText}`);

      this.service.updateCharacteristic(this.platform.Characteristic.CurrentPosition, newPosition);
      this.service.updateCharacteristic(this.platform.Characteristic.TargetPosition, newPosition);
      this.service.updateCharacteristic(this.platform.Characteristic.PositionState, this.positionState);
    }
  }

}
