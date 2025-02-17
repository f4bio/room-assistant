import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import noble, { Peripheral } from '@mkerix/noble';
import util from 'util';
import { exec } from 'child_process';
import { BluetoothClassicConfig } from '../../integrations/bluetooth-classic/bluetooth-classic.config';
import { BluetoothLowEnergyConfig } from '../../integrations/bluetooth-low-energy/bluetooth-low-energy.config';
import { ConfigService } from '../../config/config.service';
import { Device } from '../../integrations/bluetooth-classic/device';
import { promiseWithTimeout, sleep } from '../../util/promises';
import { Interval } from '@nestjs/schedule';
import _ from 'lodash';
import { Counter } from 'prom-client';
import { InjectMetric } from '@willsoto/nestjs-prometheus';

const RSSI_REGEX = new RegExp(/-?[0-9]+/);
const INQUIRY_LOCK_TIMEOUT = 30 * 1000;
const SCAN_NO_PERIPHERAL_TIMEOUT = 30 * 1000;

const BLE_CONNECTION_RETRIES = 5;
const BLE_CONNECTION_TIMEOUT = 10 * 1000;
const BLE_READ_TIMEOUT = 15 * 1000;

const execPromise = util.promisify(exec);

type BluetoothAdapterState = 'inquiry' | 'scan' | 'inactive' | 'resetting';
type ExecOutput = { stdout: string; stderr: string };

class BluetoothAdapter {
  state: BluetoothAdapterState;
  startedAt: Date;
}

class BluetoothAdapterMap extends Map<number, BluetoothAdapter> {
  getState(key: number): BluetoothAdapterState {
    return this.get(key)?.state;
  }

  setState(key: number, state: BluetoothAdapterState): this {
    return this.set(key, { state, startedAt: new Date() });
  }
}

@Injectable()
export class BluetoothService implements OnApplicationShutdown {
  private readonly logger: Logger = new Logger(BluetoothService.name);
  private readonly classicConfig: BluetoothClassicConfig;
  private readonly bleConfig: BluetoothLowEnergyConfig;
  private readonly adapters = new BluetoothAdapterMap();
  private _lowEnergyAdapterId: number;
  private _successiveErrorsOccurred = 0;
  private lastLowEnergyDiscovery: Date;
  private scanStartedAt?: Date;
  private queryMutexAvailable = true;

  constructor(
    private readonly configService: ConfigService,
    @InjectMetric('bluetooth_le_advertisements_received_count')
    private readonly advertisementReceivedCounter: Counter<string>
  ) {
    this.classicConfig = this.configService.get('bluetoothClassic');
    this.bleConfig = this.configService.get('bluetoothLowEnergy');
  }

  /**
   * Returns the time in milliseconds since the last discovery or since the
   * scan state started if no discovery was made yet.
   * Returns null if the time is unknown.
   */
  get timeSinceLastDiscovery(): number | null {
    if (
      this._lowEnergyAdapterId == null ||
      !['inactive', 'scan'].includes(
        this.adapters.getState(this._lowEnergyAdapterId)
      )
    ) {
      return null;
    }

    const timestamp =
      this.lastLowEnergyDiscovery == null
        ? this.adapters.get(this._lowEnergyAdapterId).startedAt
        : this.lastLowEnergyDiscovery;
    return Date.now() - timestamp.getTime();
  }

  /**
   * Returns the ID of the adapter that is used for BLE.
   * Returns null if BLE was not setup yet.
   */
  get lowEnergyAdapterId(): number | undefined {
    return this._lowEnergyAdapterId;
  }

  /**
   * Returns the current number of successive BT Classic errors.
   */
  get successiveErrorsOccurred(): number {
    return this._successiveErrorsOccurred;
  }

  /**
   * Application hook, called when the application shuts down.
   */
  onApplicationShutdown(): void {
    if (
      this._lowEnergyAdapterId != null &&
      this.adapters.getState(this._lowEnergyAdapterId) != 'inquiry'
    ) {
      noble.stopScanning();
    }
  }

  /**
   * Registers a callback function that will be invoked when a
   * Bluetooth Low Energy peripheral advertisement was received.
   *
   * @param callback - Callback function that receives a peripheral
   */
  onLowEnergyDiscovery(callback: (peripheral: Peripheral) => void): void {
    if (this._lowEnergyAdapterId == undefined) {
      this.setupNoble();
    }

    noble.on('discover', callback);
  }

  /**
   * Locks the adapter and establishes a connection the given BLE peripheral.
   * Connection attempts time out after 10s.
   *
   * @param peripheral - BLE peripheral to connect to
   */
  async connectLowEnergyDevice(peripheral: Peripheral): Promise<Peripheral> {
    if (!peripheral.connectable) {
      throw new Error('Trying to connect to a non-connectable device');
    }

    if (peripheral.state === 'connected') {
      return peripheral;
    } else if (peripheral.state === 'connecting') {
      throw new Error(
        `Connection to ${peripheral.address} is already trying to be established`
      );
    }

    this.lockAdapter(this._lowEnergyAdapterId);

    try {
      await this.connectLowEnergyDeviceWithRetry(
        peripheral,
        BLE_CONNECTION_RETRIES
      );
      return peripheral;
    } catch (e) {
      this.logger.error(
        `Failed to connect to ${peripheral.address}: ${e.message}`,
        e.trace
      );
      await this.unlockAdapter(this._lowEnergyAdapterId);
      throw e;
    }
  }

  /**
   * Disconnect from the given BLE peripheral and unlock the adapter.
   *
   * @param peripheral - BLE peripheral to disconnect from
   */
  async disconnectLowEnergyDevice(peripheral: Peripheral): Promise<void> {
    if (!['connecting', 'connected'].includes(peripheral.state)) {
      return;
    }

    this.logger.debug(
      `Disconnecting from BLE device at address ${peripheral.address}`
    );
    try {
      await promiseWithTimeout(peripheral.disconnectAsync(), 1000);
    } catch (e) {
      this.logger.debug(
        `Failed to disconnect from ${peripheral.address}: ${e.message}`,
        e.trace
      );
      await this.resetHciDevice(this._lowEnergyAdapterId);
    }
  }

  /**
   * Acquires exclusive access to executing a BLE query.
   * Will return true if mutex granted otherwise returns false.
   */
  acquireQueryMutex(): boolean {
    if (this.queryMutexAvailable) {
      this.queryMutexAvailable = false;
      return true;
    }
    return false;
  }

  /**
   * Releases the exclusive access on executing a BLE query.
   */
  releaseQueryMutex(): void {
    this.queryMutexAvailable = true;
  }

  /**
   * Connects to the given peripheral and queries the service/characteristic value.
   * If the service and characteristic are not found it will return null.
   *
   * @param peripheral - Peripheral to connect to
   * @param serviceUuid - Service UUID to query
   * @param characteristicUuid - Characteristic UUID to query
   */
  async queryLowEnergyDevice(
    target: Peripheral,
    serviceUuid: string,
    characteristicUuid: string
  ): Promise<Buffer | null> {
    if (this.queryMutexAvailable) {
      this.logger.error(
        `Permission to query ${target.id} has not been acquired`
      );
      return null;
    }

    const peripheral = await this.connectLowEnergyDevice(target);

    try {
      return await this.readLowEnergyCharacteristic(
        peripheral,
        serviceUuid,
        characteristicUuid
      );
    } catch (e) {
      this.logger.error(
        `Failed to query value from ${target.id}: ${e.message}`,
        e.trace
      );

      if (e.message === 'timed out') {
        await this.resetHciDevice(this.lowEnergyAdapterId);
      }

      return null;
    } finally {
      if (!['disconnecting', 'disconnected'].includes(target.state)) {
        await this.disconnectLowEnergyDevice(target);
      }
      await this.unlockAdapter(this._lowEnergyAdapterId);
    }
  }

  /**
   * Reads a characteristic value of a BLE peripheral as Buffer.
   *
   * @param peripheral - peripheral to read from
   * @param serviceUuid - UUID of the service that contains the characteristic
   * @param characteristicUuid - UUID of the characteristic to read
   */
  private async readLowEnergyCharacteristic(
    peripheral: Peripheral,
    serviceUuid: string,
    characteristicUuid: string
  ): Promise<Buffer | null> {
    if (peripheral.state !== 'connected') {
      return null;
    }

    const cutoffTime = Date.now() + BLE_READ_TIMEOUT;

    let timeout = cutoffTime - Date.now();
    const services = (await promiseWithTimeout(
      peripheral.discoverServicesAsync([serviceUuid]),
      timeout
    )) as noble.Service[];

    timeout = cutoffTime - Date.now();
    if (
      services.length > 0 &&
      peripheral.state === 'connected' &&
      timeout > 0
    ) {
      const characteristics = (await promiseWithTimeout(
        services[0].discoverCharacteristicsAsync([characteristicUuid]),
        timeout
      )) as noble.Characteristic[];

      timeout = cutoffTime - Date.now();
      if (
        characteristics.length > 0 &&
        peripheral.state === 'connected' &&
        timeout > 0
      ) {
        return await promiseWithTimeout(
          characteristics[0].readAsync(),
          timeout
        );
      }
    }
    return null;
  }

  /**
   * Queries for the RSSI of a Bluetooth device using the hcitool shell command.
   *
   * @param adapterId - HCI Adapter ID to use for queries
   * @param address - Bluetooth MAC address
   * @returns RSSI value
   */
  async inquireClassicRssi(
    adapterId: number,
    address: string
  ): Promise<number> {
    this.lockAdapter(adapterId);

    this.logger.debug(`Querying for RSSI of ${address} using hcitool`);
    try {
      const output = await promiseWithTimeout<ExecOutput>(
        execPromise(
          `hcitool -i hci${adapterId} cc "${address}" && hcitool -i hci${adapterId} rssi "${address}"`,
          {
            timeout: this.classicConfig.scanTimeLimit * 1000,
            killSignal: 'SIGKILL',
          }
        ),
        this.classicConfig.scanTimeLimit * 1000 * 2
      );
      const matches = output.stdout.match(RSSI_REGEX);

      this._successiveErrorsOccurred = 0;

      return matches?.length > 0 ? parseInt(matches[0], 10) : undefined;
    } catch (e) {
      if (e.signal === 'SIGKILL') {
        this.logger.debug(
          `Query of ${address} reached scan time limit, cancelling connection attempt`
        );
        await this.cancelClassicInquiry(adapterId);
      } else if (
        e.message?.includes('Input/output') ||
        e.message?.includes('I/O')
      ) {
        this.logger.debug(e.message);
      } else {
        this.logger.error(`Inquiring RSSI via BT Classic failed: ${e.message}`);
        this._successiveErrorsOccurred++;
      }

      return undefined;
    } finally {
      this.unlockAdapter(adapterId);
    }
  }

  /**
   * Cancels the connection attempt to a BT Classic device.
   *
   * @param adapterId - HCI Adapter ID to use for queries
   */
  async cancelClassicInquiry(adapterId: number): Promise<void> {
    await execPromise(`hcitool -i hci${adapterId} cmd 0x01 0x0008`, {
      timeout: 3000,
    });
  }

  /**
   * Inquires device information of a Bluetooth peripheral.
   *
   * @param adapterId - HCI Adapter ID to use for queries
   * @param address - Bluetooth MAC address
   * @returns Device information
   */
  async inquireClassicDeviceInfo(
    adapterId: number,
    address: string
  ): Promise<Device> {
    this.lockAdapter(adapterId);

    try {
      const output = await promiseWithTimeout<ExecOutput>(
        execPromise(`hcitool -i hci${adapterId} info "${address}"`, {
          timeout: this.classicConfig.scanTimeLimit * 1000,
        }),
        6000
      );

      const nameMatches = /Device Name: (.+)/g.exec(output.stdout);
      const manufacturerMatches = /OUI Company: (.+) \(.+\)/g.exec(
        output.stdout
      );

      return {
        address,
        name: nameMatches ? nameMatches[1] : address,
        manufacturer: manufacturerMatches ? manufacturerMatches[1] : undefined,
      };
    } catch (e) {
      this.logger.error(e.message, e.stack);
      return {
        address,
        name: address,
      };
    } finally {
      this.unlockAdapter(adapterId);
    }
  }

  /**
   * Reset the hci (Bluetooth) device.
   */
  async resetHciDevice(adapterId: number): Promise<void> {
    if (this.adapters.getState(adapterId) === 'resetting') {
      throw new Error('Adapter is already resetting');
    }

    this.logger.debug(`Resetting HCI adapter ${adapterId}`);
    this.adapters.setState(adapterId, 'resetting');

    if (this._lowEnergyAdapterId === adapterId) {
      noble.stopScanning();
    }

    try {
      await execPromise(`hciconfig hci${adapterId} reset`, {
        timeout: 3000,
      });
    } catch (e) {
      this.logger.error(e.message);
    }

    if (this._lowEnergyAdapterId === adapterId) {
      await sleep(5000);

      try {
        noble.resetBindings();
        await this.handleAdapterStateChange(noble.state);
      } catch (e) {
        this.logger.error('Failed to reset low energy library', e.stack);
      } finally {
        if (this.adapters.getState(this._lowEnergyAdapterId) === 'resetting') {
          this.adapters.setState(this._lowEnergyAdapterId, 'inactive');
        }
      }
    } else {
      this.adapters.setState(adapterId, 'inactive');
    }
  }

  /**
   * Locks an adapter for an active inquiry.
   *
   * @param adapterId - HCI Device ID of the adapter to lock
   */
  lockAdapter(adapterId: number): void {
    this.logger.debug(`Locking adapter ${adapterId}`);

    switch (this.adapters.getState(adapterId)) {
      case 'inquiry':
        throw new Error(
          `Trying to lock adapter ${adapterId} even though it is already locked`
        );
      case 'resetting':
        throw new Error(`Cannot lock resetting adapter ${adapterId}`);
      case 'scan':
        this.logger.debug(
          `Stopping scanning for BLE peripherals on adapter ${adapterId}`
        );
        noble.stopScanning();
    }

    this.adapters.setState(adapterId, 'inquiry');
  }

  /**
   * Unlocks an adapter and returns it to scan or inactive state.
   *
   * @param adapterId - HCI Device ID of the adapter to unlock
   */
  async unlockAdapter(adapterId: number): Promise<void> {
    if (this.adapters.getState(adapterId) != 'inquiry') {
      return;
    }

    this.logger.debug(`Unlocking adapter ${adapterId}`);
    this.adapters.setState(adapterId, 'inactive');

    if (adapterId == this._lowEnergyAdapterId) {
      await this.handleAdapterStateChange(noble.state);
    }
  }

  /**
   * Checks if any adapters had a lock acquired on them for longer than
   * INQUIRY_LOCK_TIMEOUT and resets them before unlocking them again.
   */
  @Interval(10 * 1000)
  unlockDeadlockedAdapters(): void {
    this.adapters.forEach(async (adapter, adapterId) => {
      if (
        adapter.state === 'inquiry' &&
        adapter.startedAt.getTime() < Date.now() - INQUIRY_LOCK_TIMEOUT
      ) {
        this.logger.log(
          `Detected unusually long lock on Bluetooth adapter ${adapterId}, force unlocking`
        );
        await this.unlockAdapter(adapterId);
      }
    });
  }

  /**
   * Restarts the scanning process if nothing has been detected for a while.
   */
  @Interval(15 * 1000)
  async verifyLowEnergyScanner(): Promise<void> {
    if (this.timeSinceLastDiscovery > SCAN_NO_PERIPHERAL_TIMEOUT) {
      this.logger.warn(
        'Did not detect any low energy advertisements in a while, resetting'
      );
      await this.resetHciDevice(this._lowEnergyAdapterId);
    }
  }

  /**
   * Sets up Noble hooks.
   */
  private setupNoble(): void {
    this._lowEnergyAdapterId = parseInt(process.env.NOBLE_HCI_DEVICE_ID) || 0;
    this.adapters.setState(this._lowEnergyAdapterId, 'inactive');

    const debouncedScanRecovery = _.debounce(
      async () => {
        if (this.adapters.getState(this._lowEnergyAdapterId) === 'scan') {
          this.logger.debug('Trying to recover low energy scanner');
          await this.resetHciDevice(this._lowEnergyAdapterId);
        }
      },
      10 * 1000,
      { maxWait: 30 * 1000 }
    );

    noble.on('stateChange', this.handleAdapterStateChange.bind(this));
    noble.on('discover', debouncedScanRecovery.cancel.bind(this));
    noble.on('discover', this.handleDiscover.bind(this));
    noble.on('scanStart', debouncedScanRecovery.cancel.bind(this));
    noble.on('scanStop', debouncedScanRecovery.bind(this));
    noble.on('scanStart', this.handleScanStart.bind(this));
    noble.on('scanStop', this.handleScanStop.bind(this));
    noble.on('warning', (message) => {
      if (message == 'unknown peripheral undefined RSSI update!') {
        return;
      }

      this.logger.warn(message);
    });
  }

  /**
   * Callback that is executed when BLE scanning is started.
   */
  private handleScanStart(): void {
    this.logger.debug(
      `Started scanning for BLE peripherals on adapter ${this._lowEnergyAdapterId}`
    );
    this.scanStartedAt = new Date();
    this.adapters.setState(this._lowEnergyAdapterId, 'scan');
  }

  /**
   * Callback that is executed when BLE scanning is stopped.
   */
  private handleScanStop(): void {
    this.logger.debug(
      `Stopped scanning for BLE peripherals on adapter ${this._lowEnergyAdapterId}`
    );
    this.scanStartedAt = null;
    if (this.adapters.getState(this._lowEnergyAdapterId) === 'scan') {
      this.adapters.setState(this._lowEnergyAdapterId, 'inactive');
    }
  }

  /**
   * Callback that is executed when a BLE advertisement is received.
   */
  private handleDiscover(): void {
    this.lastLowEnergyDiscovery = new Date();
    this.advertisementReceivedCounter.inc();
    const adapterState = this.adapters.get(this._lowEnergyAdapterId);
    if (
      adapterState.state === 'inactive' ||
      (adapterState.state === 'resetting' &&
        adapterState.startedAt.getTime() < Date.now() - 1000)
    ) {
      this.handleScanStart();
    }
  }

  /**
   * Handles state adapter changes as reported by Noble.
   *
   * @param state - State of the HCI adapter
   */
  private async handleAdapterStateChange(state: string): Promise<void> {
    this.logger.debug(
      `Adapter ${this._lowEnergyAdapterId} went into state ${state}`
    );
    const adapterState = this.adapters.getState(this._lowEnergyAdapterId);

    if (state === 'poweredOn') {
      if (['resetting', 'inactive'].includes(adapterState)) {
        this.logger.debug(
          `Starting scanning for BLE peripherals on adapter ${this._lowEnergyAdapterId}`
        );

        noble.startScanning([], true);
      }
    } else if (adapterState === 'scan') {
      this.logger.debug(
        `Adapter ${this._lowEnergyAdapterId} is set to inactive`
      );
      this.adapters.setState(this._lowEnergyAdapterId, 'inactive');
    }
  }

  /**
   * Connect to a peripheral and retry if it immediately disconnects.
   *
   * @param peripheral - BLE peripheral to connect to
   * @param tries - Amount of connection attempts before failing
   */
  private async connectLowEnergyDeviceWithRetry(
    peripheral: Peripheral,
    tries: number
  ): Promise<Peripheral> {
    this.logger.debug(
      `Connecting to BLE device at address ${peripheral.address}`
    );

    const cutoffTime = Date.now() + BLE_CONNECTION_TIMEOUT;

    let timeout = cutoffTime - Date.now();
    do {
      try {
        await promiseWithTimeout(peripheral.connectAsync(), timeout);
      } catch (e) {
        this.logger.debug(`Connection error ${peripheral.address}: ${e})`);
      }
      if (peripheral.state === 'connecting') {
        try {
          // Force cancellation if connection attempt timed-out
          await promiseWithTimeout(peripheral.disconnectAsync(), 1000);
        } catch (e) {
          this.logger.debug(`Disconnect error ${peripheral.address}: ${e})`);
        }
      }

      await sleep(100);

      tries--;
      timeout = cutoffTime - Date.now();
      this.logger.debug(
        `Connect attempt ${5 - tries}: State ${
          peripheral.state
        } with time remaining ${timeout} ms`
      );
    } while (tries > 0 && timeout > 0 && peripheral.state !== 'connected');

    if (peripheral.state !== 'connected') {
      throw new Error(timeout <= 0 ? 'timed out' : 'retries exceeded');
    }

    return peripheral;
  }
}
