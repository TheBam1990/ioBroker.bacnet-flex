"use strict";

const utils = require("@iobroker/adapter-core");
const Bacnet = require("node-bacnet");
const fs = require("node:fs/promises");
const { createRequire } = require("node:module");

const requireFromHere = createRequire(__filename);

const OBJECT_TYPES = {
    analogInput: 0,
    analogOutput: 1,
    analogValue: 2,
    binaryInput: 3,
    binaryOutput: 4,
    binaryValue: 5,
    device: 8,
    multiStateInput: 13,
    multiStateOutput: 14,
    multiStateValue: 19,
    characterStringValue: 40,
    integerValue: 45,
    largeAnalogValue: 46,
    positiveIntegerValue: 48,
    binaryLightingOutput: 55,
};

const OBJECT_TYPE_NAMES = Object.fromEntries(Object.entries(OBJECT_TYPES).map(([name, value]) => [value, name]));

class BacnetFlexAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: "bacnet-flex",
        });

        this.client = null;
        this.pollTimer = null;
        this.serverTimer = null;
        this.stopping = false;
        this.knownStates = new Set();
        this.serverObjects = new Map();
        this.serverObjectByKey = new Map();
        this.clientObjects = [];
        this.clientDiscoveredObjects = [];
        this.sc = null;
        this.scModule = null;

        this.on("ready", () => this.onReady());
        this.on("stateChange", (id, state) => this.onStateChange(id, state));
        this.on("unload", callback => this.onUnload(callback));
    }

    async onReady() {
        this.config = {
            enabled: this.config.enabled !== false,
            mode: String(this.config.mode || "client"),
            transportMode: String(this.config.transportMode || "bacnet-ip"),
            port: Number(this.config.port || 47808),
            interface: String(this.config.interface || "0.0.0.0"),
            broadcastAddress: String(this.config.broadcastAddress || "255.255.255.255"),
            mstpRouterAddress: String(this.config.mstpRouterAddress || ""),
            mstpNetworkNumber: String(this.config.mstpNetworkNumber || ""),
            mstpNote: String(this.config.mstpNote || ""),
            scHubUrl: String(this.config.scHubUrl || ""),
            scDeviceUuid: String(this.config.scDeviceUuid || ""),
            clientPollIntervalMs: Math.max(Number(this.config.clientPollIntervalMs || 30000), 1000),
            clientTimeoutMs: Math.max(Number(this.config.clientTimeoutMs || 10000), 1000),
            clientDiscoverOnStart: this.config.clientDiscoverOnStart !== false && this.config.clientDiscoverOnStart !== "false",
            clientTargetIp: String(this.config.clientTargetIp || ""),
            clientTargetDeviceId: String(this.config.clientTargetDeviceId || ""),
            clientAutoDiscoverObjects: this.config.clientAutoDiscoverObjects !== false && this.config.clientAutoDiscoverObjects !== "false",
            clientObjects: this.parseJson(this.config.clientObjectsJson, []),
            clientDevices: this.parseJson(this.config.clientDevicesJson, []),
            serverDeviceId: Math.max(Number(this.config.serverDeviceId || 810203), 0),
            serverVendorId: Math.max(Number(this.config.serverVendorId || 999), 0),
            serverObjectName: String(this.config.serverObjectName || "ioBroker BACnet"),
            serverStatesPattern: String(this.config.serverStatesPattern || "0_userdata.0.*"),
            serverPoints: Array.isArray(this.config.serverPoints) ? this.config.serverPoints : [],
            serverMaxObjects: Math.max(Number(this.config.serverMaxObjects || 500), 1),
            serverUpdateIntervalMs: Math.max(Number(this.config.serverUpdateIntervalMs || 10000), 1000),
        };

        await this.cleanupLegacyNativeConfig();
        await this.createBaseObjects();
        await this.subscribeStatesAsync("control.*");

        await this.setStateAsync("info.connection", false, true);
        await this.setStateAsync("info.lastError", "", true);
        await this.setStateAsync("client.discoveredJson", "[]", true);
        await this.setStateAsync("client.rawObjectListJson", "[]", true);
        await this.setStateAsync("client.discoveredObjectsJson", "[]", true);
        await this.setStateAsync("client.targetDeviceJson", "{}", true);
        await this.setStateAsync("server.objectCount", 0, true);
        await this.setStateAsync("transport.mode", this.config.transportMode, true);
        await this.setStateAsync("transport.status", "initializing", true);

        if (!this.config.enabled) {
            this.log.info("BACnet adapter is disabled");
            return;
        }

        try {
            await this.startBacnet();
        } catch (error) {
            await this.setError(error);
        }
    }

    async createBaseObjects() {
        await this.setObjectNotExistsAsync("info", { type: "channel", common: { name: "Information" }, native: {} });
        await this.setObjectNotExistsAsync("control", { type: "channel", common: { name: "Control" }, native: {} });
        await this.setObjectNotExistsAsync("client", { type: "channel", common: { name: "BACnet client" }, native: {} });
        await this.setObjectNotExistsAsync("server", { type: "channel", common: { name: "BACnet server" }, native: {} });
        await this.setObjectNotExistsAsync("server.points", { type: "channel", common: { name: "Manual BACnet server points" }, native: {} });
        await this.setObjectNotExistsAsync("transport", { type: "channel", common: { name: "BACnet transport" }, native: {} });

        await this.ensureState("info.connection", "BACnet socket open", "boolean", "indicator.connected", true);
        await this.ensureState("info.lastError", "Last error", "string", "text", true);
        await this.ensureState("info.lastUpdate", "Last update", "string", "value.time", true);
        await this.ensureState("transport.mode", "Active BACnet transport mode", "string", "text", true);
        await this.ensureState("transport.status", "BACnet transport status", "string", "text", true);
        await this.ensureState("transport.scLocalDeviceUuid", "BACnet/SC local device UUID", "string", "text", true);
        await this.ensureState("control.discover", "Discover BACnet devices", "boolean", "button", false, true);
        await this.ensureState("control.discoverObjects", "Discover target BACnet objects", "boolean", "button", false, true);
        await this.ensureState("control.refresh", "Refresh BACnet client values", "boolean", "button", false, true);
        await this.ensureState("control.rebuildServerObjects", "Rebuild server objects", "boolean", "button", false, true);
        await this.ensureState("client.discoveredJson", "Discovered BACnet devices JSON", "string", "json", true);
        await this.ensureState("client.rawObjectListJson", "Raw BACnet target object list JSON", "string", "json", true);
        await this.ensureState("client.discoveredObjectsJson", "Discovered BACnet target objects JSON", "string", "json", true);
        await this.ensureState("client.targetDeviceJson", "Selected BACnet target device JSON", "string", "json", true);
        await this.ensureState("client.lastPoll", "Client last poll", "string", "value.time", true);
        await this.ensureState("client.lastWrite", "Client last write", "string", "text", true);
        await this.ensureState("client.pollCount", "Client poll count", "number", "value", true);
        await this.ensureState("server.objectCount", "Published BACnet objects", "number", "value", true);
        await this.ensureState("server.lastBuild", "Server last object build", "string", "value.time", true);
        await this.ensureState("server.lastRequest", "Server last request", "string", "text", true);
        await this.deleteLegacyObject("control.exportServerPoints");
        await this.deleteLegacyObject("control.importServerPoints");
        await this.deleteLegacyObject("server.pointsJson");
    }

    async startBacnet() {
        if (this.config.transportMode === "bacnet-sc") {
            await this.startBacnetSc();
            return;
        }

        if (this.config.transportMode === "mstp-router" && this.config.mstpRouterAddress) {
            this.config.clientTargetIp = this.config.clientTargetIp || this.config.mstpRouterAddress;
            await this.setStateAsync("transport.status", `Using BACnet/IP to MS/TP router ${this.config.mstpRouterAddress}`, true);
        }

        this.client = new Bacnet({
            port: this.config.port,
            interface: this.config.interface,
            broadcastAddress: this.config.broadcastAddress,
            apduTimeout: this.config.clientTimeoutMs,
            reuseAddr: true,
        });

        this.client.on("listening", async () => {
            this.log.info(`BACnet/IP listening on ${this.config.interface}:${this.config.port}`);
            await this.setStateAsync("info.connection", true, true);
            await this.setStateAsync("transport.status", this.config.transportMode === "mstp-router" ? "BACnet/IP to MS/TP router mode active" : "BACnet/IP active", true);
            if (this.isServerMode()) {
                await this.buildServerObjects();
                this.bindServerEvents();
                this.client.iAmResponse(null, this.config.serverDeviceId, Bacnet.enum.Segmentation.NO_SEGMENTATION, this.config.serverVendorId);
            }
            if (this.isClientMode()) {
                if (this.config.clientTargetIp && this.config.clientAutoDiscoverObjects && !this.config.clientObjects.length && !this.config.clientDevices.length) {
                    await this.discoverTargetObjects();
                }
                await this.buildClientObjects();
                if (this.config.clientDiscoverOnStart) {
                    void this.discoverDevices();
                }
                this.startClientPolling(true);
            }
        });

        this.client.on("error", error => {
            void this.setError(error);
        });
    }

    async startBacnetSc() {
        if (this.isServerMode()) {
            throw new Error("BACnet/SC mode currently supports client polling and writes only. Server mode needs BACnet/IP.");
        }
        if (!this.config.scHubUrl) {
            throw new Error("BACnet/SC hub URL is required, for example wss://hub.example.com:47809");
        }
        if (!this.config.scHubUrl.startsWith("wss://")) {
            throw new Error("BACnet/SC requires a secure wss:// hub URL");
        }

        this.scModule = await this.loadBacnetScModule();
        const { BACnetScClient } = this.scModule;
        this.sc = this.config.scDeviceUuid
            ? BACnetScClient.withDeviceUuid(this.uuidToBytes(this.config.scDeviceUuid))
            : new BACnetScClient();
        await this.sc.connect(this.config.scHubUrl);
        await this.setStateAsync("info.connection", true, true);
        await this.setStateAsync("transport.status", `BACnet/SC connected to ${this.config.scHubUrl}`, true);
        await this.setStateAsync("transport.scLocalDeviceUuid", this.bytesToHex(this.sc.localDeviceUuid), true);
        if (this.config.clientDiscoverOnStart) void this.discoverDevices();
        await this.buildClientObjects();
        this.startClientPolling(true);
    }

    async loadBacnetScModule() {
        const bgPath = requireFromHere.resolve("bacnet-wasm/bacnet_wasm_bg.js");
        const wasmPath = requireFromHere.resolve("bacnet-wasm/bacnet_wasm_bg.wasm");
        const bg = await import(bgPath);
        const bytes = await fs.readFile(wasmPath);
        const module = await WebAssembly.compile(bytes);
        const instance = await WebAssembly.instantiate(module, { "./bacnet_wasm_bg.js": bg });
        bg.__wbg_set_wasm(instance.exports);
        instance.exports.__wbindgen_start();
        return bg;
    }

    isClientMode() {
        return this.config.mode === "client" || this.config.mode === "both";
    }

    isServerMode() {
        return this.config.mode === "server" || this.config.mode === "both";
    }

    bindServerEvents() {
        this.client.on("whoIs", msg => this.handleWhoIs(msg));
        this.client.on("readProperty", msg => this.handleReadProperty(msg));
        this.client.on("readPropertyMultiple", msg => this.handleReadPropertyMultiple(msg));
        this.client.on("writeProperty", msg => this.handleWriteProperty(msg));
    }

    handleWhoIs(msg) {
        const low = msg && msg.payload ? msg.payload.lowLimit : undefined;
        const high = msg && msg.payload ? msg.payload.highLimit : undefined;
        if (Number.isFinite(low) && this.config.serverDeviceId < low) {
            return;
        }
        if (Number.isFinite(high) && this.config.serverDeviceId > high) {
            return;
        }
        const receiver = msg && msg.header ? msg.header.sender : null;
        this.client.iAmResponse(receiver, this.config.serverDeviceId, Bacnet.enum.Segmentation.NO_SEGMENTATION, this.config.serverVendorId);
        void this.setStateAsync("server.lastRequest", `whoIs from ${receiver && receiver.address || "broadcast"}`, true);
    }

    handleReadProperty(msg) {
        const receiver = msg.header.sender;
        const objectId = msg.payload.objectId;
        const property = msg.payload.property;
        const values = this.getServerPropertyValues(objectId, property.id);
        if (!values) {
            this.log.warn(`Unsupported BACnet read ${this.objectKey(objectId)} property ${property.id}`);
            return;
        }
        this.client.readPropertyResponse(receiver, msg.invokeId, objectId, property, values);
        void this.setStateAsync("server.lastRequest", `read ${this.objectKey(objectId)} property ${property.id}`, true);
    }

    handleReadPropertyMultiple(msg) {
        const receiver = msg.header.sender;
        const response = [];
        for (const item of msg.payload.properties || []) {
            const values = [];
            for (const property of item.properties || []) {
                const propertyValues = this.getServerPropertyValues(item.objectId, property.id);
                if (propertyValues) {
                    values.push({ property: { id: property.id, index: property.index }, value: propertyValues });
                }
            }
            if (values.length) {
                response.push({ objectId: item.objectId, values });
            }
        }
        if (response.length) {
            this.client.readPropertyMultipleResponse(receiver, msg.invokeId, response);
        }
        void this.setStateAsync("server.lastRequest", `readPropertyMultiple ${response.length}`, true);
    }

    async handleWriteProperty(msg) {
        const objectId = msg.payload.objectId;
        const propertyId = msg.payload.value.property.id;
        if (propertyId !== Bacnet.enum.PropertyIdentifier.PRESENT_VALUE) {
            return;
        }
        const object = this.serverObjectByKey.get(this.objectKey(objectId));
        if (!object || !object.stateId || object.write === false || !msg.payload.value.value || !msg.payload.value.value.length) {
            return;
        }
        const value = this.decodeBacnetValue(msg.payload.value.value[0]);
        await this.setForeignStateAsync(object.stateId, value, false);
        object.value = value;
        object.ts = Date.now();
        this.client.simpleAckResponse(msg.header.sender, Bacnet.enum.ConfirmedServiceChoice.WRITE_PROPERTY, msg.invokeId);
        void this.setStateAsync("server.lastRequest", `write ${this.objectKey(objectId)}=${value}`, true);
    }

    async buildClientObjects() {
        this.clientObjects = [];
        for (const device of this.getConfiguredClientDevices()) {
            if (!device || !device.id || !device.address || !Array.isArray(device.objects)) {
                continue;
            }
            const deviceId = this.sanitizeId(device.id);
            await this.removeLegacyClientChannel(device.id, deviceId);
            await this.setObjectNotExistsAsync(`client.${deviceId}`, {
                type: "channel",
                common: { name: device.name || device.id },
                native: { address: device.address, deviceId: device.deviceId },
            });
            for (const object of device.objects) {
                const objectId = this.sanitizeId(object.id || `${object.type}_${object.instance}`);
                const type = this.normalizeObjectType(object.type);
                const stateId = `client.${deviceId}.${objectId}`;
                const stateType = this.ioBrokerTypeForBacnetType(type);
                await this.ensureState(stateId, object.name || objectId, stateType, "value", true, false);
                const setStateId = object.write === true ? `client.${deviceId}.${objectId}_set` : null;
                if (setStateId) {
                    await this.ensureState(setStateId, `Set ${object.name || objectId}`, stateType, this.roleForSetState(stateType), true, true);
                    const current = await this.getStateAsync(stateId);
                    if (current) {
                        await this.setStateAsync(setStateId, current.val, true);
                    }
                }
                this.clientObjects.push({
                    deviceId,
                    stateId,
                    setStateId,
                    address: device.address,
                    type,
                    instance: Number(object.instance),
                    write: object.write === true,
                });
            }
        }
        if (this.clientObjects.some(object => object.write)) {
            await this.subscribeStatesAsync("client.*");
        }
        this.log.info(`Configured ${this.clientObjects.length} BACnet client objects`);
    }

    async removeLegacyClientChannel(originalId, sanitizedId) {
        const legacyId = String(originalId);
        if (!legacyId.includes(".") || legacyId === sanitizedId) {
            return;
        }
        try {
            const object = await this.getObjectAsync(`client.${legacyId}`);
            if (object) {
                await this.delObjectAsync(`client.${legacyId}`, { recursive: true });
                this.log.info(`Removed legacy nested BACnet client channel client.${legacyId}`);
            }
        } catch (error) {
            this.log.debug(`Could not remove legacy BACnet client channel ${legacyId}: ${error.message || error}`);
        }
    }

    getConfiguredClientDevices() {
        if (this.config.clientDevices.length) {
            return this.config.clientDevices;
        }
        if (!this.config.clientTargetIp || (!this.config.clientObjects.length && !this.clientDiscoveredObjects.length)) {
            return [];
        }
        return [{
            id: this.config.clientTargetDeviceId || this.config.clientTargetIp,
            name: this.config.clientTargetDeviceId ? `Device ${this.config.clientTargetDeviceId}` : this.config.clientTargetIp,
            address: this.config.clientTargetIp,
            deviceId: this.config.clientTargetDeviceId,
            objects: this.config.clientObjects.length ? this.config.clientObjects : this.clientDiscoveredObjects,
        }];
    }

    startClientPolling(runNow) {
        this.stopClientPolling();
        if (runNow) {
            void this.pollClientObjects();
        }
        this.pollTimer = this.setInterval(() => {
            void this.pollClientObjects();
        }, this.config.clientPollIntervalMs);
    }

    stopClientPolling() {
        if (this.pollTimer) {
            this.clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
    }

    async pollClientObjects() {
        for (const object of this.clientObjects) {
            try {
                const value = await this.readPresentValue(object.address, object.type, object.instance);
                await this.setStateAsync(object.stateId, value, true);
                if (object.setStateId) {
                    await this.setStateAsync(object.setStateId, value, true);
                }
            } catch (error) {
                this.log.warn(`BACnet read ${object.address} ${object.type}:${object.instance} failed: ${error.message || error}`);
            }
        }
        await this.setStateAsync("client.lastPoll", new Date().toISOString(), true);
        const count = await this.getStateAsync("client.pollCount");
        await this.setStateAsync("client.pollCount", Number(count && count.val || 0) + 1, true);
        await this.setStateAsync("info.lastUpdate", new Date().toISOString(), true);
    }

    readPresentValue(address, type, instance) {
        if (this.config.transportMode === "bacnet-sc") {
            return this.readPresentValueSc(type, instance);
        }
        return new Promise((resolve, reject) => {
            this.client.readProperty(address, { type, instance }, Bacnet.enum.PropertyIdentifier.PRESENT_VALUE, (error, result) => {
                if (error) {
                    reject(error);
                    return;
                }
                const value = result && result.values && result.values[0] ? this.decodeBacnetValue(result.values[0]) : null;
                resolve(value);
            });
        });
    }

    writePresentValue(address, type, instance, value) {
        if (this.config.transportMode === "bacnet-sc") {
            return this.writePresentValueSc(type, instance, value);
        }
        const encoded = this.encodePresentValue(type, value);
        return new Promise((resolve, reject) => {
            this.client.writeProperty(
                address,
                { type, instance },
                Bacnet.enum.PropertyIdentifier.PRESENT_VALUE,
                [encoded],
                { priority: 16 },
                error => error ? reject(error) : resolve(),
            );
        });
    }

    async readPresentValueSc(type, instance) {
        if (!this.sc || !this.sc.connected) throw new Error("BACnet/SC is not connected");
        const value = await this.sc.readProperty(type, Number(instance), this.scModule.PropertyIds.present_value());
        return this.decodeScValue(value);
    }

    async writePresentValueSc(type, instance, value) {
        if (!this.sc || !this.sc.connected) throw new Error("BACnet/SC is not connected");
        await this.sc.writeProperty(
            type,
            Number(instance),
            this.scModule.PropertyIds.present_value(),
            this.encodeScPresentValue(type, value),
            16,
        );
    }

    async discoverDevices() {
        if (this.config.transportMode === "bacnet-sc") {
            const found = [];
            this.sc.onIAm(data => found.push(data));
            this.sc.whoIs();
            await this.delay(5000);
            await this.setStateAsync("client.discoveredJson", JSON.stringify(found, null, 2), true);
            this.log.info(`BACnet/SC discovery collected ${found.length} I-Am messages`);
            return found;
        }
        const found = new Map();
        const onIAm = device => {
            if (device && device.payload && device.payload.deviceId) {
                found.set(device.payload.deviceId, {
                    deviceId: device.payload.deviceId,
                    address: device.header && device.header.sender && device.header.sender.address,
                    maxApdu: device.payload.maxApdu,
                    segmentation: device.payload.segmentation,
                    vendorId: device.payload.vendorId,
                });
            }
        };
        this.client.on("iAm", onIAm);
        this.client.whoIs();
        if (this.config.clientTargetIp) {
            this.client.whoIs(this.config.clientTargetIp);
        }
        await this.delay(5000);
        this.client.removeListener("iAm", onIAm);
        const devices = Array.from(found.values()).sort((a, b) => a.deviceId - b.deviceId);
        await this.setStateAsync("client.discoveredJson", JSON.stringify(devices, null, 2), true);
        this.log.info(`BACnet discovery found ${devices.length} devices`);
        return devices;
    }

    async discoverTargetObjects() {
        if (this.config.transportMode === "bacnet-sc") {
            this.log.warn("Automatic objectList discovery is not implemented for BACnet/SC yet. Configure client objects manually.");
            return [];
        }
        const target = await this.findTargetDevice();
        if (!target || !target.deviceId) {
            this.log.warn(`No BACnet device answered on target IP ${this.config.clientTargetIp}`);
            return [];
        }
        await this.setStateAsync("client.targetDeviceJson", JSON.stringify(target, null, 2), true);
        const rawObjects = await this.readObjectList(this.config.clientTargetIp, Number(target.deviceId));
        await this.setStateAsync("client.rawObjectListJson", JSON.stringify(rawObjects.map(objectId => ({
            type: objectId.type,
            typeName: OBJECT_TYPE_NAMES[objectId.type] || `type${objectId.type}`,
            instance: objectId.instance,
        })), null, 2), true);
        const supported = rawObjects
            .filter(objectId => this.isReadableClientObjectType(objectId.type))
            .slice(0, 500);
        const objects = [];
        for (const objectId of supported) {
            const typeName = OBJECT_TYPE_NAMES[objectId.type] || `type${objectId.type}`;
            let name = `${typeName} ${objectId.instance}`;
            try {
                name = await this.readObjectName(this.config.clientTargetIp, objectId);
            } catch (error) {
                this.log.debug(`Could not read object name for ${typeName}:${objectId.instance}: ${error.message || error}`);
            }
            objects.push({
                id: `${typeName}_${objectId.instance}`,
                name,
                type: typeName,
                instance: objectId.instance,
                write: this.isUsuallyWritableType(objectId.type),
            });
        }
        this.clientDiscoveredObjects = objects;
        await this.setStateAsync("client.discoveredObjectsJson", JSON.stringify(objects, null, 2), true);
        this.log.info(`BACnet target ${this.config.clientTargetIp} exposes ${objects.length} supported objects`);
        return objects;
    }

    async findTargetDevice() {
        if (this.config.clientTargetDeviceId) {
            return { deviceId: Number(this.config.clientTargetDeviceId), address: this.config.clientTargetIp };
        }
        const found = new Map();
        const onIAm = device => {
            if (device && device.payload && device.payload.deviceId) {
                const address = device.header && device.header.sender && device.header.sender.address;
                found.set(device.payload.deviceId, {
                    deviceId: device.payload.deviceId,
                    address,
                    maxApdu: device.payload.maxApdu,
                    segmentation: device.payload.segmentation,
                    vendorId: device.payload.vendorId,
                });
            }
        };
        this.client.on("iAm", onIAm);
        this.client.whoIs(this.config.clientTargetIp);
        await this.delay(5000);
        this.client.removeListener("iAm", onIAm);
        const devices = Array.from(found.values());
        return devices.find(device => device.address === this.config.clientTargetIp) || devices[0] || null;
    }

    readObjectList(address, deviceId) {
        return new Promise((resolve, reject) => {
            this.client.readProperty(address, { type: OBJECT_TYPES.device, instance: deviceId }, Bacnet.enum.PropertyIdentifier.OBJECT_LIST, (error, result) => {
                if (error) {
                    reject(error);
                    return;
                }
                const objects = (result && result.values || [])
                    .map(item => item && item.value)
                    .filter(value => value && Number.isFinite(value.type) && Number.isFinite(value.instance));
                if (objects.length > 1) {
                    resolve(objects);
                    return;
                }
                this.readObjectListByIndex(address, deviceId)
                    .then(indexedObjects => resolve(indexedObjects.length ? indexedObjects : objects))
                    .catch(() => resolve(objects));
            });
        });
    }

    async readObjectListByIndex(address, deviceId) {
        const count = await this.readObjectListCount(address, deviceId);
        const objects = [];
        for (let index = 1; index <= Math.min(count, 1000); index++) {
            const objectId = await this.readObjectListIndex(address, deviceId, index);
            if (objectId && Number.isFinite(objectId.type) && Number.isFinite(objectId.instance)) {
                objects.push(objectId);
            }
        }
        return objects;
    }

    readObjectListCount(address, deviceId) {
        return new Promise((resolve, reject) => {
            this.client.readProperty(
                address,
                { type: OBJECT_TYPES.device, instance: deviceId },
                Bacnet.enum.PropertyIdentifier.OBJECT_LIST,
                { arrayIndex: 0 },
                (error, result) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    const value = result && result.values && result.values[0] ? result.values[0].value : 0;
                    resolve(Number(value || 0));
                },
            );
        });
    }

    readObjectListIndex(address, deviceId, arrayIndex) {
        return new Promise((resolve, reject) => {
            this.client.readProperty(
                address,
                { type: OBJECT_TYPES.device, instance: deviceId },
                Bacnet.enum.PropertyIdentifier.OBJECT_LIST,
                { arrayIndex },
                (error, result) => {
                    if (error) {
                        reject(error);
                        return;
                    }
                    const value = result && result.values && result.values[0] ? result.values[0].value : null;
                    resolve(value);
                },
            );
        });
    }

    readObjectName(address, objectId) {
        return new Promise((resolve, reject) => {
            this.client.readProperty(address, objectId, Bacnet.enum.PropertyIdentifier.OBJECT_NAME, (error, result) => {
                if (error) {
                    reject(error);
                    return;
                }
                const value = result && result.values && result.values[0] ? result.values[0].value : null;
                resolve(value || `${OBJECT_TYPE_NAMES[objectId.type] || objectId.type} ${objectId.instance}`);
            });
        });
    }

    isReadableClientObjectType(type) {
        return type === OBJECT_TYPES.analogInput ||
            type === OBJECT_TYPES.analogOutput ||
            type === OBJECT_TYPES.analogValue ||
            type === OBJECT_TYPES.binaryInput ||
            type === OBJECT_TYPES.binaryOutput ||
            type === OBJECT_TYPES.binaryValue ||
            type === OBJECT_TYPES.multiStateInput ||
            type === OBJECT_TYPES.multiStateOutput ||
            type === OBJECT_TYPES.multiStateValue ||
            type === OBJECT_TYPES.characterStringValue ||
            type === OBJECT_TYPES.integerValue ||
            type === OBJECT_TYPES.largeAnalogValue ||
            type === OBJECT_TYPES.positiveIntegerValue ||
            type === OBJECT_TYPES.binaryLightingOutput;
    }

    isUsuallyWritableType(type) {
        return type === OBJECT_TYPES.analogOutput ||
            type === OBJECT_TYPES.analogValue ||
            type === OBJECT_TYPES.binaryOutput ||
            type === OBJECT_TYPES.binaryValue ||
            type === OBJECT_TYPES.multiStateOutput ||
            type === OBJECT_TYPES.multiStateValue ||
            type === OBJECT_TYPES.integerValue ||
            type === OBJECT_TYPES.largeAnalogValue ||
            type === OBJECT_TYPES.positiveIntegerValue ||
            type === OBJECT_TYPES.binaryLightingOutput;
    }

    async buildServerObjects() {
        this.serverObjects = new Map();
        this.serverObjectByKey = new Map();
        const objects = await this.getForeignObjectsAsync(this.config.serverStatesPattern, "state");
        const states = typeof this.getForeignStatesAsync === "function"
            ? await this.getForeignStatesAsync(this.config.serverStatesPattern)
            : {};
        let instance = 1;
        for (const [stateId, object] of Object.entries(objects || {})) {
            if (this.serverObjectByKey.size >= this.config.serverMaxObjects) {
                break;
            }
            if (stateId.startsWith(`${this.namespace}.`) || stateId.startsWith(`system.adapter.${this.namespace}`)) {
                continue;
            }
            const common = object.common || {};
            const type = this.serverObjectTypeForIoBrokerType(common.type);
            const bacnetObject = {
                objectId: { type, instance },
                stateId,
                name: this.getObjectName(object) || stateId,
                value: states && states[stateId] ? states[stateId].val : null,
                ts: states && states[stateId] ? states[stateId].ts : Date.now(),
                write: common.write === true,
                source: "pattern",
            };
            this.addServerObject(bacnetObject);
            instance++;
        }
        await this.buildManualServerObjects();
        await this.subscribeForeignStatesAsync(this.config.serverStatesPattern);
        for (const object of this.serverObjects.values()) {
            await this.subscribeForeignStatesAsync(object.stateId);
        }
        await this.setStateAsync("server.objectCount", this.serverObjects.size, true);
        await this.setStateAsync("server.lastBuild", new Date().toISOString(), true);
        this.log.info(`Published ${this.serverObjects.size} ioBroker states as BACnet objects`);
    }

    async buildManualServerObjects() {
        const points = Array.isArray(this.config.serverPoints) ? this.config.serverPoints : [];
        for (const rawPoint of points) {
            if (this.serverObjectByKey.size >= this.config.serverMaxObjects) {
                break;
            }
            const point = this.normalizeServerPoint(rawPoint);
            if (!point) {
                continue;
            }
            if (this.serverObjectByKey.has(this.objectKey(point.objectId))) {
                this.log.warn(`Skipping manual BACnet point ${point.name}: duplicate object ${this.objectKey(point.objectId)}`);
                continue;
            }
            if (point.internal) {
                await this.ensureState(point.relativeStateId, point.name, point.ioBrokerType, this.roleForSetState(point.ioBrokerType), true, point.write);
                const existing = await this.getForeignStateAsync(point.stateId);
                if (!existing && point.initialValue !== undefined) {
                    await this.setForeignStateAsync(point.stateId, point.initialValue, true);
                }
            }
            const state = await this.getForeignStateAsync(point.stateId);
            this.addServerObject({
                objectId: point.objectId,
                stateId: point.stateId,
                name: point.name,
                value: state ? state.val : point.initialValue,
                ts: state ? state.ts : Date.now(),
                write: point.write,
                source: "manual",
            });
        }
    }

    normalizeServerPoint(rawPoint) {
        if (!rawPoint || typeof rawPoint !== "object") {
            return null;
        }
        if (rawPoint.enabled === false || rawPoint.enabled === "false") {
            return null;
        }
        const instance = Number(rawPoint.instance);
        if (!Number.isFinite(instance) || instance < 1) {
            this.log.warn(`Skipping manual BACnet point ${rawPoint.name || ""}: missing object instance`);
            return null;
        }
        const id = this.sanitizeId(rawPoint.id || rawPoint.name || `point_${instance}`);
        const type = this.normalizeObjectType(rawPoint.type || rawPoint.objectType || "analogValue");
        const ioBrokerType = this.normalizeIoBrokerStateType(rawPoint.ioBrokerType || this.ioBrokerTypeForBacnetType(type), type);
        const stateId = rawPoint.stateId ? String(rawPoint.stateId) : `${this.namespace}.server.points.${instance}`;
        return {
            id,
            relativeStateId: `server.points.${instance}`,
            stateId,
            internal: !rawPoint.stateId,
            objectId: { type, instance },
            name: String(rawPoint.name || id),
            write: rawPoint.writable === true || rawPoint.writable === "true" || rawPoint.write === true || rawPoint.write === "true",
            ioBrokerType,
            initialValue: rawPoint.initialValue,
        };
    }

    addServerObject(object) {
        const key = this.objectKey(object.objectId);
        if (this.serverObjectByKey.has(key)) {
            this.log.warn(`Skipping duplicate BACnet server object ${key} for ${object.stateId}`);
            return false;
        }
        this.serverObjects.set(object.stateId, object);
        this.serverObjectByKey.set(key, object);
        return true;
    }

    getServerPropertyValues(objectId, propertyId) {
        if (objectId.type === OBJECT_TYPES.device && objectId.instance === this.config.serverDeviceId) {
            return this.getDevicePropertyValues(propertyId);
        }
        const object = this.serverObjectByKey.get(this.objectKey(objectId));
        if (!object) {
            return null;
        }
        if (propertyId === Bacnet.enum.PropertyIdentifier.PRESENT_VALUE) {
            return [this.encodePresentValue(object.objectId.type, object.value)];
        }
        if (propertyId === Bacnet.enum.PropertyIdentifier.OBJECT_NAME) {
            return [{ type: Bacnet.enum.ApplicationTag.CHARACTER_STRING, value: object.name }];
        }
        if (propertyId === Bacnet.enum.PropertyIdentifier.OBJECT_IDENTIFIER) {
            return [{ type: Bacnet.enum.ApplicationTag.OBJECTIDENTIFIER, value: object.objectId }];
        }
        if (propertyId === Bacnet.enum.PropertyIdentifier.OBJECT_TYPE) {
            return [{ type: Bacnet.enum.ApplicationTag.ENUMERATED, value: object.objectId.type }];
        }
        if (propertyId === Bacnet.enum.PropertyIdentifier.DESCRIPTION) {
            return [{ type: Bacnet.enum.ApplicationTag.CHARACTER_STRING, value: object.stateId }];
        }
        return null;
    }

    getDevicePropertyValues(propertyId) {
        if (propertyId === Bacnet.enum.PropertyIdentifier.OBJECT_NAME) {
            return [{ type: Bacnet.enum.ApplicationTag.CHARACTER_STRING, value: this.config.serverObjectName }];
        }
        if (propertyId === Bacnet.enum.PropertyIdentifier.OBJECT_IDENTIFIER) {
            return [{ type: Bacnet.enum.ApplicationTag.OBJECTIDENTIFIER, value: { type: OBJECT_TYPES.device, instance: this.config.serverDeviceId } }];
        }
        if (propertyId === Bacnet.enum.PropertyIdentifier.OBJECT_TYPE) {
            return [{ type: Bacnet.enum.ApplicationTag.ENUMERATED, value: OBJECT_TYPES.device }];
        }
        if (propertyId === Bacnet.enum.PropertyIdentifier.VENDOR_IDENTIFIER) {
            return [{ type: Bacnet.enum.ApplicationTag.UNSIGNED_INTEGER, value: this.config.serverVendorId }];
        }
        if (propertyId === Bacnet.enum.PropertyIdentifier.OBJECT_LIST) {
            return [
                { type: Bacnet.enum.ApplicationTag.OBJECTIDENTIFIER, value: { type: OBJECT_TYPES.device, instance: this.config.serverDeviceId } },
                ...Array.from(this.serverObjectByKey.values()).map(object => ({
                    type: Bacnet.enum.ApplicationTag.OBJECTIDENTIFIER,
                    value: object.objectId,
                })),
            ];
        }
        return null;
    }

    async onStateChange(id, state) {
        if (!state) {
            return;
        }
        if (id.startsWith(`${this.namespace}.control.`) && !state.ack) {
            const control = id.substring(`${this.namespace}.control.`.length);
            await this.setStateAsync(`control.${control}`, false, true);
            if (control === "discover") {
                await this.discoverDevices();
            } else if (control === "discoverObjects") {
                await this.discoverTargetObjects();
                await this.buildClientObjects();
            } else if (control === "refresh") {
                await this.pollClientObjects();
            } else if (control === "rebuildServerObjects") {
                await this.buildServerObjects();
            }
            return;
        }
        if (id.startsWith(`${this.namespace}.client.`) && !state.ack) {
            const target = this.clientObjects.find(object =>
                `${this.namespace}.${object.setStateId}` === id ||
                `${this.namespace}.${object.stateId}` === id
            );
            if (target && target.write) {
                try {
                    await this.writePresentValue(target.address, target.type, target.instance, state.val);
                    await this.setStateAsync(target.stateId, state.val, true);
                    if (target.setStateId) {
                        await this.setStateAsync(target.setStateId, state.val, true);
                    }
                    await this.setStateAsync("client.lastWrite", `${new Date().toISOString()} ${target.address} ${OBJECT_TYPE_NAMES[target.type] || target.type}:${target.instance}=${state.val}`, true);
                } catch (error) {
                    await this.setError(error);
                }
            }
            return;
        }
        const serverObject = this.serverObjects.get(id);
        if (serverObject) {
            serverObject.value = state.val;
            serverObject.ts = state.ts || Date.now();
        }
    }

    encodePresentValue(type, value) {
        if (type === OBJECT_TYPES.binaryInput || type === OBJECT_TYPES.binaryOutput || type === OBJECT_TYPES.binaryValue) {
            return { type: Bacnet.enum.ApplicationTag.ENUMERATED, value: value ? 1 : 0 };
        }
        if (type === OBJECT_TYPES.characterStringValue) {
            return { type: Bacnet.enum.ApplicationTag.CHARACTER_STRING, value: value === null || value === undefined ? "" : String(value) };
        }
        return { type: Bacnet.enum.ApplicationTag.REAL, value: Number(value || 0) };
    }

    encodeScPresentValue(type, value) {
        if (type === OBJECT_TYPES.binaryInput || type === OBJECT_TYPES.binaryOutput || type === OBJECT_TYPES.binaryValue) {
            return this.scModule.encodeEnumerated(value ? 1 : 0);
        }
        if (Number.isInteger(Number(value)) && (
            type === OBJECT_TYPES.integerValue ||
            type === OBJECT_TYPES.positiveIntegerValue ||
            type === OBJECT_TYPES.multiStateInput ||
            type === OBJECT_TYPES.multiStateOutput ||
            type === OBJECT_TYPES.multiStateValue
        )) {
            return this.scModule.encodeUnsigned(Number(value));
        }
        return this.scModule.encodeReal(Number(value || 0));
    }

    decodeBacnetValue(value) {
        if (!value) {
            return null;
        }
        if (value.type === Bacnet.enum.ApplicationTag.BOOLEAN) {
            return value.value === true;
        }
        if (value.type === Bacnet.enum.ApplicationTag.ENUMERATED && (value.value === 0 || value.value === 1)) {
            return value.value === 1;
        }
        return value.value;
    }

    decodeScValue(value) {
        if (value === null || value === undefined) return null;
        if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
        if (Array.isArray(value)) {
            if (value.length === 1) return this.decodeScValue(value[0]);
            return JSON.stringify(value);
        }
        if (typeof value === "object") {
            if (Object.prototype.hasOwnProperty.call(value, "value")) return this.decodeScValue(value.value);
            return JSON.stringify(value);
        }
        return String(value);
    }

    normalizeObjectType(type) {
        if (typeof type === "number") {
            return type;
        }
        const key = String(type || "analogValue").replace(/[-_\s]/g, "").toLowerCase();
        for (const [name, value] of Object.entries(OBJECT_TYPES)) {
            if (name.toLowerCase() === key) {
                return value;
            }
        }
        return OBJECT_TYPES.analogValue;
    }

    serverObjectTypeForIoBrokerType(type) {
        if (type === "boolean") {
            return OBJECT_TYPES.binaryValue;
        }
        if (type === "number") {
            return OBJECT_TYPES.analogValue;
        }
        return OBJECT_TYPES.characterStringValue;
    }

    ioBrokerTypeForBacnetType(type) {
        if (type === OBJECT_TYPES.binaryInput || type === OBJECT_TYPES.binaryOutput || type === OBJECT_TYPES.binaryValue) {
            return "boolean";
        }
        if (type === OBJECT_TYPES.characterStringValue) {
            return "string";
        }
        return "number";
    }

    normalizeIoBrokerStateType(type, bacnetType) {
        if (type === "boolean" || type === "number" || type === "string") {
            return type;
        }
        return this.ioBrokerTypeForBacnetType(bacnetType);
    }

    roleForSetState(type) {
        if (type === "boolean") {
            return "switch";
        }
        if (type === "number") {
            return "level";
        }
        return "state";
    }

    objectKey(objectId) {
        return `${objectId.type}:${objectId.instance}`;
    }

    parseJson(value, fallback) {
        try {
            if (typeof value === "string") {
                return JSON.parse(value);
            }
            return value || fallback;
        } catch (error) {
            this.log.warn(`Invalid JSON config: ${error.message}`);
            return fallback;
        }
    }

    getObjectName(object) {
        const name = object && object.common ? object.common.name : "";
        if (typeof name === "string") {
            return name;
        }
        if (name && typeof name === "object") {
            return name.de || name.en || Object.values(name)[0] || "";
        }
        return "";
    }

    sanitizeId(value) {
        return String(value).replace(/[^a-zA-Z0-9-]/g, "_");
    }

    delay(ms) {
        return new Promise(resolve => this.setTimeout(resolve, ms));
    }

    uuidToBytes(value) {
        const hex = String(value).replace(/[^a-fA-F0-9]/g, "");
        if (hex.length !== 32) throw new Error("BACnet/SC device UUID must contain 32 hex characters");
        return Uint8Array.from(hex.match(/../g).map(byte => parseInt(byte, 16)));
    }

    bytesToHex(bytes) {
        return Array.from(bytes || []).map(byte => byte.toString(16).padStart(2, "0")).join("");
    }

    async ensureState(id, name, type, role, read, write = false) {
        if (this.knownStates.has(id)) {
            return;
        }
        const object = {
            type: "state",
            common: { name, type, role, read, write },
            native: {},
        };
        await this.setObjectNotExistsAsync(id, object);
        await this.extendObjectAsync(id, object);
        this.knownStates.add(id);
    }

    async deleteLegacyObject(id) {
        try {
            const object = await this.getObjectAsync(id);
            if (object) {
                await this.delObjectAsync(id);
            }
        } catch (error) {
            this.log.debug(`Could not remove legacy object ${id}: ${error.message || error}`);
        }
    }

    async cleanupLegacyNativeConfig() {
        try {
            const instanceId = `system.adapter.${this.namespace}`;
            const object = await this.getForeignObjectAsync(instanceId);
            if (!object || !object.native) {
                return;
            }
            let changed = false;
            for (const key of ["serverPatternInstanceStart", "serverManualInstanceStart", "serverPointsJson"]) {
                if (Object.prototype.hasOwnProperty.call(object.native, key)) {
                    delete object.native[key];
                    changed = true;
                }
            }
            if (changed) {
                await this.setForeignObjectAsync(instanceId, object);
            }
        } catch (error) {
            this.log.debug(`Could not clean legacy native config: ${error.message || error}`);
        }
    }

    async setError(error) {
        const message = error && error.message ? error.message : String(error);
        this.log.error(message);
        await this.setStateAsync("info.lastError", message, true);
    }

    closeBacnet() {
        this.stopClientPolling();
        if (this.serverTimer) {
            this.clearInterval(this.serverTimer);
            this.serverTimer = null;
        }
        if (this.client) {
            try {
                this.client.close();
            } catch (error) {
                // ignore close errors
            }
            this.client = null;
        }
        if (this.sc) {
            try {
                void this.sc.disconnect();
            } catch (error) {
                // ignore close errors
            }
            this.sc = null;
        }
    }

    onUnload(callback) {
        try {
            this.stopping = true;
            this.closeBacnet();
            callback();
        } catch (error) {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new BacnetFlexAdapter(options);
} else {
    new BacnetFlexAdapter();
}
