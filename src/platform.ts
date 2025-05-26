import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge';

import { request as HttpRequest } from 'urllib';
import { load as LoadHtml } from 'cheerio';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { LightingDevice, LightingAccessory } from './lightingAccessory';
import { ShutterDevice, ShutterAccessory, OpenState } from './shutterAccessory';
import * as deviceInfo from './deviceInfo';
import { deviceIdToHex, hexToString } from './utils';


export interface Aiseg2Node {
  nodeId: string;
  eoj: string;
  type: string;
  nodeIdentNum: string;
  deviceId: string;
}

export class Aiseg2Platform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory[] = [];
  public lightingDevices: { [uid: string]: LightingAccessory } = {};
  public shutterDevices: { [uid: string]: ShutterAccessory } = {};
  public Token: string;

  private backoff: number;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Token = '';

    this.backoff = 0;

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');

      // Get a control token from the AiSEG2 controller
      this.updateControlToken();

      // Refresh the control token periodically
      setInterval(() => {
        this.updateControlToken();
      }, 60000);

      // Refresh all device states often
      setInterval(() => {
        this.updateLightingDeviceStates();
        this.updateShutterDeviceStates();
      }, 2500);

      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  // Fetch the latest token to use for AiSEG2 device action requests
  updateControlToken() {
    const url = `http://${this.config.host}/page/devices/device/32i1?page=1`;

    const responseHandler = (err, data, res) => {
      if (err) {
        this.log.info(err);
      }

      if (res.status !== 200) {
        this.log.info(`HTTP get failed with status ${res.status}: ${res.statusMessage}`);
        return;
      }

      const $ = LoadHtml(data);

      this.Token = $('#main').attr('token') || '';
      this.log.debug(`Retrieved control token '${this.Token}'`);
    };

    this.log.debug(`Fetching control token from ${url}`);
    HttpRequest(url, {
      method: 'GET',
      rejectUnauthorized: false,
      digestAuth: `aiseg:${this.config.password}`,
    }, responseHandler);
  }

  // Discover the various AiSEG2 device types that are compatible with Homekit
  discoverDevices() {
    this.discoverWirelessDevices();
    this.discoverNetworkDevices();
  }

  // Process discovered devices and categorize them by type
  private processDiscoveredDevices(devices: any[]) {
    const lightingDevData: { [nodeId: string]: LightingDevice } = {};
    const shutterDevData: { [nodeId: string]: ShutterDevice } = {};

    for (const device of devices) {
      const deviceId: string = device['deviceId'];
      const model = hexToString(device['productCode']);
      const deviceUid = this.generateUid(device);

      if (device['devType'] === '0x92') {
        // Handle lighting devices
        const deviceData: LightingDevice = {
          displayName: device['devName'] || '',
          manufacturer: device['devMaker'] || '',
          model: model || '',
          serialNumber: deviceId.split('+')[1] || '',
          firmwareRevision: '0.0.0',
          nodeId: device['nodeId'] || '',
          eoj: device['eoj'] || '',
          type: device['devType'] || '',
          nodeIdentNum: '0x' + device['uniqueNo'] || '',
          deviceId: deviceIdToHex(deviceId) || '',
          dimmable: deviceInfo.switchModels[model]?.dimmable || false,
          state: 'off',
        };

        if (deviceData.dimmable === true) {
          deviceData.brightness = 0;
        }

        lightingDevData[deviceUid] = deviceData;
        const devType = device['devType'];
        this.log.info(`Discovered ${deviceInfo.types[devType]} device '${deviceData.displayName}'`);
        this.log.debug(JSON.stringify(deviceData));
      } else if (device['devType'] === '0x2b') {
        // Handle shutter devices - they have different data structure
        const shutterDeviceId = device['nodeId'] + '_' + device['eoj']; // Create a unique ID from nodeId and eoj
        const deviceData: ShutterDevice = {
          displayName: device['devName'] || '',
          manufacturer: device['devMaker'] || 'Unknown',
          model: model || 'Shutter', // Fixed model name for shutters
          serialNumber: device['uniqueNo'] || shutterDeviceId,
          firmwareRevision: '0.0.0',
          nodeId: device['nodeId'] || '',
          eoj: device['eoj'] || '',
          type: device['devType'] || '',
          nodeIdentNum: '0x' + device['uniqueNo'] || '',
          deviceId: shutterDeviceId, // Use our generated ID
          state: OpenState.Closed, // Default to closed
          position: 0, // Default to fully closed (0%)
        };

        shutterDevData[deviceUid] = deviceData;
        const devType = device['devType'];
        this.log.info(`Discovered ${deviceInfo.types[devType]} device '${deviceData.displayName}'`);
        this.log.debug(JSON.stringify(deviceData));
      } else {
        this.log.debug(`Ignoring unsupported device type ${device['devType']} for ${device['devName']}`);
      }
    }

    return { lightingDevData, shutterDevData };
  }

  // Common device discovery logic
  private discoverDevicesFromUrl(url: string, deviceType: string) {
    const responseHandler = (err, data, res) => {
      if (err) {
        this.log.info(err);
        return;
      }

      if (res.status !== 200) {
        this.log.info(`HTTP get failed with status ${res.status}: ${res.statusMessage}`);
        return;
      }

      const $ = LoadHtml(data);
      let allDevices: any[] = [];

      $('script').each((index, element) => {
        const content = $(element).html() || '';
        const pattern = /window.onload = function\(\){ init\((.*), \d\); };/;

        const match = content.match(pattern);
        if (match) {
          this.log.debug(`Found ${deviceType} device data at script index ${index}: ${content}`);
          const devices = JSON.parse(match[1]);
          this.log.info(`Found ${devices.length} ${deviceType} devices`);
          allDevices = allDevices.concat(devices);
        }
      });

      const { lightingDevData, shutterDevData } = this.processDiscoveredDevices(allDevices);
      this.provisionLightingDevices(lightingDevData);
      this.provisionShutterDevices(shutterDevData);
    };

    this.log.debug(`Fetching ${deviceType} devices at ${url}`);
    HttpRequest(url, {
      method: 'GET',
      rejectUnauthorized: false,
      digestAuth: `aiseg:${this.config.password}`,
    }, responseHandler);
  }

  discoverWirelessDevices() {
    const url = `http://${this.config.host}/page/setting/installation/7314`;
    this.discoverDevicesFromUrl(url, 'wireless');
  }

  discoverNetworkDevices() {
    const url = `http://${this.config.host}/page/setting/installation/7322`;
    this.discoverDevicesFromUrl(url, 'network');
  }

  // Provision a lighting device in Homebridge
  provisionLightingDevices(deviceData: { [nodeId: string]: LightingDevice }) {
    for (const [devId, device] of Object.entries(deviceData)) {
      if (device.type === '0x92') {
        this.provisionLightingDevice(devId, device);
      }
    }
  }

  // Provision shutter devices in Homebridge
  provisionShutterDevices(deviceData: { [nodeId: string]: ShutterDevice }) {
    for (const [devId, device] of Object.entries(deviceData)) {
      if (device.type === '0x2b') {
        this.provisionShutterDevice(devId, device);
      }
    }
  }

  // Fetch the current state of all AiSEG2 devices
  updateLightingDeviceStates() {
    if (this.backoff > 0) {
      this.log.debug(`Skip lighting device update due to backoff (${this.backoff})`);
      this.backoff--;
      return;
    }

    const url = `http://${this.config.host}/data/devices/device/32i1/auto_update`;

    const payloadDevices: Aiseg2Node[] = [];

    // Add lighting devices to payload
    for (const [, accessory] of Object.entries(this.lightingDevices)) {
      const device = accessory.getDeviceContext();
      payloadDevices.push({
        nodeId: device.nodeId,
        eoj: device.eoj,
        type: device.type,
        nodeIdentNum: device.nodeIdentNum,
        deviceId: device.deviceId,
      });
    }

    if (payloadDevices.length === 0) {
      return; // No lighting devices to update
    }

    const payload = `data={"page":"1","list":${JSON.stringify(payloadDevices)}}`;

    const responseHandler = (err, data, res) => {
      if (err) {
        this.backoff += this.backoff <= 25 ? 3 : 0;
        this.log.info(err);
        return;
      }

      if (res.status !== 200) {
        this.backoff += this.backoff <= 25 ? 3 : 0;
        this.log.info(`HTTP post failed with status ${res.status}: ${res.statusMessage}`);
        return;
      }

      this.backoff = 0;

      const deviceInfo = JSON.parse(data);

      for (const device of deviceInfo.panelData) {
        const devId = device.nodeId + device.eoj;
        const lightingAccessory = this.lightingDevices[devId];
        if (lightingAccessory) {
          const deviceData = lightingAccessory.getDeviceContext();
          deviceData.state = device.state;
          if (deviceData.dimmable) {
            deviceData.brightness = device.modulate_level * 20;
          }
          lightingAccessory.updateLightingState(deviceData);
        }
      }
    };

    HttpRequest(url, {
      method: 'POST',
      rejectUnauthorized: false,
      digestAuth: `aiseg:${this.config.password}`,
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: payload,
    }, responseHandler);
  }

  // Fetch the current state of all shutter devices
  updateShutterDeviceStates() {
    const url = `http://${this.config.host}/data/devices/device/325/auto_update`;

    const payloadDevices: any[] = [];

    // Add shutter devices to payload - only need nodeId, eoj, and type
    for (const [, accessory] of Object.entries(this.shutterDevices)) {
      const device = accessory.getDeviceContext();
      payloadDevices.push({
        nodeId: device.nodeId,
        eoj: device.eoj,
        type: device.type,
      });
    }

    if (payloadDevices.length === 0) {
      return; // No shutter devices to update
    }

    // Shutter payload format is different - no "page" field, and includes "token"
    const payload = `data={"list":"${JSON.stringify(payloadDevices).replace(/"/g, '\\"')}","token":"${this.Token}"}`;

    const responseHandler = (err, data, res) => {
      if (err) {
        this.log.info(err);
        return;
      }

      if (res.status !== 200) {
        this.log.info(`HTTP post failed with status ${res.status}: ${res.statusMessage}`);
        return;
      }

      const deviceInfo = JSON.parse(data);
      const shutterDevices = JSON.parse(deviceInfo.arrayControlDevInfo);

      for (const device of shutterDevices) {
        const devId = device.nodeId + device.eoj;
        const shutterAccessory = this.shutterDevices[devId];
        if (shutterAccessory) {
          const deviceData = shutterAccessory.getDeviceContext();
          if (device.shutter?.openState) {
            deviceData.state = device.shutter.openState;
          }
          shutterAccessory.updateShutterState(deviceData);
        }
      }
    };

    HttpRequest(url, {
      method: 'POST',
      rejectUnauthorized: false,
      digestAuth: `aiseg:${this.config.password}`,
      headers: {
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: payload,
    }, responseHandler);
  }

  // Generate a unique ID for a given Aiseg2Node object
  generateUid(obj: Aiseg2Node): string {
    return obj['nodeId'] + obj['eoj'];
  }

  provisionLightingDevice(devId: string, device: LightingDevice) {
    const uuid = this.api.hap.uuid.generate(device.deviceId);
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

    if (existingAccessory) {
      this.log.info('Restoring cached accessory:', existingAccessory.displayName);

      // if you need to update the accessory.context then you should run `api.updatePlatformAccessories`. eg.:
      // existingAccessory.context.device = device;
      // this.api.updatePlatformAccessories([existingAccessory]);

      this.lightingDevices[devId] = new LightingAccessory(this, existingAccessory);

      // it is possible to remove platform accessories at any time using `api.unregisterPlatformAccessories`, eg.:
      // remove platform accessories when no longer present
      // this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [existingAccessory]);
      // this.log.info('Removing existing accessory from cache:', existingAccessory.displayName);
    } else {
      this.log.info('Adding new accessory:', device.displayName);
      const accessory = new this.api.platformAccessory(device.displayName, uuid);
      accessory.context.device = device;
      this.lightingDevices[devId] = new LightingAccessory(this, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }

  provisionShutterDevice(devId: string, device: ShutterDevice) {
    const uuid = this.api.hap.uuid.generate(device.deviceId);
    const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);

    if (existingAccessory) {
      this.log.info('Restoring cached shutter accessory:', existingAccessory.displayName);
      this.shutterDevices[devId] = new ShutterAccessory(this, existingAccessory);
    } else {
      this.log.info('Adding new shutter accessory:', device.displayName);
      const accessory = new this.api.platformAccessory(device.displayName, uuid);
      accessory.context.device = device;
      this.shutterDevices[devId] = new ShutterAccessory(this, accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
  }
}

// Get device version information
/*
  getVersionInfo() {
    const url = `http://${this.config.host}/page/setting/installation/7315`;

    const responseHandler = (err, data, res) => {
      if (err) {
        this.log.info(err);
      }

      if (res.status !== 200) {
        this.log.info(`HTTP get failed with status ${res.status}: ${res.statusMessage}`);
        return;
      }

      const devData = {};

      const $ = LoadHtml(data);
      $('script').each((index, element) => {
        const content = $(element).html() || '';
        const pattern = /window.onload = function\(\){ init\((.*), \d\); };/;

        let devices = [];

        const match = content.match(pattern);
        if (match) {
          this.log.debug(`Found Wireless device data at script index ${index}: ${content}`);
          devices = JSON.parse(match[1]);
          // this.log.debug(`Result: ${JSON.stringify(devices, null, 2)}`);
        }
      });
    };

    this.log.debug(`Fetching lighting devices at ${url}`);
    HttpRequest(url, {
      method: 'GET',
      rejectUnauthorized: false,
      digestAuth: `aiseg:${this.config.password}`,
    }, responseHandler);
  }
  */
